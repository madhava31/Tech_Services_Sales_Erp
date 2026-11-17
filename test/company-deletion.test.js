// Deleting a company: a salesperson asks for one they added, a manager or admin decides. Approved, the
// company is archived and what hangs off it is wound down; the history stays.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, createClient } from './helpers/server.js';
import { createCompany, createUser, dealFieldsFor, login, signedInSalesperson } from './helpers/fixtures.js';
import { query } from './helpers/testDb.js';

let server;
let ravi;
let priya;
let admin;
let manager;
let fields;

before(async () => {
  server = await startTestServer();
  ravi = await signedInSalesperson(server.baseUrl, 'Ravi', createClient);
  priya = await signedInSalesperson(server.baseUrl, 'Priya', createClient);
  const adminId = await createUser('boss', 'admin');
  admin = createClient(server.baseUrl);
  await login(admin, 'boss');
  await createUser('mgr', 'sales_manager');
  manager = createClient(server.baseUrl);
  await login(manager, 'mgr');
  fields = await dealFieldsFor('DEL-1');
  assert.ok(adminId);
});

after(async () => {
  await server?.close();
});

async function companyWithWork(name) {
  const companyId = await createCompany(name, { city: 'Hyderabad', createdBy: ravi.userId });
  const deal = await ravi.client.request('POST', '/api/opportunities', { company_id: companyId, title: `${name} deal`, ...fields });
  assert.equal(deal.status, 201, JSON.stringify(deal.body));
  await query(
    `INSERT INTO task (company_id, assignee_salesperson_id, task_type, title, due_date, created_by) VALUES ($1, $2, 'call', 'Call them', CURRENT_DATE, $3)`,
    [companyId, ravi.salespersonId, ravi.userId]
  );
  return { companyId, dealId: deal.body.id };
}
const ask = (client, id, body) => client.request('POST', `/api/companies/${id}/delete-request`, body);
const notes = (userId, kind) => query(`SELECT title, body, read_at FROM notification WHERE user_id = $1 AND kind = $2 ORDER BY id`, [userId, kind]);

test('only the person who added the company can ask, and a reason is needed', async () => {
  const { companyId } = await companyWithWork('Ask Labs');
  assert.equal((await ask(priya.client, companyId, { reason: 'Mine now' })).status, 403, 'someone else cannot');
  const noReason = await ask(ravi.client, companyId, {});
  assert.equal(noReason.status, 400);
  assert.equal((await ask(createClient(server.baseUrl), companyId, { reason: 'x' })).status, 401, 'signed in only');
});

