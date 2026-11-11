// Migration 0016: the category comes from the segment list, pin codes, contact departments, and a company's
// contact person saved as a contact so opportunities can choose them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, createClient } from './helpers/server.js';
import { createUser, login, signedInSalesperson } from './helpers/fixtures.js';

let server;
let ravi;
let admin;

before(async () => {
  server = await startTestServer();
  ravi = await signedInSalesperson(server.baseUrl, 'Ravi', createClient);
  await createUser('admin', 'admin');
  admin = createClient(server.baseUrl);
  await login(admin, 'admin');
});

after(async () => {
  await server?.close();
});

test('the category is chosen from the segment list, and only an admin changes the list', async () => {
  const listed = await ravi.client.request('POST', '/api/companies', { name: 'Category Labs', city: 'Pune', category: 'non-pharma' });
  assert.equal(listed.status, 201, JSON.stringify(listed.body));
  assert.equal(listed.body.category, 'Non-pharma', 'spelled as it is on the list');

  const free = await ravi.client.request('POST', '/api/companies', { name: 'Free Text Labs', city: 'Pune', category: 'Food testing' });
  assert.equal(free.status, 400);
  assert.match(free.body.error, /category from the list/);

  assert.equal((await ravi.client.request('POST', '/api/market-segments', { name: 'Cosmetics' })).status, 403, 'a salesperson cannot add to the list');
  const added = await admin.request('POST', '/api/market-segments', { name: 'Cosmetics' });
  assert.equal(added.status, 201);
  const names = (await ravi.client.request('GET', '/api/market-segments')).body.map((s) => s.name);
  assert.deepEqual(names, ['Pharma', 'Non-pharma', 'Food', 'Research & Analytics', 'Cosmetics'], 'a new one goes after the four');
});

test('pin code is six digits', async () => {
  const good = await ravi.client.request('POST', '/api/companies', { name: 'Pin Labs', city: 'Hyderabad', address: 'Plot 4, IDA', pincode: '500032' });
  assert.equal(good.status, 201, JSON.stringify(good.body));
  assert.equal(good.body.pincode, '500032');
  const bad = await ravi.client.request('POST', '/api/companies', { name: 'Bad Pin Labs', city: 'Hyderabad', pincode: '5000' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /6 digits/);
});

test('the contact person becomes a contact; contacts keep a department', async () => {
  const company = await ravi.client.request('POST', '/api/companies', {
    name: 'Contact Labs',
    city: 'Chennai',
    contact_person: 'Dr. Iyer',
    contact: { name: 'Ms. Rao', designation: 'QC Head', department: 'Quality control', phone: '9000012345' },
  });
  assert.equal(company.status, 201, JSON.stringify(company.body));
  const detail = (await ravi.client.request('GET', `/api/companies/${company.body.id}`)).body;
  const byName = Object.fromEntries(detail.contacts.map((c) => [c.name, c]));
  assert.ok(byName['Dr. Iyer'], 'the contact person is a contact');
  assert.equal(byName['Ms. Rao'].department, 'Quality control');
  assert.equal(detail.contacts.length, 2);

  // What the new-company form sends: the contact person with their role, kept as one contact.
  const fromForm = await ravi.client.request('POST', '/api/companies', {
    name: 'Form Labs',
    city: 'Chennai',
    contact_person: 'Dr. Menon',
    contact: { name: 'Dr. Menon', designation: 'Lab Manager', department: 'R&D' },
  });
  assert.equal(fromForm.status, 201, JSON.stringify(fromForm.body));
  const formContacts = (await ravi.client.request('GET', `/api/companies/${fromForm.body.id}`)).body.contacts;
  assert.equal(formContacts.length, 1);
  assert.deepEqual([formContacts[0].designation, formContacts[0].department], ['Lab Manager', 'R&D']);

  // Typed twice (as contact person and as the person met), they are one contact.
  const same = await ravi.client.request('POST', '/api/companies', { name: 'Same Person Labs', city: 'Chennai', contact_person: 'Mr. Shah', contact: { name: 'mr. shah' } });
  assert.equal(same.status, 201, JSON.stringify(same.body));
  assert.equal((await ravi.client.request('GET', `/api/companies/${same.body.id}`)).body.contacts.length, 1);
});
