// Team views and handover, run against the demo data set so the numbers are realistic.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startTestServer, createClient } from './helpers/server.js';
import { PASSWORD, createSalesperson, createUser, login } from './helpers/fixtures.js';
import { query, testDatabaseUrl } from './helpers/testDb.js';

const run = promisify(execFile);
let server;
let admin;
let manager;
let office;
let ravi;
let raviId;
let priyaId;

before(async () => {
  server = await startTestServer();
  await createUser('admin', 'admin');
  // Ravi needs his login before the demo data so his records are created as him.
  raviId = await createSalesperson('Ravi Kumar');
  await query(`UPDATE salesperson SET employee_code = 'SE-001' WHERE id = $1`, [raviId]);
  await createUser('ravi', 'salesperson', { salespersonId: raviId });
  await run(process.execPath, ['server/scripts/seed-demo.js'], { env: { ...process.env, DATABASE_URL: testDatabaseUrl() } });
  [{ id: priyaId }] = await query(`SELECT id FROM salesperson WHERE name = 'Priya Sharma'`);
  await createUser('manager', 'sales_manager');
  await createUser('office', 'office_staff');
  for (const [name, set] of [['admin', (c) => (admin = c)], ['manager', (c) => (manager = c)], ['office', (c) => (office = c)], ['ravi', (c) => (ravi = c)]]) {
    const c = createClient(server.baseUrl);
    await login(c, name, PASSWORD);
    set(c);
  }
});

after(async () => {
  await server?.close();
});

test('the demo loader refuses to run twice and leaves consistent data', async () => {
  await assert.rejects(run(process.execPath, ['server/scripts/seed-demo.js'], { env: { ...process.env, DATABASE_URL: testDatabaseUrl() } }), /already loaded/);
  const [row] = await query(
    `SELECT (SELECT COUNT(*)::int FROM company) AS companies,
            (SELECT COUNT(*)::int FROM opportunity) AS deals,
            (SELECT COUNT(*)::int FROM opportunity o WHERE (SELECT h.to_value FROM opportunity_history h WHERE h.opportunity_id = o.id ORDER BY h.changed_at DESC, h.id DESC LIMIT 1) <> o.stage) AS mismatched,
            (SELECT COUNT(*)::int FROM visit WHERE visited_at > NOW()) AS future_visits,
            (SELECT COUNT(*)::int FROM opportunity WHERE stage = 'lost') AS lost,
            (SELECT COUNT(*)::int FROM opportunity WHERE code !~ '^TS-[A-Z][A-Z0-9]*-[0-9]{4,}$') AS bad_ids,
            (SELECT COUNT(*)::int FROM opportunity o WHERE EXISTS (SELECT 1 FROM opportunity_product op JOIN product p ON p.id = op.product_id
              WHERE op.opportunity_id = o.id AND NOT EXISTS (SELECT 1 FROM opportunity_oem oo WHERE oo.opportunity_id = o.id AND oo.oem_id = p.oem_id))) AS product_outside_oems,
            (SELECT COUNT(*)::int FROM opportunity WHERE stage NOT IN ('won', 'lost') AND expected_close_date < (NOW() AT TIME ZONE 'Asia/Kolkata')::date) AS overdue,
            (SELECT COUNT(*)::int FROM opportunity WHERE NOT EXISTS (SELECT 1 FROM opportunity_oem oo WHERE oo.opportunity_id = opportunity.id) OR expected_close_date IS NULL OR estimated_value IS NULL
              OR NOT EXISTS (SELECT 1 FROM opportunity_product op WHERE op.opportunity_id = opportunity.id)) AS incomplete,
            (SELECT COUNT(*)::int FROM opportunity o JOIN company c ON c.id = o.company_id WHERE c.approval_status <> 'approved') AS deals_on_unapproved,
            (SELECT COUNT(*)::int FROM company WHERE approval_status = 'pending') AS pending,
            (SELECT COUNT(*)::int FROM tender) AS tenders,
            (SELECT COUNT(*)::int FROM installed_instrument) AS instruments,
            (SELECT COUNT(*)::int FROM reorder_plan) AS reorders`
  );
  assert.ok(row.lost >= 1);
  assert.equal(row.bad_ids, 0, 'every opportunity has an ID like TS-R-0001');
  assert.equal(row.product_outside_oems, 0, 'products belong to the opportunity’s OEMs');
  assert.ok(row.overdue >= 1);
  assert.ok(row.pending >= 1);
  assert.ok(row.tenders >= 1);
  assert.ok(row.instruments >= 1);
  assert.ok(row.reorders >= 1);
  assert.equal(row.incomplete, 0, 'every demo deal has all its required fields');
  assert.equal(row.deals_on_unapproved, 0);
  assert.equal(row.companies, 50);
  assert.ok(row.deals >= 45);
  assert.equal(row.mismatched, 0, 'every deal’s last history row is its current stage');
  assert.equal(row.future_visits, 0);
});

