// The read-only database health check passes on a healthy database, and notices a broken one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resetTestDatabase, query, testDatabaseUrl } from './helpers/testDb.js';
import { createCompany, createSalesperson, createUser } from './helpers/fixtures.js';

const run = () => spawnSync(process.execPath, ['server/scripts/db-check.js'], { env: { ...process.env, DATABASE_URL: testDatabaseUrl() }, encoding: 'utf-8' });

test('the health check passes on a healthy database and changes nothing', async () => {
  await resetTestDatabase();
  const spId = await createSalesperson('Ravi');
  const userId = await createUser('ravi', 'salesperson', { salespersonId: spId });
  await createCompany('Check Labs', { createdBy: userId });
  const res = run();
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /checks passed\./);
  assert.ok(!res.stdout.includes('FAIL'), res.stdout);
  assert.equal((await query(`SELECT COUNT(*)::int AS n FROM company`))[0].n, 1, 'nothing was changed');
});

test('it reports data that breaks the rules of the app, and exits with an error', async () => {
  await resetTestDatabase();
  const spId = await createSalesperson('Priya');
  const userId = await createUser('priya', 'salesperson', { salespersonId: spId });
  const companyId = await createCompany('Odd State Labs', { createdBy: userId });
  await query(`UPDATE company SET state = 'Atlantis' WHERE id = $1`, [companyId]);
  const res = run();
  assert.equal(res.status, 1, res.stdout + res.stderr);
  assert.match(res.stdout, /FAIL {2}every company state is on the Indian list/);
  assert.match(res.stdout, /1 FAILED/);
});
