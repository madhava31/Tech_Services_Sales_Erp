// Stuck deals, the sales funnel and the monthly forecast, checked against hand-built data.
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
let today;
let runDailyReminders;

const ago = (days) => `(NOW() - make_interval(days => ${days}))`;

// A deal with a backdated path, written directly because history can't be edited afterwards.
// path: [[stage, daysAgo], ...], oldest first; the last entry is its stage now.
async function deal(owner, { path, value = 100000, probability = 25, close = null, title = 'Deal' }) {
  const stage = path[path.length - 1][0];
  const closed = ['won', 'lost', 'abandoned'].includes(stage);
  const [{ id }] = await query(
    `INSERT INTO opportunity (company_id, title, owner_salesperson_id, original_owner_salesperson_id, stage, estimated_value, probability, expected_close_date,
                              won_value, lost_reason, close_reason, closed_at, created_by, created_at)
     VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10, ${closed ? ago(path[path.length - 1][1]) : 'NULL'}, $11, ${ago(path[0][1])}) RETURNING id`,
    [companyId, title, owner.salespersonId, stage, value, stage === 'won' ? 100 : closed ? 0 : probability, close, stage === 'won' ? value : null, stage === 'lost' ? 'price' : null, closed ? 'Closed' : null, owner.userId]
  );
  for (const [i, [to, days]] of path.entries()) {
    await query(
      `INSERT INTO opportunity_history (opportunity_id, change_type, from_value, to_value, changed_by, changed_at) VALUES ($1, $2, $3, $4, $5, ${ago(days)})`,
      [id, i === 0 ? 'created' : 'stage', i === 0 ? null : path[i - 1][0], to, owner.userId]
    );
  }
  return id;
}

