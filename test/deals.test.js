// Phase 4b: the full deal record, closing rules, overdue, contacts by phone and Excel export.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { startTestServer, createClient } from './helpers/server.js';
import { createCompany, createProduct, createUser, dealFieldsFor, login, signedInSalesperson } from './helpers/fixtures.js';
import { query } from './helpers/testDb.js';

let server;
let ravi;
let priya;
let manager;
let office;
let companyId;
let otherCompanyId;
let dealFields;

before(async () => {
  server = await startTestServer();
  ravi = await signedInSalesperson(server.baseUrl, 'Ravi', createClient);
  priya = await signedInSalesperson(server.baseUrl, 'Priya', createClient);
  await createUser('manager', 'sales_manager');
  manager = createClient(server.baseUrl);
  await login(manager, 'manager');
  await createUser('office', 'office_staff');
  office = createClient(server.baseUrl);
  await login(office, 'office');
  companyId = await createCompany('Delta Labs', { createdBy: ravi.userId });
  otherCompanyId = await createCompany('Gamma Labs', { createdBy: ravi.userId });
  dealFields = await dealFieldsFor('DEAL-1');
});

after(async () => {
  await server?.close();
});

const newDeal = (body = {}) => ({ company_id: companyId, title: 'AAS for QC lab', ...dealFields, ...body });

async function openDeal(client, body) {
  const res = await client.request('POST', '/api/opportunities', newDeal(body));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

const IST_TODAY = `(NOW() AT TIME ZONE 'Asia/Kolkata')::date`;
async function makeOverdue(dealId) {
  await query(`UPDATE opportunity SET expected_close_date = ${IST_TODAY} - 1 WHERE id = $1`, [dealId]);
}

test('a new deal needs a name, OEM, products, closing date and order value', async () => {
  for (const [field, message] of [
    ['title', /title is required/],
    ['oem_id', /Choose the OEM/],
    ['product_ids', /at least one product/],
    ['expected_close_date', /expected_close_date/],
    ['estimated_value', /order value/],
  ]) {
    const res = await ravi.client.request('POST', '/api/opportunities', newDeal({ [field]: undefined }));
    assert.equal(res.status, 400, field);
    assert.match(res.body.error, message);
  }
});

test('a deal stores every field, with defaults for probability and tender', async () => {
  const [segment] = await query(`SELECT id FROM market_segment WHERE name = 'Pharma'`);
  const deal = await openDeal(ravi.client, { segment_ids: [segment.id], probability_reason: 'Budget confirmed', notes: 'Wants training', estimated_value: 6850000 });
  assert.equal(deal.probability, 25);
  assert.equal(deal.tender, false);
  assert.equal(deal.oem_name, 'PerkinElmer');
  assert.equal(deal.products[0].id, dealFields.product_ids[0]);
  assert.equal(deal.segments[0].name, 'Pharma');
  assert.equal(deal.estimated_value, 6850000);
  assert.equal(deal.is_overdue, false);

  const tender = await openDeal(ravi.client, { tender: true, probability: 75 });
  assert.equal(tender.tender, true);
  assert.equal(tender.probability, 75);
  assert.equal((await ravi.client.request('POST', '/api/opportunities', newDeal({ probability: 40 }))).status, 400, 'only 25, 50, 75 or 100');
});

test('products must belong to the chosen OEM, and changing the OEM clears them', async () => {
  const mettler = await createProduct('DEAL-MT', 'Mettler Toledo');
  const wrong = await ravi.client.request('POST', '/api/opportunities', newDeal({ product_ids: [mettler.id] }));
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.error, /not a PerkinElmer product/);

  const inactive = await createProduct('DEAL-OLD', 'PerkinElmer', { active: false });
  assert.equal((await ravi.client.request('POST', '/api/opportunities', newDeal({ product_ids: [inactive.id] }))).status, 400, 'inactive products cannot be chosen');

  const deal = await openDeal(ravi.client);
  const noProducts = await ravi.client.request('PUT', `/api/opportunities/${deal.id}`, { oem_id: mettler.oem_id });
  assert.equal(noProducts.status, 400, 'a new OEM needs its own products');
  assert.match(noProducts.body.error, /at least one product/);
  const switched = await ravi.client.request('PUT', `/api/opportunities/${deal.id}`, { oem_id: mettler.oem_id, product_ids: [mettler.id] });
  assert.equal(switched.status, 200);
  assert.equal(switched.body.oem_name, 'Mettler Toledo');
  assert.deepEqual(switched.body.products.map((p) => p.id), [mettler.id]);
});

