// A salesperson asks for a quotation (the opportunity enters Develop): the office here is told, the request is sent
// to the ERP (and retried if the ERP can't be reached), and recording the quotation closes it and tells the owner.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startTestServer, createClient } from './helpers/server.js';
import { createCompany, createUser, dealFieldsFor, login, signedInSalesperson } from './helpers/fixtures.js';
import { query } from './helpers/testDb.js';
import { processQuotationRequests } from '../server/erp/quotationRequest.js';

const WRITE_KEY = 'w'.repeat(40);
let server;
let ravi;
let office;
let manager;
let fields;
let erp;
let erpBehaviour = 'ok';
const received = [];

before(async () => {
  server = await startTestServer();
  ravi = await signedInSalesperson(server.baseUrl, 'Ravi', createClient);
  await createUser('office1', 'office_staff');
  office = createClient(server.baseUrl);
  await login(office, 'office1');
  await createUser('mgr1', 'sales_manager');
  manager = createClient(server.baseUrl);
  await login(manager, 'mgr1');
  fields = await dealFieldsFor('QR-1');

  // A stand-in for the ERP.
  erp = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url !== '/api/integration/v1/quotation-requests' || req.headers.authorization !== `Bearer ${WRITE_KEY}`) {
        res.writeHead(401);
        return res.end('{}');
      }
      if (erpBehaviour === 'down') {
        res.writeHead(500);
        return res.end('{}');
      }
      received.push(JSON.parse(body));
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 700 + received.length }));
    });
  });
  await new Promise((r) => erp.listen(0, '127.0.0.1', r));
  process.env.ERP_API_URL = `http://127.0.0.1:${erp.address().port}`;
  process.env.ERP_API_KEY = 'r'.repeat(40);
});

after(async () => {
  delete process.env.ERP_API_URL;
  delete process.env.ERP_API_KEY;
  delete process.env.ERP_API_WRITE_KEY;
  await new Promise((r) => erp.close(r));
  await server?.close();
});

async function newDeal(name) {
  const companyId = await createCompany(name, { city: 'Hyderabad', createdBy: ravi.userId });
  const res = await ravi.client.request('POST', '/api/opportunities', { company_id: companyId, title: `${name} deal`, ...fields });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}
const request = (deal) => ravi.client.request('POST', `/api/opportunities/${deal.id}/stage`, { stage: 'develop' });
const notes = (userId, kind) => query(`SELECT title, body FROM notification WHERE user_id = $1 AND kind = $2 ORDER BY id`, [userId, kind]);
const userId = async (name) => (await query(`SELECT id FROM app_user WHERE username = $1`, [name]))[0].id;

test('asking for a quotation tells the office and the managers, not the person asking; it waits when the ERP link is not set up', async () => {
  delete process.env.ERP_API_WRITE_KEY;
  const deal = await newDeal('Wait Labs');
  const res = await request(deal);
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const told = (await notes(await userId('office1'), 'quotation_request')).filter((n) => /Wait Labs/.test(n.body));
  assert.equal(told.length, 1);
  assert.match(told[0].body, /Ravi asks for a quotation for Wait Labs/);
  assert.ok(told[0].body.includes(deal.code), told[0].body);
  assert.equal((await notes(await userId('mgr1'), 'quotation_request')).filter((n) => /Wait Labs/.test(n.body)).length, 1);
  assert.equal((await notes(ravi.userId, 'quotation_request')).length, 0, 'the person asking is not told');

  const detail = (await ravi.client.request('GET', `/api/opportunities/${deal.id}`)).body;
  assert.equal(detail.quotation_request.state, 'waiting');
  assert.match(detail.quotation_request.note, /not set up/);
  assert.equal(received.length, 0, 'nothing was sent');

  // Asking again while one is open does not make a second.
  await processQuotationRequests();
  assert.equal((await query(`SELECT COUNT(*)::int AS n FROM quotation_request WHERE opportunity_id = $1`, [deal.id]))[0].n, 1);
  assert.equal((await notes(await userId('office1'), 'quotation_request')).filter((n) => /Wait Labs/.test(n.body)).length, 1, 'told once');
});

