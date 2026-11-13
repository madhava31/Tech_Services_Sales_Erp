// The ERP sync, over real HTTP against a stand-in that answers like the ERP's read-only API.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startTestServer, createClient } from './helpers/server.js';
import { createCompany, createUser, dealFieldsFor, login, signedInSalesperson } from './helpers/fixtures.js';
import { query } from './helpers/testDb.js';

const KEY = 'test-key-'.padEnd(40, 'x');
let server;
let fakeErp;
let ravi;
let priya;
let manager;
let office;
let admin;
let runErpSync;
let requests = [];
let inFlight = 0;
let maxInFlight = 0;
let failPath = null;

const erp = {
  customers: [
    { id: 1, name: 'Exact Labs Pvt Ltd', state: 'Telangana', gstin: null, phone: '040' },
    { id: 2, name: 'Totally Renamed Industries', gstin: '36GST0001', state: null },
    { id: 3, name: 'Exak Labz', gstin: null },
    { id: 4, name: 'Brand New Customer', gstin: null, state: 'Goa', phone: '0832', email: 'x@example.com', contact_person: 'Ms. New' },
    { id: 5, name: 'Twin Labs', gstin: null },
  ],
  products: [
    { id: 11, part_no: 'ERP-AP-1', description: 'Density meter', make: 'Anton Paar', key_features: ['Fast', 7] },
    { id: 12, part_no: 'LOCAL-1', description: 'Renamed in ERP', make: 'PerkinElmer', key_features: [] },
    { id: 13, part_no: 'ERP-X', description: 'Unknown make', make: 'Mystery Co', key_features: [] },
  ],
  quotations: [
    { id: 21, number: 'Q-100', date: '2026-10-01', status: 'sent', total: 118000, company_id: 1 },
    { id: 22, number: 'Q-101', date: '2026-10-02', status: 'draft', total: 50000, company_id: 1 },
    { id: 23, number: 'Q-OTHER', date: '2026-10-03', status: 'sent', total: 900, company_id: 4 },
  ],
  orders: [{ id: 31, number: 'PO-1', date: '2026-10-05', quotation_id: 21, client_po_ref: 'CL-77', status: 'open' }],
};

before(async () => {
  fakeErp = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    requests.push(url.pathname);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const done = (status, body) =>
      setTimeout(() => {
        inFlight--;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      }, 2);
    if (req.headers.authorization !== `Bearer ${KEY}`) return done(401, { error: 'Invalid key' });
    const kind = url.pathname.split('/').pop();
    if (failPath === kind) return done(500, { error: 'secret internal detail' });
    const after = Number(url.searchParams.get('after_id'));
    const limit = Number(url.searchParams.get('limit'));
    done(200, (erp[kind] ?? []).filter((r) => r.id > after).slice(0, limit));
  });
  await new Promise((resolve) => fakeErp.listen(0, resolve));
  process.env.ERP_API_URL = `http://127.0.0.1:${fakeErp.address().port}`;
  process.env.ERP_API_KEY = KEY;

  server = await startTestServer();
  ({ runErpSync } = await import('../server/erp/sync.js'));
  ravi = await signedInSalesperson(server.baseUrl, 'Ravi', createClient);
  priya = await signedInSalesperson(server.baseUrl, 'Priya', createClient);
  for (const [name, role] of [['manager', 'sales_manager'], ['office', 'office_staff'], ['admin', 'admin']]) await createUser(name, role);
  manager = createClient(server.baseUrl);
  await login(manager, 'manager');
  office = createClient(server.baseUrl);
  await login(office, 'office');
  admin = createClient(server.baseUrl);
  await login(admin, 'admin');
});

after(async () => {
  delete process.env.ERP_API_URL;
  delete process.env.ERP_API_KEY;
  await server?.close();
  await new Promise((resolve) => fakeErp.close(resolve));
});

beforeEach(() => {
  requests = [];
  failPath = null;
});

test('only MD/Admin reach the sync screen; the connection refuses a plain http address and a missing key', async () => {
  for (const client of [ravi.client, manager, office]) assert.equal((await client.request('GET', '/api/admin/erp')).status, 403);
  assert.equal((await admin.request('GET', '/api/admin/erp')).body.problem, null);

  const url = process.env.ERP_API_URL;
  process.env.ERP_API_URL = 'http://erp.example.com';
  assert.match((await admin.request('GET', '/api/admin/erp')).body.problem, /https/);
  assert.equal((await admin.request('POST', '/api/admin/erp/run')).status, 409);
  process.env.ERP_API_URL = url;
  delete process.env.ERP_API_KEY;
  assert.match((await admin.request('GET', '/api/admin/erp')).body.problem, /ERP_API_KEY/);
  process.env.ERP_API_KEY = KEY;
});

