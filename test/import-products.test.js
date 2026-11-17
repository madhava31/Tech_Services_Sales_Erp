// The catalogue import: previews safely, adds the missing OEM only when asked, can be run twice, and the
// products then show up for a salesperson.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { startTestServer, createClient } from './helpers/server.js';
import { signedInSalesperson } from './helpers/fixtures.js';
import { query, testDatabaseUrl } from './helpers/testDb.js';
import { parseProductCsv } from '../server/crm/products.js';

let server;
let rep;
const CSV = 'server/db/seeds/technicon_products_seed.csv';
const run = (...args) => spawnSync(process.execPath, ['server/scripts/import-products.js', ...args], { env: { ...process.env, DATABASE_URL: testDatabaseUrl() }, encoding: 'utf-8' });
const count = async (sql, params = []) => (await query(sql, params))[0].n;

before(async () => {
  server = await startTestServer();
  rep = await signedInSalesperson(server.baseUrl, 'Ravi', createClient);
});

after(async () => {
  await server?.close();
});

test('the catalogue file is well formed: unique part numbers, names and makes', () => {
  const rows = parseProductCsv(fs.readFileSync(CSV, 'utf-8'));
  assert.ok(rows.length >= 90, `${rows.length} products`);
  assert.equal(new Set(rows.map((r) => r.part_number)).size, rows.length, 'part numbers are unique');
  assert.equal(new Set(rows.map((r) => `${r.make}|${r.name}`.toLowerCase())).size, rows.length, 'no product is listed twice under one make');
  const makes = [...new Set(rows.map((r) => r.make))].sort();
  assert.deepEqual(makes, ['Anton Paar', 'Merck', 'Mettler Toledo', 'PerkinElmer', 'SHINE', 'Technicon Services']);
});

test('a dry run saves nothing, and stops on the OEM that is missing unless told to add it', async () => {
  const stops = run('--dry-run');
  assert.notEqual(stops.status, 0);
  assert.match(stops.stderr, /Unknown make in the file: Technicon Services/);

  const dry = run('--dry-run', '--add-missing-oems');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /DRY RUN, nothing was saved/);
  assert.match(dry.stdout, /OEMs added: Technicon Services/);
  assert.equal(await count(`SELECT COUNT(*)::int AS n FROM product`), 0);
  assert.equal(await count(`SELECT COUNT(*)::int AS n FROM oem WHERE name = 'Technicon Services'`), 0, 'the OEM was rolled back too');
});

test('the real import adds everything, once, and a second run changes nothing', async () => {
  const rows = parseProductCsv(fs.readFileSync(CSV, 'utf-8'));
  const first = run('--add-missing-oems');
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, new RegExp(`${rows.length} added, 0 updated`));
  assert.equal(await count(`SELECT COUNT(*)::int AS n FROM product`), rows.length);
  assert.equal(await count(`SELECT COUNT(*)::int AS n FROM product WHERE is_active`), rows.length);

  const again = run('--add-missing-oems');
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, new RegExp(`0 added, ${rows.length} updated`));
  assert.equal(await count(`SELECT COUNT(*)::int AS n FROM product`), rows.length, 'no duplicates');
  assert.equal(await count(`SELECT COUNT(*)::int AS n FROM oem WHERE name = 'Technicon Services'`), 1);
});

test('a salesperson sees the products, by OEM and by search', async () => {
  const oems = (await rep.client.request('GET', '/api/oems')).body;
  const pe = oems.find((o) => o.name === 'PerkinElmer');
  const list = (await rep.client.request('GET', `/api/products?oem_id=${pe.id}&limit=500`)).body;
  assert.ok(list.length >= 30);
  assert.ok(list.some((p) => p.name.startsWith('PinAAcle')));
  const found = (await rep.client.request('GET', '/api/products?q=titrator&limit=50')).body;
  assert.ok(found.some((p) => p.name === 'Auto Titrator' && p.oem_name === 'Mettler Toledo'));
  const tc = oems.find((o) => o.name === 'Technicon Services');
  assert.ok((await rep.client.request('GET', `/api/products?oem_id=${tc.id}&limit=500`)).body.length >= 40);
});
