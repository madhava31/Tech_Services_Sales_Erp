// Salespeople sign in every day: the session ends at 11:50 pm India time, and a login quiet for 72 hours is
// reminded once, flagged to the admin, and cleared by signing in again.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, createClient } from './helpers/server.js';
import { createUser, login, signedInSalesperson } from './helpers/fixtures.js';
import { query } from './helpers/testDb.js';
import { nextCutoff } from '../server/auth/dailySession.js';
import { runInactivityCheck } from '../server/crm/inactivity.js';

let server;
let admin;

before(async () => {
  server = await startTestServer();
  await createUser('boss', 'admin');
  admin = createClient(server.baseUrl);
  await login(admin, 'boss');
});

after(async () => {
  await server?.close();
});

test('the cutoff is the next 11:50 pm India time', () => {
  // 11:00 am IST on 20 Nov 2026 = 05:30 UTC: ends 11:50 pm the same day (18:20 UTC).
  assert.equal(nextCutoff(new Date('2026-11-20T05:30:00Z')).toISOString(), '2026-11-20T18:20:00.000Z');
  // 11:49 pm IST: one minute left. 11:50 pm exactly, or 11:51 pm: the next day's.
  assert.equal(nextCutoff(new Date('2026-11-20T18:19:00Z')).toISOString(), '2026-11-20T18:20:00.000Z');
  assert.equal(nextCutoff(new Date('2026-11-20T18:20:00Z')).toISOString(), '2026-11-21T18:20:00.000Z');
  assert.equal(nextCutoff(new Date('2026-11-20T18:21:00Z')).toISOString(), '2026-11-21T18:20:00.000Z');
  // 12:30 am IST on the 21st (19:00 UTC on the 20th): that evening.
  assert.equal(nextCutoff(new Date('2026-11-20T19:00:00Z')).toISOString(), '2026-11-21T18:20:00.000Z');
});

test('a salesperson’s session ends at 11:50 pm, an admin’s lasts; an ended session means signing in again', async () => {
  const rep = await signedInSalesperson(server.baseUrl, 'Daily', createClient);
  const [mine] = await query(`SELECT expires_at FROM session WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [rep.userId]);
  const ends = new Date(mine.expires_at).getTime();
  assert.ok(ends > Date.now() && ends <= Date.now() + 24 * 3600 * 1000 + 60000, 'within a day');
  assert.equal(ends, nextCutoff(new Date(ends - 1)).getTime(), 'exactly at an 11:50 pm India time');

  const [boss] = await query(`SELECT expires_at FROM session s JOIN app_user u ON u.id = s.user_id WHERE u.username = 'boss' ORDER BY s.created_at DESC LIMIT 1`);
  assert.ok(new Date(boss.expires_at).getTime() > Date.now() + 25 * 24 * 3600 * 1000, 'an admin keeps the long session');

  // The day passes: the session is gone, and signing in again works at once.
  await query(`UPDATE session SET expires_at = NOW() - INTERVAL '1 minute' WHERE user_id = $1`, [rep.userId]);
  assert.equal((await rep.client.request('GET', '/api/auth/me')).status, 401);
  const name = (await query(`SELECT username FROM app_user WHERE id = $1`, [rep.userId]))[0].username;
  await login(rep.client, name);
  assert.equal((await rep.client.request('GET', '/api/auth/me')).status, 200);
});

test('signing in records it; 72 hours quiet gets one reminder, an audit row and a place on the admin list; signing in clears it', async () => {
  const rep = await signedInSalesperson(server.baseUrl, 'Quiet', createClient);
  const name = (await query(`SELECT username FROM app_user WHERE id = $1`, [rep.userId]))[0].username;
  const [signedIn] = await query(`SELECT last_login_at FROM app_user WHERE id = $1`, [rep.userId]);
  assert.ok(signedIn.last_login_at, 'the sign-in is recorded');

  await query(`UPDATE app_user SET last_login_at = NOW() - INTERVAL '71 hours' WHERE id = $1`, [rep.userId]);
  assert.equal((await runInactivityCheck()).reminded, 0, '71 hours is not yet');

  await query(`UPDATE app_user SET last_login_at = NOW() - INTERVAL '4 days' WHERE id = $1`, [rep.userId]);
  assert.equal((await runInactivityCheck()).reminded, 1);
  assert.equal((await runInactivityCheck()).reminded, 0, 'once per quiet spell');
  const told = await query(`SELECT title, body FROM notification WHERE user_id = $1 AND kind = 'inactive_reminder'`, [rep.userId]);
  assert.equal(told.length, 1);
  assert.match(told[0].title, /4 days/);
  const audit = await query(`SELECT summary, actor_user_id FROM audit_log WHERE action = 'user.inactive_reminder' AND entity_id = $1`, [rep.userId]);
  assert.equal(audit.length, 1);
  assert.match(audit[0].summary, /Quiet has not signed in for 4 days/);

  const listed = (await admin.request('GET', '/api/admin/users')).body.find((u) => u.id === rep.userId);
  assert.ok(listed.hours_since_login >= 95 && listed.hours_since_login < 97, `hours ${listed.hours_since_login}`);
  assert.ok(listed.last_login_at);

  await login(rep.client, name);
  const [back] = await query(`SELECT inactive_alerted_at FROM app_user WHERE id = $1`, [rep.userId]);
  assert.equal(back.inactive_alerted_at, null, 'signing in clears it');
  await query(`UPDATE app_user SET last_login_at = NOW() - INTERVAL '5 days' WHERE id = $1`, [rep.userId]);
  assert.equal((await runInactivityCheck()).reminded, 1, 'a new quiet spell is reminded again');
});

test('only active salespeople are reminded; a login never used counts from when it was made', async () => {
  const gone = await signedInSalesperson(server.baseUrl, 'Gone', createClient);
  await query(`UPDATE app_user SET is_active = FALSE, deactivated_at = NOW(), last_login_at = NOW() - INTERVAL '9 days' WHERE id = $1`, [gone.userId]);
  await createUser('mgr9', 'sales_manager');
  await query(`UPDATE app_user SET last_login_at = NOW() - INTERVAL '9 days' WHERE username IN ('mgr9', 'boss')`);
  const fresh = await signedInSalesperson(server.baseUrl, 'Never', createClient);
  await query(`UPDATE app_user SET last_login_at = NULL, created_at = NOW() - INTERVAL '5 days' WHERE id = $1`, [fresh.userId]);

  const result = await runInactivityCheck();
  assert.equal(result.reminded, 1, 'only the never-used login that is five days old');
  assert.equal((await query(`SELECT COUNT(*)::int AS n FROM notification WHERE user_id = $1 AND kind = 'inactive_reminder'`, [fresh.userId]))[0].n, 1);
  assert.equal((await query(`SELECT COUNT(*)::int AS n FROM notification WHERE user_id = $1 AND kind = 'inactive_reminder'`, [gone.userId]))[0].n, 0);
});