test('team performance rows add up to the team total and match each person’s own dashboard', async () => {
  const { status, body } = await manager.request('GET', '/api/team/performance?days=90');
  assert.equal(status, 200);
  for (const key of ['visits', 'deals_won', 'won_value', 'deals_lost', 'quotations_sent', 'open_deals', 'pipeline_value', 'overdue_follow_ups']) {
    const sum = body.salespeople.reduce((s, p) => s + p.metrics[key], 0);
    assert.ok(Math.abs(sum - body.totals[key]) < 0.01, `${key}: rows ${sum} vs total ${body.totals[key]}`);
  }
  const raviRow = body.salespeople.find((p) => p.id === raviId);
  const own = (await ravi.request('GET', '/api/performance?days=90')).body;
  assert.deepEqual(raviRow.metrics, own);
  assert.equal((await office.request('GET', '/api/team/performance')).status, 200, 'office staff see the team');
});

test('salespeople cannot see team views or hand over work', async () => {
  assert.equal((await ravi.request('GET', '/api/team/performance')).status, 403);
  assert.equal((await ravi.request('GET', '/api/team/insights')).status, 403);
  assert.equal((await ravi.request('GET', `/api/handover/preview?from_salesperson_id=${raviId}`)).status, 403);
  assert.equal((await office.request('POST', '/api/handover', {})).status, 403, 'office staff cannot hand over either');
});

test('insights: six months of wins, category and city breakdowns, stale deals', async () => {
  const { body } = await admin.request('GET', '/api/team/insights?days=90');
  assert.equal(body.won_by_month.length, 6);
  const [{ won }] = await query(
    `SELECT COALESCE(SUM(won_value), 0)::float AS won FROM opportunity WHERE stage = 'won'
     AND closed_at >= (date_trunc('month', (NOW() AT TIME ZONE 'Asia/Kolkata')) - interval '5 months') AT TIME ZONE 'Asia/Kolkata'`
  );
  assert.equal(body.won_by_month.reduce((s, m) => s + m.won_value, 0), won);
  const team = (await admin.request('GET', '/api/team/performance?days=90')).body.totals;
  assert.equal(body.by_city.reduce((s, c) => s + c.open_deals, 0), team.open_deals);
  assert.equal(body.by_category.reduce((s, c) => s + c.pipeline_value, 0), team.pipeline_value);
  for (const d of body.stale_deals) assert.ok(d.idle_days >= body.stale_after_days - 1, `${d.title} idle ${d.idle_days}`);
});

