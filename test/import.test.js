// Bulk import: companies, contacts and open deals, from CSV and Excel.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { startTestServer, createClient } from './helpers/server.js';
import { createProduct, createSalesperson, createUser, login, signedInSalesperson, PASSWORD } from './helpers/fixtures.js';
import { query } from './helpers/testDb.js';

let server;
let admin;
let adminCookieClient;
let manager;
let ravi;
let baseUrl;
let spId;

// Sends a file as the raw request body, the way the web app does.
async function upload(client, path, content) {
  const cookie = client.cookie();
  const res = await fetch(baseUrl + path, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Cookie: cookie }, body: content });
  return { status: res.status, body: await res.json() };
}

before(async () => {
  server = await startTestServer();
  baseUrl = server.baseUrl;
  await createUser('admin', 'admin');
  admin = createClient(baseUrl);
  await login(admin, 'admin', PASSWORD);
  adminCookieClient = admin;
  await createUser('manager', 'sales_manager');
  manager = createClient(baseUrl);
  await login(manager, 'manager');
  ravi = await signedInSalesperson(baseUrl, 'Ravi', createClient);
  spId = ravi.salespersonId;
  await query(`UPDATE salesperson SET employee_code = 'SE-001' WHERE id = $1`, [spId]);
  await createProduct('TS-AP-DMA', 'Anton Paar');
  await createProduct('TS-AP-RHEO', 'Anton Paar');
});

after(async () => {
  await server?.close();
});

test('only MD/Admin can import; templates download', async () => {
  assert.equal((await upload(manager, '/api/admin/import/companies/preview', 'Company\nX\n')).status, 403);
  assert.equal((await upload(ravi.client, '/api/admin/import/companies/commit', 'Company\nX\n')).status, 403);
  assert.equal((await upload(admin, '/api/admin/import/nonsense/preview', 'Company\nX\n')).status, 404);
  const template = await admin.requestRaw('GET', '/api/admin/import/deals/template');
  assert.equal(template.status, 200);
  assert.match(template.buffer.toString(), /Expected closing date/);
});

test('companies: the preview changes nothing; commit imports valid rows and skips the rest', async () => {
  await admin.request('POST', '/api/companies', { name: 'Already Here Ltd', phone: '0401111111' });
  const csv = [
    'Company,City,State,Phone,Email,Contact person,Category,GSTIN,Parent company',
    '"Lupin Labs, Pvt Ltd",Pune,Maharashtra,0202222222,info@lupin.example,Dr. A,Pharma,36abc,',
    'Lupin Labs,Goa,Goa,,,,,,Lupin Labs',
    'M/s Already Here,Hyderabad,,,,,,,',
    'Lupin Labs Private Limited,Pune,,,,,,,',
    ',Pune,,,,,,,',
    'Bad Mail Co,,,,not-an-email,,,,',
    'Orphan Branch,,,,,,,,No Such Parent',
    'Same Phone Co,,,0401111111,,,,,',
  ].join('\r\n');

  const preview = await upload(admin, '/api/admin/import/companies/preview', csv);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.deepEqual(preview.body.summary, { total: 8, new: 3, skip: 2, error: 3, warnings: 1 });
  const byRow = Object.fromEntries(preview.body.rows.map((r) => [r.row, r]));
  assert.match(byRow[4].warnings[0], /Already registered/);
  assert.match(byRow[5].warnings[0], /row 2 of this file/);
  assert.match(byRow[6].errors[0], /name is empty/);
  assert.match(byRow[7].errors[0], /not a valid email/);
  assert.match(byRow[8].errors[0], /No Such Parent/);
  assert.match(byRow[9].warnings[0], /Same phone number as "Already Here Ltd"/);
  assert.equal((await query(`SELECT COUNT(*)::int c FROM company WHERE name LIKE 'Lupin%'`))[0].c, 0, 'preview wrote nothing');

  const commit = await upload(admin, '/api/admin/import/companies/commit?name=customers.csv', csv);
  assert.equal(commit.status, 200, JSON.stringify(commit.body));
  assert.equal(commit.body.imported, 3);
  const [main] = await query(`SELECT * FROM company WHERE name = 'Lupin Labs, Pvt Ltd'`);
  assert.equal(main.approval_status, 'approved', 'an administrator’s import needs no second approval');
  assert.equal(main.gstin, '36ABC');
  assert.equal(main.category, 'Pharma');
  const [branch] = await query(`SELECT parent_company_id FROM company WHERE name = 'Lupin Labs' AND city = 'Goa'`);
  assert.equal(branch.parent_company_id, main.id, 'a parent earlier in the file works');
  const [audit] = await query(`SELECT summary, after FROM audit_log WHERE action = 'import.completed' ORDER BY id DESC LIMIT 1`);
  assert.match(audit.summary, /Imported 3 companies/);
  assert.equal(audit.after.ids.length, 3);
  assert.equal(audit.after.file, 'customers.csv');

  const twice = await upload(admin, '/api/admin/import/companies/commit', csv);
  assert.equal(twice.body.imported, 0, 'loading the same file again adds nothing');
});

