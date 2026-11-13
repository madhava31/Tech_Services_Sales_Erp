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
let companyId;
let otherCompanyId;
let dealFields;

const REQUIREMENT = { description: 'Cooling tower pumps', quantity: 6 };
const FOLLOW_UP = { title: 'Send quote', due_date: '2099-01-10' };

before(async () => {
  server = await startTestServer();
  ravi = await signedInSalesperson(server.baseUrl, 'Ravi', createClient);
  priya = await signedInSalesperson(server.baseUrl, 'Priya', createClient);
  await createUser('manager', 'sales_manager');
  manager = createClient(server.baseUrl);
  await login(manager, 'manager');
  await createUser('office', 'office_staff');
  office = createClient(server.baseUrl);
  await login(office, 'office');
  companyId = await createCompany('Delta Pumps', { createdBy: ravi.userId });
  otherCompanyId = await createCompany('Other Co', { createdBy: ravi.userId });
  dealFields = await dealFieldsFor('TEST-1');
});

after(async () => {
  await server?.close();
});

async function openDeal(client, body = {}) {
  const res = await client.request('POST', '/api/opportunities', { company_id: companyId, title: 'Pumps order', ...dealFields, ...body });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

async function completeVisit(client, body) {
  const { body: visit } = await client.request('POST', '/api/visits', { company_id: body.company_id ?? companyId });
  const res = await client.request('POST', `/api/visits/${visit.id}/complete`, body);
  return { visit, res };
}

test('a deal records its creator as owner and original owner, with a "created" history row', async () => {
  const deal = await openDeal(ravi.client, { owner_salesperson_id: priya.salespersonId });
  assert.equal(deal.owner_salesperson_id, ravi.salespersonId);
  assert.equal(deal.original_owner_salesperson_id, ravi.salespersonId);
  assert.equal(deal.stage, 'create');
  assert.equal(deal.probability, 25, 'the default win probability');
  const detail = await ravi.client.request('GET', `/api/opportunities/${deal.id}`);
  assert.deepEqual(detail.body.history.map((h) => [h.change_type, h.to_value]), [['created', 'create']]);
});

test('deals are private to their owner; managers and office staff see all', async () => {
  const deal = await openDeal(ravi.client);
  assert.equal((await priya.client.request('GET', `/api/opportunities/${deal.id}`)).body.error, 'Opportunity not found');
  assert.equal((await priya.client.request('POST', `/api/opportunities/${deal.id}/stage`, { stage: 'qualify' })).body.error, 'Opportunity not found');
  assert.ok((await priya.client.request('GET', '/api/opportunities')).body.every((o) => o.owner_salesperson_id === priya.salespersonId));
  assert.equal((await manager.request('GET', `/api/opportunities/${deal.id}`)).status, 200);
  assert.equal((await office.request('GET', `/api/opportunities/${deal.id}`)).status, 200);
  assert.equal((await office.request('POST', '/api/opportunities', { company_id: companyId, title: 'x' })).status, 403);
});

test('completing a visit can open a deal at the stage the outcome implies', async () => {
  const { visit, res } = await completeVisit(ravi.client, {
    outcome: 'quotation_requested', requirements: [REQUIREMENT], follow_up: FOLLOW_UP,
    opportunity: { title: 'Cooling tower pumps', ...dealFields, estimated_value: 450000 },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.opportunity_stage, 'develop');
  const deal = (await ravi.client.request('GET', `/api/opportunities/${res.body.opportunity_id}`)).body;
  assert.equal(deal.source_visit_id, visit.id);
  assert.equal(deal.requirements.length, 1, 'the visit’s requirements belong to the deal');
  assert.equal(deal.tasks.length, 1, 'and so does its follow-up');
  assert.equal(deal.visits[0].id, visit.id);

  const queue = await office.request('GET', '/api/opportunities/quotation-requests');
  assert.ok(queue.body.some((o) => o.id === deal.id), 'appears in the office quotation queue');
});

test('a later visit moves an existing deal forward but never backwards', async () => {
  const deal = await openDeal(ravi.client);
  const { res } = await completeVisit(ravi.client, { outcome: 'interested', requirements: [REQUIREMENT], follow_up: FOLLOW_UP, opportunity: { id: deal.id } });
  assert.equal(res.body.opportunity_stage, 'qualify');
  const { res: again } = await completeVisit(ravi.client, { outcome: 'follow_up_needed', requirements: [REQUIREMENT], follow_up: FOLLOW_UP, opportunity: { id: deal.id } });
  assert.equal(again.body.opportunity_stage, 'qualify', 'follow-up needed does not move it back to visit completed');
  const { res: notInterested } = await completeVisit(ravi.client, { outcome: 'not_interested', opportunity: { id: deal.id } });
  assert.equal(notInterested.body.opportunity_stage, 'qualify', '"not interested" never closes a deal by itself');
});

test('deal links from a visit are validated', async () => {
  const otherCompanyDeal = await openDeal(ravi.client, { company_id: otherCompanyId });
  const wrongCompany = await completeVisit(ravi.client, { outcome: 'not_interested', opportunity: { id: otherCompanyDeal.id } });
  assert.equal(wrongCompany.res.status, 400);
  const priyaDeal = await openDeal(priya.client);
  const notVisible = await completeVisit(ravi.client, { outcome: 'not_interested', opportunity: { id: priyaDeal.id } });
  assert.equal(notVisible.res.status, 400);
  const newOnNoNeed = await completeVisit(ravi.client, { outcome: 'not_interested', opportunity: { title: 'Nope', ...dealFields } });
  assert.equal(newOnNoNeed.res.status, 400);
  assert.equal((await query(`SELECT status FROM visit WHERE id = $1`, [newOnNoNeed.visit.id]))[0].status, 'draft', 'nothing half-saved');
});

test('quotations: office records them, the deal advances, salespeople cannot', async () => {
  const deal = await openDeal(ravi.client);
  assert.equal((await ravi.client.request('POST', `/api/opportunities/${deal.id}/stage`, { stage: 'prove' })).status, 400, 'no quotation yet');
  assert.equal((await ravi.client.request('POST', `/api/opportunities/${deal.id}/quotations`, { quotation_number: 'QTN-1' })).status, 403);

  const draft = await office.request('POST', `/api/opportunities/${deal.id}/quotations`, { quotation_number: 'QTN-100', amount: 480000, status: 'draft' });
  assert.equal(draft.status, 201);
  assert.equal((await ravi.client.request('GET', `/api/opportunities/${deal.id}`)).body.stage, 'create', 'a draft quotation does not advance the deal');

  const sent = await office.request('PUT', `/api/quotation-links/${draft.body.id}`, { status: 'sent', quotation_date: '2026-10-20' });
  assert.equal(sent.status, 200);
  const after = (await ravi.client.request('GET', `/api/opportunities/${deal.id}`)).body;
  assert.equal(after.stage, 'prove');
  assert.equal(after.probability, 25, 'moving stage keeps the probability the salesperson chose');
  assert.equal(after.history[0].to_value, 'prove');

  const dup = await office.request('POST', `/api/opportunities/${deal.id}/quotations`, { quotation_number: 'QTN-100' });
  assert.equal(dup.status, 409);
});

test('winning needs a value, losing needs a reason, and both are audited', async () => {
  const deal = await openDeal(ravi.client);
  assert.equal((await ravi.client.request('POST', `/api/opportunities/${deal.id}/stage`, { stage: 'won' })).status, 400);
  assert.equal((await ravi.client.request('POST', `/api/opportunities/${deal.id}/stage`, { stage: 'won', won_value: -5, close_reason: 'x' })).status, 400);
  assert.equal((await ravi.client.request('POST', `/api/opportunities/${deal.id}/stage`, { stage: 'won', won_value: 475000 })).status, 400, 'a written reason is required');
  const won = await ravi.client.request('POST', `/api/opportunities/${deal.id}/stage`, { stage: 'won', won_value: 475000, close_reason: 'PO received' });
  assert.equal(won.status, 200);
  assert.equal(won.body.probability, 100);
  assert.equal(won.body.won_value, 475000);
  assert.ok(won.body.closed_at);
  assert.equal((await ravi.client.request('PUT', `/api/opportunities/${deal.id}`, { title: 'x' })).status, 409, 'closed deals are read-only');

  const lostDeal = await openDeal(ravi.client);
  assert.equal((await ravi.client.request('POST', `/api/opportunities/${lostDeal.id}/stage`, { stage: 'lost' })).status, 400);
  assert.equal((await ravi.client.request('POST', `/api/opportunities/${lostDeal.id}/stage`, { stage: 'lost', lost_reason: 'other' })).status, 400, 'a written reason is required');
  const lost = await ravi.client.request('POST', `/api/opportunities/${lostDeal.id}/stage`, { stage: 'lost', lost_reason: 'competitor', close_reason: 'Went with KSB' });
  assert.equal(lost.body.stage, 'lost');

  const actions = (await query(`SELECT action FROM audit_log WHERE entity_type = 'opportunity' AND entity_id = ANY($1::int[]) ORDER BY id`, [[deal.id, lostDeal.id]])).map((r) => r.action);
  assert.ok(actions.includes('opportunity.won'));
  assert.ok(actions.includes('opportunity.lost'));
});

test('only a manager can reopen a closed deal; reopening clears the result', async () => {
  const deal = await openDeal(ravi.client);
  await ravi.client.request('POST', `/api/opportunities/${deal.id}/stage`, { stage: 'lost', lost_reason: 'timing', close_reason: 'Budget frozen' });
  assert.equal((await ravi.client.request('POST', `/api/opportunities/${deal.id}/stage`, { stage: 'qualify' })).status, 403);
  assert.equal((await manager.request('POST', `/api/opportunities/${deal.id}/stage`, { stage: 'won', won_value: 1, close_reason: 'x' })).status, 400, 'reopen to an open stage first');
  const reopened = await manager.request('POST', `/api/opportunities/${deal.id}/stage`, { stage: 'qualify', note: 'Budget approved after all' });
  assert.equal(reopened.status, 200);
  assert.equal(reopened.body.closed_at, null);
  assert.equal(reopened.body.lost_reason, null);
  assert.equal(reopened.body.close_reason, null);
  assert.equal(reopened.body.probability, 25);
  assert.equal((await query(`SELECT action FROM audit_log WHERE entity_id = $1 AND entity_type = 'opportunity' ORDER BY id DESC LIMIT 1`, [deal.id]))[0].action, 'opportunity.reopened');
});

test('history is append-only and the database enforces closed-deal rules', async () => {
  const deal = await openDeal(ravi.client);
  await assert.rejects(query(`UPDATE opportunity_history SET note = 'x' WHERE opportunity_id = $1`, [deal.id]), /append-only/);
  await assert.rejects(query(`UPDATE opportunity SET stage = 'won', closed_at = NOW(), probability = 100, close_reason = 'x' WHERE id = $1`, [deal.id]), /opportunity_won_has_value/);
  await assert.rejects(query(`UPDATE opportunity SET stage = 'lost', closed_at = NOW(), close_reason = 'x' WHERE id = $1`, [deal.id]), /opportunity_lost_has_reason/);
  await assert.rejects(query(`UPDATE opportunity SET stage = 'lost', lost_reason = 'price', closed_at = NOW() WHERE id = $1`, [deal.id]), /opportunity_closed_has_written_reason/);
  await assert.rejects(query(`UPDATE opportunity SET probability = 40 WHERE id = $1`, [deal.id]), /opportunity_open_probability/);
});

test('company page lists only the deals the user may see', async () => {
  const ravisView = await ravi.client.request('GET', `/api/companies/${companyId}`);
  assert.ok(ravisView.body.opportunities.length > 0);
  assert.ok(ravisView.body.opportunities.every((o) => o.owner_name === 'Ravi'));
  const managersView = await manager.request('GET', `/api/companies/${companyId}`);
  assert.ok(managersView.body.opportunities.some((o) => o.owner_name === 'Priya'));
});
