// Customer phone numbers are 10 digits without +91, and a company's state is chosen from the Indian list.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, createClient } from './helpers/server.js';
import { createCompany, signedInSalesperson } from './helpers/fixtures.js';
import { query } from './helpers/testDb.js';
import { tenDigitPhone, checkedPhone } from '../server/crm/phone.js';
import { INDIAN_STATES } from '../server/crm/states.js';

let server;
let rep;

before(async () => {
  server = await startTestServer();
  rep = await signedInSalesperson(server.baseUrl, 'Ravi', createClient);
});

after(async () => {
  await server?.close();
});

test('the country code and the zero in front are dropped; anything else must be exactly 10 digits', () => {
  for (const typed of ['9502660090', '+91 9502660090', '+91 95026 60090', '91 9502660090', '09502660090', '091-9502660090', '(+91) 95026-60090']) {
    assert.equal(tenDigitPhone(typed), '9502660090', typed);
  }
  assert.equal(checkedPhone(''), null);
  assert.equal(checkedPhone(null), null);
  for (const bad of ['950266009', '95026600901', '950266009012', '12345', '+91 95026600901']) {
    assert.throws(() => checkedPhone(bad), /must be 10 digits/, bad);
  }
  // A saved number that comes back unchanged is left alone, even if it is an older odd one.
  assert.equal(checkedPhone('040 2345 6789 / 9848012345', { keep: '040 2345 6789 / 9848012345' }), '040 2345 6789 / 9848012345');
});

test('a company phone is saved as 10 digits, and a longer one is refused', async () => {
  const ok = await rep.client.request('POST', '/api/companies', { name: 'Phone Labs', city: 'Hyderabad', phone: '+91 95026 60090' });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.phone, '9502660090');

  const tooLong = await rep.client.request('POST', '/api/companies', { name: 'Long Number Labs', phone: '95026600901' });
  assert.equal(tooLong.status, 400);
  assert.match(tooLong.body.error, /Company phone must be 10 digits/);
  const tooShort = await rep.client.request('POST', '/api/companies', { name: 'Short Number Labs', phone: '95026' });
  assert.equal(tooShort.status, 400);
});

test('a contact phone follows the same rule, on a new contact and on an edit', async () => {
  const companyId = await createCompany('Contact Phone Labs', { createdBy: rep.userId });
  const added = await rep.client.request('POST', `/api/companies/${companyId}/contacts`, { name: 'Anil', phone: '+91 98480 12345' });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.equal(added.body.phone, '9848012345');
  const refused = await rep.client.request('POST', `/api/companies/${companyId}/contacts`, { name: 'Bad', phone: '984801234567' });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /10 digits/);
  const edited = await rep.client.request('PUT', `/api/contacts/${added.body.id}`, { phone: '98480123456' });
  assert.equal(edited.status, 400);
});

test('an older odd number does not block editing something else', async () => {
  const companyId = await createCompany('Older Labs', { createdBy: rep.userId });
  await query(`UPDATE company SET phone = $1 WHERE id = $2`, ['040-2345 6789 / 98480 12345', companyId]);
  const renamedCity = await rep.client.request('PUT', `/api/companies/${companyId}`, { phone: '040-2345 6789 / 98480 12345', city: 'Warangal' });
  assert.equal(renamedCity.status, 200, JSON.stringify(renamedCity.body));
  assert.equal(renamedCity.body.phone, '040-2345 6789 / 98480 12345', 'left as it was');
  const changed = await rep.client.request('PUT', `/api/companies/${companyId}`, { phone: '98480 12345' });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.phone, '9848012345');
});

test('the state is chosen from the list of 28 states and 8 union territories', async () => {
  assert.equal(INDIAN_STATES.length, 36);
  assert.equal(new Set(INDIAN_STATES).size, 36);
  assert.ok(['Telangana', 'Andhra Pradesh', 'Delhi', 'Ladakh', 'Puducherry'].every((s) => INDIAN_STATES.includes(s)));

  const ok = await rep.client.request('POST', '/api/companies', { name: 'State Labs', city: 'Hyderabad', state: 'telangana' });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.state, 'Telangana', 'spelled as on the list');
  const bad = await rep.client.request('POST', '/api/companies', { name: 'Nowhere Labs', state: 'Atlantis' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /state from the list/);

  // An older free-text state is kept while it is not touched.
  const companyId = await createCompany('Old State Labs', { createdBy: rep.userId });
  await query(`UPDATE company SET state = $1 WHERE id = $2`, ['Andhra', companyId]);
  const same = await rep.client.request('PUT', `/api/companies/${companyId}`, { state: 'Andhra', city: 'Guntur' });
  assert.equal(same.status, 200, JSON.stringify(same.body));
  const fixed = await rep.client.request('PUT', `/api/companies/${companyId}`, { state: 'Andhra Pradesh' });
  assert.equal(fixed.body.state, 'Andhra Pradesh');
});
