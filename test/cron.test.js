// Scheduled jobs for Vercel (no always-on server), the health page, and what a crash shows.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, createClient } from './helpers/server.js';
import { signedInSalesperson } from './helpers/fixtures.js';
import { query } from './helpers/testDb.js';

let server;
let anon;
let ravi;

before(async () => {
  server = await startTestServer();
  anon = createClient(server.baseUrl);
  ravi = await signedInSalesperson(server.baseUrl, 'Ravi', createClient);
});

after(async () => {
  delete process.env.CRON_SECRET;
  await server?.close();
});

const withSecret = (secret) => ({ Authorization: `Bearer ${secret}` });

test('cron endpoints refuse everyone unless the secret matches', async () => {
  delete process.env.CRON_SECRET;
  const unset = await anon.request('GET', '/api/cron/reminders', undefined, withSecret('anything'));
  assert.equal(unset.status, 503, 'with no secret set, nothing runs');

  process.env.CRON_SECRET = 'right-secret-value';
  assert.equal((await anon.request('GET', '/api/cron/reminders')).status, 401, 'no header');
  assert.equal((await anon.request('GET', '/api/cron/reminders', undefined, withSecret('wrong'))).status, 401);
  assert.equal((await anon.request('GET', '/api/cron/erp-sync', undefined, withSecret('right-secret-value-and-more'))).status, 401);
  assert.equal((await ravi.client.request('GET', '/api/cron/reminders')).status, 401, 'a signed-in salesperson cannot start it');
});

test('the reminders job runs with the secret, once a day, and skips Sundays', async () => {
  process.env.CRON_SECRET = 'right-secret-value';
  const run = () => anon.request('GET', '/api/cron/reminders', undefined, withSecret('right-secret-value'));
  const first = await run();
  assert.equal(first.status, 200, JSON.stringify(first.body));
  // Sunday: the job itself skips, whatever time it is called.
  const { runReminderJob } = await import('../server/crm/reminders.js');
  assert.deepEqual(await runReminderJob({ now: new Date('2026-11-15T05:00:00Z') }), { skipped: true });
  // Running it again the same day creates no second digest.
  const before = (await query(`SELECT COUNT(*)::int AS n FROM notification WHERE kind = 'daily_digest'`))[0].n;
  assert.equal((await run()).status, 200);
  assert.equal((await query(`SELECT COUNT(*)::int AS n FROM notification WHERE kind = 'daily_digest'`))[0].n, before);
});

test('the ERP sync job does nothing, quietly, until the ERP connection is set up', async () => {
  process.env.CRON_SECRET = 'right-secret-value';
  const res = await anon.request('GET', '/api/cron/erp-sync', undefined, withSecret('right-secret-value'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { skipped: true });
});

test('the health page says whether the database answers, and nothing about why it does not', async () => {
  const ok = await anon.request('GET', '/api/health');
  assert.deepEqual(ok.body, { ok: true, database: true });
  const db = (await import('../server/db/index.js')).default;
  const original = db.prepare;
  db.prepare = () => ({ get: async () => { throw new Error('password authentication failed for user "postgres" at db.secret.example'); } });
  try {
    const down = await anon.request('GET', '/api/health');
    assert.deepEqual(down.body, { ok: true, database: false });
    assert.doesNotMatch(JSON.stringify(down.body), /password|secret|postgres/);
  } finally {
    db.prepare = original;
  }
});

test('the Vercel entry points answer a crash with a plain message, never the stack or the settings', async () => {
  const fs = await import('node:fs');
  for (const file of ['api/index.js', 'server/[...slug].js']) {
    const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf-8');
    assert.match(source, /Something went wrong. Please try again./, file);
    assert.doesNotMatch(source, /err\.stack|err\.message,|env_keys|Object\.keys\(process\.env/, `${file} must not send the stack or the settings to the browser`);
  }
});