test('field changes are kept in the deal history and the audit log', async () => {
  const deal = await openDeal(ravi.client);
  const res = await ravi.client.request('PUT', `/api/opportunities/${deal.id}`, { estimated_value: 900000, probability: 50, tender: true });
  assert.equal(res.status, 200);
  const detail = (await ravi.client.request('GET', `/api/opportunities/${deal.id}`)).body;
  const fieldRows = detail.history.filter((h) => h.change_type === 'field');
  assert.deepEqual(fieldRows.map((h) => h.field).sort(), ['Order value', 'Tender', 'Win probability']);
  assert.equal(fieldRows.find((h) => h.field === 'Order value').from_value, '500000');
  assert.equal(fieldRows.find((h) => h.field === 'Order value').to_value, '900000');
  const [audit] = await query(`SELECT action, before, after FROM audit_log WHERE entity_type = 'opportunity' AND entity_id = $1 ORDER BY id DESC LIMIT 1`, [deal.id]);
  assert.equal(audit.action, 'opportunity.updated');
  assert.equal(audit.after['Win probability'], 50);
});

test('closing as won or lost needs a written reason; only a manager reopens', async () => {
  const deal = await openDeal(ravi.client);
  assert.equal((await ravi.client.request('POST', `/api/opportunities/${deal.id}/stage`, { stage: 'lost', lost_reason: 'no_requirement' })).status, 400);
  assert.equal((await ravi.client.request('POST', `/api/opportunities/${deal.id}/stage`, { stage: 'abandoned', close_reason: 'x' })).status, 400, 'Abandoned is gone: it is Lost');
  const lost = await ravi.client.request('POST', `/api/opportunities/${deal.id}/stage`, { stage: 'lost', lost_reason: 'no_requirement', close_reason: 'Project shelved' });
  assert.equal(lost.status, 200);
  assert.equal(lost.body.stage, 'lost');
  assert.equal(lost.body.close_reason, 'Project shelved');
  assert.ok(lost.body.closed_at);
  assert.equal((await ravi.client.request('PUT', `/api/opportunities/${deal.id}`, { title: 'x' })).status, 409, 'closed deals are read-only');
  assert.equal((await ravi.client.request('POST', `/api/opportunities/${deal.id}/stage`, { stage: 'qualify' })).status, 403);

  const reopened = await manager.request('POST', `/api/opportunities/${deal.id}/stage`, { stage: 'qualify' });
  assert.equal(reopened.status, 200);
  assert.equal(reopened.body.close_reason, null);
  const actions = (await query(`SELECT action FROM audit_log WHERE entity_type = 'opportunity' AND entity_id = $1 ORDER BY id`, [deal.id])).map((r) => r.action);
  assert.deepEqual(actions, ['opportunity.created', 'opportunity.lost', 'opportunity.reopened']);

  assert.equal((await office.request('POST', `/api/opportunities/${deal.id}/stage`, { stage: 'lost', lost_reason: 'price', close_reason: 'x' })).status, 403, 'office staff cannot close deals');
});

test('overdue: past its closing date in India time and not closed, listed first and filterable', async () => {
  const late = await openDeal(priya.client, { title: 'Late deal' });
  const onTime = await openDeal(priya.client, { title: 'On time' });
  await makeOverdue(late.id);

  const list = (await priya.client.request('GET', '/api/opportunities')).body;
  assert.equal(list[0].id, late.id, 'overdue deals come first');
  assert.equal(list[0].is_overdue, true);
  assert.equal(list.find((d) => d.id === onTime.id).is_overdue, false);
  const filtered = (await priya.client.request('GET', '/api/opportunities?overdue=1')).body;
  assert.deepEqual(filtered.map((d) => d.id), [late.id]);

  const today = (await priya.client.request('GET', '/api/today')).body;
  assert.deepEqual(today.overdue_deals.map((d) => d.id), [late.id], 'listed on Today');
  assert.equal((await ravi.client.request('GET', '/api/today')).body.overdue_deals.some((d) => d.id === late.id), false, 'only for its owner');

  const team = (await manager.request('GET', '/api/team/performance')).body;
  assert.equal(team.salespeople.find((p) => p.id === priya.salespersonId).metrics.overdue_deals, 1, 'counted per salesperson');

  // Due today is not overdue; a closed deal never is.
  await query(`UPDATE opportunity SET expected_close_date = ${IST_TODAY} WHERE id = $1`, [onTime.id]);
  assert.equal((await priya.client.request('GET', `/api/opportunities/${onTime.id}`)).body.is_overdue, false);
  await priya.client.request('POST', `/api/opportunities/${late.id}/stage`, { stage: 'lost', lost_reason: 'no_response', close_reason: 'Gone quiet' });
  assert.equal((await priya.client.request('GET', `/api/opportunities/${late.id}`)).body.is_overdue, false);
});

