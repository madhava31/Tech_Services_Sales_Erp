// The 12-11-2026 upgrade: opportunity IDs, several OEMs, the stage chosen on creation (closing included),
// the competitor, and the universal search.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, createClient } from './helpers/server.js';
import { createCompany, createProduct, createUser, login, signedInSalesperson } from './helpers/fixtures.js';
import { query } from './helpers/testDb.js';

let server;
let ganesh;
let ganesh2;
let priya;
let manager;
let companyId;
let pe; // a PerkinElmer product
let ap; // an Anton Paar product
let apOther;

before(async () => {
  server = await startTestServer();
  ganesh = await signedInSalesperson(server.baseUrl, 'Ganesh', createClient);
  ganesh2 = await signedInSalesperson(server.baseUrl, 'Gaurav', createClient);
  priya = await signedInSalesperson(server.baseUrl, 'Priya', createClient);
  await createUser('manager', 'sales_manager');
  manager = createClient(server.baseUrl);
  await login(manager, 'manager');
  companyId = await createCompany('Upgrade Labs', { createdBy: ganesh.userId });
  pe = await createProduct('UP-PE-1', 'PerkinElmer');
  ap = await createProduct('UP-AP-1', 'Anton Paar');
  apOther = await createProduct('UP-AP-2', 'Anton Paar');
});

after(async () => {
  await server?.close();
});

const base = (body = {}) => ({
  company_id: companyId,
  title: 'Density meter',
  oem_ids: [ap.oem_id],
  product_ids: [ap.id],
  estimated_value: 800000,
  expected_close_date: '2099-03-31',
  ...body,
});

async function open(client, body) {
  const res = await client.request('POST', '/api/opportunities', base(body));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

test('IDs: TS + the salesperson’s letters + their own running number, kept on transfer', async () => {
  const [g] = await query(`SELECT id_prefix FROM salesperson WHERE id = $1`, [ganesh.salespersonId]);
  const [g2] = await query(`SELECT id_prefix FROM salesperson WHERE id = $1`, [ganesh2.salespersonId]);
  assert.equal(g.id_prefix, 'G');
  assert.equal(g2.id_prefix, 'GA', 'same first letter: the next letter of the name');

  const first = await open(ganesh.client, { title: 'First' });
  const second = await open(ganesh.client, { title: 'Second' });
  const theirs = await open(ganesh2.client, { title: 'Theirs' });
  assert.equal(first.code, 'TS-G-0001');
  assert.equal(second.code, 'TS-G-0002');
  assert.equal(theirs.code, 'TS-GA-0001');

  const moved = await manager.request('POST', `/api/opportunities/${first.id}/owner`, { to_salesperson_id: priya.salespersonId, reason: 'Territory change' });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.code, 'TS-G-0001', 'the ID never changes');
  assert.equal((await open(ganesh.client)).code, 'TS-G-0003');
});

test('IDs stay unique when many are saved at the same moment', async () => {
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => ganesh2.client.request('POST', '/api/opportunities', base({ title: `Parallel ${i}` }))));
  assert.ok(results.every((r) => r.status === 201));
  const codes = results.map((r) => r.body.code);
  assert.equal(new Set(codes).size, codes.length);
  assert.ok(codes.every((c) => /^TS-GA-\d{4}$/.test(c)));
});

test('several OEMs, each with its own products; found under each OEM', async () => {
  const both = await open(ganesh.client, { title: 'Two makes', oem_ids: [ap.oem_id, pe.oem_id], product_ids: [ap.id, apOther.id, pe.id] });
  assert.deepEqual(both.oems.map((o) => o.id).sort(), [ap.oem_id, pe.oem_id].sort());
  assert.equal(both.products.length, 3);

  const outside = await ganesh.client.request('POST', '/api/opportunities', base({ oem_ids: [ap.oem_id], product_ids: [pe.id] }));
  assert.equal(outside.status, 400);
  assert.match(outside.body.error, /is not a Anton Paar product/);
  const empty = await ganesh.client.request('POST', '/api/opportunities', base({ oem_ids: [ap.oem_id, pe.oem_id], product_ids: [ap.id] }));
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /at least one PerkinElmer product/);

  for (const oem of [ap.oem_id, pe.oem_id]) {
    const list = (await ganesh.client.request('GET', `/api/opportunities?oem_id=${oem}`)).body;
    assert.ok(list.some((d) => d.id === both.id), `found under OEM ${oem}`);
  }
  const insights = (await manager.request('GET', '/api/team/insights')).body;
  const names = insights.by_oem.map((r) => r.oem);
  assert.ok(names.includes('Anton Paar') && names.includes('PerkinElmer'), 'counted under each OEM');

  // Editing: taking an OEM off takes its products off.
  const edited = await ganesh.client.request('PUT', `/api/opportunities/${both.id}`, { oem_ids: [ap.oem_id] });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.deepEqual(edited.body.products.map((p) => p.id).sort(), [ap.id, apOther.id].sort());
  // An older client sending one oem_id still works.
  assert.equal((await ganesh.client.request('POST', '/api/opportunities', { ...base(), oem_ids: undefined, oem_id: ap.oem_id })).status, 201);
});