test('the request waits for a manager: the asker and the approvers are told, and nothing is deleted yet', async () => {
  const { companyId } = await companyWithWork('Waiting Labs');
  const res = await ask(ravi.client, companyId, { reason: 'Entered by mistake' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.status, 'pending');

  assert.equal((await ask(ravi.client, companyId, { reason: 'again' })).status, 409, 'one request at a time');
  assert.equal((await ravi.client.request('GET', `/api/companies/${companyId}`)).status, 200, 'still there');
  const detail = (await ravi.client.request('GET', `/api/companies/${companyId}`)).body;
  assert.equal(detail.deletion_request.reason, 'Entered by mistake');

  const adminId = (await query(`SELECT id FROM app_user WHERE username = 'boss'`))[0].id;
  const toAdmin = (await notes(adminId, 'approval_request')).filter((n) => /Waiting Labs/.test(n.body));
  assert.equal(toAdmin.length, 1);
  assert.ok(toAdmin[0].body.includes('asks to delete Waiting Labs (Hyderabad): Entered by mistake. It has 1 open deal, 1 open follow-up.'), toAdmin[0].body);
  assert.equal((await notes(ravi.userId, 'approval_sent')).filter((n) => /Waiting Labs/.test(n.body)).length, 1);

  const list = await admin.request('GET', '/api/companies/deletion-requests');
  assert.equal(list.status, 200);
  const row = list.body.find((r) => r.company_id === companyId);
  assert.equal(row.requested_by_name, 'Ravi');
  assert.equal(row.impact.open_deals, 1);
  assert.equal(row.impact.open_tasks, 1);
  assert.equal((await ravi.client.request('GET', '/api/companies/deletion-requests')).status, 403, 'salespeople cannot read the queue');
});

test('rejecting keeps the company and tells the asker why; they may ask again', async () => {
  const { companyId } = await companyWithWork('Rejected Labs');
  const requestId = (await ask(ravi.client, companyId, { reason: 'Test entry' })).body.id;
  assert.equal((await admin.request('POST', `/api/companies/deletion-requests/${requestId}/reject`, {})).status, 400, 'a reason is needed');
  assert.equal((await ravi.client.request('POST', `/api/companies/deletion-requests/${requestId}/reject`, { reason: 'no' })).status, 403, 'only a manager decides');
  const res = await admin.request('POST', `/api/companies/deletion-requests/${requestId}/reject`, { reason: 'It is a real customer' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((await ravi.client.request('GET', `/api/companies/${companyId}`)).status, 200);
  const told = (await notes(ravi.userId, 'approval_decided')).find((n) => /Not deleted: Rejected Labs/.test(n.title));
  assert.match(told.body, /It is a real customer/);
  assert.equal((await admin.request('POST', `/api/companies/deletion-requests/${requestId}/approve`)).status, 409, 'already decided');
  assert.equal((await ask(ravi.client, companyId, { reason: 'Asking again' })).status, 201);
});

test('approving archives the company, closes its open deals, cancels its follow-ups and keeps the history', async () => {
  const { companyId, dealId } = await companyWithWork('Gone Labs');
  const requestId = (await ask(ravi.client, companyId, { reason: 'Duplicate entry' })).body.id;
  const res = await manager.request('POST', `/api/companies/deletion-requests/${requestId}/approve`);
  assert.equal(res.status, 200, JSON.stringify(res.body));

  assert.equal((await ravi.client.request('GET', `/api/companies/${companyId}`)).status, 404, 'no longer there');
  const found = (await ravi.client.request('GET', '/api/companies?q=Gone')).body;
  assert.ok(!found.some((c) => c.id === companyId), 'not in lists or search');
  assert.ok((await query(`SELECT archived_at FROM company WHERE id = $1`, [companyId]))[0].archived_at, 'archived, not removed');

  const [deal] = await query(`SELECT stage, lost_reason, close_reason, probability FROM opportunity WHERE id = $1`, [dealId]);
  assert.equal(deal.stage, 'lost');
  assert.equal(deal.lost_reason, 'other');
  assert.match(deal.close_reason, /Company deleted on approval: Duplicate entry/);
  assert.equal(deal.probability, 0);
  assert.equal((await query(`SELECT COUNT(*)::int AS n FROM opportunity_history WHERE opportunity_id = $1 AND to_value = 'lost'`, [dealId]))[0].n, 1, 'the move is in the history');
  assert.equal((await query(`SELECT COUNT(*)::int AS n FROM task WHERE company_id = $1 AND status = 'open'`, [companyId]))[0].n, 0);
  assert.equal((await query(`SELECT COUNT(*)::int AS n FROM task WHERE company_id = $1 AND status = 'cancelled'`, [companyId]))[0].n, 1);

  assert.ok((await notes(ravi.userId, 'approval_decided')).some((n) => /Deleted: Gone Labs/.test(n.title)));
  const audit = await query(`SELECT summary FROM audit_log WHERE action = 'company.archived' AND entity_id = $1`, [companyId]);
  assert.equal(audit.length, 1);
  assert.match(audit[0].summary, /Duplicate entry/);
  const pending = await admin.request('GET', '/api/companies/deletion-requests');
  assert.ok(!pending.body.some((r) => r.company_id === companyId), 'off the queue');
  assert.ok(
    (await notes((await query(`SELECT id FROM app_user WHERE username = 'boss'`))[0].id, 'approval_request')).filter((n) => /Gone Labs/.test(n.body)).every((n) => n.read_at),
    'the other approvers’ reminders are cleared'
  );
});

test('a manager or admin deleting a company needs no second approval', async () => {
  const { companyId } = await companyWithWork('Direct Labs');
  const res = await admin.request('POST', `/api/companies/${companyId}/delete-request`, { reason: 'Cleaning up' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.archived, true);
  assert.equal((await admin.request('GET', `/api/companies/${companyId}`)).status, 404);
});

test('a company with branches cannot be deleted until they are dealt with', async () => {
  const { companyId } = await companyWithWork('Head Office Labs');
  const branchId = await createCompany('Branch Labs', { city: 'Pune', createdBy: ravi.userId });
  await query(`UPDATE company SET parent_company_id = $1 WHERE id = $2`, [companyId, branchId]);
  const res = await ask(ravi.client, companyId, { reason: 'Close it' });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /has 1 branch\. Delete or move it first/);
});
