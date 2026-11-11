// Phase 4b: products, OEMs, market segments, company approval and audit filters.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startTestServer, createClient } from './helpers/server.js';
import { createCompany, createUser, dealFieldsFor, login, signedInSalesperson } from './helpers/fixtures.js';
import { query, testDatabaseUrl } from './helpers/testDb.js';


let server;
let ravi;
let admin;
let adminId;
let manager;
let office;

before(async () => {
  server = await startTestServer();
  ravi = await signedInSalesperson(server.baseUrl, 'Ravi', createClient);
  adminId = await createUser('admin', 'admin');
  admin = createClient(server.baseUrl);
  await login(admin, 'admin');
  await createUser('manager', 'sales_manager');
  manager = createClient(server.baseUrl);
  await login(manager, 'manager');
  await createUser('office', 'office_staff');
  office = createClient(server.baseUrl);
  await login(office, 'office');
});

after(async () => {
  await server?.close();
});

const oemId = async (name) => (await query(`SELECT id FROM oem WHERE name = $1`, [name]))[0].id;

test('the six OEMs and four market segments are seeded', async () => {
  const oems = (await ravi.client.request('GET', '/api/oems')).body.map((o) => o.name).sort();
  assert.deepEqual(oems, ['Anton Paar', 'Merck', 'Mettler Toledo', 'PerkinElmer', 'SHINE', 'Vintage Chrom']);
  const segments = (await ravi.client.request('GET', '/api/market-segments')).body.map((s) => s.name);
  assert.deepEqual(segments, ['Pharma', 'Non-pharma', 'Food', 'Research & Analytics'], 'the fixed list, in its set order');
});

test('products: admin and office manage them; managers and salespeople only view', async () => {
  const body = { part_number: 'TS-PE-AAS', name: 'Atomic Absorption Spectrometer', oem_id: await oemId('PerkinElmer'), category: 'Spectroscopy', key_features: ['Flame', ' Furnace ', ''] };
  assert.equal((await ravi.client.request('POST', '/api/products', body)).status, 403);
  assert.equal((await manager.request('POST', '/api/products', body)).status, 403);
  const created = await office.request('POST', '/api/products', body);
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.key_features, ['Flame', 'Furnace']);
  assert.equal((await admin.request('POST', '/api/products', body)).status, 409, 'part numbers are unique');
  assert.equal((await ravi.client.request('PUT', `/api/products/${created.body.id}`, { name: 'x' })).status, 403);

  const edited = await admin.request('PUT', `/api/products/${created.body.id}`, { category: 'Atomic spectroscopy' });
  assert.equal(edited.body.category, 'Atomic spectroscopy');
  assert.equal(edited.body.name, body.name, 'other fields are kept');
  const actions = (await query(`SELECT action FROM audit_log WHERE entity_type = 'product' AND entity_id = $1 ORDER BY id`, [created.body.id])).map((r) => r.action);
  assert.deepEqual(actions, ['product.created', 'product.updated']);
});

test('products: search by part number or name, filter by make, view the detail', async () => {
  await office.request('POST', '/api/products', { part_number: 'TS-MT-XPR', name: 'Analytical Balance', oem_id: await oemId('Mettler Toledo'), key_features: ['0.1 mg'] });
  const list = async (qs) => (await ravi.client.request('GET', `/api/products${qs}`)).body.map((p) => p.part_number);
  assert.deepEqual(await list('?q=ts-mt'), ['TS-MT-XPR']);
  assert.deepEqual(await list('?q=balance'), ['TS-MT-XPR']);
  assert.deepEqual(await list(`?oem_id=${await oemId('PerkinElmer')}`), ['TS-PE-AAS']);
  assert.deepEqual(await list('?q=%25'), [], 'a wildcard character is taken literally');
  const [{ id }] = (await ravi.client.request('GET', '/api/products?q=balance')).body;
  const detail = await ravi.client.request('GET', `/api/products/${id}`);
  assert.equal(detail.body.oem_name, 'Mettler Toledo');
  assert.deepEqual(detail.body.key_features, ['0.1 mg']);
});