test('a missing heading, an empty file and an unreadable Excel file are explained', async () => {
  const noName = await upload(admin, '/api/admin/import/companies/preview', 'City,State\nPune,MH\n');
  assert.equal(noName.status, 400);
  assert.match(noName.body.error, /no "company" column/);
  assert.equal((await upload(admin, '/api/admin/import/companies/preview', '')).status, 400);
  const fake = await upload(admin, '/api/admin/import/companies/preview', Buffer.from('PK not really a zip'));
  assert.equal(fake.status, 400);
  assert.match(fake.body.error, /could not be read/);
});

test('contacts: phone numbers stay unique; a number on another company is refused by name', async () => {
  const csv = [
    'Company,Contact,Designation,Phone,Email',
    'Lupin Labs Pvt Ltd,Dr. Mehta,QC Head,+91 90000 55555,mehta@lupin.example',
    'Lupin Labs Pvt Ltd,Dr. Mehta Again,,9000055555,',
    'Already Here Ltd,Mr. Khan,,090000-55555,',
    'No Such Company,Someone,,,',
    'Already Here Ltd,No Phone Person,,,',
    'Already Here Ltd,No Phone Person,,,',
  ].join('\n');
  const res = await upload(admin, '/api/admin/import/contacts/commit', csv);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.imported, 2);
  assert.deepEqual(res.body.summary, { total: 6, new: 2, skip: 2, error: 2, warnings: 0 });
  const byRow = Object.fromEntries(res.body.rows.map((r) => [r.row, r]));
  assert.match(byRow[3].warnings[0], /already Dr. Mehta/);
  assert.match(byRow[4].errors[0], /Lupin Labs/, 'names the company holding the number');
  assert.match(byRow[5].errors[0], /Import companies first/);
});

