// An opportunity an admin opens belongs to the company, "Technicon Services", not to any salesperson.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, createClient } from './helpers/server.js';
import { createCompany, createUser, dealFieldsFor, login, signedInSalesperson } from './helpers/fixtures.js';
import { query } from './helpers/testDb.js';

let server;
let ravi;
let admin;
let manager;
let companyId;
let fields;

before(async () => {
  server = await startTestServer();
  ravi = await signedInSalesperson(server.baseUrl, 'Ravi', createClient);
  await createUser('boss', 'admin');
  admin = createClient(server.baseUrl);
  await login(admin, 'boss');
  const mgrSp = await signedInSalesperson(server.baseUrl, 'Manju', createClient);
  await query(`UPDATE app_user SET role = 'sales_manager' WHERE id = $1`, [mgrSp.userId]);
  manager = createClient(server.baseUrl);
  await login(manager, (await query(`SELECT username FROM app_user WHERE id = $1`, [mgrSp.userId]))[0].username);
  companyId = await createCompany('House Labs', { city: 'Hyderabad', createdBy: ravi.userId });
  fields = await dealFieldsFor('HO-1');
});

after(async () => {
  await server?.close();
});

const open = (client, extra = {}) => client.request('POST', '/api/opportunities', { company_id: companyId, title: 'Some deal', ...fields, ...extra });

test('an opportunity opened by an admin belongs to Technicon Services, even if a salesperson is named', async () => {
  const res = await open(admin, { owner_salesperson_id: ravi.salespersonId });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.owner_name, 'Technicon Services');
  assert.notEqual(res.body.owner_salesperson_id, ravi.salespersonId);
  assert.match(res.body.code, /^TS-[A-Z0-9]+-0001$/);

  const second = await open(admin);
  assert.match(second.body.code, /-0002$/, 'the company’s own opportunities are numbered too');
  const [house] = await query(`SELECT id, is_house FROM salesperson WHERE name = 'Technicon Services'`);
  assert.equal(house.is_house, true);
  assert.equal((await query(`SELECT COUNT(*)::int AS n FROM salesperson WHERE is_house`))[0].n, 1, 'one company owner, however many are opened');
});

test('a salesperson’s own opportunity stays theirs, and a manager still names the owner', async () => {
  const mine = await open(ravi.client);
  assert.equal(mine.body.owner_salesperson_id, ravi.salespersonId);
  const named = await open(manager, { owner_salesperson_id: ravi.salespersonId });
  assert.equal(named.status, 201, JSON.stringify(named.body));
  assert.equal(named.body.owner_salesperson_id, ravi.salespersonId);
});

test('the company owner has no login and cannot be deactivated, and a salesperson does not see its opportunities', async () => {
  const [house] = await query(`SELECT id FROM salesperson WHERE is_house`);
  const hid = house?.id ?? (await open(admin)).body.owner_salesperson_id;
  const deactivate = await admin.request('POST', `/api/admin/salespeople/${hid}/deactivate`);
  assert.equal(deactivate.status, 409);
  const login = await admin.request('POST', '/api/admin/users', { username: 'house.login', password: 'Temp-Passw0rd', role: 'salesperson', salesperson_id: hid });
  assert.equal(login.status, 400);
  assert.match(login.body.error, /company owner/);

  const theirs = (await open(admin)).body;
  assert.equal((await ravi.client.request('GET', `/api/opportunities/${theirs.id}`)).status, 404);
  assert.equal((await admin.request('GET', `/api/opportunities/${theirs.id}`)).status, 200);
});