test('customers: linked only when certain; the rest wait for a person; details here aren’t overwritten', async () => {
  const exact = await createCompany('Exact Labs', { createdBy: ravi.userId, city: 'Hyderabad' });
  await query(`UPDATE company SET phone = 'mine' WHERE id = $1`, [exact]);
  const byGstin = await createCompany('Old Name Works', { createdBy: ravi.userId });
  await query(`UPDATE company SET gstin = '36gst0001' WHERE id = $1`, [byGstin]);
  await createCompany('Exact Labz Trading', { createdBy: ravi.userId });

  const run = await admin.request('POST', '/api/admin/erp/run');
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.status, 'ok');
  assert.equal(run.body.counts.customers, 5);
  assert.equal(run.body.counts.customers_linked, 2);
  const [a] = await query(`SELECT erp_company_id, phone FROM company WHERE id = $1`, [exact]);
  assert.equal(a.erp_company_id, 1);
  assert.equal(a.phone, 'mine', 'the company here is left as it was');
  assert.equal((await query(`SELECT erp_company_id FROM company WHERE id = $1`, [byGstin]))[0].erp_company_id, 2);
  const [audit] = await query(`SELECT summary FROM audit_log WHERE action = 'company.erp_linked' AND entity_id = $1`, [exact]);
  assert.match(audit.summary, /Exact Labs Pvt Ltd/);

  const waiting = (await admin.request('GET', '/api/admin/erp/customers')).body;
  assert.deepEqual(waiting.map((c) => c.id).sort(), [3, 4, 5]);
  assert.ok(waiting.find((c) => c.id === 3).suggestions.some((s) => s.name === 'Exact Labz Trading'), 'closest names offered');
});

test('customers: two possible matches links neither; a person links, adds or sets aside', async () => {
  const twinA = await createCompany('Twin Labs', { createdBy: ravi.userId });
  const { body: twinB } = await manager.request('POST', '/api/companies', { name: 'Twin Labs', city: 'Pune', parent_company_id: twinA, confirm_new: true });
  await runErpSync({ trigger: 'manual' });
  // The branch doesn't compete with its parent, so the top-level company is the one match.
  assert.equal((await query(`SELECT erp_company_id FROM company WHERE id = $1`, [twinA]))[0].erp_company_id, 5);
  assert.equal((await query(`SELECT erp_company_id FROM company WHERE id = $1`, [twinB.id]))[0].erp_company_id, null);

  const target = await createCompany('Exact Labz Trading Two', { createdBy: ravi.userId });
  assert.equal((await manager.request('POST', `/api/admin/erp/customers/3/link`, { company_id: target })).status, 403);
  assert.equal((await admin.request('POST', '/api/admin/erp/customers/3/link', {})).status, 400);
  assert.equal((await admin.request('POST', '/api/admin/erp/customers/3/link', { company_id: target })).status, 200);
  assert.equal((await admin.request('POST', '/api/admin/erp/customers/3/link', { company_id: target })).status, 409, 'already linked');

  const added = await admin.request('POST', '/api/admin/erp/customers/4/add');
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const [fresh] = await query(`SELECT name, state, phone, email, contact_person, approval_status, erp_company_id FROM company WHERE id = $1`, [added.body.id]);
  assert.deepEqual(fresh, { name: 'Brand New Customer', state: 'Goa', phone: '0832', email: 'x@example.com', contact_person: 'Ms. New', approval_status: 'approved', erp_company_id: 4 });

  erp.customers.push({ id: 6, name: 'Not Tracked Here' });
  await runErpSync({ trigger: 'manual' });
  assert.equal((await admin.request('POST', '/api/admin/erp/customers/6/ignore')).status, 200);
  await runErpSync({ trigger: 'manual' });
  assert.ok(!(await admin.request('GET', '/api/admin/erp/customers')).body.some((c) => c.id === 6), 'a set-aside customer stays set aside');
});

