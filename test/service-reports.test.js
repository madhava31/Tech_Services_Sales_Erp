// Field service reports: a draft is saved and changed freely, a report signed by both is complete and locked,
// numbers count up per engineer, the instrument joins the customer's installed base, and who can see what.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, createClient } from './helpers/server.js';
import { createCompany, createUser, login, signedInSalesperson } from './helpers/fixtures.js';
import { query } from './helpers/testDb.js';

const SIGN = 'data:image/png;base64,iVBORw0KGgo=';
let server;
let ravi;
let priya;
let admin;
let companyId;

before(async () => {
  server = await startTestServer();
  ravi = await signedInSalesperson(server.baseUrl, 'Ravi', createClient);
  priya = await signedInSalesperson(server.baseUrl, 'Priya', createClient);
  await createUser('boss', 'admin');
  admin = createClient(server.baseUrl);
  await login(admin, 'boss');
  companyId = await createCompany('Mahi Drugs Private Limited', { city: 'Parawada', createdBy: ravi.userId });
});

after(async () => {
  await server?.close();
});

const body = (extra = {}) => ({
  company_id: companyId,
  company_name: 'Mahi Drugs Private Limited',
  company_address: 'JNPC, Parawada, Andhra Pradesh',
  user_name: 'T.Srinivas Reddy',
  user_department: 'QC',
  user_email: 'qc_wet@mahidrugs.com',
  instrument_make: 'Mettler Toledo',
  instrument_name: 'FP20 PH meter',
  model_no: '30266629',
  serial_no: 'C606130414,QC127',
  call_reported_date: '2026-10-31',
  call_attended_date: '2026-10-31',
  problem_reported: 'Electrode issue: the pH level goes down, calibration fails, slope not coming properly.',
  engineer_name: 'L.Achuth kumar',
  parts: [{ part_no: 'NA', description: 'NA', qty: 1 }],
  ...extra,
});
const signed = (extra = {}) => body({ call_completed_date: '2026-10-31', engineer_signature: SIGN, customer_name: 'T.Srinivas Reddy', customer_signature: SIGN, complete: true, ...extra });

test('a draft is saved with its number, and its instrument joins the customer’s installed base once', async () => {
  const res = await ravi.client.request('POST', '/api/service-reports', body());
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.match(res.body.code, /^FSR-[A-Z0-9]+-0001$/);
  assert.equal(res.body.status, 'draft');
  assert.equal(res.body.parts.length, 1);
  assert.ok(res.body.instrument_id, 'linked to an instrument');

  const second = await ravi.client.request('POST', '/api/service-reports', body({ problem_reported: 'Came back' }));
  assert.match(second.body.code, /-0002$/, 'numbers count up');
  assert.equal(second.body.instrument_id, res.body.instrument_id, 'the same serial number is the same instrument');
  const [{ n }] = await query(`SELECT COUNT(*)::int AS n FROM installed_instrument WHERE company_id = $1`, [companyId]);
  assert.equal(n, 1);

  const other = await priya.client.request('POST', '/api/service-reports', body());
  assert.match(other.body.code, /-0001$/, 'each engineer counts from one');
});

test('a draft can be changed; completing needs both signatures and the customer’s name', async () => {
  const draft = (await ravi.client.request('POST', '/api/service-reports', body({ serial_no: 'S-EDIT' }))).body;
  const edited = await ravi.client.request('PUT', `/api/service-reports/${draft.id}`, body({ serial_no: 'S-EDIT', work_done: 'Replaced the electrode', parts: [{ description: 'pH electrode', qty: 2 }] }));
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.work_done, 'Replaced the electrode');
  assert.deepEqual(edited.body.parts.map((p) => [p.description, p.qty]), [['pH electrode', 2]]);

  const noCustomer = await ravi.client.request('PUT', `/api/service-reports/${draft.id}`, signed({ serial_no: 'S-EDIT', customer_signature: undefined }));
  assert.equal(noCustomer.status, 400);
  assert.match(noCustomer.body.error, /customer needs to sign/);
  const noEngineer = await ravi.client.request('PUT', `/api/service-reports/${draft.id}`, signed({ serial_no: 'S-EDIT', engineer_signature: undefined }));
  assert.equal(noEngineer.status, 400);

  const done = await ravi.client.request('PUT', `/api/service-reports/${draft.id}`, signed({ serial_no: 'S-EDIT' }));
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.status, 'completed');
  assert.ok(done.body.engineer_signed_at && done.body.customer_signed_at && done.body.completed_at);
});

test('a completed report is locked; only a manager reopens it, with a reason, and the signatures are cleared', async () => {
  const report = (await ravi.client.request('POST', '/api/service-reports', signed({ serial_no: 'S-LOCK' }))).body;
  assert.equal(report.status, 'completed');
  const change = await ravi.client.request('PUT', `/api/service-reports/${report.id}`, body({ serial_no: 'S-LOCK', problem_reported: 'Changed' }));
  assert.equal(change.status, 409);

  assert.equal((await ravi.client.request('POST', `/api/service-reports/${report.id}/reopen`, { reason: 'Typo' })).status, 403, 'a salesperson cannot reopen');
  assert.equal((await admin.request('POST', `/api/service-reports/${report.id}/reopen`, {})).status, 400, 'a reason is needed');
  const reopened = await admin.request('POST', `/api/service-reports/${report.id}/reopen`, { reason: 'Wrong serial number' });
  assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
  assert.equal(reopened.body.status, 'draft');
  assert.equal(reopened.body.engineer_signature, null);
  assert.equal(reopened.body.customer_signature, null);
  assert.equal((await query(`SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'service_report.reopened' AND entity_id = $1`, [report.id]))[0].n, 1);
});

test('a salesperson sees their own reports, managers see all, and the checks refuse bad input', async () => {
  const mine = (await ravi.client.request('POST', '/api/service-reports', body({ serial_no: 'S-VIS' }))).body;
  assert.equal((await priya.client.request('GET', `/api/service-reports/${mine.id}`)).status, 404, 'someone else’s is not shown');
  assert.equal((await admin.request('GET', `/api/service-reports/${mine.id}`)).status, 200);
  const list = (await priya.client.request('GET', '/api/service-reports')).body;
  assert.ok(list.every((r) => r.salesperson_id === priya.salespersonId));
  assert.ok((await admin.request('GET', '/api/service-reports?q=S-VIS')).body.some((r) => r.id === mine.id));

  assert.equal((await ravi.client.request('POST', '/api/service-reports', body({ problem_reported: '' }))).status, 400);
  assert.equal((await ravi.client.request('POST', '/api/service-reports', body({ call_attended_date: '2026-10-30' }))).status, 400, 'attended before reported');
  assert.equal((await ravi.client.request('POST', '/api/service-reports', body({ engineer_signature: 'not-an-image' }))).status, 400);
  assert.equal((await createClient(server.baseUrl).request('POST', '/api/service-reports', body())).status, 401);
});

test('a save retried with the same client id returns the report it already made', async () => {
  const uuid = '3f0c1a52-7a1b-4c2e-9d8e-0a1b2c3d4e5f';
  const first = await ravi.client.request('POST', '/api/service-reports', body({ serial_no: 'S-RETRY', client_uuid: uuid }));
  const again = await ravi.client.request('POST', '/api/service-reports', body({ serial_no: 'S-RETRY', client_uuid: uuid }));
  assert.equal(first.status, 201);
  assert.equal(again.status, 200);
  assert.equal(again.body.id, first.body.id);
});