test('handover moves open deals and follow-ups, keeps history and original owner, and is audited', async () => {
  const preview = (await manager.request('GET', `/api/handover/preview?from_salesperson_id=${priyaId}`)).body;
  assert.ok(preview.deals.length > 0, 'Priya has open deals in the demo data');
  const [before] = await query(
    `SELECT (SELECT COUNT(*)::int FROM opportunity WHERE owner_salesperson_id = $1 AND stage IN ('won', 'lost')) AS closed,
            (SELECT COUNT(*)::int FROM visit WHERE salesperson_id = $1) AS visits`,
    [priyaId]
  );

  assert.equal((await manager.request('POST', '/api/handover', { from_salesperson_id: priyaId, to_salesperson_id: raviId })).status, 400, 'reason required');
  assert.equal((await manager.request('POST', '/api/handover', { from_salesperson_id: priyaId, to_salesperson_id: priyaId, reason: 'x' })).status, 400);
  const inactive = await createSalesperson('Gone', { active: false });
  assert.equal((await manager.request('POST', '/api/handover', { from_salesperson_id: priyaId, to_salesperson_id: inactive, reason: 'x' })).status, 400);

  const res = await manager.request('POST', '/api/handover', { from_salesperson_id: priyaId, to_salesperson_id: raviId, reason: 'Priya moved to Chennai branch' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.deals_moved, preview.deals.length);

  const [afterRow] = await query(
    `SELECT (SELECT COUNT(*)::int FROM opportunity WHERE owner_salesperson_id = $1 AND stage NOT IN ('won', 'lost')) AS open,
            (SELECT COUNT(*)::int FROM task WHERE assignee_salesperson_id = $1 AND status = 'open') AS tasks,
            (SELECT COUNT(*)::int FROM opportunity WHERE owner_salesperson_id = $1 AND stage IN ('won', 'lost')) AS closed,
            (SELECT COUNT(*)::int FROM visit WHERE salesperson_id = $1) AS visits`,
    [priyaId]
  );
  assert.equal(afterRow.open, 0);
  assert.equal(afterRow.tasks, 0);
  assert.equal(afterRow.closed, before.closed, 'closed deals keep their owner');
  assert.equal(afterRow.visits, before.visits, 'visits stay attributed to Priya');

  const moved = preview.deals[0].id;
  const deal = (await ravi.request('GET', `/api/opportunities/${moved}`)).body;
  assert.equal(deal.owner_salesperson_id, raviId, 'the new owner can now see and work the deal');
  assert.equal(deal.original_owner_salesperson_id, priyaId, 'original owner never changes');
  assert.equal(deal.history[0].change_type, 'owner');
  assert.equal(deal.history[0].from_value, 'Priya Sharma');
  assert.equal(deal.history[0].note, 'Priya moved to Chennai branch');

  const [audit] = await query(`SELECT summary, after FROM audit_log WHERE action = 'handover.completed' ORDER BY id DESC LIMIT 1`);
  assert.match(audit.summary, /from Priya Sharma to Ravi Kumar/);
  assert.equal(audit.after.opportunity_ids.length, preview.deals.length);

  assert.equal((await manager.request('POST', '/api/handover', { from_salesperson_id: priyaId, to_salesperson_id: raviId, reason: 'again' })).status, 409, 'nothing left to move');
});

test('a single deal can be transferred by a manager only', async () => {
  const [{ id: dealId, owner_salesperson_id: ownerId }] = await query(
    `SELECT id, owner_salesperson_id FROM opportunity WHERE owner_salesperson_id = $1 AND stage NOT IN ('won', 'lost') LIMIT 1`,
    [raviId]
  );
  assert.equal((await ravi.request('POST', `/api/opportunities/${dealId}/owner`, { to_salesperson_id: priyaId, reason: 'x' })).status, 403);
  const res = await manager.request('POST', `/api/opportunities/${dealId}/owner`, { to_salesperson_id: priyaId, reason: 'Priya knows this customer' });
  assert.equal(res.status, 200);
  assert.equal(res.body.owner_salesperson_id, priyaId);
  assert.notEqual(res.body.owner_salesperson_id, ownerId);
  assert.equal((await ravi.request('GET', `/api/opportunities/${dealId}`)).body.error, 'Opportunity not found');
  const [{ action }] = await query(`SELECT action FROM audit_log WHERE entity_type = 'opportunity' AND entity_id = $1 ORDER BY id DESC LIMIT 1`, [dealId]);
  assert.equal(action, 'opportunity.transferred');
});

test('a salesperson with open work cannot be deactivated until it is handed over', async () => {
  const [{ id: arjunId }] = await query(`SELECT id FROM salesperson WHERE name = 'Arjun Rao'`);
  const blocked = await admin.request('POST', `/api/admin/salespeople/${arjunId}/deactivate`);
  const [{ open }] = await query(`SELECT COUNT(*)::int AS open FROM opportunity WHERE owner_salesperson_id = $1 AND stage NOT IN ('won', 'lost')`, [arjunId]);
  if (open > 0) {
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, /Hand them over first/);
  }
  await manager.request('POST', '/api/handover', { from_salesperson_id: arjunId, to_salesperson_id: raviId, reason: 'Arjun resigned' });
  assert.equal((await admin.request('POST', `/api/admin/salespeople/${arjunId}/deactivate`)).status, 200);

  const insights = (await admin.request('GET', '/api/team/insights')).body;
  assert.ok(!insights.orphaned.some((o) => o.salesperson_id === arjunId), 'nothing left orphaned after the handover');

  // Arjun is inactive now, but his past results still count — and still add up.
  const team = (await manager.request('GET', '/api/team/performance?days=90')).body;
  const arjunRow = team.salespeople.find((p) => p.id === arjunId);
  assert.ok(arjunRow, 'inactive salesperson with results in the period is still listed');
  assert.equal(arjunRow.is_active, false);
  const sum = team.salespeople.reduce((s, p) => s + p.metrics.visits, 0);
  assert.equal(sum, team.totals.visits);
});