test('products: added and updated by part number; unknown makes reported; category and active stay as set here', async () => {
  // Already synced by an earlier test, then changed here.
  const [local] = await query(`UPDATE product SET category = 'Kept category', is_active = FALSE WHERE part_number = 'LOCAL-1' RETURNING id`);
  const { counts } = await runErpSync({ trigger: 'manual' });
  assert.equal(counts.products, 2);
  assert.equal(counts.products_skipped, 1);
  assert.deepEqual(counts.unknown_makes, ['Mystery Co']);
  const [added] = await query(`SELECT name, key_features, erp_product_id FROM product WHERE part_number = 'ERP-AP-1'`);
  assert.deepEqual(added, { name: 'Density meter', key_features: ['Fast'], erp_product_id: 11 });
  const [updated] = await query(`SELECT name, category, is_active, erp_product_id FROM product WHERE id = $1`, [local.id]);
  assert.deepEqual(updated, { name: 'Renamed in ERP', category: 'Kept category', is_active: false, erp_product_id: 12 });
});

test('quotations: picked from the ERP on a deal, then kept current and locked', async () => {
  const [{ id: companyId }] = await query(`SELECT id FROM company WHERE erp_company_id = 1`);
  const fields = await dealFieldsFor('ERPQ-1');
  const { body: deal } = await ravi.client.request('POST', '/api/opportunities', { company_id: companyId, title: 'ERP deal', ...fields });

  const offered = await office.request('GET', `/api/opportunities/${deal.id}/erp-quotations`);
  assert.deepEqual(offered.body.map((q) => q.number).sort(), ['Q-100', 'Q-101'], 'only this customer’s');
  assert.equal((await priya.client.request('GET', `/api/opportunities/${deal.id}/erp-quotations`)).status, 404);
  assert.equal((await ravi.client.request('GET', `/api/opportunities/${deal.id}/erp-quotations`)).status, 200);

  assert.equal((await office.request('POST', `/api/opportunities/${deal.id}/quotations`, { erp_quotation_id: 23 })).status, 409, 'another customer’s quotation');
  assert.equal((await office.request('POST', `/api/opportunities/${deal.id}/quotations`, { erp_quotation_id: 999 })).status, 400);
  const picked = await office.request('POST', `/api/opportunities/${deal.id}/quotations`, { erp_quotation_id: 21 });
  assert.equal(picked.status, 201, JSON.stringify(picked.body));
  assert.equal(picked.body.quotation_number, 'Q-100');
  assert.equal(picked.body.amount, 118000);
  assert.equal(picked.body.quotation_date, '2026-10-01');
  assert.equal(picked.body.source, 'erp');
  assert.equal((await ravi.client.request('GET', `/api/opportunities/${deal.id}`)).body.stage, 'prove');
  assert.equal((await office.request('POST', `/api/opportunities/${deal.id}/quotations`, { erp_quotation_id: 21 })).status, 409);
  assert.ok(!(await office.request('GET', `/api/opportunities/${deal.id}/erp-quotations`)).body.some((q) => q.id === 21), 'no longer offered');

  assert.equal((await office.request('PUT', `/api/quotation-links/${picked.body.id}`, { status: 'rejected' })).status, 409, 'the ERP owns it');
  assert.equal((await office.request('PUT', `/api/quotation-links/${picked.body.id}`, { document_url: 'https://example.com/q.pdf' })).status, 200, 'the document link is still ours');

  erp.quotations[0] = { ...erp.quotations[0], status: 'accepted', total: 120000 };
  const { counts } = await runErpSync({ trigger: 'manual' });
  assert.equal(counts.quotations_updated, 1);
  const [link] = await query(`SELECT status, amount FROM quotation_link WHERE id = $1`, [picked.body.id]);
  assert.equal(link.status, 'accepted');
  assert.equal(link.amount, 120000);
  const [audit] = await query(`SELECT before, after FROM audit_log WHERE action = 'quotation.synced' AND entity_id = $1 ORDER BY id DESC LIMIT 1`, [deal.id]);
  assert.equal(audit.before.status, 'sent');
  assert.equal(audit.after.status, 'accepted');
  assert.equal((await runErpSync({ trigger: 'manual' })).counts.quotations_updated, 0, 'nothing new, nothing written');

  // An order shows on the deal and on Today; the deal stays open for a person to close.
  const seen = (await ravi.client.request('GET', `/api/opportunities/${deal.id}`)).body;
  assert.equal(seen.erp_orders[0].number, 'PO-1');
  assert.equal(seen.erp_orders[0].client_po_ref, 'CL-77');
  assert.equal(seen.stage, 'prove');
  assert.ok((await ravi.client.request('GET', '/api/today')).body.erp_orders.some((o) => o.id === deal.id));
  assert.ok(!(await priya.client.request('GET', '/api/today')).body.erp_orders.some((o) => o.id === deal.id));
  await ravi.client.request('POST', `/api/opportunities/${deal.id}/stage`, { stage: 'won', won_value: 120000, close_reason: 'PO received' });
  assert.ok(!(await ravi.client.request('GET', '/api/today')).body.erp_orders.some((o) => o.id === deal.id), 'gone once won');
});

