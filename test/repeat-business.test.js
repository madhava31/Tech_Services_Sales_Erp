// Tender tracking, installed base with renewal follow-ups, and consumables reorders.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, createClient } from './helpers/server.js';
import { createCompany, createProduct, createUser, dealFieldsFor, login, signedInSalesperson } from './helpers/fixtures.js';
import { query } from './helpers/testDb.js';

let server;
let ravi;
let priya;
let manager;
let office;
let companyId;
let dealFields;
let today;
let runDailyReminders;
let createRepeatFollowups;

const fromToday = (n) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

before(async () => {
  server = await startTestServer();
  ({ runDailyReminders } = await import('../server/crm/reminders.js'));
  ({ createRepeatFollowups } = await import('../server/crm/repeat.js'));
  ravi = await signedInSalesperson(server.baseUrl, 'Ravi', createClient);
  priya = await signedInSalesperson(server.baseUrl, 'Priya', createClient);
  await createUser('manager', 'sales_manager');
  manager = createClient(server.baseUrl);
  await login(manager, 'manager');
  await createUser('office', 'office_staff');
  office = createClient(server.baseUrl);
  await login(office, 'office');
  companyId = await createCompany('Repeat Labs', { createdBy: ravi.userId });
  dealFields = await dealFieldsFor('REP-1');
  [{ today }] = await query(`SELECT ((NOW() AT TIME ZONE 'Asia/Kolkata')::date)::text AS today`);
});

after(async () => {
  await server?.close();
});

const newDeal = async (client, body = {}) => (await client.request('POST', '/api/opportunities', { company_id: companyId, title: 'Tender deal', ...dealFields, ...body })).body;
const TENDER = () => ({ tender_number: 'GEM/2026/B/1234', issuing_authority: 'CSIR Lab', bid_due_date: fromToday(5), emd_amount: 50000, emd_status: 'pending' });

test('tender details: validated, mark the deal as a tender, and are private like the deal', async () => {
  const deal = await newDeal(ravi.client);
  assert.equal(deal.tender, false);
  assert.equal((await ravi.client.request('PUT', `/api/tenders/deal/${deal.id}`, { bid_due_date: fromToday(5) })).status, 400, 'tender number required');
  assert.equal((await ravi.client.request('PUT', `/api/tenders/deal/${deal.id}`, { tender_number: 'X' })).status, 400, 'bid date required');
  assert.equal((await ravi.client.request('PUT', `/api/tenders/deal/${deal.id}`, { ...TENDER(), emd_amount: null })).status, 400, 'a deposit needs its amount');
  assert.equal((await ravi.client.request('PUT', `/api/tenders/deal/${deal.id}`, { ...TENDER(), document_url: 'javascript:alert(1)' })).status, 400);
  assert.equal((await priya.client.request('PUT', `/api/tenders/deal/${deal.id}`, TENDER())).status, 404, 'someone else’s deal');
  assert.equal((await office.request('PUT', `/api/tenders/deal/${deal.id}`, TENDER())).status, 403);

  const saved = await ravi.client.request('PUT', `/api/tenders/deal/${deal.id}`, TENDER());
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.days_left, 5);
  const detail = (await ravi.client.request('GET', `/api/opportunities/${deal.id}`)).body;
  assert.equal(detail.tender, true);
  assert.equal(detail.tender_details.tender_number, 'GEM/2026/B/1234');

  assert.ok((await ravi.client.request('GET', '/api/tenders?view=open')).body.some((t) => t.opportunity_id === deal.id));
  assert.ok(!(await priya.client.request('GET', '/api/tenders?view=open')).body.some((t) => t.opportunity_id === deal.id));
  assert.ok((await office.request('GET', '/api/tenders?view=open')).body.some((t) => t.opportunity_id === deal.id));
  const todayView = (await ravi.client.request('GET', '/api/today')).body;
  assert.ok(todayView.tenders_due.some((t) => t.opportunity_id === deal.id), 'due within a week, on Today');
});

test('tender changes are in the deal history and audit log; late bids are flagged', async () => {
  const deal = await newDeal(ravi.client);
  await ravi.client.request('PUT', `/api/tenders/deal/${deal.id}`, TENDER());
  await ravi.client.request('PUT', `/api/tenders/deal/${deal.id}`, { ...TENDER(), bid_status: 'submitted', emd_status: 'paid' });
  const detail = (await ravi.client.request('GET', `/api/opportunities/${deal.id}`)).body;
  const fields = detail.history.filter((h) => h.change_type === 'field').map((h) => h.field);
  assert.ok(fields.includes('Bid status') && fields.includes('EMD status') && fields.includes('Tender'));
  const actions = (await query(`SELECT action FROM audit_log WHERE entity_type = 'opportunity' AND entity_id = $1 ORDER BY id`, [deal.id])).map((r) => r.action);
  assert.deepEqual(actions, ['opportunity.created', 'tender.created', 'tender.updated']);

  const late = await newDeal(ravi.client);
  const res = await ravi.client.request('PUT', `/api/tenders/deal/${late.id}`, { ...TENDER(), bid_due_date: fromToday(-1) });
  assert.equal(res.body.is_late, true);
  const done = await ravi.client.request('PUT', `/api/tenders/deal/${late.id}`, { ...TENDER(), bid_due_date: fromToday(-1), bid_status: 'submitted' });
  assert.equal(done.body.is_late, false, 'already submitted isn’t late');
});