// Date `n` days from today, and the month `n` months from this one, in India time.
const fromToday = (n) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const monthsAhead = (n) => {
  const d = new Date(`${today.slice(0, 7)}-15T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};

before(async () => {
  server = await startTestServer();
  ({ runDailyReminders } = await import('../api/crm/reminders.js'));
  ravi = await signedInSalesperson(server.baseUrl, 'Ravi', createClient);
  priya = await signedInSalesperson(server.baseUrl, 'Priya', createClient);
  for (const [name, role] of [['manager', 'sales_manager'], ['office', 'office_staff'], ['admin', 'admin']]) await createUser(name, role);
  manager = createClient(server.baseUrl);
  await login(manager, 'manager');
  office = createClient(server.baseUrl);
  await login(office, 'office');
  admin = createClient(server.baseUrl);
  await login(admin, 'admin');
  companyId = await createCompany('Analysis Labs', { createdBy: ravi.userId });
  [{ today }] = await query(`SELECT ((NOW() AT TIME ZONE 'Asia/Kolkata')::date)::text AS today`);
});

after(async () => {
  await server?.close();
});

test('stuck: past the limit for its current stage; a stage change restarts the clock, an edit does not', async () => {
  // Quote requested allows 7 days by default; negotiation allows 30.
  const stuck = await deal(priya, { path: [['new_prospect', 40], ['quotation_requested', 10]], title: 'Stuck deal' });
  const fine = await deal(priya, { path: [['new_prospect', 40], ['negotiation', 10]], title: 'Within limit' });
  const closed = await deal(priya, { path: [['new_prospect', 90], ['lost', 60]], title: 'Closed long ago' });

  const get = async (id) => (await priya.client.request('GET', `/api/opportunities/${id}`)).body;
  const s = await get(stuck);
  assert.equal(s.is_stuck, true);
  assert.equal(s.days_in_stage, 10);
  assert.equal(s.stuck_after_days, 7);
  assert.equal((await get(fine)).is_stuck, false);
  assert.equal((await get(closed)).is_stuck, false);

  const stuckList = (await priya.client.request('GET', '/api/opportunities?stuck=1')).body;
  assert.deepEqual(stuckList.map((d) => d.id), [stuck], 'the filter');

  const today_ = (await priya.client.request('GET', '/api/today')).body;
  assert.deepEqual(today_.stuck_deals.map((d) => d.id), [stuck], 'listed on Today');
  assert.equal((await ravi.client.request('GET', '/api/today')).body.stuck_deals.length, 0, 'only for its owner');

  const team = (await manager.request('GET', '/api/team/performance')).body;
  assert.equal(team.salespeople.find((p) => p.id === priya.salespersonId).metrics.stuck_deals, 1, 'counted per salesperson');
  assert.equal((await priya.client.request('GET', '/api/performance')).body.stuck_deals, 1);

  // Filling in a missing field isn't progress.
  await query(`UPDATE opportunity SET notes = 'edited', updated_at = NOW() WHERE id = $1`, [stuck]);
  assert.equal((await get(stuck)).is_stuck, true);
  // A stage change is.
  await query(`INSERT INTO quotation_link (opportunity_id, quotation_number, created_by) VALUES ($1, 'Q', $2)`, [stuck, priya.userId]);
  const moved = await priya.client.request('POST', `/api/opportunities/${stuck}/stage`, { stage: 'negotiation' });
  assert.equal(moved.body.is_stuck, false);
  assert.equal(moved.body.days_in_stage, 0);
});

test('the morning reminder mentions stuck deals, to the owner and to managers', async () => {
  await query(`DELETE FROM notification`);
  await deal(priya, { path: [['qualified', 100]], title: 'Very stuck' });
  await runDailyReminders({ send: async () => undefined });
  const mine = (await priya.client.request('GET', '/api/notifications')).body;
  assert.match(mine.items[0].body, /1 opportunity stuck/);
  const team = (await manager.request('GET', '/api/notifications')).body;
  assert.match(team.items[0].body, /1 opportunity stuck/);
});

test('stuck limits: everyone can read them, only MD/Admin change them, and it is audited', async () => {
  const settings = (await ravi.client.request('GET', '/api/analysis/stage-settings')).body;
  assert.deepEqual(settings.map((s) => s.stage), ['new_prospect', 'visit_completed', 'qualified', 'quotation_requested', 'quotation_sent', 'negotiation']);
  for (const client of [ravi.client, manager, office]) {
    assert.equal((await client.request('PUT', '/api/analysis/stage-settings/negotiation', { stuck_after_days: 5 })).status, 403);
  }
  assert.equal((await admin.request('PUT', '/api/analysis/stage-settings/negotiation', { stuck_after_days: 0 })).status, 400);
  assert.equal((await admin.request('PUT', '/api/analysis/stage-settings/won', { stuck_after_days: 5 })).status, 404);

  const fine = await deal(ravi, { path: [['negotiation', 10]], title: 'Limit test' });
  assert.equal((await ravi.client.request('GET', `/api/opportunities/${fine}`)).body.is_stuck, false);
  assert.equal((await admin.request('PUT', '/api/analysis/stage-settings/negotiation', { stuck_after_days: 5 })).status, 200);
  assert.equal((await ravi.client.request('GET', `/api/opportunities/${fine}`)).body.is_stuck, true, 'takes effect at once');
  const [audit] = await query(`SELECT summary FROM audit_log WHERE action = 'stage_setting.updated' ORDER BY id DESC LIMIT 1`);
  assert.match(audit.summary, /after 5 days \(was 30\)/);
  await admin.request('PUT', '/api/analysis/stage-settings/negotiation', { stuck_after_days: 30 });
  await query(`UPDATE opportunity SET owner_salesperson_id = $1, original_owner_salesperson_id = $1 WHERE id = $2`, [priya.salespersonId, fine]);
});

test('the funnel: how far deals opened in the period got, by stage', async () => {
  const rep = await signedInSalesperson(server.baseUrl, 'Funnel', createClient);
  await deal(rep, { path: [['new_prospect', 40], ['qualified', 30], ['quotation_sent', 20], ['won', 10]], value: 500000 });
  await deal(rep, { path: [['qualified', 40], ['lost', 20]], value: 200000 });
  await deal(rep, { path: [['new_prospect', 30], ['negotiation', 10]], value: 300000 });
  await deal(rep, { path: [['new_prospect', 5]], value: 100000 });
  await deal(rep, { path: [['new_prospect', 200]], value: 999999, title: 'Outside 90 days' });

  const { body } = await rep.client.request('GET', '/api/analysis/funnel?days=90');
  assert.equal(body.total, 4);
  const row = (stage) => body.stages.find((s) => s.stage === stage);
  assert.deepEqual(body.stages.map((s) => s.reached), [4, 3, 3, 2, 2, 2, 1], 'a skipped stage still counts as passed');
  assert.equal(row('new_prospect').reached_value, 1100000);
  assert.equal(row('won').reached_value, 500000);
  assert.equal(row('new_prospect').to_next_pct, 75);
  assert.equal(row('quotation_requested').to_next_pct, 100);
  assert.equal(row('negotiation').to_next_pct, 50);
  assert.equal(row('won').to_next_pct, null);
  assert.equal(row('qualified').dropped, 1, 'lost after reaching Qualified');
  assert.equal(body.lost_or_abandoned, 1);
  assert.equal(row('negotiation').open_now, 1);
  assert.equal(row('new_prospect').open_now, 1);
  // The won deal spent 10 days in Quote sent; nobody else stopped there.
  assert.equal(row('quotation_sent').avg_days, 10);

  // The snapshot isn't limited to the period.
  assert.equal(body.open_by_stage.find((s) => s.stage === 'new_prospect').value, 1099999);

  const longer = (await rep.client.request('GET', '/api/analysis/funnel?days=365')).body;
  assert.equal(longer.total, 5);
});

test('funnel and forecast: a salesperson sees only their own; managers can narrow to one person', async () => {
  const mine = (await ravi.client.request('GET', '/api/analysis/funnel')).body;
  const snoop = (await ravi.client.request('GET', `/api/analysis/funnel?salesperson_id=${priya.salespersonId}`)).body;
  assert.equal(snoop.total, 0, 'asking for someone else finds nothing');
  assert.ok((await manager.request('GET', '/api/analysis/funnel')).body.total > mine.total);
  const one = (await office.request('GET', `/api/analysis/funnel?salesperson_id=${priya.salespersonId}`)).body;
  assert.ok(one.total > 0);
  assert.equal((await manager.request('GET', '/api/analysis/funnel?salesperson_id=abc')).status, 400);
  const forecast = (await ravi.client.request('GET', `/api/analysis/forecast?salesperson_id=${priya.salespersonId}`)).body;
  assert.equal(forecast.months.reduce((s, m) => s + m.count, 0), 0);
  assert.deepEqual(forecast.by_salesperson, []);
});

test('the forecast: by closing month and confidence, with overdue deals kept apart', async () => {
  const rep = await signedInSalesperson(server.baseUrl, 'Forecast', createClient);
  const open = (value, probability, close, title = 'F') => deal(rep, { path: [['qualified', 2]], value, probability, close, title });
  await open(1000000, 100, monthsAhead(1), 'Commit 100');
  await open(800000, 75, monthsAhead(1), 'Commit 75');
  await open(400000, 50, monthsAhead(1), 'Best');
  await open(200000, 25, monthsAhead(1), 'Pipeline');
  await open(300000, 50, monthsAhead(5), 'Last month shown');
  await open(900000, 75, monthsAhead(6), 'Later');
  await open(600000, 50, fromToday(-3), 'Overdue');
  await open(50000, 25, null, 'No date');
  await open(70000, 25, fromToday(0), 'Due today');
  await deal(rep, { path: [['new_prospect', 30], ['won', 0]], value: 1500000, title: 'Won this month' });
  await deal(rep, { path: [['new_prospect', 30], ['lost', 1]], value: 7777777, close: monthsAhead(1), title: 'Lost, never forecast' });

  const { body } = await rep.client.request('GET', '/api/analysis/forecast');
  assert.equal(body.months.length, 6);
  assert.equal(body.months[0].month, today.slice(0, 7));
  const next = body.months[1];
  assert.equal(next.commit, 1800000);
  assert.equal(next.best_case, 400000);
  assert.equal(next.pipeline, 200000);
  assert.equal(next.total, 2400000);
  assert.equal(next.count, 4);
  assert.equal(next.weighted, 1000000 + 600000 + 200000 + 50000);
  assert.deepEqual(next.deals.map((d) => d.title).sort(), ['Best', 'Commit 100', 'Commit 75', 'Pipeline']);
  assert.equal(body.months[5].best_case, 300000);

  assert.equal(body.later.commit, 900000);
  assert.equal(body.overdue.best_case, 600000);
  assert.equal(body.overdue.deals[0].title, 'Overdue');
  assert.equal(body.no_date.count, 1);
  assert.equal(body.months[0].pipeline, 70000, 'due today isn’t overdue');
  assert.equal(body.months[0].won_value, 1500000);
  assert.equal(body.months[0].won_deals, 1);

  // Every open deal lands in exactly one place, so this adds up to the pipeline.
  const sum = (key) => [...body.months, body.overdue, body.later, body.no_date].reduce((s, b) => s + b[key], 0);
  const metrics = (await rep.client.request('GET', '/api/performance')).body;
  assert.equal(sum('total'), metrics.pipeline_value);
  assert.equal(sum('count'), metrics.open_deals);

  const team = (await manager.request('GET', '/api/analysis/forecast')).body;
  const row = team.by_salesperson.find((p) => p.salesperson_id === rep.salespersonId);
  assert.equal(row.commit, 1800000, 'the next three months');
  assert.equal(row.total, 2400000 + 70000);
  assert.equal(row.deals, undefined);
});

test('a brand-new deal from the app starts with a clear clock', async () => {
  const fields = await dealFieldsFor('AN-1');
  const { body } = await ravi.client.request('POST', '/api/opportunities', { company_id: companyId, title: 'Fresh', ...fields });
  assert.equal(body.days_in_stage, 0);
  assert.equal(body.is_stuck, false);
});