test('products are deactivated, never deleted', async () => {
  const [{ id }] = (await ravi.client.request('GET', '/api/products?q=balance')).body;
  assert.equal((await admin.request('DELETE', `/api/products/${id}`)).status, 404);
  assert.equal((await office.request('PUT', `/api/products/${id}`, { is_active: false })).body.is_active, false);
  assert.deepEqual((await ravi.client.request('GET', '/api/products?q=balance')).body, [], 'gone from pickers');
  assert.equal((await office.request('GET', '/api/products?q=balance&include_inactive=1')).body.length, 1);
  assert.equal((await ravi.client.request('GET', '/api/products?q=balance&include_inactive=1')).body.length, 0, 'salespeople see active ones only');
  await office.request('PUT', `/api/products/${id}`, { is_active: true });
});

test('OEMs and market segments: only MD/Admin manage them; in use can be deactivated, not deleted', async () => {
  for (const client of [ravi.client, manager, office]) {
    assert.equal((await client.request('POST', '/api/oems', { name: 'Nope' })).status, 403);
    assert.equal((await client.request('POST', '/api/market-segments', { name: 'Nope' })).status, 403);
  }
  const oem = await admin.request('POST', '/api/oems', { name: 'Shimadzu' });
  assert.equal(oem.status, 201);
  assert.equal((await admin.request('POST', '/api/oems', { name: 'Shimadzu' })).status, 409);
  const segment = await admin.request('POST', '/api/market-segments', { name: 'Academia' });
  assert.equal(segment.status, 201);

  const companyId = await createCompany('Segment Labs', { createdBy: ravi.userId });
  const fields = await dealFieldsFor('CAT-1');
  const deal = await ravi.client.request('POST', '/api/opportunities', { company_id: companyId, title: 'Uses a segment', ...fields, segment_ids: [segment.body.id] });
  assert.equal(deal.status, 201);

  assert.equal((await admin.request('DELETE', `/api/market-segments/${segment.body.id}`)).status, 404, 'no way to delete');
  const off = await admin.request('PUT', `/api/market-segments/${segment.body.id}`, { is_active: false });
  assert.equal(off.body.is_active, false);
  assert.ok(!(await ravi.client.request('GET', '/api/market-segments')).body.some((s) => s.id === segment.body.id));
  assert.equal((await ravi.client.request('POST', '/api/opportunities', { company_id: companyId, title: 'New', ...fields, segment_ids: [segment.body.id] })).status, 400, 'inactive segments cannot be chosen');
  const keep = await ravi.client.request('PUT', `/api/opportunities/${deal.body.id}`, { title: 'Keeps its segment' });
  assert.equal(keep.status, 200, 'a deal keeps a segment that was deactivated later');
  assert.equal(keep.body.segments[0].id, segment.body.id);
});