test('EMD to recover: paid and decided, tracked even after the deal closes, until refunded', async () => {
  const deal = await newDeal(ravi.client, { title: 'EMD deal' });
  const paid = { ...TENDER(), emd_status: 'paid', bid_status: 'submitted' };
  await ravi.client.request('PUT', `/api/tenders/deal/${deal.id}`, paid);
  const inList = async () => (await ravi.client.request('GET', '/api/tenders?view=emd')).body.some((t) => t.opportunity_id === deal.id);
  assert.equal(await inList(), false, 'still with the bid');

  await ravi.client.request('POST', `/api/opportunities/${deal.id}/stage`, { stage: 'lost', lost_reason: 'price', close_reason: 'L1 was lower' });
  assert.equal(await inList(), true, 'closed deal, deposit still out');

  const refund = await ravi.client.request('PUT', `/api/tenders/deal/${deal.id}`, { ...paid, bid_status: 'lost', emd_status: 'refunded' });
  assert.equal(refund.status, 200, 'editable after the deal closed');
  assert.equal(await inList(), false);
});

test('installed base: everyone sees a company’s instruments; only the owner or the office changes them', async () => {
  const product = await createProduct('INST-1');
  const body = { company_id: companyId, description: 'AAS spectrometer', product_id: product.id, serial_number: 'SN-1', installed_on: fromToday(-300), warranty_end_date: fromToday(65) };
  assert.equal((await ravi.client.request('POST', '/api/installed-base', { ...body, description: '' })).status, 400);
  assert.equal((await ravi.client.request('POST', '/api/installed-base', { ...body, product_id: 999999 })).status, 400);
  const created = await ravi.client.request('POST', '/api/installed-base', { ...body, salesperson_id: priya.salespersonId });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.salesperson_id, ravi.salespersonId, 'a salesperson’s record is their own');
  assert.equal(created.body.product_name, 'Product INST-1');

  assert.equal((await office.request('POST', '/api/installed-base', body)).status, 400, 'the office must name who is responsible');
  const fromOffice = await office.request('POST', '/api/installed-base', { ...body, serial_number: 'SN-2', salesperson_id: priya.salespersonId });
  assert.equal(fromOffice.status, 201);

  const seen = (await priya.client.request('GET', `/api/installed-base?company_id=${companyId}`)).body;
  assert.ok(seen.some((i) => i.id === created.body.id), 'a shared fact about the customer');
  assert.equal((await priya.client.request('PUT', `/api/installed-base/${created.body.id}`, { notes: 'x' })).status, 403);
  assert.equal((await office.request('PUT', `/api/installed-base/${created.body.id}`, { notes: 'Service due' })).body.notes, 'Service due');

  const mine = (await ravi.client.request('GET', '/api/installed-base/renewals')).body;
  assert.ok(mine.every((r) => r.salesperson_id === ravi.salespersonId));
  assert.ok(mine.some((r) => r.id === created.body.id && r.kind === 'warranty' && r.days_left === 65));
  assert.ok(!mine.some((r) => r.id === fromOffice.body.id), 'the list shows your own');
  assert.ok((await manager.request('GET', '/api/installed-base/renewals')).body.some((r) => r.id === fromOffice.body.id));
});

