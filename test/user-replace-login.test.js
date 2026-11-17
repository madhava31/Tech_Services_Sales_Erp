// A salesperson whose login was deactivated can be given a new one; the old login keeps its history.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, createClient } from './helpers/server.js';
import { createCompany, createUser, login, signedInSalesperson } from './helpers/fixtures.js';
import { query } from './helpers/testDb.js';

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

const newLogin = (username, salespersonId) => admin.request('POST', '/api/admin/users', { username, password: 'Sup3rSecret!x', role: 'salesperson', salesperson_id: salespersonId });

test('a deactivated login is released, so the salesperson can have a new one', async () => {
  const rep = await signedInSalesperson(server.baseUrl, 'Ganesh', createClient);
  await createCompany('Old Login Labs', { createdBy: rep.userId });
  await query(`UPDATE app_user SET is_active = FALSE, deactivated_at = NOW() WHERE id = $1`, [rep.userId]);

  const res = await newLogin('ganesh.new', rep.salespersonId);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.salesperson_id, rep.salespersonId);

  const [old] = await query(`SELECT salesperson_id, role, is_active FROM app_user WHERE id = $1`, [rep.userId]);
  assert.equal(old.salesperson_id, null);
  assert.equal(old.role, 'office_staff');
  assert.equal(old.is_active, false);
  assert.equal((await query(`SELECT COUNT(*)::int AS n FROM company WHERE created_by = $1`, [rep.userId]))[0].n, 1, 'its history stays with it');
  assert.equal((await query(`SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'user.released' AND entity_id = $1`, [rep.userId]))[0].n, 1);
});

test('an active login is not replaced', async () => {
  const rep = await signedInSalesperson(server.baseUrl, 'Priya', createClient);
  const res = await newLogin('priya.second', rep.salespersonId);
  assert.equal(res.status, 409);
  assert.equal((await query(`SELECT is_active FROM app_user WHERE id = $1`, [rep.userId]))[0].is_active, true);
});