test('with the ERP link set up the request is sent with the company, products and value, once', async () => {
  process.env.ERP_API_WRITE_KEY = WRITE_KEY;
  erpBehaviour = 'ok';
  const deal = await newDeal('Sent Labs');
  await request(deal);

  const mineSent = () => received.filter((r) => r.opportunity_code === deal.code);
  assert.equal(mineSent().length, 1);
  const sent = mineSent()[0];
  assert.equal(sent.opportunity_code, deal.code);
  assert.equal(sent.company.name, 'Sent Labs');
  assert.equal(sent.requested_by, 'Ravi');
  assert.ok(sent.oems.length >= 1);
  assert.ok(sent.products.length >= 1);
  assert.ok(Number.isInteger(sent.sales_request_id));

  const [row] = await query(`SELECT sent_at, erp_request_id, last_error FROM quotation_request WHERE opportunity_id = $1`, [deal.id]);
  assert.ok(row.sent_at);
  assert.ok(row.erp_request_id >= 701);
  assert.equal((await ravi.client.request('GET', `/api/opportunities/${deal.id}`)).body.quotation_request.state, 'sent');

  await processQuotationRequests();
  assert.equal(mineSent().length, 1, 'sent once, not again');
});

test('when the ERP cannot be reached the request waits and goes out on the next try', async () => {
  process.env.ERP_API_WRITE_KEY = WRITE_KEY;
  erpBehaviour = 'down';
  const before = received.length;
  const deal = await newDeal('Retry Labs');
  const res = await request(deal);
  assert.equal(res.status, 200, 'the move itself is not undone');
  const [waiting] = await query(`SELECT sent_at, attempts, last_error FROM quotation_request WHERE opportunity_id = $1`, [deal.id]);
  assert.equal(waiting.sent_at, null);
  assert.ok(waiting.attempts >= 1);
  assert.match(waiting.last_error, /error \(500\)/);
  assert.equal((await ravi.client.request('GET', `/api/opportunities/${deal.id}`)).body.quotation_request.state, 'waiting');

  erpBehaviour = 'ok';
  const retry = await processQuotationRequests();
  assert.ok(retry.sent >= 1);
  assert.equal(received.length, before + 1);
  assert.equal((await notes(await userId('office1'), 'quotation_request')).filter((n) => /Retry Labs/.test(n.body)).length, 1, 'the office was told once, not on every try');
});

test('recording the quotation closes the request and tells the salesperson who owns it', async () => {
  process.env.ERP_API_WRITE_KEY = WRITE_KEY;
  erpBehaviour = 'ok';
  const deal = await newDeal('Done Labs');
  await request(deal);
  const res = await office.request('POST', `/api/opportunities/${deal.id}/quotations`, { quotation_number: 'Q-9001', amount: 125000, status: 'sent' });
  assert.equal(res.status, 201, JSON.stringify(res.body));

  assert.ok((await query(`SELECT done_at FROM quotation_request WHERE opportunity_id = $1`, [deal.id]))[0].done_at);
  const ready = (await notes(ravi.userId, 'quotation_ready')).filter((n) => /Done Labs/.test(n.title));
  assert.equal(ready.length, 1);
  assert.match(ready[0].body, /Q-9001/);
  assert.match(ready[0].body, /1,25,000/);
  assert.equal((await ravi.client.request('GET', `/api/opportunities/${deal.id}`)).body.quotation_request.state, 'done');
  // A quotation recorded by the owner themselves is not announced back to them.
  const mine = await newDeal('Own Labs');
  await request(mine);
  assert.equal((await ravi.client.request('POST', `/api/opportunities/${mine.id}/quotations`, { quotation_number: 'Q-9002', status: 'sent' })).status, 403, 'only the office records quotations');
});

test('"check for the quotation" sends what is waiting; a deleted opportunity takes its request with it', async () => {
  process.env.ERP_API_WRITE_KEY = WRITE_KEY;
  const deal = await newDeal('Check Labs');
  erpBehaviour = 'down';
  await request(deal);
  erpBehaviour = 'ok';
  const before = received.length;
  const res = await ravi.client.request('POST', `/api/opportunities/${deal.id}/refresh-quotation`, {});
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.requests.sent >= 1, true);
  assert.equal(received.length, before + 1);

  assert.equal((await ravi.client.request('DELETE', `/api/opportunities/${deal.id}`, {})).status, 200);
  assert.equal((await query(`SELECT COUNT(*)::int AS n FROM quotation_request WHERE opportunity_id = $1`, [deal.id]))[0].n, 0);
});