test('deals from Excel: every rule applies, cells are understood, and they land in the pipeline', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Deals');
  sheet.addRow(['Company', 'Deal', 'Salesperson', 'OEM', 'Products', 'Expected closing date', 'Order value (INR)', 'Win probability', 'Tender', 'Market segment', 'Stage', 'Phone', 'Contact', 'Comments', 'Quotation number']);
  sheet.addRow(['Lupin Labs Pvt Ltd', 'Density meter', 'SE-001', 'anton paar', 'TS-AP-DMA; Product TS-AP-RHEO', new Date(Date.UTC(2027, 2, 31)), 6850000, 0.75, 'Yes', 'Pharma; R&A', 'Quote sent', 9000055555, '', 'From old sheet', 'QTN-77']);
  sheet.addRow(['Lupin Labs Pvt Ltd', 'New contact deal', 'Ravi', 'Anton Paar', 'TS-AP-DMA', '31/03/2027', '₹1,25,000', '50%', 'No', '', '', '9000066666', 'Ms. New', '', '']);
  sheet.addRow(['Lupin Labs Pvt Ltd', 'Density meter', 'SE-001', 'Anton Paar', 'TS-AP-DMA', '31/03/2027', 1000, '', '', '', '', '', '', '', '']);
  sheet.addRow(['Nobody Ltd', 'x', 'SE-001', 'Anton Paar', 'TS-AP-DMA', '31/03/2027', 1000, '', '', '', '', '', '', '', '']);
  sheet.addRow(['Lupin Labs Pvt Ltd', 'Bad everything', 'Ghost', 'Unknown OEM', 'TS-AP-DMA', '2027/31/31', 'lots', '', 'maybe', 'Nope', 'Won', '', '', '', '']);
  sheet.addRow(['Lupin Labs Pvt Ltd', 'Wrong make', 'SE-001', 'PerkinElmer', 'TS-AP-DMA', '31-Mar-2027', 1000, '', '', '', '', '', '', '', '']);
  sheet.addRow(['Lupin Labs Pvt Ltd', 'Needs quote', 'SE-001', 'Anton Paar', 'TS-AP-DMA', '31.03.2027', 1000, '', '', '', 'Negotiation', '', '', '', '']);
  sheet.addRow(['Lupin Labs Pvt Ltd', 'Bad probability', 'SE-001', 'Anton Paar', 'TS-AP-DMA', '31/03/2027', 1000, 40, '', '', '', '', '', '', '']);
  const file = Buffer.from(await workbook.xlsx.writeBuffer());

  const res = await upload(admin, '/api/admin/import/deals/commit', file);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.imported, 2, JSON.stringify(res.body.rows));
  const byRow = Object.fromEntries(res.body.rows.map((r) => [r.row, r]));
  assert.match(byRow[4].warnings[0], /same|already exists/i);
  assert.match(byRow[5].errors[0], /Nobody Ltd/);
  const messages = byRow[6].errors.join(' | ');
  for (const part of [/Ghost/, /Unknown OEM/, /is not a date/, /not an order value/, /Yes or No/, /Nope/, /not an open stage/]) assert.match(messages, part);
  assert.match(byRow[7].errors[0], /not an active PerkinElmer product/);
  assert.match(byRow[8].errors[0], /quotation number/);
  assert.match(byRow[9].errors[0], /probability/);

  const deals = (await ravi.client.request('GET', '/api/opportunities')).body;
  const first = deals.find((d) => d.title === 'Density meter');
  assert.equal(first.stage, 'prove');
  assert.equal(first.estimated_value, 6850000);
  assert.equal(first.probability, 75);
  assert.equal(first.tender, true);
  assert.equal(first.expected_close_date, '2027-03-31');
  assert.equal(first.oem_name, 'Anton Paar');
  assert.equal(first.products.length, 2);
  assert.equal(first.segments.length, 2);
  assert.equal(first.contact_name, 'Dr. Mehta');
  assert.equal(first.quotation_count, 1);
  const second = deals.find((d) => d.title === 'New contact deal');
  assert.equal(second.estimated_value, 125000);
  assert.equal(second.probability, 50);
  assert.equal(second.contact_name, 'Ms. New', 'a new number with a name creates the contact');
  assert.equal(second.stage, 'create');
  assert.equal(second.owner_name, 'Ravi');
});

test('deals cannot go to someone who left, or onto a company waiting for approval', async () => {
  await createSalesperson('Gone Person', { active: false });
  await ravi.client.request('POST', '/api/companies', { name: 'Waiting Approval Co' });
  const csv = [
    'Company,Deal,Salesperson,OEM,Products,Expected closing date,Order value',
    'Lupin Labs Pvt Ltd,A,Gone Person,Anton Paar,TS-AP-DMA,31/03/2027,1000',
    'Waiting Approval Co,B,SE-001,Anton Paar,TS-AP-DMA,31/03/2027,1000',
  ].join('\n');
  const { body } = await upload(admin, '/api/admin/import/deals/preview', csv);
  assert.equal(body.summary.error, 2);
  assert.match(body.rows[0].errors[0], /has left/);
  assert.match(body.rows[1].errors[0], /not approved/);
  assert.ok(adminCookieClient);
});