test('performance: weighted pipeline uses each deal’s probability; lost and overdue are counted', async () => {
  const rep = await signedInSalesperson(server.baseUrl, 'Weighted', createClient);
  await openDeal(rep.client, { estimated_value: 1000000, probability: 50 });
  const late = await openDeal(rep.client, { estimated_value: 400000, probability: 25 });
  await makeOverdue(late.id);
  const dropped = await openDeal(rep.client, { estimated_value: 9000000, probability: 100 });
  await rep.client.request('POST', `/api/opportunities/${dropped.id}/stage`, { stage: 'lost', lost_reason: 'no_requirement', close_reason: 'Shelved' });
  const m = (await rep.client.request('GET', '/api/performance')).body;
  assert.equal(m.open_deals, 2);
  assert.equal(m.pipeline_value, 1400000);
  assert.equal(m.weighted_pipeline, 600000);
  assert.equal(m.overdue_deals, 1);
  assert.equal(m.deals_lost, 1);
});

test('"+ Add customer number": creates, selects an existing contact, or blocks another company’s number', async () => {
  const first = await openDeal(ravi.client, { new_contact: { phone: '+91 98765 11111', name: 'Mr. Rao', designation: 'QC Head', email: 'rao@example.com' } });
  assert.equal(first.contact_name, 'Mr. Rao');
  assert.equal(first.contact_phone, '+91 98765 11111');
  const [contact] = await query(`SELECT company_id FROM company_contact WHERE id = $1`, [first.contact_id]);
  assert.equal(contact.company_id, companyId);

  const same = await openDeal(ravi.client, { new_contact: { phone: '098765-11111', name: 'Someone Else' } });
  assert.equal(same.contact_id, first.contact_id, 'the number already on this company selects that contact');

  const blocked = await ravi.client.request('POST', '/api/opportunities', newDeal({ company_id: otherCompanyId, new_contact: { phone: '9876511111', name: 'Other' } }));
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /Delta Labs/, 'names the company that has it');

  assert.equal((await ravi.client.request('POST', '/api/opportunities', newDeal({ new_contact: { name: 'No phone' } }))).status, 400);
  const foreign = await ravi.client.request('POST', '/api/opportunities', newDeal({ company_id: otherCompanyId, contact_id: first.contact_id }));
  assert.equal(foreign.status, 400, 'a contact of another company cannot be selected');
});

test('contact phone numbers are unique across all contacts', async () => {
  await ravi.client.request('POST', `/api/companies/${companyId}/contacts`, { name: 'First', phone: '9000022222' });
  const dup = await ravi.client.request('POST', `/api/companies/${otherCompanyId}/contacts`, { name: 'Second', phone: '+91 90000 22222' });
  assert.equal(dup.status, 409);
  assert.match(dup.body.error, /Delta Labs/);
  const { body: other } = await ravi.client.request('POST', `/api/companies/${otherCompanyId}/contacts`, { name: 'Third', phone: '9000033333' });
  assert.equal((await ravi.client.request('PUT', `/api/contacts/${other.id}`, { phone: '9000022222' })).status, 409);
  assert.equal((await ravi.client.request('PUT', `/api/contacts/${other.id}`, { designation: 'Same number is fine' })).status, 200);
  await assert.rejects(
    query(`INSERT INTO company_contact (company_id, name, phone, created_by) VALUES ($1, 'Direct', '09000022222', $2)`, [otherCompanyId, ravi.userId]),
    /company_contact_phone_unique/,
    'the database enforces it too'
  );
  // An archived contact's number is free again.
  await ravi.client.request('POST', `/api/contacts/${other.id}/archive`);
  assert.equal((await ravi.client.request('POST', `/api/companies/${companyId}/contacts`, { name: 'New holder', phone: '9000033333' })).status, 201);
});

test('quotation requests: the queue, recording a quotation with a link, and safe links only', async () => {
  const deal = await openDeal(ravi.client);
  await ravi.client.request('POST', `/api/opportunities/${deal.id}/stage`, { stage: 'develop' });
  assert.ok((await office.request('GET', '/api/opportunities/quotation-requests')).body.some((d) => d.id === deal.id));
  assert.equal((await office.request('POST', `/api/opportunities/${deal.id}/quotations`, { quotation_number: 'Q-1', document_url: 'javascript:alert(1)' })).status, 400);
  const q = await office.request('POST', `/api/opportunities/${deal.id}/quotations`, { quotation_number: 'Q-1', quotation_date: '2026-11-01', amount: 480000, document_url: 'https://erp.example.com/q/1.pdf' });
  assert.equal(q.status, 201);
  assert.equal(q.body.document_url, 'https://erp.example.com/q/1.pdf');
  assert.equal((await ravi.client.request('GET', `/api/opportunities/${deal.id}`)).body.stage, 'prove');
  assert.equal((await office.request('GET', '/api/opportunities/quotation-requests')).body.some((d) => d.id === deal.id), false);
});

