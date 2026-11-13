// Changing many at once, calls and WhatsApp logged from a follow-up, and the weekly report.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, createClient } from './helpers/server.js';
import { createCompany, createUser, dealFieldsFor, login, signedInSalesperson } from './helpers/fixtures.js';
import { query } from './helpers/testDb.js';

let server;
let ravi;
let priya;
let manager;
let office;
let admin;
let companyId;
let dealFields;
let today;
let runWeeklyReport;
let reportEmail;

const fromToday = (n) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

before(async () => {
  server = await startTestServer();
  ({ runWeeklyReport, reportEmail } = await import('../server/crm/weeklyReport.js'));
  ravi = await signedInSalesperson(server.baseUrl, 'Ravi', createClient);
  priya = await signedInSalesperson(server.baseUrl, 'Priya', createClient);
  for (const [name, role] of [['manager', 'sales_manager'], ['office', 'office_staff'], ['admin', 'admin']]) await createUser(name, role);
  manager = createClient(server.baseUrl);
  await login(manager, 'manager');
  office = createClient(server.baseUrl);
  await login(office, 'office');
  admin = createClient(server.baseUrl);
  await login(admin, 'admin');
  companyId = await createCompany('Bulk Labs', { createdBy: ravi.userId });
  dealFields = await dealFieldsFor('BULK-1');
  [{ today }] = await query(`SELECT ((NOW() AT TIME ZONE 'Asia/Kolkata')::date)::text AS today`);
});

after(async () => {
  await server?.close();
});

const newDeal = async (client, title = 'Bulk deal', body = {}) => (await client.request('POST', '/api/opportunities', { company_id: companyId, title, ...dealFields, ...body })).body;
const newTask = async (client, title = 'Bulk task', due = '2099-01-01', body = {}) => (await client.request('POST', '/api/tasks', { company_id: companyId, title, due_date: due, ...body })).body;