test('renewal follow-ups: one per date, at the right time; renewing finishes it and starts the next cycle', async () => {
  const rep = await signedInSalesperson(server.baseUrl, 'Renewer', createClient);
  const add = async (fields) => (await rep.client.request('POST', '/api/installed-base', { company_id: companyId, description: 'Balance', ...fields })).body;
  const soon = await add({ amc_end_date: fromToday(10), description: 'Soon' });
  const near = await add({ warranty_end_date: fromToday(50), description: 'Near' });
  await add({ warranty_end_date: fromToday(120), description: 'Too far' });
  await add({ amc_end_date: fromToday(-200), description: 'Long ended' });

  await createRepeatFollowups();
  const tasks = async () => (await rep.client.request('GET', '/api/tasks?status=open')).body;
  let open = await tasks();
  assert.equal(open.length, 2, JSON.stringify(open.map((t) => t.title)));
  const soonTask = open.find((t) => t.title.includes('Soon'));
  assert.equal(soonTask.task_type, 'renewal');
  assert.equal(soonTask.priority, 'high');
  assert.match(soonTask.title, /^AMC ends/);
  assert.equal(soonTask.due_date, fromToday(7));
  assert.equal(open.find((t) => t.title.includes('Near')).priority, 'normal');

  assert.equal(await createRepeatFollowups(), 0, 'running again adds nothing');
  await rep.client.request('POST', `/api/tasks/${soonTask.id}/complete`, {});
  await createRepeatFollowups();
  assert.equal((await tasks()).length, 1, 'finishing it doesn’t bring it back');

  // Renewing the warranty closes its reminder.
  const renewed = await rep.client.request('PUT', `/api/installed-base/${near.id}`, { warranty_end_date: fromToday(415) });
  assert.equal(renewed.status, 200);
  assert.equal((await tasks()).length, 0);
  const [audit] = await query(`SELECT action, summary FROM audit_log WHERE entity_type = 'installed_instrument' AND entity_id = $1 ORDER BY id DESC LIMIT 1`, [near.id]);
  assert.equal(audit.action, 'instrument.renewed');

  // A renewal that is itself ending soon gets its own new follow-up.
  await rep.client.request('PUT', `/api/installed-base/${soon.id}`, { amc_end_date: fromToday(20) });
  await createRepeatFollowups();
  assert.equal((await tasks()).length, 1);

  // Retiring an instrument cancels its reminder, keeps the record, and stops new ones.
  assert.equal((await rep.client.request('POST', `/api/installed-base/${soon.id}/retire`, {})).status, 400, 'a reason is required');
  assert.equal((await rep.client.request('POST', `/api/installed-base/${soon.id}/retire`, { reason: 'Replaced' })).body.is_active, false);
  assert.equal((await tasks()).length, 0);
  assert.equal((await rep.client.request('DELETE', `/api/installed-base/${soon.id}`)).status, 404, 'no way to delete');
  assert.ok(!(await rep.client.request('GET', `/api/installed-base?company_id=${companyId}`)).body.some((i) => i.id === soon.id));
  assert.ok((await rep.client.request('GET', `/api/installed-base?company_id=${companyId}&include_retired=1`)).body.some((i) => i.id === soon.id));
});

test('reorders: next due counts from the last order; marking ordered restarts it', async () => {
  const rep = await signedInSalesperson(server.baseUrl, 'Reorderer', createClient);
  const body = { company_id: companyId, item: 'HPLC solvents', interval_days: 30, last_order_date: fromToday(-25), typical_value: 40000 };
  assert.equal((await rep.client.request('POST', '/api/reorders', { ...body, interval_days: 0 })).status, 400);
  const created = await rep.client.request('POST', '/api/reorders', body);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.next_due_date, fromToday(5));
  const far = (await rep.client.request('POST', '/api/reorders', { ...body, item: 'Not yet', last_order_date: fromToday(-5) })).body;
  assert.equal(far.days_left, 25);

  await createRepeatFollowups();
  const tasks = async () => (await rep.client.request('GET', '/api/tasks?status=open')).body;
  let open = await tasks();
  assert.deepEqual(open.map((t) => t.title), ['Reorder call: HPLC solvents, Repeat Labs'], 'only the one within a week');
  assert.equal(open[0].task_type, 'reorder');
  assert.equal(open[0].due_date, fromToday(5));

  assert.equal((await priya.client.request('POST', `/api/reorders/${created.body.id}/ordered`, {})).status, 403);
  assert.equal((await rep.client.request('POST', `/api/reorders/${created.body.id}/ordered`, { ordered_on: fromToday(1) })).status, 400, 'not in the future');
  const ordered = await rep.client.request('POST', `/api/reorders/${created.body.id}/ordered`, { value: 45000 });
  assert.equal(ordered.status, 200);
  assert.equal(ordered.body.last_order_date, today);
  assert.equal(ordered.body.next_due_date, fromToday(30));
  assert.equal(ordered.body.typical_value, 45000);
  assert.equal((await tasks()).length, 0, 'the reminder is finished');

  // "Call me next week": moving the date replaces the reminder.
  await rep.client.request('PUT', `/api/reorders/${far.id}`, { next_due_date: fromToday(3) });
  await createRepeatFollowups();
  open = await tasks();
  assert.equal(open.length, 1);
  await rep.client.request('PUT', `/api/reorders/${far.id}`, { next_due_date: fromToday(20) });
  assert.equal((await tasks()).length, 0);

  assert.equal((await rep.client.request('POST', `/api/reorders/${far.id}/stop`, { reason: 'Changed supplier' })).status, 200);
  assert.ok(!(await rep.client.request('GET', '/api/reorders')).body.some((r) => r.id === far.id));
  assert.equal((await rep.client.request('POST', `/api/reorders/${far.id}/ordered`, {})).status, 409);
  assert.ok((await query(`SELECT 1 FROM reorder_plan WHERE id = $1`, [far.id])).length, 'kept, not deleted');
});