async function readSheet(res) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(res.buffer);
  const sheet = workbook.getWorksheet('Opportunities');
  const header = sheet.getRow(1).values.slice(1);
  const rows = [];
  sheet.eachRow((row, n) => {
    if (n > 1) rows.push(Object.fromEntries(header.map((h, i) => [h, row.getCell(i + 1).value])));
  });
  return { header, rows };
}

test('Excel export: Admin only, in the agreed order, one OEM column pair per OEM, and only the chosen columns', async () => {
  const rep = await signedInSalesperson(server.baseUrl, 'Exporter', createClient);
  await createUser('exportadmin', 'admin');
  const admin = createClient(server.baseUrl);
  await login(admin, 'exportadmin');
  const late = await openDeal(rep.client, {
    title: 'Overdue export',
    estimated_value: 1000000,
    probability: 50,
    new_contact: { phone: '9000044444', name: 'Ms. Iyer', email: 'iyer@example.com', designation: 'QC Head', department: 'Quality' },
  });
  await makeOverdue(late.id);
  await openDeal(rep.client, { title: 'Not overdue' });

  for (const client of [rep.client, manager, office]) {
    assert.equal((await client.requestRaw('GET', '/api/opportunities/export.xlsx')).status, 403, 'only Admin downloads');
    assert.equal((await client.request('GET', '/api/opportunities/export-columns')).status, 403);
  }

  const mine = `owner_id=${rep.salespersonId}`;
  const res = await admin.requestRaw('GET', `/api/opportunities/export.xlsx?overdue=1&${mine}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /spreadsheetml/);
  const { header, rows } = await readSheet(res);
  assert.deepEqual(header, [
    'Created date', 'Company name', 'Contact name', 'Contact number', 'Contact email', 'Designation', 'Department', 'Opportunity ID', 'Opportunity',
    'OEM', 'Products (OEM)', 'Salesperson', 'Salesperson ID', 'Stage', 'Closing date',
    'Win probability %', 'Probability reason', 'Order value (INR)', 'Weighted value', 'Tender', 'Market segment', 'Competitor', 'Outcome', 'Overdue', 'Close reason / comments',
  ]);
  assert.equal(rows.length, 1, 'filters apply');
  const [row] = rows;
  assert.equal(row.Opportunity, 'Overdue export');
  assert.equal(row['Opportunity ID'], late.code);
  assert.deepEqual([row['Contact name'], row['Contact number'], row['Contact email'], row.Designation, row.Department], ['Ms. Iyer', '9000044444', 'iyer@example.com', 'QC Head', 'Quality']);
  assert.equal(row.Salesperson, 'Exporter');
  assert.equal(row['Salesperson ID'], 'E');
  assert.equal(row['Weighted value'], 500000);
  assert.equal(row.Overdue, 'Yes');

  // Two OEMs: each gets its own OEM and Products columns.
  const ap = await createProduct('EXPORT-AP', 'Anton Paar');
  await openDeal(rep.client, { title: 'Two makes', oem_ids: [dealFields.oem_id, ap.oem_id], product_ids: [...dealFields.product_ids, ap.id] });
  const multi = await readSheet(await admin.requestRaw('GET', `/api/opportunities/export.xlsx?${mine}`));
  assert.deepEqual(multi.header.slice(9, 13), ['OEM 1', 'Products (OEM 1)', 'OEM 2', 'Products (OEM 2)']);
  const two = multi.rows.find((r) => r.Opportunity === 'Two makes');
  assert.deepEqual([two['OEM 1'], two['OEM 2']].sort(), ['Anton Paar', 'PerkinElmer']);
  assert.equal(two[`Products (OEM ${two['OEM 1'] === 'Anton Paar' ? 1 : 2})`], 'Product EXPORT-AP');

  // Only the chosen columns, still in the agreed order.
  const chosen = await readSheet(await admin.requestRaw('GET', `/api/opportunities/export.xlsx?${mine}&columns=deal,code,salesperson`));
  assert.deepEqual(chosen.header, ['Opportunity ID', 'Opportunity', 'Salesperson']);
  assert.equal((await admin.requestRaw('GET', '/api/opportunities/export.xlsx?columns=nonsense')).status, 400);
  const columns = (await admin.request('GET', '/api/opportunities/export-columns')).body;
  assert.equal(columns[0].label, 'Created date');
  assert.ok(columns.some((c) => c.key === 'oems'));
});
