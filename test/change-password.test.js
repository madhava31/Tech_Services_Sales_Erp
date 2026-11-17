// Anyone signed in can change their own password: current one required, other sessions signed out, audited.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, createClient } from './helpers/server.js';
import { createUser, PASSWORD } from './helpers/fixtures.js';
import { query } from './helpers/testDb.js';

let server;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server?.close();
});

async function signedIn(username, password) {
  const client = createClient(server.baseUrl);
  const res = await client.request('POST', '/api/auth/login', { username, password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return client;
}

test('a salesperson changes their own password: the new one works, the old one does not, other sessions end', async () => {
  await createUser('cp.rep', 'admin');
  const phone = await signedIn('cp.rep', PASSWORD);
  const laptop = await signedIn('cp.rep', PASSWORD);

  const res = await phone.request('POST', '/api/auth/change-password', { current_password: PASSWORD, new_password: 'NewPassw0rd!9' });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  assert.equal((await phone.request('GET', '/api/auth/me')).status, 200, 'this session stays signed in');
  assert.equal((await laptop.request('GET', '/api/auth/me')).status, 401, 'the other one is signed out');
  assert.equal((await createClient(server.baseUrl).request('POST', '/api/auth/login', { username: 'cp.rep', password: PASSWORD })).status, 401);
  assert.equal((await createClient(server.baseUrl).request('POST', '/api/auth/login', { username: 'cp.rep', password: 'NewPassw0rd!9' })).status, 200);
  assert.equal((await query(`SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'user.password_changed'`))[0].n, 1);
});

test('a wrong current password, a weak or unchanged new one, and a signed-out caller are all refused', async () => {
  await createUser('cp.two', 'admin');
  const client = await signedIn('cp.two', PASSWORD);
  const change = (body) => client.request('POST', '/api/auth/change-password', body);
  assert.equal((await change({ current_password: 'nope', new_password: 'NewPassw0rd!9' })).status, 400);
  assert.equal((await change({ current_password: PASSWORD, new_password: 'short' })).status, 400);
  assert.equal((await change({ current_password: PASSWORD, new_password: PASSWORD })).status, 400);
  assert.equal((await change({ current_password: PASSWORD })).status, 400);
  assert.equal((await createClient(server.baseUrl).request('POST', '/api/auth/change-password', { current_password: 'a', new_password: 'b' })).status, 401);
  assert.equal((await createClient(server.baseUrl).request('POST', '/api/auth/login', { username: 'cp.two', password: PASSWORD })).status, 200, 'password unchanged');
});
