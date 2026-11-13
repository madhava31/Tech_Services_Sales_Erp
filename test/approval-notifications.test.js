// A salesperson's new company: they are told it was sent, everyone who can approve is told who is
// asking, and after the decision the salesperson is told the answer and the others' requests close.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, createClient } from './helpers/server.js';
import { createUser, login, signedInSalesperson } from './helpers/fixtures.js';
import { query } from './helpers/testDb.js';

let server;
let ravi;
let admin;
let md;
let manager;
let office;

async function signIn(username, role) {
  await createUser(username, role);
  const client = createClient(server.baseUrl);
  await login(client, username);
  return client;
}

const items = async (client) => (await client.request('GET', '/api/notifications')).body;

before(async () => {
  server = await startTestServer();
  ravi = await signedInSalesperson(server.baseUrl, 'Ravi', createClient);
  admin = await signIn('admin', 'admin');
  md = await signIn('md', 'managing_director');
  manager = await signIn('manager', 'sales_manager');
  office = await signIn('office', 'office_staff');
});

after(async () => {
  await server?.close();
});

test('sending a company for approval notifies the salesperson and every approver', async () => {
  const created = await ravi.client.request('POST', '/api/companies', { name: 'Notify Labs', city: 'Pune' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.approval_status, 'pending');

  const mine = await items(ravi.client);
  assert.equal(mine.items[0].title, 'Sent for approval');
  assert.match(mine.items[0].body, /Notify Labs \(Pune\) is waiting/);
  assert.equal(mine.items[0].url, `/companies/${created.body.id}`);

  for (const client of [admin, md, manager]) {
    const n = await items(client);
    assert.equal(n.items[0].title, 'Company waiting for approval');
    assert.match(n.items[0].body, /Ravi is asking for approval of Notify Labs \(Pune\)/);
    assert.equal(n.items[0].url, '/approvals');
    assert.equal(n.unread, 1);
  }
  assert.equal((await items(office)).items.length, 0, 'office staff cannot approve, so are not asked');
});

test('the decision reaches the salesperson; the other approvers’ requests are marked done', async () => {
  const { body: company } = await ravi.client.request('POST', '/api/companies', { name: 'Decided Labs', city: 'Nashik' });
  assert.equal((await manager.request('POST', `/api/companies/${company.id}/approve`)).status, 200);

  const mine = await items(ravi.client);
  assert.equal(mine.items[0].title, 'Approved: Decided Labs');
  assert.match(mine.items[0].body, /approved Decided Labs \(Nashik\)/);
  const [request] = await query(
    `SELECT COUNT(*) FILTER (WHERE read_at IS NULL)::int AS open FROM notification WHERE kind = 'approval_request' AND ref_type = 'company' AND ref_id = $1`,
    [company.id]
  );
  assert.equal(request.open, 0, 'nobody is still asked to approve it');

  const { body: other } = await ravi.client.request('POST', '/api/companies', { name: 'Refused Labs', city: 'Thane' });
  assert.equal((await admin.request('POST', `/api/companies/${other.id}/reject`, { reason: 'Duplicate of an existing customer' })).status, 200);
  const after = await items(ravi.client);
  assert.equal(after.items[0].title, 'Rejected: Refused Labs');
  assert.match(after.items[0].body, /Duplicate of an existing customer/);
});

test('a manager’s own company needs no approval, so nobody is notified', async () => {
  const before = (await query(`SELECT COUNT(*)::int AS n FROM notification`))[0].n;
  const created = await manager.request('POST', '/api/companies', { name: 'Manager Labs', city: 'Goa' });
  assert.equal(created.body.approval_status, 'approved');
  assert.equal((await query(`SELECT COUNT(*)::int AS n FROM notification`))[0].n, before);
});

test('several approval notifications a day, while the daily digest stays once a day', async () => {
  await ravi.client.request('POST', '/api/companies', { name: 'Second Labs', city: 'Pune' });
  await ravi.client.request('POST', '/api/companies', { name: 'Third Labs', city: 'Pune' });
  const [{ n }] = await query(`SELECT COUNT(*)::int AS n FROM notification WHERE user_id = $1 AND kind = 'approval_sent'`, [ravi.userId]);
  assert.ok(n >= 4);
  await query(`INSERT INTO notification (user_id, kind, for_date, title, body, url) VALUES ($1, 'daily_digest', '2026-01-01', 't', 'b', '/')`, [ravi.userId]);
  await assert.rejects(query(`INSERT INTO notification (user_id, kind, for_date, title, body, url) VALUES ($1, 'daily_digest', '2026-01-01', 't', 'b', '/')`, [ravi.userId]));
});