test('the products CSV: quoted fields, " | " features, update by part number, unknown makes refused', async () => {
  const { parseProductCsv } = await import('../server/crm/products.js');
  const rows = parseProductCsv(`part_number,product_name,make,category,key_features\r\nTS-A,"Balance, analytical",Mettler Toledo,Weighing,"0.1 mg | Auto ""cal"""\r\n\r\n`);
  assert.deepEqual(rows, [{ part_number: 'TS-A', name: 'Balance, analytical', make: 'Mettler Toledo', category: 'Weighing', key_features: ['0.1 mg', 'Auto "cal"'] }]);
  assert.throws(() => parseProductCsv('part_number,name\nx,y'), /product_name/);

  const run = promisify(execFile);
  const env = { ...process.env, DATABASE_URL: testDatabaseUrl() };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'products-'));
  const good = path.join(dir, 'good.csv');
  fs.writeFileSync(good, 'part_number,product_name,make,category,key_features\nTS-IMP,First name,Anton Paar,Density,A | B\n');
  assert.match((await run(process.execPath, ['server/scripts/import-products.js', good], { env })).stdout, /1 added, 0 updated/);
  fs.writeFileSync(good, 'part_number,product_name,make,category,key_features\nTS-IMP,Second name,Anton Paar,Density,A | B | C\n');
  assert.match((await run(process.execPath, ['server/scripts/import-products.js', good], { env })).stdout, /0 added, 1 updated/);
  const [row] = await query(`SELECT name, key_features FROM product WHERE part_number = 'TS-IMP'`);
  assert.equal(row.name, 'Second name');
  assert.deepEqual(row.key_features, ['A', 'B', 'C']);
  const bad = path.join(dir, 'bad.csv');
  fs.writeFileSync(bad, 'part_number,product_name,make,category,key_features\nTS-X,Thing,Unknown Make,,\n');
  await assert.rejects(run(process.execPath, ['server/scripts/import-products.js', bad], { env }), /Unknown Make/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('company approval: a salesperson’s company waits; a manager’s is approved at once', async () => {
  const pending = await ravi.client.request('POST', '/api/companies', { name: 'Pending Labs', city: 'Pune', state: 'Maharashtra', category: 'Pharma', contact_person: 'Dr. Patil' });
  assert.equal(pending.status, 201);
  assert.equal(pending.body.approval_status, 'pending');
  assert.equal(pending.body.state, 'Maharashtra');
  assert.equal(pending.body.category, 'Pharma');
  assert.equal(pending.body.contact_person, 'Dr. Patil');

  const direct = await manager.request('POST', '/api/companies', { name: 'Manager Labs' });
  assert.equal(direct.body.approval_status, 'approved');
  assert.ok(direct.body.approved_by);
  assert.equal((await admin.request('POST', '/api/companies', { name: 'Admin Labs' })).body.approval_status, 'approved');

  // A visit can be logged, a deal cannot be opened; the message says why.
  assert.equal((await ravi.client.request('POST', '/api/visits', { company_id: pending.body.id })).status, 201);
  const fields = await dealFieldsFor('CAT-2');
  const refused = await ravi.client.request('POST', '/api/opportunities', { company_id: pending.body.id, title: 'Too soon', ...fields });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /waiting for approval/);
  const { body: draft } = await ravi.client.request('POST', '/api/visits', { company_id: pending.body.id });
  const fromVisit = await ravi.client.request('POST', `/api/visits/${draft.id}/complete`, {
    outcome: 'interested', requirements: [{ description: 'A balance' }], follow_up: { title: 'Call', due_date: '2099-01-01' }, opportunity: { title: 'Too soon', ...fields },
  });
  assert.equal(fromVisit.status, 409, 'nor from a visit');

  // The approvals list and who may use it.
  assert.equal((await ravi.client.request('GET', '/api/companies/approvals')).status, 403);
  assert.equal((await office.request('GET', '/api/companies/approvals')).status, 403);
  const list = await manager.request('GET', '/api/companies/approvals');
  assert.deepEqual(list.body.map((c) => c.name), ['Pending Labs']);
  assert.equal(list.body[0].created_by_username, 'ravi');

  assert.equal((await ravi.client.request('POST', `/api/companies/${pending.body.id}/approve`)).status, 403);
  assert.equal((await office.request('POST', `/api/companies/${pending.body.id}/approve`)).status, 403);
  const approved = await manager.request('POST', `/api/companies/${pending.body.id}/approve`);
  assert.equal(approved.body.approval_status, 'approved');
  assert.ok(approved.body.approved_at);
  assert.equal((await manager.request('POST', `/api/companies/${pending.body.id}/approve`)).status, 409, 'already decided');
  assert.equal((await ravi.client.request('POST', '/api/opportunities', { company_id: pending.body.id, title: 'Now fine', ...fields })).status, 201);
  const [audit] = await query(`SELECT action FROM audit_log WHERE action = 'company.approved' AND entity_id = $1`, [pending.body.id]);
  assert.ok(audit);
});