test('many deals: one new closing date, recorded on each; others’ deals and closed deals left alone', async () => {
  const a = await newDeal(ravi.client, 'A');
  const b = await newDeal(ravi.client, 'B');
  const closed = await newDeal(ravi.client, 'Closed');
  await ravi.client.request('POST', `/api/opportunities/${closed.id}/stage`, { stage: 'lost', lost_reason: 'no_requirement', close_reason: 'Shelved' });
  const others = await newDeal(priya.client, 'Priya’s');

  const res = await ravi.client.request('POST', '/api/opportunities/bulk', { ids: [a.id, b.id, closed.id, others.id], expected_close_date: '2099-06-30' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.updated, 2);
  assert.equal(res.body.skipped.length, 2);
  assert.match(res.body.skipped.find((s) => s.id === closed.id).reason, /closed/);
  const hidden = res.body.skipped.find((s) => s.id === others.id);
  assert.equal(hidden.title, `#${others.id}`, 'nothing about someone else’s deal is revealed');
  assert.equal(hidden.reason, 'not found');

  const after = (await ravi.client.request('GET', `/api/opportunities/${a.id}`)).body;
  assert.equal(after.expected_close_date, '2099-06-30');
  assert.equal(after.history[0].field, 'Expected closing date');
  assert.equal((await priya.client.request('GET', `/api/opportunities/${others.id}`)).body.expected_close_date, dealFields.expected_close_date);
  const [audit] = await query(`SELECT action FROM audit_log WHERE entity_type = 'opportunity' AND entity_id = $1 ORDER BY id DESC LIMIT 1`, [a.id]);
  assert.equal(audit.action, 'opportunity.updated');
});

test('many deals: moving stage follows the same rules; only one kind of change at a time', async () => {
  const a = await newDeal(ravi.client, 'Stage A');
  const b = await newDeal(ravi.client, 'Stage B');
  const moved = await ravi.client.request('POST', '/api/opportunities/bulk', { ids: [a.id, b.id], stage: 'qualify' });
  assert.equal(moved.body.updated, 2);
  assert.equal((await ravi.client.request('GET', `/api/opportunities/${a.id}`)).body.history[0].to_value, 'qualify');

  const again = await ravi.client.request('POST', '/api/opportunities/bulk', { ids: [a.id], stage: 'qualify' });
  assert.equal(again.body.skipped[0].reason, 'already there');
  const noQuote = await ravi.client.request('POST', '/api/opportunities/bulk', { ids: [a.id], stage: 'prove' });
  assert.equal(noQuote.body.updated, 0);
  assert.match(noQuote.body.skipped[0].reason, /quotation/);

  assert.equal((await ravi.client.request('POST', '/api/opportunities/bulk', { ids: [a.id], stage: 'won' })).status, 400, 'closing needs each deal’s own reason and value');
  assert.equal((await ravi.client.request('POST', '/api/opportunities/bulk', { ids: [a.id] })).status, 400);
  assert.equal((await ravi.client.request('POST', '/api/opportunities/bulk', { ids: [a.id], stage: 'qualify', expected_close_date: '2099-01-01' })).status, 400);
  assert.equal((await ravi.client.request('POST', '/api/opportunities/bulk', { ids: [], stage: 'qualify' })).status, 400);
  assert.equal((await ravi.client.request('POST', '/api/opportunities/bulk', { ids: Array.from({ length: 201 }, (_, i) => i + 1), stage: 'qualify' })).status, 400);
  assert.equal((await office.request('POST', '/api/opportunities/bulk', { ids: [a.id], stage: 'qualify' })).status, 403);
});

test('many deals: transfer is for managers, needs a reason, and is audited per deal', async () => {
  const a = await newDeal(ravi.client, 'Transfer A');
  const b = await newDeal(ravi.client, 'Transfer B');
  const keep = await newDeal(priya.client, 'Already Priya’s');
  const task = await newTask(ravi.client, 'Moves too', '2099-01-01');
  await query(`UPDATE task SET opportunity_id = $1 WHERE id = $2`, [a.id, task.id]);

  assert.equal((await ravi.client.request('POST', '/api/opportunities/bulk', { ids: [a.id], to_salesperson_id: priya.salespersonId, reason: 'x' })).status, 403);
  assert.equal((await manager.request('POST', '/api/opportunities/bulk', { ids: [a.id], to_salesperson_id: priya.salespersonId })).status, 400, 'a reason is required');
  const res = await manager.request('POST', '/api/opportunities/bulk', { ids: [a.id, b.id, keep.id], to_salesperson_id: priya.salespersonId, reason: 'Territory change' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.updated, 2);
  assert.equal(res.body.skipped[0].reason, 'already theirs');
  const after = (await priya.client.request('GET', `/api/opportunities/${a.id}`)).body;
  assert.equal(after.owner_salesperson_id, priya.salespersonId);
  assert.equal(after.original_owner_salesperson_id, ravi.salespersonId);
  assert.equal(after.tasks[0].assignee_name, 'Priya', 'its follow-ups go with it');
  const [audit] = await query(`SELECT action, summary FROM audit_log WHERE entity_type = 'opportunity' AND entity_id = $1 ORDER BY id DESC LIMIT 1`, [b.id]);
  assert.equal(audit.action, 'opportunity.transferred');
  assert.match(audit.summary, /Territory change/);
});

test('many follow-ups: new date, mark done, reassign; each within the normal rules', async () => {
  const a = await newTask(ravi.client, 'T1');
  const b = await newTask(ravi.client, 'T2');
  const others = await newTask(priya.client, 'Priya’s task');
  const moved = await ravi.client.request('POST', '/api/tasks/bulk', { ids: [a.id, b.id, others.id], due_date: '2099-03-03' });
  assert.equal(moved.body.updated, 2);
  assert.equal(moved.body.skipped[0].reason, 'not found');
  assert.equal((await ravi.client.request('GET', `/api/tasks/${a.id}`)).body.due_date, '2099-03-03');
  assert.equal((await priya.client.request('GET', `/api/tasks/${others.id}`)).body.due_date, '2099-01-01');

  assert.equal((await ravi.client.request('POST', '/api/tasks/bulk', { ids: [a.id], assignee_salesperson_id: priya.salespersonId })).status, 403);
  const reassigned = await manager.request('POST', '/api/tasks/bulk', { ids: [a.id], assignee_salesperson_id: priya.salespersonId });
  assert.equal(reassigned.body.updated, 1);
  assert.equal((await priya.client.request('GET', `/api/tasks/${a.id}`)).body.assignee_salesperson_id, priya.salespersonId);

  const done = await ravi.client.request('POST', '/api/tasks/bulk', { ids: [b.id], complete: true, outcome_notes: 'Spoke to all of them' });
  assert.equal(done.body.updated, 1);
  const closed = (await ravi.client.request('GET', `/api/tasks/${b.id}`)).body;
  assert.equal(closed.status, 'done');
  assert.equal(closed.outcome_notes, 'Spoke to all of them');
  assert.equal((await ravi.client.request('POST', '/api/tasks/bulk', { ids: [b.id], complete: true })).body.skipped[0].reason, 'already closed');
  const actions = (await query(`SELECT action FROM audit_log WHERE entity_type = 'task' AND entity_id = $1 ORDER BY id`, [b.id])).map((r) => r.action);
  assert.deepEqual(actions, ['task.created', 'task.updated', 'task.completed']);
  assert.equal((await office.request('POST', '/api/tasks/bulk', { ids: [a.id], due_date: '2099-01-01' })).status, 403);
});

test('a follow-up shows the best number to call: the deal’s contact first, then the visit’s, then the company’s', async () => {
  const company = await createCompany('Phone Labs', { createdBy: ravi.userId });
  const add = async (name, phone) => (await ravi.client.request('POST', `/api/companies/${company}/contacts`, { name, phone })).body;
  const first = await add('First Contact', '9333300001');
  const dealContact = await add('Deal Contact', '9333300002');
  const noContact = (await ravi.client.request('POST', '/api/tasks', { company_id: company, title: 'Any', due_date: '2099-01-01' })).body;
  assert.equal(noContact.contact_name, first.name);
  assert.equal(noContact.contact_phone, '9333300001');

  const deal = await newDeal(ravi.client, 'Has contact', { company_id: company, contact_id: dealContact.id });
  const withDeal = (await ravi.client.request('POST', '/api/tasks', { company_id: company, title: 'On deal', due_date: '2099-01-01' })).body;
  await query(`UPDATE task SET opportunity_id = $1 WHERE id = $2`, [deal.id, withDeal.id]);
  assert.equal((await ravi.client.request('GET', `/api/tasks/${withDeal.id}`)).body.contact_name, 'Deal Contact');

  const bare = await createCompany('No Phone Labs', { createdBy: ravi.userId });
  await query(`UPDATE company SET phone = '0401234000' WHERE id = $1`, [bare]);
  const companyOnly = (await ravi.client.request('POST', '/api/tasks', { company_id: bare, title: 'Switchboard', due_date: '2099-01-01' })).body;
  assert.equal(companyOnly.contact_phone, '0401234000');
  assert.equal(companyOnly.contact_name, null);
  assert.ok((await ravi.client.request('GET', '/api/today')).status === 200);
});

test('logging a call: reached finishes the follow-up and can set the next; no answer moves it', async () => {
  const company = await createCompany('Call Labs', { createdBy: ravi.userId });
  await ravi.client.request('POST', `/api/companies/${company}/contacts`, { name: 'Dr. Call', phone: '9444400001' });
  const fields = await dealFieldsFor('CALL-1');
  const deal = (await ravi.client.request('POST', '/api/opportunities', { company_id: company, title: 'Call deal', ...fields })).body;
  const mk = async (title) => {
    const t = (await ravi.client.request('POST', '/api/tasks', { company_id: company, title, due_date: today })).body;
    await query(`UPDATE task SET opportunity_id = $1 WHERE id = $2`, [deal.id, t.id]);
    return t;
  };
  const noAnswer = await mk('Try them');
  assert.equal((await ravi.client.request('POST', `/api/tasks/${noAnswer.id}/log`, { channel: 'pigeon', result: 'reached' })).status, 400);
  assert.equal((await priya.client.request('POST', `/api/tasks/${noAnswer.id}/log`, { channel: 'call', result: 'reached' })).status, 404);
  assert.equal((await office.request('POST', `/api/tasks/${noAnswer.id}/log`, { channel: 'call', result: 'reached' })).status, 403);

  const missed = await ravi.client.request('POST', `/api/tasks/${noAnswer.id}/log`, { channel: 'call', result: 'no_answer' });
  assert.equal(missed.status, 200, JSON.stringify(missed.body));
  assert.equal(missed.body.task.status, 'open');
  assert.equal(missed.body.task.due_date, fromToday(1), 'tomorrow unless told otherwise');
  const chosen = await ravi.client.request('POST', `/api/tasks/${noAnswer.id}/log`, { channel: 'call', result: 'no_answer', next_due_date: fromToday(5) });
  assert.equal(chosen.body.task.due_date, fromToday(5));

  const reached = await ravi.client.request('POST', `/api/tasks/${noAnswer.id}/log`, { channel: 'call', result: 'reached', notes: 'Wants a demo', next_due_date: fromToday(3) });
  assert.equal(reached.body.task.status, 'done');
  assert.equal(reached.body.task.outcome_notes, 'Wants a demo');
  assert.equal(reached.body.next_task.due_date, fromToday(3));
  assert.equal(reached.body.next_task.opportunity_id, deal.id, 'the next step stays on the deal');
  assert.equal((await ravi.client.request('POST', `/api/tasks/${noAnswer.id}/log`, { channel: 'call', result: 'reached' })).status, 409, 'already closed');

  const justDone = await mk('No next step');
  const finished = await ravi.client.request('POST', `/api/tasks/${justDone.id}/log`, { channel: 'whatsapp', result: 'reached' });
  assert.equal(finished.body.task.status, 'done');
  assert.equal(finished.body.next_task, null);

  // The record, on the company and the deal, only for those who may see it.
  const companyView = (await ravi.client.request('GET', `/api/companies/${company}`)).body;
  assert.equal(companyView.contact_log.length, 4);
  assert.equal(companyView.contact_log[0].channel, 'whatsapp');
  assert.equal(companyView.contact_log.at(-1).contact_name, 'Dr. Call');
  assert.equal((await priya.client.request('GET', `/api/companies/${company}`)).body.contact_log.length, 0);
  assert.equal((await manager.request('GET', `/api/companies/${company}`)).body.contact_log.length, 4);
  assert.equal((await ravi.client.request('GET', `/api/opportunities/${deal.id}`)).body.contact_log.length, 4);
  const actions = (await query(`SELECT action FROM audit_log WHERE entity_type = 'task' AND entity_id = $1 AND action = 'contact.logged'`, [noAnswer.id]));
  assert.equal(actions.length, 3);

  // A stale offline attempt is refused like any other stale edit.
  const stale = await mk('Stale');
  await manager.request('PUT', `/api/tasks/${stale.id}`, { due_date: '2099-09-09' });
  const refused = await ravi.client.request('POST', `/api/tasks/${stale.id}/log`, { channel: 'call', result: 'no_answer', expected_updated_at: stale.updated_at });
  assert.equal(refused.status, 409);
});

test('the weekly report: last finished week, once only, with the right figures and managers told', async () => {
  const [{ monday }] = await query(`SELECT (date_trunc('week', (NOW() AT TIME ZONE 'Asia/Kolkata')::date::timestamp) - interval '4 days')::date::text AS monday`);
  const midLast = `(${`'${monday}'`}::date::timestamp + time '12:00') AT TIME ZONE 'Asia/Kolkata'`;
  await query(
    `INSERT INTO opportunity (company_id, title, owner_salesperson_id, original_owner_salesperson_id, stage, estimated_value, probability, won_value, close_reason, closed_at, created_by, created_at)
     VALUES ($1, '<b>Won</b> last week', $2, $2, 'won', 700000, 100, 700000, 'PO', ${midLast}, $3, ${midLast})`,
    [companyId, ravi.salespersonId, ravi.userId]
  );
  const sent = [];
  await admin.request('POST', '/api/reports/recipients', { email: 'md@example.com' });
  const pushes = [];
  const first = await runWeeklyReport({ push: async (id, payload) => pushes.push([id, payload]), sendEmail: async (message) => sent.push(message) });
  assert.equal(first.created, true);
  assert.equal(first.email.sent, 1);
  assert.equal(sent[0].to, 'md@example.com');
  assert.match(sent[0].subject, /weekly sales report/);
  assert.ok(sent[0].html.includes('&lt;b&gt;Won&lt;/b&gt;'), 'names typed by people are escaped');
  assert.ok(!sent[0].html.includes('<b>Won</b>'));

  const again = await runWeeklyReport({ sendEmail: async (message) => sent.push(message) });
  assert.equal(again.created, false);
  assert.equal(sent.length, 1, 'a restart sends nothing new');

  const list = (await manager.request('GET', '/api/reports')).body;
  assert.equal(list.reports.length, 1);
  assert.equal(list.reports[0].email_error, null);
  assert.ok(list.reports[0].emailed_at);
  const report = (await manager.request('GET', `/api/reports/${list.reports[0].id}`)).body;
  const span = (Date.parse(report.week_end) - Date.parse(report.week_start)) / 86400000;
  assert.equal(span, 6);
  assert.equal(new Date(`${report.week_start}T00:00:00Z`).getUTCDay(), 1, 'starts on a Monday');
  assert.equal(report.data.totals.won_value, 700000);
  assert.equal(report.data.wins[0].value, 700000);
  assert.ok(report.data.salespeople.find((p) => p.name === 'Ravi').won_value === 700000);

  assert.equal(pushes.length, 2, 'the manager and the admin');
  assert.equal((await manager.request('GET', '/api/notifications')).body.items[0].url, '/reports');
  assert.equal((await office.request('GET', '/api/notifications')).body.items.length, 0);
  assert.ok(reportEmail(report).text.includes('Orders won'));
});

test('weekly report access, the email list, and a failed send is kept to show and retry', async () => {
  assert.equal((await ravi.client.request('GET', '/api/reports')).status, 403);
  assert.equal((await office.request('GET', '/api/reports')).status, 200);
  assert.equal((await office.request('POST', '/api/reports/generate')).status, 403);
  assert.equal((await manager.request('POST', '/api/reports/recipients', { email: 'x@example.com' })).status, 403);
  assert.equal((await admin.request('POST', '/api/reports/recipients', { email: 'not-an-email' })).status, 400);
  assert.equal((await admin.request('POST', '/api/reports/recipients', { email: 'MD@example.com' })).status, 409, 'the same address in capitals');
  const [{ id }] = (await admin.request('GET', '/api/reports/recipients')).body;
  assert.equal((await admin.request('PUT', `/api/reports/recipients/${id}`, { is_active: false })).body.is_active, false);
  assert.equal((await admin.request('PUT', `/api/reports/recipients/${id}`, { is_active: true })).body.is_active, true);

  const { emailReport } = await import('../server/crm/weeklyReport.js');
  const [row] = await query(`SELECT * FROM weekly_report LIMIT 1`);
  const failed = await emailReport(row, { sendEmail: async () => { throw new Error('Mail server said no'); } });
  assert.equal(failed.error, 'Mail server said no');
  assert.equal((await manager.request('GET', '/api/reports')).body.reports[0].email_error, 'Mail server said no');
  assert.equal((await admin.request('POST', `/api/reports/${row.id}/email`)).status, 409, 'email isn’t set up in this environment');
});
