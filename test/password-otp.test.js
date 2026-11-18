// Setting your own password with a code texted to the registered mobile: the first sign-in after an admin
// created the login, and "forgot password". Tests use the in-memory sender; nothing is really sent.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, createClient } from './helpers/server.js';
import { createUser, login, PASSWORD } from './helpers/fixtures.js';
import { query } from './helpers/testDb.js';
import { lastSms } from '../server/auth/sms.js';

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

async function newSalesperson(name, phone) {
  const [sp] = await query(
    `INSERT INTO salesperson (employee_code, name, phone, id_prefix) VALUES ($1, $2, $3, $4) RETURNING id`,
    [`E-${name}`, name, phone, name.slice(0, 2).toUpperCase()]
  );
  const res = await admin.request('POST', '/api/admin/users', { username: name.toLowerCase(), password: 'Temp-Passw0rd', role: 'salesperson', salesperson_id: sp.id });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { id: res.body.id, username: name.toLowerCase() };
}
const signIn = async (username, password) => {
  const client = createClient(server.baseUrl);
  const res = await client.request('POST', '/api/auth/login', { username, password });
  return { client, res };
};

test('a new salesperson login must set its own password: the registered mobile is shown, the code verifies it', async () => {
  const rep = await newSalesperson('Asha', '9542325230');
  const { client, res } = await signIn(rep.username, 'Temp-Passw0rd');
  assert.equal(res.status, 200);
  assert.equal(res.body.user.must_change_password, true);

  const blocked = await client.request('GET', '/api/opportunities');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, 'password_change_required');
  assert.equal((await client.request('POST', '/api/auth/change-password', { current_password: 'Temp-Passw0rd', new_password: 'Another-Passw0rd' })).status, 403, 'the normal change is not a way around the code');

  const info = (await client.request('GET', '/api/auth/otp-info')).body;
  assert.equal(info.phone, '+91 95423 25230');
  assert.equal(info.can_send, true);

  assert.equal((await client.request('POST', '/api/auth/first-login/complete', { new_password: 'Chosen-Passw0rd', otp: '000000' })).status, 400, 'no code asked for yet');
  assert.equal((await client.request('POST', '/api/auth/first-login/send')).status, 200);
  const sms = lastSms();
  assert.equal(sms.phone, '9542325230');
  assert.match(sms.code, /^\d{6}$/);

  const wrong = sms.code === '123456' ? '654321' : '123456';
  assert.equal((await client.request('POST', '/api/auth/first-login/complete', { new_password: 'Chosen-Passw0rd', otp: wrong })).status, 400);
  const done = await client.request('POST', '/api/auth/first-login/complete', { new_password: 'Chosen-Passw0rd', otp: sms.code });
  assert.equal(done.status, 200, JSON.stringify(done.body));

  assert.equal((await client.request('GET', '/api/opportunities')).status, 200, 'the app opens');
  assert.equal((await signIn(rep.username, 'Temp-Passw0rd')).res.status, 401, 'the temporary password is gone');
  const again = await signIn(rep.username, 'Chosen-Passw0rd');
  assert.equal(again.res.status, 200);
  assert.equal(again.res.body.user.must_change_password, false);
  assert.equal((await client.request('POST', '/api/auth/first-login/complete', { new_password: 'Third-Passw0rd', otp: sms.code })).status, 409, 'a code works once, and only while the password is temporary');
  assert.equal((await query(`SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'user.password_set' AND entity_id = $1`, [rep.id]))[0].n, 1);
});

test('a code dies after five wrong tries, and codes can’t be asked for in a flood', async () => {
  const rep = await newSalesperson('Bala', '9876543210');
  const { client } = await signIn(rep.username, 'Temp-Passw0rd');
  assert.equal((await client.request('POST', '/api/auth/first-login/send')).status, 200);
  const real = lastSms().code;
  const wrong = real === '111111' ? '222222' : '111111';
  for (let i = 0; i < 5; i++) assert.equal((await client.request('POST', '/api/auth/first-login/complete', { new_password: 'Chosen-Passw0rd', otp: wrong })).status, 400);
  assert.equal((await client.request('POST', '/api/auth/first-login/complete', { new_password: 'Chosen-Passw0rd', otp: real })).status, 400, 'the right code is dead after five wrong tries');
  assert.equal((await client.request('POST', '/api/auth/first-login/send')).status, 429, 'a second code straight away is refused');
});

test('forgot password: the code goes to the registered mobile, a wrong username looks the same, and it ends other sessions', async () => {
  const rep = await newSalesperson('Chitra', '9123456789');
  const first = await signIn(rep.username, 'Temp-Passw0rd');
  await query(`UPDATE app_user SET must_change_password = FALSE WHERE id = $1`, [rep.id]);

  const anon = createClient(server.baseUrl);
  const unknown = await anon.request('POST', '/api/auth/forgot/send', { username: 'nobody-here' });
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknown.body, { sent: true });

  const sent = await anon.request('POST', '/api/auth/forgot/send', { username: rep.username });
  assert.deepEqual(sent.body, { sent: true });
  const sms = lastSms();
  assert.equal(sms.phone, '9123456789');

  assert.equal((await anon.request('POST', '/api/auth/forgot/reset', { username: rep.username, otp: '000000', new_password: 'Forgot-Passw0rd' })).status, 400);
  const done = await anon.request('POST', '/api/auth/forgot/reset', { username: rep.username, otp: sms.code, new_password: 'Forgot-Passw0rd' });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal((await signIn(rep.username, 'Forgot-Passw0rd')).res.status, 200);
  assert.equal((await first.client.request('GET', '/api/auth/me')).status, 401, 'older sessions are signed out');
});

test('without a valid registered number the first sign-in falls back to the temporary password', async () => {
  const rep = await newSalesperson('Dev', null);
  const { client } = await signIn(rep.username, 'Temp-Passw0rd');
  const info = (await client.request('GET', '/api/auth/otp-info')).body;
  assert.equal(info.phone, null);
  assert.equal(info.can_send, false);
  assert.equal((await client.request('POST', '/api/auth/first-login/send')).status, 409);
  assert.equal((await client.request('POST', '/api/auth/first-login/complete', { new_password: 'Chosen-Passw0rd', current_password: 'wrong' })).status, 400);
  assert.equal((await client.request('POST', '/api/auth/first-login/complete', { new_password: 'Chosen-Passw0rd', current_password: 'Temp-Passw0rd' })).status, 200);
  assert.equal((await client.request('GET', '/api/opportunities')).status, 200);
  assert.equal(PASSWORD.length > 0, true);
});
