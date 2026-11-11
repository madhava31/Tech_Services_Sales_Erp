import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startTestServer, createClient } from './helpers/server.js';
import { createCompany, createSalesperson, createUser, login, signedInSalesperson } from './helpers/fixtures.js';
import { query } from './helpers/testDb.js';

let server;
let ravi;
let priya;
let manager;
let companyId;

const FOLLOW_UP = { title: 'Call back with pricing', due_date: '2099-01-15' };
const REQUIREMENT = { product_category: 'Valves', description: '2" ball valves, SS316', quantity: 40, unit: 'Nos', urgency: 'high' };

before(async () => {
  server = await startTestServer();
  ravi = await signedInSalesperson(server.baseUrl, 'Ravi', createClient);
  priya = await signedInSalesperson(server.baseUrl, 'Priya', createClient);
  await createUser('manager', 'sales_manager');
  manager = createClient(server.baseUrl);
  await login(manager, 'manager');
  const [{ id: adminId }] = await query(`SELECT id FROM app_user WHERE username = 'ravi'`);
  companyId = await createCompany('Delta Pumps', { city: 'Hyderabad', createdBy: adminId });
});

after(async () => {
  await server?.close();
});

async function startVisit(client, body = {}) {
  const res = await client.request('POST', '/api/visits', { company_id: companyId, ...body });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

test('a salesperson starts a draft visit for themselves, with a new contact', async () => {
  const visit = await startVisit(ravi.client, { contact: { name: 'Mr. Rao', designation: 'GM' }, notes: 'Arrived 11am', salesperson_id: priya.salespersonId });
  assert.equal(visit.status, 'draft');
  assert.equal(visit.salesperson_id, ravi.salespersonId, 'salesperson_id in the request is ignored for salespeople');
  assert.equal(visit.contact_name, 'Mr. Rao');
});

test('the same client_uuid never creates a second visit', async () => {
  const uuid = crypto.randomUUID();
  const first = await startVisit(ravi.client, { client_uuid: uuid });
  const retry = await ravi.client.request('POST', '/api/visits', { company_id: companyId, client_uuid: uuid });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.id, first.id);
  const other = await priya.client.request('POST', '/api/visits', { company_id: companyId, client_uuid: uuid });
  assert.equal(other.status, 409);
});

test('visits are private to their salesperson; managers see everyone', async () => {
  const visit = await startVisit(ravi.client);
  assert.equal((await priya.client.request('GET', `/api/visits/${visit.id}`)).body.error, 'Opportunity not found');
  assert.equal((await priya.client.request('PUT', `/api/visits/${visit.id}`, { notes: 'x' })).body.error, 'Opportunity not found');
  assert.equal((await priya.client.request('POST', `/api/visits/${visit.id}/complete`, { outcome: 'not_interested' })).body.error, 'Opportunity not found');
  const priyaList = await priya.client.request('GET', '/api/visits');
  assert.ok(priyaList.body.every((v) => v.salesperson_id === priya.salespersonId));
  assert.equal((await manager.request('GET', `/api/visits/${visit.id}`)).status, 200);
  const managerList = await manager.request('GET', '/api/visits');
  assert.ok(managerList.body.some((v) => v.salesperson_id === ravi.salespersonId));
});

test('a manager records a visit on behalf of a named salesperson only', async () => {
  const missing = await manager.request('POST', '/api/visits', { company_id: companyId });
  assert.equal(missing.status, 400);
  const res = await manager.request('POST', '/api/visits', { company_id: companyId, salesperson_id: priya.salespersonId });
  assert.equal(res.status, 201);
  assert.equal(res.body.salesperson_id, priya.salespersonId);
  const inactive = await createSalesperson('Gone', { active: false });
  assert.equal((await manager.request('POST', '/api/visits', { company_id: companyId, salesperson_id: inactive })).status, 400);
});

test('a contact from another company is rejected', async () => {
  const [{ id: otherCompany }] = await query(`INSERT INTO company (name, normalized_name, created_by) SELECT 'Other', 'other', id FROM app_user LIMIT 1 RETURNING id`);
  const [{ id: foreignContact }] = await query(`INSERT INTO company_contact (company_id, name, created_by) SELECT $1, 'Stranger', id FROM app_user LIMIT 1 RETURNING id`, [otherCompany]);
  const res = await ravi.client.request('POST', '/api/visits', { company_id: companyId, contact_id: foreignContact });
  assert.equal(res.status, 400);
});