test('quotations typed by hand: matched by number, but never across customers', async () => {
  const [{ id: companyId }] = await query(`SELECT id FROM company WHERE erp_company_id = 1`);
  const fields = await dealFieldsFor('ERPQ-2');
  const { body: deal } = await ravi.client.request('POST', '/api/opportunities', { company_id: companyId, title: 'Hand typed', ...fields });
  const { body: typed } = await office.request('POST', `/api/opportunities/${deal.id}/quotations`, { quotation_number: 'Q-101', amount: 1, status: 'draft' });
  const wrong = await office.request('POST', `/api/opportunities/${deal.id}/quotations`, { quotation_number: 'Q-OTHER', amount: 2, status: 'draft' });
  assert.equal(wrong.status, 201);

  const { counts } = await runErpSync({ trigger: 'manual' });
  assert.equal(counts.quotations_mismatched, 1);
  const [matched] = await query(`SELECT source, amount, erp_quotation_id FROM quotation_link WHERE id = $1`, [typed.id]);
  assert.deepEqual(matched, { source: 'erp', amount: 50000, erp_quotation_id: 22 });
  const [kept] = await query(`SELECT source, amount FROM quotation_link WHERE id = $1`, [wrong.body.id]);
  assert.deepEqual(kept, { source: 'manual', amount: 2 }, 'a number belonging to another customer is left alone');
});

test('one request at a time, a whole list across pages, and a failure stops only its own part', async () => {
  const many = Array.from({ length: 450 }, (_, i) => ({ id: 1000 + i, part_no: `BULK-${i}`, description: `Item ${i}`, make: 'Merck', key_features: [] }));
  const saved = erp.products;
  erp.products = many;
  maxInFlight = 0;
  const ok = await runErpSync({ trigger: 'manual' });
  erp.products = saved;
  assert.equal(ok.counts.products, 450, 'all pages');
  assert.equal(requests.filter((p) => p.endsWith('/products')).length, 3);
  assert.equal(maxInFlight, 1, 'never in parallel');

  failPath = 'quotations';
  const partial = await admin.request('POST', '/api/admin/erp/run');
  assert.equal(partial.body.status, 'partial');
  assert.equal(partial.body.errors[0].part, 'Quotations');
  assert.ok(!partial.body.errors[0].message.includes('secret'), 'the ERP’s own error text isn’t repeated');
  assert.ok(partial.body.counts.orders >= 1, 'the rest still ran');
  const [{ status }] = (await admin.request('GET', '/api/admin/erp')).body.runs;
  assert.equal(status, 'partial');

  const key = process.env.ERP_API_KEY;
  process.env.ERP_API_KEY = 'wrong-key';
  const refused = await admin.request('POST', '/api/admin/erp/run');
  process.env.ERP_API_KEY = key;
  assert.equal(refused.body.status, 'failed');
  assert.match(refused.body.errors[0].message, /refused the key/);
  assert.ok(!JSON.stringify(refused.body).includes('wrong-key'), 'the key is never shown');
});

test('nothing ever goes to the ERP but reads', async () => {
  const seen = [];
  const original = fakeErp.listeners('request')[0];
  fakeErp.removeAllListeners('request');
  fakeErp.on('request', (req, res) => {
    seen.push(req.method);
    original(req, res);
  });
  await runErpSync({ trigger: 'manual' });
  assert.ok(seen.length >= 4);
  assert.ok(seen.every((m) => m === 'GET'));
});

test('without a connection the app works as before', async () => {
  const url = process.env.ERP_API_URL;
  delete process.env.ERP_API_URL;
  try {
    const [{ id: companyId }] = await query(`SELECT id FROM company WHERE erp_company_id IS NULL AND approval_status = 'approved' LIMIT 1`);
    const fields = await dealFieldsFor('ERPQ-3');
    const { body: deal } = await ravi.client.request('POST', '/api/opportunities', { company_id: companyId, title: 'No ERP', ...fields });
    assert.deepEqual((await office.request('GET', `/api/opportunities/${deal.id}/erp-quotations`)).body, []);
    const typed = await office.request('POST', `/api/opportunities/${deal.id}/quotations`, { quotation_number: 'HAND-1', amount: 5 });
    assert.equal(typed.body.source, 'manual');
    assert.equal((await office.request('PUT', `/api/quotation-links/${typed.body.id}`, { status: 'accepted' })).status, 200);
  } finally {
    process.env.ERP_API_URL = url;
  }
});
