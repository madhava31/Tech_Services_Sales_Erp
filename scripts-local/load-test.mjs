// Local load test: many salespeople using the app at once, against the local *_test database only
// (the test helpers refuse any other database). Not part of npm test. Run: node scripts-local/load-test.mjs
import { startTestServer, createClient } from '../test/helpers/server.js';
import { createUser, createSalesperson, createCompany, dealFieldsFor, login } from '../test/helpers/fixtures.js';

const SALESPEOPLE = 12;
const server = await startTestServer();
const db = (await import('../api/db/index.js')).default;

// Watch the connection pool: how many connections open, and how many requests queued waiting for one.
const poolPeak = { total: 0, waiting: 0 };
const sampler = setInterval(() => {
  poolPeak.total = Math.max(poolPeak.total, db.pool.totalCount);
  poolPeak.waiting = Math.max(poolPeak.waiting, db.pool.waitingCount);
}, 5);

const stats = new Map();
async function timed(label, fn) {
  const t = performance.now();
  let ok = false, status = 0;
  try {
    const res = await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 30s')), 30000))]);
    status = res.status;
    ok = res.status < 400;
  } catch (e) {
    status = e.message;
  }
  const ms = performance.now() - t;
  const s = stats.get(label) ?? { n: 0, fail: 0, times: [], errors: {} };
  s.n++; s.times.push(ms);
  if (!ok) { s.fail++; s.errors[status] = (s.errors[status] ?? 0) + 1; }
  stats.set(label, s);
}
const pct = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return Math.round(a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))]); };
function report(title) {
  console.log(`\n== ${title} ==`);
  for (const [label, s] of stats) {
    console.log(`${label.padEnd(34)} ${String(s.n).padStart(5)} req  fail ${String(s.fail).padStart(3)}  p50 ${String(pct(s.times, 50)).padStart(5)}ms  p95 ${String(pct(s.times, 95)).padStart(5)}ms  max ${String(Math.round(Math.max(...s.times))).padStart(5)}ms${s.fail ? '  ' + JSON.stringify(s.errors) : ''}`);
  }
  console.log(`pool peak: ${poolPeak.total} connections open, ${poolPeak.waiting} requests waiting for one`);
  stats.clear(); poolPeak.total = 0; poolPeak.waiting = 0;
}

// --- Set up: a manager, an admin, 12 salespeople, 150 approved companies, products.
const people = [];
for (let i = 1; i <= SALESPEOPLE; i++) {
  const spId = await createSalesperson(`Seller ${i}`);
  const userId = await createUser(`seller${i}`, 'salesperson', { salespersonId: spId });
  people.push({ name: `seller${i}`, spId, userId, client: createClient(server.baseUrl) });
}
await createUser('boss', 'sales_manager');
const boss = createClient(server.baseUrl);
const companies = [];
for (let i = 1; i <= 150; i++) companies.push(await createCompany(`Load Labs ${i}`, { city: 'Hyderabad', createdBy: people[i % SALESPEOPLE].userId }));
const fields = [];
for (let i = 1; i <= 20; i++) fields.push(await dealFieldsFor(`LT-${i}`));

// --- 1. Everyone signs in at the same moment (start of the day, all from one office address).
await Promise.all([...people.map((p) => timed('sign in (all at once)', async () => { await login(p.client, p.name); return { status: 200 }; })), timed('sign in (all at once)', async () => { await login(boss, 'boss'); return { status: 200 }; })]);
report('1. 13 people sign in at the same moment');

// --- 2. Everyone saves at once: each salesperson adds 5 companies and 10 opportunities, all in parallel.
await Promise.all(people.flatMap((p, pi) => [
  ...Array.from({ length: 5 }, (_, k) => timed('create company', () => p.client.request('POST', '/api/companies', { name: `New Lab ${pi}-${k}`, city: 'Pune', confirm_new: true, contact_person: `Dr. ${pi}${k}` }))),
  ...Array.from({ length: 10 }, (_, k) => timed('create opportunity', () => p.client.request('POST', '/api/opportunities', { company_id: companies[(pi * 10 + k) % companies.length], title: `Spectrometer ${pi}-${k}`, ...fields[(pi + k) % fields.length] }))),
]));
report('2. 12 salespeople save 180 records at the same time');

// --- 3. A normal busy morning: each person opens the main screens 15 times, all in parallel.
const screens = [
  ['today', '/api/today'],
  ['opportunities list', '/api/opportunities?status=open'],
  ['companies list', '/api/companies'],
  ['tasks', '/api/tasks'],
  ['notifications', '/api/notifications'],
  ['performance', '/api/performance'],
  ['analysis forecast', '/api/analysis/forecast'],
  ['analysis funnel', '/api/analysis/funnel'],
  ['offline bootstrap (phone sync)', '/api/offline/bootstrap'],
];
const everyone = [...people.map((p) => p.client), boss];
await Promise.all(everyone.map(async (c) => {
  for (let round = 0; round < 15; round++) await Promise.all(screens.map(([label, path]) => timed(label, () => c.request('GET', path))));
}));
await Promise.all(Array.from({ length: 15 }, () => Promise.all([timed('team insights (manager)', () => boss.request('GET', '/api/team/insights')), timed('team performance (manager)', () => boss.request('GET', '/api/team/performance'))])));
report('3. busy morning: 13 people x 15 rounds of every main screen');

// --- 4. Spike: 400 requests fired in the same instant (far more than 12 people would ever send).
await Promise.all(Array.from({ length: 400 }, (_, i) => { const [label, path] = screens[i % screens.length]; return timed(`spike ${label}`, () => everyone[i % everyone.length].request('GET', path)); }));
report('4. spike: 400 requests at the same instant');

// --- 5. Two people edit the same opportunity at the same moment.
const target = (await people[0].client.request('GET', '/api/opportunities?status=open')).body[0];
await Promise.all(Array.from({ length: 10 }, (_, i) => timed('same record edited 10x at once', () => people[0].client.request('PUT', `/api/opportunities/${target.id}`, { title: `Edited ${i}` }))));
report('5. same opportunity saved 10 times at once');

// --- Data check: nothing lost or doubled.
const counts = (await db.pool.query(`SELECT (SELECT COUNT(*) FROM company WHERE name LIKE 'New Lab %') AS companies, (SELECT COUNT(*) FROM opportunity WHERE title LIKE 'Spectrometer %') AS opportunities, (SELECT COUNT(*) FROM opportunity_history) AS history_rows`).catch((e) => ({ rows: [{ error: e.message }] }))).rows[0];
console.log('\n== data check ==', counts, '(expected 60 companies, 120 opportunities)');

clearInterval(sampler);
await server.close();
