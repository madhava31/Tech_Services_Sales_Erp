// Role-based access, checked with real HTTP requests: the web app hiding a page is never what
// keeps a role out.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, createClient } from './helpers/server.js';
import { createSalesperson, createUser, login } from './helpers/fixtures.js';
import { visibleSalespersonIds } from '../server/auth/roles.js';

let server;
const clients = {};

const ADMIN_ENDPOINTS = [
  ['GET', '/api/admin/users'],
  ['POST', '/api/admin/users'],
  ['PUT', '/api/admin/users/1'],
  ['POST', '/api/admin/users/1/deactivate'],
  ['POST', '/api/admin/users/1/reset-password'],
  ['GET', '/api/admin/salespeople'],
  ['POST', '/api/admin/salespeople'],
  ['POST', '/api/admin/salespeople/1/deactivate'],
  ['GET', '/api/admin/audit'],
];

before(async () => {
  server = await startTestServer();
  const salespersonId = await createSalesperson('Ravi');
  await createUser('admin1', 'admin');
  await createUser('md1', 'managing_director');
  const managerId = await createUser('manager1', 'sales_manager');
  await createUser('sales1', 'salesperson', { salespersonId, managerUserId: managerId });
  await createUser('office1', 'office_staff');
  for (const name of ['admin1', 'md1', 'manager1', 'sales1', 'office1']) {
    clients[name] = createClient(server.baseUrl);
    await login(clients[name], name);
  }
});

after(async () => {
  await server?.close();
});

test('only admin and managing director reach the admin API', async () => {
  for (const name of ['sales1', 'manager1', 'office1']) {
    for (const [method, path] of ADMIN_ENDPOINTS) {
      const res = await clients[name].request(method, path, method === 'GET' ? undefined : {});
      assert.equal(res.status, 403, `${name} ${method} ${path} returned ${res.status}`);
    }
  }
  for (const name of ['admin1', 'md1']) {
    assert.equal((await clients[name].request('GET', '/api/admin/users')).status, 200, name);
    assert.equal((await clients[name].request('GET', '/api/admin/salespeople')).status, 200, name);
    assert.equal((await clients[name].request('GET', '/api/admin/audit')).status, 200, name);
  }
});

test('a salesperson session carries their salesperson id', async () => {
  const me = await clients.sales1.request('GET', '/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.role, 'salesperson');
  assert.ok(me.body.user.salesperson_id);
});

test('unauthenticated requests get 401; unknown routes 404 only after sign-in; health is public', async () => {
  const anon = createClient(server.baseUrl);
  assert.equal((await anon.request('GET', '/api/admin/users')).status, 401);
  assert.equal((await anon.request('GET', '/api/anything')).status, 401);
  assert.equal((await anon.request('GET', '/api/health')).status, 200);
  assert.equal((await clients.sales1.request('GET', '/api/anything')).status, 404);
});

test('record visibility: salespeople see only their own records, never everything', () => {
  assert.deepEqual(visibleSalespersonIds({ role: 'salesperson', salesperson_id: 7 }), [7]);
  assert.deepEqual(visibleSalespersonIds({ role: 'salesperson', salesperson_id: null }), []);
  assert.equal(visibleSalespersonIds({ role: 'sales_manager' }), null);
  assert.equal(visibleSalespersonIds({ role: 'managing_director' }), null);
  assert.equal(visibleSalespersonIds({ role: 'office_staff' }), null);
});
