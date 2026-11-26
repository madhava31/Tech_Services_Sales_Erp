// Deleting an opportunity: its owner or a manager/admin, at once. A won deal stays. The audit log keeps a copy.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, createClient } from './helpers/server.js';
import { createCompany, createUser, dealFieldsFor, login, signedInSalesperson } from './helpers/fixtures.js';
import { query } from './helpers/testDb.js';

let server;
let ravi;
let priya;
let admin;
let fields;

before(async () => {
  server = await startTestServer();
  ravi = await signedInSalesperson(server.baseUrl, 'Ravi', createClient);
  priya = await signedInSalesperson(server.baseUrl, 'Priya', createClient);
  await createUser('boss', 'admin');
  admin = createClient(server.baseUrl);
  await login(admin, 'boss');
  fields = await dealFieldsFor('OD-1');
});

after(async () => {
  await server?.close();
});

async function newDeal(owner, name) {
  const companyId = await createCompany(name, { city: 'Hyderabad', createdBy: owner.userId });
  const res = await owner.client.request('POST', '/api/opportunities', { company_id: companyId, title: `${name} deal`, ...fields });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  await query(
    `INSERT INTO task (company_id, opportunity_id, assignee_salesperson_id, task_type, title, due_date, created_by) VALUES ($1, $2, $3, 'call', 'Call', CURRENT_DATE, $4)`,
    [companyId, res.body.id, owner.salespersonId, owner.userId]
  );
  return res.body;
}
const remove = (client, id, body = {}) => client.request('DELETE', `/api/opportunities/${id}`, body);

test('the owner deletes their opportunity: it and what hangs off it go, and the audit log keeps a copy', async () => {
  const deal = await newDeal(ravi, 'Mine Labs');
  const res = await remove(ravi.client, deal.id, { reason: 'Entered by mistake' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((await ravi.client.request('GET', `/api/opportunities/${deal.id}`)).status, 404);
  assert.equal((await query(`SELECT COUNT(*)::int AS n FROM opportunity_history WHERE opportunity_id = $1`, [deal.id]))[0].n, 0);
  assert.equal((await query(`SELECT COUNT(*)::int AS n FROM task WHERE opportunity_id = $1`, [deal.id]))[0].n, 0);
  const audit = await query(`SELECT summary, before FROM audit_log WHERE action = 'opportunity.deleted' AND entity_id = $1`, [deal.id]);
  assert.equal(audit.length, 1);
  assert.match(audit[0].summary, /Entered by mistake/);
  assert.equal(audit[0].before.opportunity.id, deal.id);
  assert.ok(audit[0].before.history.length >= 1, 'history is in the copy');
  // The append-only protection is back on.
  assert.equal((await query(`SELECT tgenabled FROM pg_trigger WHERE tgname = 'opportunity_history_no_update_delete'`))[0].tgenabled, 'O');
});

test('another salesperson cannot delete it, and signed-out callers are refused', async () => {
  const deal = await newDeal(ravi, 'Theirs Labs');
  const other = await remove(priya.client, deal.id);
  assert.ok([403, 404].includes(other.status), `status ${other.status}`);
  assert.equal((await remove(createClient(server.baseUrl), deal.id)).status, 401);
  assert.equal((await ravi.client.request('GET', `/api/opportunities/${deal.id}`)).status, 200, 'still there');
});

test('an admin can delete anyone’s opportunity', async () => {
  const deal = await newDeal(ravi, 'Admin Labs');
  assert.equal((await remove(admin, deal.id)).status, 200);
  assert.equal((await admin.request('GET', `/api/opportunities/${deal.id}`)).status, 404);
});

test('a salesperson’s delete is kept for the managers; a manager’s delete leaves nothing; a manager can remove the record', async () => {
  const mine = await newDeal(ravi, 'Kept Labs');
  assert.equal((await remove(ravi.client, mine.id, { reason: 'Wrong customer' })).status, 200);
  assert.equal((await ravi.client.request('GET', `/api/opportunities/${mine.id}`)).status, 404, 'gone from their account');
  const kept = (await admin.request('GET', '/api/opportunities/deleted')).body.find((d) => d.code === mine.code);
  assert.ok(kept, 'the admin sees it');
  assert.equal(kept.reason, 'Wrong customer');
  assert.equal(kept.owner_name, 'Ravi');
  assert.equal(kept.deleted_by_name, 'Ravi');

  // Salespeople cannot see or purge the list.
  assert.equal((await ravi.client.request('GET', '/api/opportunities/deleted')).status, 403);
  assert.equal((await ravi.client.request('DELETE', `/api/opportunities/deleted/${kept.id}`)).status, 403);

  // A manager's own delete is not kept.
  const theirs = await newDeal(priya, 'Gone Labs');
  assert.equal((await remove(admin, theirs.id)).status, 200);
  assert.equal((await admin.request('GET', '/api/opportunities/deleted')).body.some((d) => d.code === theirs.code), false);

  // Removing the record deletes it from the database.
  assert.equal((await admin.request('DELETE', `/api/opportunities/deleted/${kept.id}`)).status, 200);
  assert.equal((await query(`SELECT COUNT(*)::int AS n FROM deleted_opportunity WHERE id = $1`, [kept.id]))[0].n, 0);
  assert.equal((await admin.request('DELETE', `/api/opportunities/deleted/${kept.id}`)).status, 404);
});

test('a won opportunity cannot be deleted', async () => {
  const deal = await newDeal(ravi, 'Won Labs');
  const won = await ravi.client.request('POST', `/api/opportunities/${deal.id}/stage`, { stage: 'won', won_value: 1000, close_reason: 'Good price' });
  assert.equal(won.status, 200, JSON.stringify(won.body));
  const res = await remove(admin, deal.id);
  assert.equal(res.status, 409);
  assert.match(res.body.error, /won/i);
});
