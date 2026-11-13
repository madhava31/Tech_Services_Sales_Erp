// Metric definitions, checked against hand-built data so every number is explainable.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, createClient } from './helpers/server.js';
import { createCompany, createUser, login, signedInSalesperson } from './helpers/fixtures.js';
import { query } from './helpers/testDb.js';

let server;
let ravi;
let priya;
let manager;
let today;

// A timestamp `days` ago at noon India time.
const ago = (days) => `((NOW() AT TIME ZONE 'Asia/Kolkata')::date - ${days} + time '12:00')::timestamp AT TIME ZONE 'Asia/Kolkata'`;

async function visit(salespersonId, companyId, daysAgo, userId) {
  await query(
    `INSERT INTO visit (company_id, salesperson_id, visited_at, status, outcome, completed_at, created_by)
     VALUES ($1, $2, ${ago(daysAgo)}, 'completed', 'interested', ${ago(daysAgo)}, $3)`,
    [companyId, salespersonId, userId]
  );
}

async function deal(ownerId, companyId, userId, { createdDaysAgo, stage = 'qualify', value = 100000, closedDaysAgo = null, won = null, lostReason = null, probability = 25 }) {
  const [{ id }] = await query(
    `INSERT INTO opportunity (company_id, title, owner_salesperson_id, original_owner_salesperson_id, stage, estimated_value, probability,
                              won_value, lost_reason, close_reason, closed_at, created_by, created_at)
     VALUES ($1, 'Deal', $2, $2, $3, $4, $5, $6, $7, ${closedDaysAgo === null ? 'NULL' : "'Closed'"}, ${closedDaysAgo === null ? 'NULL' : ago(closedDaysAgo)}, $8, ${ago(createdDaysAgo)})
     RETURNING id`,
    [companyId, ownerId, stage, value, probability, won, lostReason, userId]
  );
  return id;
}

before(async () => {
  server = await startTestServer();
  ravi = await signedInSalesperson(server.baseUrl, 'Ravi', createClient);
  priya = await signedInSalesperson(server.baseUrl, 'Priya', createClient);
  await createUser('manager', 'sales_manager');
  manager = createClient(server.baseUrl);
  await login(manager, 'manager');
  [{ today }] = await query(`SELECT ((NOW() AT TIME ZONE 'Asia/Kolkata')::date)::text AS today`);

  const a = await createCompany('Alpha', { createdBy: ravi.userId });
  const b = await createCompany('Beta', { createdBy: ravi.userId });
  const c = await createCompany('Gamma', { createdBy: ravi.userId });

  // Ravi: 3 visits in the last 30 days to 2 companies; Alpha was first visited by Priya long ago.
  await visit(priya.salespersonId, a, 200, priya.userId);
  await visit(ravi.salespersonId, a, 5, ravi.userId);
  await visit(ravi.salespersonId, b, 10, ravi.userId);
  await visit(ravi.salespersonId, b, 40, ravi.userId); // outside 30 days
  await visit(priya.salespersonId, c, 3, priya.userId);

  // Ravi's deals: one won (₹2,00,000 after 20 days), one lost, one open at Prove.
  await deal(ravi.salespersonId, a, ravi.userId, { createdDaysAgo: 25, stage: 'won', won: 200000, closedDaysAgo: 5, probability: 100 });
  await deal(ravi.salespersonId, b, ravi.userId, { createdDaysAgo: 20, stage: 'lost', lostReason: 'price', closedDaysAgo: 2, probability: 0 });
  const open = await deal(ravi.salespersonId, b, ravi.userId, { createdDaysAgo: 15, stage: 'prove', value: 300000, probability: 50 });
  await query(`INSERT INTO opportunity_history (opportunity_id, change_type, from_value, to_value, changed_by, changed_at)
               VALUES ($1, 'stage', 'qualify', 'develop', $2, ${ago(12)})`, [open, ravi.userId]);
  await query(`INSERT INTO quotation_link (opportunity_id, quotation_number, status, amount, quotation_date, created_by)
               VALUES ($1, 'Q1', 'sent', 300000, (NOW() AT TIME ZONE 'Asia/Kolkata')::date - 10, $2)`, [open, ravi.userId]);
  // Priya: one open deal.
  await deal(priya.salespersonId, c, priya.userId, { createdDaysAgo: 2, value: 50000, probability: 25 });
});

after(async () => {
  await server?.close();
});

test('a salesperson sees their own numbers for the default 30 days', async () => {
  const { status, body: m } = await ravi.client.request('GET', '/api/performance');
  assert.equal(status, 200);
  assert.equal(m.to, today);
  assert.equal(m.visits, 2);
  assert.equal(m.companies_visited, 2);
  assert.equal(m.new_prospects, 0, 'Beta was first visited 40 days ago; Alpha first by Priya');
  assert.equal(m.deals_opened, 3);
  assert.equal(m.quotation_requests, 1);
  assert.equal(m.quotations_sent, 1);
  assert.equal(m.deals_won, 1);
  assert.equal(m.won_value, 200000, 'won value, never the quotation total');
  assert.equal(m.deals_lost, 1);
  assert.equal(m.win_rate, 50);
  assert.equal(m.avg_days_to_win, 20);
  assert.deepEqual(m.lost_reasons, [{ reason: 'price', count: 1 }]);
  assert.equal(m.open_deals, 1);
  assert.equal(m.pipeline_value, 300000);
  assert.equal(m.weighted_pipeline, 150000);
});

test('ranges change the period but not the pipeline snapshot', async () => {
  const week = (await ravi.client.request('GET', '/api/performance?days=7')).body;
  assert.equal(week.visits, 1);
  assert.equal(week.deals_won, 1);
  assert.equal(week.deals_opened, 0);
  assert.equal(week.pipeline_value, 300000);
  const quarter = (await ravi.client.request('GET', '/api/performance?days=90')).body;
  assert.equal(quarter.visits, 3);
  assert.equal(quarter.new_prospects, 1, 'Beta’s first-ever visit (40 days ago) was Ravi’s');
});

test('managers see the team, or one salesperson; salespeople cannot look at others', async () => {
  const team = (await manager.request('GET', '/api/performance')).body;
  assert.equal(team.visits, 3);
  assert.equal(team.new_prospects, 1, 'Gamma, first visited by Priya 3 days ago');
  assert.equal(team.open_deals, 2);
  assert.equal(team.pipeline_value, 350000);
  const priyaOnly = (await manager.request('GET', `/api/performance?salesperson_id=${priya.salespersonId}`)).body;
  assert.equal(priyaOnly.visits, 1);
  const snoop = (await ravi.client.request('GET', `/api/performance?salesperson_id=${priya.salespersonId}`)).body;
  assert.equal(snoop.visits, 0);
  assert.equal(snoop.open_deals, 0);
});

test('custom ranges are validated', async () => {
  assert.equal((await ravi.client.request('GET', '/api/performance?from=2026-10-10')).status, 400);
  assert.equal((await ravi.client.request('GET', '/api/performance?from=2026-10-10&to=2026-10-01')).status, 400);
  assert.equal((await ravi.client.request('GET', `/api/performance?from=${today}&to=${today}`)).status, 200);
});