test('the stage is chosen on creation: Prove needs the quotation number; Closed needs won or lost details', async () => {
  assert.equal((await open(ganesh.client)).stage, 'create', 'Create by default');
  assert.equal((await open(ganesh.client, { stage: 'develop' })).stage, 'develop');

  const noQuote = await ganesh.client.request('POST', '/api/opportunities', base({ stage: 'prove' }));
  assert.equal(noQuote.status, 400);
  const proved = await open(ganesh.client, { stage: 'prove', quotation_number: 'TS/Q/77' });
  assert.equal(proved.stage, 'prove');
  assert.equal(proved.quotation_count, 1);
  const detail = (await ganesh.client.request('GET', `/api/opportunities/${proved.id}`)).body;
  assert.equal(detail.quotations[0].quotation_number, 'TS/Q/77');

  assert.equal((await ganesh.client.request('POST', '/api/opportunities', base({ stage: 'won', close_reason: 'PO in hand' }))).status, 400, 'won needs the value');
  const won = await open(ganesh.client, { stage: 'won', won_value: 750000, close_reason: 'PO in hand' });
  assert.equal(won.stage, 'won');
  assert.equal(won.won_value, 750000);
  assert.equal(won.probability, 100);
  assert.ok(won.closed_at);

  assert.equal((await ganesh.client.request('POST', '/api/opportunities', base({ stage: 'lost', close_reason: 'Too costly' }))).status, 400, 'lost needs the reason');
  assert.equal((await ganesh.client.request('POST', '/api/opportunities', base({ stage: 'lost', lost_reason: 'price' }))).status, 400, 'and what happened');
  const lost = await open(ganesh.client, { stage: 'lost', lost_reason: 'competitor', close_reason: 'Went with Shimadzu' });
  assert.equal(lost.stage, 'lost');
  assert.equal(lost.lost_reason, 'competitor');
  assert.equal(lost.probability, 0);
  const [history] = await query(`SELECT change_type, to_value, note FROM opportunity_history WHERE opportunity_id = $1`, [lost.id]);
  assert.deepEqual([history.change_type, history.to_value, history.note], ['created', 'lost', 'Went with Shimadzu']);
});

test('competitor: no idea, none, or named', async () => {
  assert.equal((await open(ganesh.client, { competitor: 'no_idea' })).competitor, 'no_idea');
  const unnamed = await ganesh.client.request('POST', '/api/opportunities', base({ competitor: 'other' }));
  assert.equal(unnamed.status, 400);
  assert.match(unnamed.body.error, /Name the competitor/);
  const named = await open(ganesh.client, { competitor: 'other', competitor_note: 'Shimadzu' });
  assert.equal(named.competitor_note, 'Shimadzu');
  assert.equal((await ganesh.client.request('POST', '/api/opportunities', base({ competitor: 'someone' }))).status, 400);
  const edited = (await ganesh.client.request('PUT', `/api/opportunities/${named.id}`, { competitor: 'no_competitor' })).body;
  assert.equal(edited.competitor, 'no_competitor');
  assert.equal(edited.competitor_note, null, 'the name goes with Other');
});

test('universal search: by ID with or without dashes, name, company and contact; only what you may see', async () => {
  const mine = await open(priya.client, { title: 'Rheometer for R&D', new_contact: { phone: '9000077777', name: 'Dr. Sunitha' } });
  const someoneElses = await open(ganesh.client, { title: 'Rheometer for QC' });

  const byCode = (await priya.client.request('GET', `/api/search?q=${encodeURIComponent(mine.code)}`)).body;
  assert.equal(byCode.opportunities[0].id, mine.id);
  const compact = (await priya.client.request('GET', `/api/search?q=${mine.code.replace(/-/g, '').toLowerCase()}`)).body;
  assert.equal(compact.opportunities[0].id, mine.id, '"tsp0001" finds TS-P-0001');

  const byName = (await priya.client.request('GET', '/api/search?q=rheometer')).body;
  assert.deepEqual(byName.opportunities.map((o) => o.id), [mine.id], 'not another salesperson’s');
  const managerSees = (await manager.request('GET', '/api/search?q=rheometer')).body;
  assert.deepEqual(managerSees.opportunities.map((o) => o.id).sort(), [mine.id, someoneElses.id].sort());

  const byCompany = (await priya.client.request('GET', '/api/search?q=upgrade labs')).body;
  assert.ok(byCompany.companies.some((c) => c.id === companyId));
  const byContact = (await priya.client.request('GET', '/api/search?q=sunitha')).body;
  assert.equal(byContact.contacts[0].name, 'Dr. Sunitha');
  assert.equal(byContact.contacts[0].company_id, companyId);
  const byPhone = (await priya.client.request('GET', '/api/search?q=90000 77777')).body;
  assert.equal(byPhone.contacts[0].name, 'Dr. Sunitha');

  assert.deepEqual((await priya.client.request('GET', '/api/search?q=r')).body.opportunities, [], 'needs 2 letters');
  assert.equal((await createClient(server.baseUrl).request('GET', '/api/search?q=rheometer')).status, 401);
});

test('admins can change a salesperson’s ID letters; they stay unique', async () => {
  await createUser('admin', 'admin');
  const admin = createClient(server.baseUrl);
  await login(admin, 'admin');
  assert.equal((await admin.request('PUT', `/api/admin/salespeople/${ganesh2.salespersonId}`, { id_prefix: 'G' })).status, 409);
  assert.equal((await admin.request('PUT', `/api/admin/salespeople/${ganesh2.salespersonId}`, { id_prefix: '9X' })).status, 400);
  const ok = await admin.request('PUT', `/api/admin/salespeople/${ganesh2.salespersonId}`, { id_prefix: 'gr' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.id_prefix, 'GR');
  assert.match((await open(ganesh2.client)).code, /^TS-GR-\d{4}$/, 'new IDs use the new letters');
});

test('a manager opens an opportunity for a chosen salesperson: it is theirs, with their letters', async () => {
  const none = await manager.request('POST', '/api/opportunities', base());
  assert.equal(none.status, 400);
  assert.match(none.body.error, /Choose which salesperson/);
  const made = await manager.request('POST', '/api/opportunities', base({ owner_salesperson_id: priya.salespersonId }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.owner_salesperson_id, priya.salespersonId);
  assert.match(made.body.code, /^TS-P-\d{4}$/);
});
