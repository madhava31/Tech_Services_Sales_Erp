// The demo / test-entry clean-up script: previews safely, refuses without confirmation, and removes only
// the chosen companies with everything attached to them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { startTestServer, createClient } from './helpers/server.js';
import { createCompany, createProduct, signedInSalesperson } from './helpers/fixtures.js';
import { query, testDatabaseUrl } from './helpers/testDb.js';

let server;
let rep;
let tagged;
let typedIn;
let keep;

const run = (...args) =>
  spawnSync(process.execPath, ['server/scripts/delete-demo.js', ...args], { env: { ...process.env, DATABASE_URL: testDatabaseUrl() }, encoding: 'utf-8' });
const count = async (table, where = 'TRUE', params = []) => (await query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${where}`, params))[0].n;

before(async () => {
  server = await startTestServer();
  rep = await signedInSalesperson(server.baseUrl, 'Ravi', createClient);
  tagged = await createCompany('Seeded Labs', { createdBy: rep.userId });
  await query(`UPDATE company SET category = 'Pharma (Demo)' WHERE id = $1`, [tagged]);
  typedIn = await createCompany('dell', { city: 'Hyderabad', createdBy: rep.userId });
  keep = await createCompany('Real Customer Pvt Ltd', { createdBy: rep.userId });

  const ap = await createProduct('DD-AP-1', 'Anton Paar');
  const pe = await createProduct('DD-PE-1', 'PerkinElmer');
  for (const companyId of [typedIn, keep]) {
    const res = await rep.client.request('POST', '/api/opportunities', {
      company_id: companyId,
      title: `Deal ${companyId}`,
      oem_ids: [ap.oem_id, pe.oem_id],
      product_ids: [ap.id],
      custom_products: [{ oem_id: pe.oem_id, name: 'Typed in product' }],
      estimated_value: 100000,
      expected_close_date: '2099-03-31',
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }
  await query(`INSERT INTO notification (user_id, kind, for_date, title, body, url, ref_type, ref_id) VALUES ($1, 'approval_request', CURRENT_DATE, 't', 'b', '/', 'company', $2)`, [rep.userId, typedIn]);
});

after(async () => {
  await server?.close();
});

test('refuses to delete without --confirm=DELETE', async () => {
  const res = run(`--company-ids=${typedIn}`);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /--confirm=DELETE/);
  assert.equal(await count('company', 'id = $1', [typedIn]), 1);
});

test('a dry run lists what would go and deletes nothing', async () => {
  const res = run(`--company-ids=${typedIn}`, '--dry-run');
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /DRY RUN/);
  assert.ok(res.stdout.includes(`#${typedIn}  dell (Hyderabad)`));
  assert.ok(res.stdout.includes(`#${tagged}  Seeded Labs`));
  assert.ok(!res.stdout.includes('Real Customer'), 'the other company is not mentioned');
  assert.equal(await count('company'), 3);
  assert.equal(await count('opportunity'), 2);
});

test('the confirmed delete removes the tagged and the chosen companies with their deals, and nothing else', async () => {
  const res = run(`--company-ids=${typedIn}`, '--confirm=DELETE');
  assert.equal(res.status, 0, res.stderr);
  assert.equal(await count('company', 'id = ANY($1::int[])', [[tagged, typedIn]]), 0);
  assert.equal(await count('opportunity', 'company_id = $1', [typedIn]), 0);
  assert.equal(await count('notification', `ref_type = 'company' AND ref_id = $1`, [typedIn]), 0);
  // The kept company and its deal, OEMs and typed-in product are all still there.
  assert.equal(await count('company', 'id = $1', [keep]), 1);
  assert.equal(await count('opportunity', 'company_id = $1', [keep]), 1);
  assert.equal(await count('opportunity_oem'), 2);
  assert.equal(await count('opportunity_custom_product'), 1);
});