test('completing an active-opportunity visit needs a requirement and a follow-up', async () => {
  const visit = await startVisit(ravi.client);
  const noReq = await ravi.client.request('POST', `/api/visits/${visit.id}/complete`, { outcome: 'interested', follow_up: FOLLOW_UP });
  assert.equal(noReq.status, 400);
  assert.match(noReq.body.error, /requirement/);
  const noFollowUp = await ravi.client.request('POST', `/api/visits/${visit.id}/complete`, { outcome: 'interested', requirements: [REQUIREMENT] });
  assert.equal(noFollowUp.status, 400);
  assert.match(noFollowUp.body.error, /follow-up/);
  const badReq = await ravi.client.request('POST', `/api/visits/${visit.id}/complete`, {
    outcome: 'interested', requirements: [{ description: 'ok' }, { quantity: 3 }], follow_up: FOLLOW_UP,
  });
  assert.equal(badReq.status, 400);
  assert.match(badReq.body.error, /Requirement 2/);
  // Nothing was half-saved by the failed attempts.
  assert.equal((await query(`SELECT status FROM visit WHERE id = $1`, [visit.id]))[0].status, 'draft');

  const done = await ravi.client.request('POST', `/api/visits/${visit.id}/complete`, {
    outcome: 'quotation_requested', notes: 'Wants quote by Friday', requirements: [REQUIREMENT], follow_up: FOLLOW_UP,
  });
  assert.equal(done.status, 200);
  assert.equal(done.body.status, 'completed');
  assert.ok(done.body.completed_at);
  assert.equal(done.body.requirements.length, 1);
  assert.equal(done.body.requirements[0].quantity, 40);
  assert.equal(done.body.requirements[0].salesperson_id, ravi.salespersonId);
  assert.equal(done.body.tasks.length, 1);
  assert.equal(done.body.tasks[0].task_type, 'send_quotation', 'quotation requests default to a send-quotation task');
  assert.equal(done.body.tasks[0].assignee_salesperson_id, ravi.salespersonId);
});

test('"not interested" can be completed without requirements or follow-up', async () => {
  const visit = await startVisit(ravi.client);
  const res = await ravi.client.request('POST', `/api/visits/${visit.id}/complete`, { outcome: 'not_interested' });
  assert.equal(res.status, 200);
  assert.equal(res.body.tasks.length, 0);
});

test('completed visits cannot be changed or completed twice', async () => {
  const visit = await startVisit(ravi.client);
  await ravi.client.request('POST', `/api/visits/${visit.id}/complete`, { outcome: 'not_interested' });
  assert.equal((await ravi.client.request('PUT', `/api/visits/${visit.id}`, { notes: 'edit' })).status, 409);
  assert.equal((await ravi.client.request('POST', `/api/visits/${visit.id}/complete`, { outcome: 'not_interested' })).status, 409);
});

test('drafts can be edited; future visit times are rejected', async () => {
  const visit = await startVisit(ravi.client);
  const edited = await ravi.client.request('PUT', `/api/visits/${visit.id}`, { notes: 'Met the purchase team' });
  assert.equal(edited.body.notes, 'Met the purchase team');
  const future = await ravi.client.request('PUT', `/api/visits/${visit.id}`, { visited_at: '2099-01-01T10:00:00Z' });
  assert.equal(future.status, 400);
});

test('the database itself refuses a completed visit without an outcome', async () => {
  const visit = await startVisit(ravi.client);
  await assert.rejects(query(`UPDATE visit SET status = 'completed', completed_at = NOW() WHERE id = $1`, [visit.id]), /visit_completion_consistent/);
});

test('office staff can read visits but not record them', async () => {
  await createUser('office', 'office_staff');
  const office = createClient(server.baseUrl);
  await login(office, 'office');
  assert.equal((await office.request('GET', '/api/visits')).status, 200);
  assert.equal((await office.request('POST', '/api/visits', { company_id: companyId })).status, 403);
});
