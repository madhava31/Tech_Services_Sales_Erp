import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, createClient } from './helpers/server.js';
import { createUser, login, signedInSalesperson } from './helpers/fixtures.js';
import { query } from './helpers/testDb.js';

let server;
let rep;
let office;

before(async () => {
  server = await startTestServer();
  rep = await signedInSalesperson(server.baseUrl, 'Ravi', createClient);
  await createUser('office', 'office_staff');
  office = createClient(server.baseUrl);
  await login(office, 'office');
});

after(async () => {
  await server?.close();
});

test('registering a company, with an optional first contact', async () => {
  const res = await rep.client.request('POST', '/api/companies', {
    name: 'ABC Engineering Pvt. Ltd.',
    city: 'Hyderabad',
    phone: '+91 98765 43210',
    gstin: '36abcde1234f1z5',
    contact: { name: 'Suresh', designation: 'Purchase Manager', phone: '9000000001' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.normalized_name, 'abc engineering');
  assert.equal(res.body.gstin, '36ABCDE1234F1Z5');
  assert.ok(res.body.primary_contact_id);

  const detail = await rep.client.request('GET', `/api/companies/${res.body.id}`);
  assert.equal(detail.body.contacts[0].name, 'Suresh');
  assert.equal((await query(`SELECT action FROM audit_log WHERE entity_type = 'company'`))[0].action, 'company.created');
});

test('an exact duplicate (same normalized name) is refused outright', async () => {
  const res = await rep.client.request('POST', '/api/companies', { name: 'M/s ABC Engineering Private Limited', city: ' hyderabad ', confirm_new: true });
  assert.equal(res.status, 409);
  assert.ok(res.body.duplicates.some((d) => d.exact));
});

test('similar names or the same phone need explicit confirmation', async () => {
  const similar = await rep.client.request('POST', '/api/companies', { name: 'ABC Engineerings', city: 'Hyderabad' });
  assert.equal(similar.status, 409);
  assert.equal(similar.body.requires_confirmation, true);
  assert.equal(similar.body.duplicates[0].name, 'ABC Engineering Pvt. Ltd.');

  const samePhone = await rep.client.request('POST', '/api/companies', { name: 'Totally Different Traders', phone: '098765-43210' });
  assert.equal(samePhone.status, 409);
  assert.ok(samePhone.body.duplicates[0].same_phone);

  // The same normalized name is one company, whatever the city.
  const otherCity = await rep.client.request('POST', '/api/companies', { name: 'ABC Engineering', city: 'Chennai', confirm_new: true });
  assert.equal(otherCity.status, 409);
});

test('check-duplicates and search find companies by fuzzy name, city and phone', async () => {
  const dupes = await rep.client.request('GET', '/api/companies/check-duplicates?name=abc%20enginering&city=Hyderabad');
  assert.ok(dupes.body.length >= 1);

  const byName = await rep.client.request('GET', '/api/companies?q=enginering');
  assert.ok(byName.body.some((c) => c.name === 'ABC Engineering Pvt. Ltd.'));
  const byPhone = await rep.client.request('GET', '/api/companies?q=43210');
  assert.ok(byPhone.body.some((c) => c.name === 'ABC Engineering Pvt. Ltd.'));
  const wildcard = await rep.client.request('GET', '/api/companies?q=%25');
  assert.equal(wildcard.status, 200);
});

test('renaming into an existing name is refused; edits are audited', async () => {
  const { body: c } = await rep.client.request('POST', '/api/companies', { name: 'Zeta Pumps', city: 'Pune' });
  const clash = await rep.client.request('PUT', `/api/companies/${c.id}`, { name: 'ABC Engineering', city: 'Hyderabad' });
  assert.equal(clash.status, 409);
  const ok = await rep.client.request('PUT', `/api/companies/${c.id}`, { phone: '020-555-1234' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.name, 'Zeta Pumps');
  const [entry] = await query(`SELECT before, after FROM audit_log WHERE action = 'company.updated' AND entity_id = $1`, [c.id]);
  assert.equal(entry.before.phone, null);
  assert.equal(entry.after.phone, '0205551234');
});

test('contacts can be added, edited and archived but not deleted', async () => {
  const { body: c } = await rep.client.request('POST', '/api/companies', { name: 'Kappa Valves', city: 'Vizag' });
  const added = await rep.client.request('POST', `/api/companies/${c.id}/contacts`, { name: 'Lakshmi', email: 'bad' });
  assert.equal(added.status, 400);
  const { body: contact } = await rep.client.request('POST', `/api/companies/${c.id}/contacts`, { name: 'Lakshmi', designation: 'Engineer' });
  const edited = await rep.client.request('PUT', `/api/contacts/${contact.id}`, { designation: 'Plant Head' });
  assert.equal(edited.body.designation, 'Plant Head');
  assert.equal(edited.body.name, 'Lakshmi');
  assert.equal((await rep.client.request('POST', `/api/contacts/${contact.id}/archive`)).status, 200);
  const detail = await rep.client.request('GET', `/api/companies/${c.id}`);
  assert.equal(detail.body.contacts.length, 0);
  assert.equal((await query(`SELECT COUNT(*)::int c FROM company_contact WHERE id = $1`, [contact.id]))[0].c, 1);
});

test('office staff can read companies but not change them', async () => {
  assert.equal((await office.request('GET', '/api/companies?q=abc')).status, 200);
  assert.equal((await office.request('POST', '/api/companies', { name: 'Office Co' })).status, 403);
});

test('validation errors are 400s with a clear message', async () => {
  const noName = await rep.client.request('POST', '/api/companies', { name: '   ' });
  assert.equal(noName.status, 400);
  assert.match(noName.body.error, /name is required/);
  const badEmail = await rep.client.request('POST', '/api/companies', { name: 'Omega', email: 'x@' });
  assert.equal(badEmail.status, 400);
});
