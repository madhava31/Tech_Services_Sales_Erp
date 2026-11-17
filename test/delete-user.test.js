// Removing a deactivated login: previews safely, refuses without confirmation, and only deletes one that
// has no history behind it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { startTestServer, createClient } from './helpers/server.js';
import { createCompany, signedInSalesperson } from './helpers/fixtures.js';
import { query, testDatabaseUrl } from './helpers/testDb.js';

let server;
let idle;
let busy;

const run = (...args) => spawnSync(process.execPath, ['server/scripts/delete-user.js', ...args], { env: { ...process.env, DATABASE_URL: testDatabaseUrl() }, encoding: 'utf-8' });
const nameOf = async (userId) => (await query(`SELECT username FROM app_user WHERE id = $1`, [userId]))[0].username;
const exists = async (userId) => (await query(`SELECT COUNT(*)::int AS n FROM app_user WHERE id = $1`, [userId]))[0].n === 1;

before(async () => {
  server = await startTestServer();
  idle = await signedInSalesperson(server.baseUrl, 'Idle', createClient);
  busy = await signedInSalesperson(server.baseUrl, 'Busy', createClient);
  await createCompany('Busy Labs', { createdBy: busy.userId });
});

after(async () => {
  await server?.close();
});

test('it refuses without a flag, and for an active login', async () => {
  const name = await nameOf(idle.userId);
  assert.notEqual(run(`--username=${name}`).status, 0, 'needs --dry-run or --confirm');
  const active = run(`--username=${name}`, '--dry-run');
  assert.notEqual(active.status, 0);
  assert.match(active.stderr, /still active/);
});

test('a deactivated login with no history: the preview changes nothing, then confirming removes it and its salesperson', async () => {
  const name = await nameOf(idle.userId);
  await query(`UPDATE app_user SET is_active = FALSE, deactivated_at = NOW() WHERE id = $1`, [idle.userId]);
  const preview = run(`--username=${name}`, '--with-salesperson', '--dry-run');
  assert.equal(preview.status, 0, preview.stderr + preview.stdout);
  assert.match(preview.stdout, /Would delete/);
  assert.ok(await exists(idle.userId), 'a dry run changes nothing');

  const done = run(`--username=${name}`, '--with-salesperson', '--confirm=DELETE');
  assert.equal(done.status, 0, done.stderr + done.stdout);
  assert.equal(await exists(idle.userId), false);
  assert.equal((await query(`SELECT COUNT(*)::int AS n FROM salesperson WHERE id = $1`, [idle.salespersonId]))[0].n, 0);
});

test('a login that created things is part of the history: nothing is deleted and the script says what holds it', async () => {
  const name = await nameOf(busy.userId);
  await query(`UPDATE app_user SET is_active = FALSE, deactivated_at = NOW() WHERE id = $1`, [busy.userId]);
  const res = run(`--username=${name}`, '--confirm=DELETE');
  assert.equal(res.status, 2, res.stderr + res.stdout);
  assert.match(res.stdout, /Cannot be deleted/);
  assert.match(res.stdout, /company\.created_by/);
  assert.ok(await exists(busy.userId));
});