test('company rejection needs a reason; the record is kept, marked and out of the lists', async () => {
  const { body: c } = await ravi.client.request('POST', '/api/companies', { name: 'Reject Traders' });
  assert.equal((await manager.request('POST', `/api/companies/${c.id}/reject`, {})).status, 400);
  const rejected = await manager.request('POST', `/api/companies/${c.id}/reject`, { reason: 'Not a lab customer' });
  assert.equal(rejected.body.approval_status, 'rejected');
  assert.equal(rejected.body.rejection_reason, 'Not a lab customer');

  const detail = await ravi.client.request('GET', `/api/companies/${c.id}`);
  assert.equal(detail.status, 200, 'kept');
  assert.equal(detail.body.approval_status, 'rejected');
  assert.ok(!(await ravi.client.request('GET', '/api/companies?q=Reject')).body.some((x) => x.id === c.id), 'not offered in search');
  assert.ok((await ravi.client.request('GET', '/api/companies?approval=rejected')).body.some((x) => x.id === c.id));
  assert.equal((await ravi.client.request('POST', '/api/visits', { company_id: c.id })).status, 409);
  const fields = await dealFieldsFor('CAT-3');
  assert.equal((await manager.request('POST', '/api/opportunities', { company_id: c.id, title: 'x', owner_salesperson_id: ravi.salespersonId, ...fields })).status, 409);

  const again = await ravi.client.request('POST', '/api/companies', { name: 'Reject Traders' });
  assert.equal(again.status, 201, 'a rejected company no longer holds the name');
});

test('team insights break results down by OEM and market segment', async () => {
  const { body } = await manager.request('GET', '/api/team/insights');
  const perkin = body.by_oem.find((r) => r.oem === 'PerkinElmer');
  assert.ok(perkin.open_deals >= 1);
  assert.ok(Array.isArray(body.by_segment));
  const team = (await manager.request('GET', '/api/team/performance')).body.totals;
  assert.equal(body.by_oem.reduce((s, r) => s + r.open_deals, 0), team.open_deals);
});

test('every kind of change is audited; the audit log filters by user, record and date', async () => {
  const companyId = await createCompany('Audit Labs', { createdBy: ravi.userId });
  const { body: task } = await ravi.client.request('POST', '/api/tasks', { company_id: companyId, title: 'Call', due_date: '2099-01-01' });
  await ravi.client.request('PUT', `/api/tasks/${task.id}`, { due_date: '2099-02-01' });
  await ravi.client.request('POST', `/api/tasks/${task.id}/complete`);
  const { body: requirement } = await ravi.client.request('POST', '/api/requirements', { company_id: companyId, description: 'A balance' });
  const { body: visit } = await ravi.client.request('POST', '/api/visits', { company_id: companyId });
  await ravi.client.request('PUT', `/api/visits/${visit.id}`, { notes: 'Arrived' });

  const entries = async (qs) => (await admin.request('GET', `/api/admin/audit${qs}`)).body;
  assert.deepEqual((await entries(`?entity_type=task&entity_id=${task.id}`)).map((e) => e.action).reverse(), ['task.created', 'task.updated', 'task.completed']);
  assert.deepEqual((await entries(`?entity_type=visit&entity_id=${visit.id}`)).map((e) => e.action).reverse(), ['visit.created', 'visit.updated']);
  assert.equal((await entries(`?entity_type=requirement&entity_id=${requirement.id}`))[0].action, 'requirement.created');

  assert.ok((await entries(`?actor_user_id=${ravi.userId}`)).every((e) => e.actor_user_id === ravi.userId));
  assert.equal((await entries(`?actor_user_id=${adminId}&entity_type=task`)).length, 0);
  const [{ today }] = await query(`SELECT ((NOW() AT TIME ZONE 'Asia/Kolkata')::date)::text AS today`);
  assert.ok((await entries(`?from=${today}&to=${today}`)).length > 0);
  assert.equal((await entries('?to=2000-01-01')).length, 0);
  assert.equal((await admin.request('GET', '/api/admin/audit?from=yesterday')).status, 400);
  assert.equal((await manager.request('GET', '/api/admin/audit')).status, 403);
});
