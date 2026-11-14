// Products typed in on one opportunity (not in the catalogue): kept on that opportunity only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, createClient } from './helpers/server.js';
import ExcelJS from 'exceljs';
import { createCompany, createProduct, createUser, login, signedInSalesperson } from './helpers/fixtures.js';
import { query } from './helpers/testDb.js';

let server;
let ravi;
let companyId;
let ap;
let pe;

before(async () => {
  server = await startTestServer();
  ravi = await signedInSalesperson(server.baseUrl, 'Ravi', createClient);
  companyId = await createCompany('Custom Labs', { createdBy: ravi.userId });
  ap = await createProduct('CP-AP-1', 'Anton Paar');
  pe = await createProduct('CP-PE-1', 'PerkinElmer');
});

after(async () => {
  await server?.close();
});

const base = (body = {}) => ({
  company_id: companyId,
  title: 'Custom product deal',
  oem_ids: [ap.oem_id],
  product_ids: [ap.id],
  estimated_value: 300000,
  expected_close_date: '2099-03-31',
  ...body,
});

test('a product typed in is saved on that opportunity only, never in the catalogue', async () => {
  const productsBefore = (await query(`SELECT COUNT(*)::int AS n FROM product`))[0].n;
  const created = await ravi.client.request('POST', '/api/opportunities', base({ custom_products: [{ oem_id: ap.oem_id, name: '  Special   rig  ' }] }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(created.body.custom_products.map((p) => [p.name, p.oem_id]), [['Special rig', ap.oem_id]], 'name tidied');
  assert.equal((await query(`SELECT COUNT(*)::int AS n FROM product`))[0].n, productsBefore, 'the catalogue is untouched');

  const catalogue = (await ravi.client.request('GET', '/api/products?limit=500')).body;
  assert.ok(!catalogue.some((p) => /special rig/i.test(p.name)), 'not in the product list');

  const other = await ravi.client.request('POST', '/api/opportunities', base({ title: 'Another deal' }));
  assert.equal(other.status, 201);
  assert.deepEqual(other.body.custom_products, [], 'another opportunity does not see it');
});

test('typed-in products alone satisfy "at least one product", per OEM', async () => {
  const only = await ravi.client.request('POST', '/api/opportunities', base({ product_ids: [], custom_products: [{ oem_id: ap.oem_id, name: 'Bench unit' }] }));
  assert.equal(only.status, 201, JSON.stringify(only.body));

  const none = await ravi.client.request('POST', '/api/opportunities', base({ product_ids: [], custom_products: [] }));
  assert.equal(none.status, 400);
  assert.match(none.body.error, /at least one product/i);

  const second = await ravi.client.request('POST', '/api/opportunities', base({ oem_ids: [ap.oem_id, pe.oem_id], custom_products: [] }));
  assert.equal(second.status, 400, 'the second OEM still needs a product');
  assert.match(second.body.error, /at least one PerkinElmer product/);
  const both = await ravi.client.request('POST', '/api/opportunities', base({ oem_ids: [ap.oem_id, pe.oem_id], custom_products: [{ oem_id: pe.oem_id, name: 'Custom PE kit' }] }));
  assert.equal(both.status, 201, JSON.stringify(both.body));
});

test('bad entries are refused', async () => {
  const empty = await ravi.client.request('POST', '/api/opportunities', base({ custom_products: [{ oem_id: ap.oem_id, name: '   ' }] }));
  assert.equal(empty.status, 400);
  const wrongOem = await ravi.client.request('POST', '/api/opportunities', base({ custom_products: [{ oem_id: pe.oem_id, name: 'Not chosen' }] }));
  assert.equal(wrongOem.status, 400);
  assert.match(wrongOem.body.error, /chosen OEMs/);
  const long = await ravi.client.request('POST', '/api/opportunities', base({ custom_products: [{ oem_id: ap.oem_id, name: 'x'.repeat(121) }] }));
  assert.equal(long.status, 400);
  const notList = await ravi.client.request('POST', '/api/opportunities', base({ custom_products: 'nope' }));
  assert.equal(notList.status, 400);
  // The same name twice (any case) is saved once.
  const dup = await ravi.client.request('POST', '/api/opportunities', base({ custom_products: [{ oem_id: ap.oem_id, name: 'Twin' }, { oem_id: ap.oem_id, name: 'TWIN' }] }));
  assert.equal(dup.status, 201);
  assert.equal(dup.body.custom_products.length, 1);
});

test('editing keeps, changes and removes them; taking an OEM off takes its typed-in products off', async () => {
  const deal = (await ravi.client.request('POST', '/api/opportunities', base({ oem_ids: [ap.oem_id, pe.oem_id], product_ids: [ap.id], custom_products: [{ oem_id: pe.oem_id, name: 'PE extra' }] }))).body;

  // Editing something else leaves them alone.
  const renamed = await ravi.client.request('PUT', `/api/opportunities/${deal.id}`, { title: 'Renamed' });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.deepEqual(renamed.body.custom_products.map((p) => p.name), ['PE extra']);

  const changed = await ravi.client.request('PUT', `/api/opportunities/${deal.id}`, { custom_products: [{ oem_id: pe.oem_id, name: 'PE extra' }, { oem_id: ap.oem_id, name: 'AP extra' }] });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.deepEqual(changed.body.custom_products.map((p) => p.name).sort(), ['AP extra', 'PE extra']);
  const history = (await ravi.client.request('GET', `/api/opportunities/${deal.id}`)).body;
  assert.match(JSON.stringify(history), /AP extra/, 'shown on the opportunity');

  const withoutPe = await ravi.client.request('PUT', `/api/opportunities/${deal.id}`, { oem_ids: [ap.oem_id] });
  assert.equal(withoutPe.status, 200, JSON.stringify(withoutPe.body));
  assert.deepEqual(withoutPe.body.custom_products.map((p) => p.name), ['AP extra']);

  const cleared = await ravi.client.request('PUT', `/api/opportunities/${deal.id}`, { custom_products: [] });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.deepEqual(cleared.body.custom_products, []);
});

test('the Excel download lists them under their OEM, for an admin', async () => {
  await createUser('boss', 'admin');
  const admin = createClient(server.baseUrl);
  await login(admin, 'boss');
  await ravi.client.request('POST', '/api/opportunities', base({ title: 'Export me', custom_products: [{ oem_id: ap.oem_id, name: 'Exported extra' }] }));
  const res = await admin.requestRaw('GET', '/api/opportunities/export.xlsx?columns=deal,oems');
  assert.equal(res.status, 200);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(res.buffer);
  const cells = [];
  book.worksheets[0].eachRow((row) => row.eachCell((cell) => cells.push(String(cell.value ?? ''))));
  assert.ok(cells.some((c) => c.includes('Exported extra')), 'the typed-in product is in the sheet');
});
