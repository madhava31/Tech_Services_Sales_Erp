// A company's state is always written the way the list does: from the ERP, and when mending what was copied earlier.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startTestServer, createClient } from './helpers/server.js';
import { createCompany, createUser, login, signedInSalesperson } from './helpers/fixtures.js';
import { query } from './helpers/testDb.js';
import { canonicalState } from '../server/crm/states.js';

let server;
let admin;
let ravi;

before(async () => {
  server = await startTestServer();
  ravi = await signedInSalesperson(server.baseUrl, 'Ravi', createClient);
  await createUser('boss', 'admin');
  admin = createClient(server.baseUrl);
  await login(admin, 'boss');
});

after(async () => {
  await server?.close();
});

test('other spellings of a state are matched to the list, and what is not a state is not guessed', () => {
  assert.equal(canonicalState('Dadra & Nagar Haveli & Daman & Diu'), 'Dadra and Nagar Haveli and Daman and Diu');
  assert.equal(canonicalState('DADRA AND NAGAR HAVELI'), 'Dadra and Nagar Haveli and Daman and Diu');
  assert.equal(canonicalState('Orissa'), 'Odisha');
  assert.equal(canonicalState('  telangana '), 'Telangana');
  assert.equal(canonicalState('Jammu & Kashmir'), 'Jammu and Kashmir');
  assert.equal(canonicalState('NCT of Delhi'), 'Delhi');
  assert.equal(canonicalState('Atlantis'), null);
  assert.equal(canonicalState(''), null);
  assert.equal(canonicalState(null), null);
});

test('adding a company from the ERP writes its state as the list does', async () => {
  await query(`INSERT INTO erp_customer (id, name, normalized_name, state) VALUES (9001, 'ALPLA India Private Limited', 'alpla india', 'Dadra & Nagar Haveli & Daman & Diu'), (9002, 'Odd State Traders', 'odd state traders', 'Atlantis')`);
  const first = await admin.request('POST', '/api/admin/erp/customers/9001/add', {});
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal((await query(`SELECT state FROM company WHERE id = $1`, [first.body.id]))[0].state, 'Dadra and Nagar Haveli and Daman and Diu');
  const second = await admin.request('POST', '/api/admin/erp/customers/9002/add', {});
  assert.equal(second.status, 201);
  assert.equal((await query(`SELECT state FROM company WHERE id = $1`, [second.body.id]))[0].state, null, 'not a state: left empty, not copied');
});

test('migration 0030 mends the spellings already copied, and leaves what it cannot place', async () => {
  const sql = fs.readFileSync(new URL('../server/db/migrations/0030_fix_company_states.sql', import.meta.url), 'utf8');
  const ids = {};
  for (const [name, state] of [['Mend One', 'Dadra & Nagar Haveli & Daman & Diu'], ['Mend Two', 'ORISSA'], ['Mend Three', 'Jammu & Kashmir'], ['Fine Co', 'Telangana'], ['Odd Co', 'Atlantis']]) {
    ids[name] = await createCompany(name, { createdBy: ravi.userId });
    await query(`UPDATE company SET state = $1 WHERE id = $2`, [state, ids[name]]);
  }
  await query(sql);
  const state = async (name) => (await query(`SELECT state FROM company WHERE id = $1`, [ids[name]]))[0].state;
  assert.equal(await state('Mend One'), 'Dadra and Nagar Haveli and Daman and Diu');
  assert.equal(await state('Mend Two'), 'Odisha');
  assert.equal(await state('Mend Three'), 'Jammu and Kashmir');
  assert.equal(await state('Fine Co'), 'Telangana');
  assert.equal(await state('Odd Co'), 'Atlantis', 'not an Indian state: left for a person to look at');
});

test('abbreviations such as A.P are matched, and migration 0031 mends them and the one typo', async () => {
  assert.equal(canonicalState('A.P'), 'Andhra Pradesh');
  assert.equal(canonicalState('A.P.'), 'Andhra Pradesh');
  assert.equal(canonicalState('ap'), 'Andhra Pradesh');
  assert.equal(canonicalState('T.S.'), 'Telangana');
  assert.equal(canonicalState('Atlantis'), null);

  const sql = fs.readFileSync(new URL('../server/db/migrations/0031_fix_state_abbreviations.sql', import.meta.url), 'utf8');
  const ids = {};
  for (const [name, state] of [['Abbrev One', 'A.P'], ['Abbrev Two', 'a.p.'], ['Typo Co', 'Andhra Prdesh'], ['Ts Co', 'TS'], ['Ok Co', 'Kerala'], ['Still Odd', 'Atlantis']]) {
    ids[name] = await createCompany(name, { createdBy: ravi.userId });
    await query(`UPDATE company SET state = $1 WHERE id = $2`, [state, ids[name]]);
  }
  await query(sql);
  const state = async (name) => (await query(`SELECT state FROM company WHERE id = $1`, [ids[name]]))[0].state;
  assert.equal(await state('Abbrev One'), 'Andhra Pradesh');
  assert.equal(await state('Abbrev Two'), 'Andhra Pradesh');
  assert.equal(await state('Typo Co'), 'Andhra Pradesh');
  assert.equal(await state('Ts Co'), 'Telangana');
  assert.equal(await state('Ok Co'), 'Kerala');
  assert.equal(await state('Still Odd'), 'Atlantis', 'not recognised: left for a person to look at');
});
