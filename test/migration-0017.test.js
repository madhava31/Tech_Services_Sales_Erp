// Migration 0017 on data from before it: the nine stages become six, Abandoned becomes Lost, history
// follows, every salesperson gets ID letters and every opportunity an ID, and the single OEM becomes
// a list.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, loadMigrations, migrateLatest } from '../server/db/migrate.js';
import { testDatabaseUrl } from './helpers/testDb.js';
import { createCompany, createProduct, createSalesperson, createUser } from './helpers/fixtures.js';
import { query } from './helpers/testDb.js';

const ids = {};

async function withClient(fn) {
  const client = createClient(testDatabaseUrl());
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// An opportunity as the app stored it before 0017, with its history.
async function oldDeal({ owner, user, company, oemId, productId, stage, steps, createdDaysAgo }) {
  const closed = ['won', 'lost', 'abandoned'].includes(stage);
  const [{ id }] = await query(
    `INSERT INTO opportunity (company_id, title, owner_salesperson_id, original_owner_salesperson_id, stage, estimated_value, probability, expected_close_date,
                              oem_id, won_value, lost_reason, close_reason, closed_at, created_by, created_at)
     VALUES ($1, $2, $3, $3, $4, 100000, $5, '2099-01-01', $6, $7, $8, $9, ${closed ? 'NOW()' : 'NULL'}, $10, NOW() - make_interval(days => $11)) RETURNING id`,
    [company, `${stage} deal`, owner, stage, stage === 'won' ? 100 : closed ? 0 : 25, oemId, stage === 'won' ? 100000 : null, stage === 'lost' ? 'price' : null, closed ? 'Closed' : null, user, createdDaysAgo]
  );
  await query(`INSERT INTO opportunity_product (opportunity_id, product_id) VALUES ($1, $2)`, [id, productId]);
  for (const [i, s] of steps.entries()) {
    await query(`INSERT INTO opportunity_history (opportunity_id, change_type, from_value, to_value, changed_by) VALUES ($1, $2, $3, $4, $5)`, [id, i ? 'stage' : 'created', i ? steps[i - 1] : null, s, user]);
  }
  return id;
}

before(async () => {
  // Up to 0016 only, as production was.
  await withClient(async (client) => {
    await client.query('DROP SCHEMA public CASCADE');
    await client.query('CREATE SCHEMA public');
    await migrateLatest(client, loadMigrations().filter((m) => m.version < '0017'));
  });
  ids.ganesh = await createSalesperson('Ganesh');
  ids.ganesh2 = await createSalesperson('Ganesh Rao');
  ids.gita = await createSalesperson('Gita');
  ids.user = await createUser('admin', 'admin');
  ids.company = await createCompany('Old Labs', { createdBy: ids.user });
  const product = await createProduct('OLD-1');
  const base = { user: ids.user, company: ids.company, oemId: product.oem_id, productId: product.id };
  ids.oemId = product.oem_id;
  ids.deals = {
    prospect: await oldDeal({ ...base, owner: ids.ganesh, stage: 'new_prospect', steps: ['new_prospect'], createdDaysAgo: 30 }),
    visited: await oldDeal({ ...base, owner: ids.ganesh, stage: 'visit_completed', steps: ['new_prospect', 'visit_completed'], createdDaysAgo: 20 }),
    qualified: await oldDeal({ ...base, owner: ids.ganesh2, stage: 'qualified', steps: ['qualified'], createdDaysAgo: 10 }),
    requested: await oldDeal({ ...base, owner: ids.gita, stage: 'quotation_requested', steps: ['qualified', 'quotation_requested'], createdDaysAgo: 9 }),
    sent: await oldDeal({ ...base, owner: ids.gita, stage: 'quotation_sent', steps: ['quotation_sent'], createdDaysAgo: 8 }),
    abandoned: await oldDeal({ ...base, owner: ids.ganesh, stage: 'abandoned', steps: ['qualified', 'abandoned'], createdDaysAgo: 5 }),
  };
  await withClient((client) => migrateLatest(client));
});

test('stages map to the six new ones; Abandoned becomes Lost (no requirement)', async () => {
  const rows = await query(`SELECT id, stage, lost_reason, close_reason, closed_at FROM opportunity`);
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  const d = ids.deals;
  assert.equal(by[d.prospect].stage, 'create');
  assert.equal(by[d.visited].stage, 'qualify');
  assert.equal(by[d.qualified].stage, 'qualify');
  assert.equal(by[d.requested].stage, 'develop');
  assert.equal(by[d.sent].stage, 'prove');
  assert.equal(by[d.abandoned].stage, 'lost');
  assert.equal(by[d.abandoned].lost_reason, 'no_requirement');
  assert.equal(by[d.abandoned].close_reason, 'Closed', 'the written reason is kept');
  assert.ok(by[d.abandoned].closed_at);

  const history = await query(`SELECT to_value FROM opportunity_history WHERE opportunity_id = $1 ORDER BY id`, [d.abandoned]);
  assert.deepEqual(history.map((h) => h.to_value), ['qualify', 'lost'], 'history uses the new names');
  await assert.rejects(query(`UPDATE opportunity_history SET note = 'x' WHERE opportunity_id = $1`, [d.abandoned]), 'history is append-only again');

  const settings = await query(`SELECT stage FROM stage_setting ORDER BY stage`);
  assert.deepEqual(settings.map((s) => s.stage).sort(), ['create', 'develop', 'negotiation', 'prove', 'qualify']);
});

test('salespeople get ID letters from their names, and opportunities IDs numbered per person', async () => {
  const people = Object.fromEntries((await query(`SELECT id, id_prefix, next_opportunity_no FROM salesperson`)).map((p) => [p.id, p]));
  assert.equal(people[ids.ganesh].id_prefix, 'G');
  assert.equal(people[ids.ganesh2].id_prefix, 'GA', 'the second Ganesh takes the next letter of the name');
  assert.equal(people[ids.gita].id_prefix, 'GI');

  const codes = Object.fromEntries((await query(`SELECT id, code FROM opportunity`)).map((r) => [r.id, r.code]));
  const d = ids.deals;
  assert.equal(codes[d.prospect], 'TS-G-0001', 'oldest first');
  assert.equal(codes[d.visited], 'TS-G-0002');
  assert.equal(codes[d.abandoned], 'TS-G-0003');
  assert.equal(codes[d.qualified], 'TS-GA-0001');
  assert.equal(codes[d.requested], 'TS-GI-0001');
  assert.equal(codes[d.sent], 'TS-GI-0002');
  assert.equal(people[ids.ganesh].next_opportunity_no, 4, 'new ones continue the count');

  // A later one carries on, and an ID cannot be changed.
  const [{ code }] = await query(
    `INSERT INTO opportunity (company_id, title, owner_salesperson_id, original_owner_salesperson_id, stage, probability, created_by)
     VALUES ($1, 'New', $2, $2, 'create', 25, $3) RETURNING code`,
    [ids.company, ids.ganesh, ids.user]
  );
  assert.equal(code, 'TS-G-0004');
  await assert.rejects(query(`UPDATE opportunity SET code = 'TS-X-0001' WHERE id = $1`, [d.prospect]), /cannot be changed/);

  const [late] = await query(`INSERT INTO salesperson (employee_code, name) VALUES ('LATE', 'Gopal') RETURNING id_prefix`);
  assert.equal(late.id_prefix, 'GO', 'added later, the same rule');
});

test('the single OEM becomes the OEM list', async () => {
  const rows = await query(`SELECT opportunity_id, oem_id FROM opportunity_oem`);
  assert.equal(rows.length, Object.keys(ids.deals).length + 0);
  assert.ok(rows.every((r) => r.oem_id === ids.oemId));
  const [col] = await query(`SELECT COUNT(*)::int AS n FROM information_schema.columns WHERE table_name = 'opportunity' AND column_name = 'oem_id'`);
  assert.equal(col.n, 0);
});