test('the morning job creates these follow-ups and mentions tenders due soon', async () => {
  await query(`DELETE FROM notification`);
  const rep = await signedInSalesperson(server.baseUrl, 'Morning', createClient);
  await rep.client.request('POST', '/api/installed-base', { company_id: companyId, description: 'Viscometer', amc_end_date: fromToday(3) });
  const deal = await newDeal(rep.client, { title: 'Morning tender' });
  await rep.client.request('PUT', `/api/tenders/deal/${deal.id}`, { ...TENDER(), bid_due_date: fromToday(2) });
  await runDailyReminders({ send: async () => undefined });
  const [note] = (await rep.client.request('GET', '/api/notifications')).body.items;
  assert.match(note.body, /1 tender due soon/);
  assert.ok((await rep.client.request('GET', '/api/tasks?status=open')).body.some((t) => t.title.includes('Viscometer')));
});

test('handover moves instruments and reorders; a person who has left creates no follow-ups', async () => {
  const leaver = await signedInSalesperson(server.baseUrl, 'Leaver', createClient);
  const taker = await signedInSalesperson(server.baseUrl, 'Taker', createClient);
  const { body: inst } = await leaver.client.request('POST', '/api/installed-base', { company_id: companyId, description: 'Handed over', amc_end_date: fromToday(30) });
  const { body: plan } = await leaver.client.request('POST', '/api/reorders', { company_id: companyId, item: 'Handed reagents', interval_days: 30 });

  const res = await manager.request('POST', '/api/handover', { from_salesperson_id: leaver.salespersonId, to_salesperson_id: taker.salespersonId, reason: 'Resigned' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.instruments_moved, 1);
  assert.equal(res.body.reorders_moved, 1);
  assert.ok((await taker.client.request('GET', '/api/installed-base/renewals')).body.some((r) => r.id === inst.id));
  assert.ok((await taker.client.request('GET', '/api/reorders')).body.some((r) => r.id === plan.id));

  // Someone with a record who has left: nothing lands on a list nobody reads.
  const gone = await signedInSalesperson(server.baseUrl, 'Gone', createClient);
  const { body: orphan } = await gone.client.request('POST', '/api/installed-base', { company_id: companyId, description: 'Orphan', amc_end_date: fromToday(9) });
  await query(`UPDATE salesperson SET is_active = FALSE WHERE id = $1`, [gone.salespersonId]);
  await createRepeatFollowups();
  assert.equal((await query(`SELECT COUNT(*)::int c FROM auto_followup WHERE kind = 'amc' AND ref_id = $1`, [orphan.id]))[0].c, 0);
  await query(`UPDATE salesperson SET is_active = TRUE WHERE id = $1`, [gone.salespersonId]);

  // Deactivating someone who still has these is blocked until they are handed over.
  const blocked = await signedInSalesperson(server.baseUrl, 'Blocked', createClient);
  await blocked.client.request('POST', '/api/installed-base', { company_id: companyId, description: 'Blocks it' });
  await createUser('adminuser', 'admin');
  const admin = createClient(server.baseUrl);
  await login(admin, 'adminuser');
  await admin.request('POST', `/api/admin/users/${blocked.userId}/deactivate`, { reason: 'Leaving' });
  const refused = await admin.request('POST', `/api/admin/salespeople/${blocked.salespersonId}/deactivate`);
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.match(refused.body.error, /Hand them over first/);
});

test('merging companies moves instruments and reorders too', async () => {
  const dup = await createCompany('Duplicate Repeat', { createdBy: ravi.userId });
  const keep = await createCompany('Kept Repeat', { createdBy: ravi.userId });
  await ravi.client.request('POST', '/api/installed-base', { company_id: dup, description: 'Moves with merge' });
  await ravi.client.request('POST', '/api/reorders', { company_id: dup, item: 'Moves too', interval_days: 30 });
  const res = await manager.request('POST', `/api/companies/${dup}/merge`, { into_company_id: keep, reason: 'Duplicate' });
  assert.equal(res.body.moved.instruments, 1);
  assert.equal(res.body.moved.reorders, 1);
  assert.equal((await manager.request('GET', `/api/installed-base?company_id=${keep}`)).body.length, 1);
  assert.equal((await manager.request('GET', `/api/reorders?company_id=${keep}`)).body.length, 1);
});
