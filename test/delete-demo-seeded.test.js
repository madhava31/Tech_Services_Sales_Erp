// The clean-up script against the real demo seed: every kind of demo row (visits, tasks, quotations,
// tenders, instruments, reorder plans, history) goes in one transaction, and the demo salespeople and
// products with it. A preview changes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resetTestDatabase, query, testDatabaseUrl } from './helpers/testDb.js';
import { createUser } from './helpers/fixtures.js';

const run = (script, ...args) => spawnSync(process.execPath, [script, ...args], { env: { ...process.env, DATABASE_URL: testDatabaseUrl() }, encoding: 'utf-8' });
const count = async (table, where = 'TRUE') => (await query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${where}`))[0].n;

test('demo data from the seed is removed completely, and a preview removes nothing', async () => {
  await resetTestDatabase();
  await createUser('boss', 'admin');
  const seeded = run('server/scripts/seed-demo.js');
  assert.equal(seeded.status, 0, seeded.stderr);
  const before = { companies: await count('company'), deals: await count('opportunity'), visits: await count('visit'), tasks: await count('task') };
  assert.ok(before.companies > 0 && before.deals > 0 && before.visits > 0 && before.tasks > 0);

  const dry = run('server/scripts/delete-demo.js', '--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /DRY RUN/);
  assert.equal(await count('company'), before.companies);
  assert.equal(await count('opportunity'), before.deals);

  const real = run('server/scripts/delete-demo.js', '--confirm=DELETE');
  assert.equal(real.status, 0, real.stderr);
  for (const table of ['company', 'company_contact', 'opportunity', 'opportunity_oem', 'opportunity_product', 'opportunity_history', 'visit', 'task', 'requirement', 'quotation_link', 'tender', 'installed_instrument', 'reorder_plan']) {
    assert.equal(await count(table), 0, `${table} is empty`);
  }
  assert.equal(await count('salesperson'), 0, 'the demo salespeople are gone');
  assert.equal(await count('product', `part_number LIKE 'DEMO-%'`), 0, 'and the demo products');
  assert.equal(await count('app_user'), 1, 'the real login stays');
});
