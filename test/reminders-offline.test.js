// Daily reminders, push subscriptions, and what offline sync relies on: safe retries, stale-edit
// detection and the data a phone keeps.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startTestServer, createClient } from './helpers/server.js';
import { createCompany, createUser, dealFieldsFor, login, signedInSalesperson } from './helpers/fixtures.js';
import { query } from './helpers/testDb.js';

let server;
let ravi;
let priya;
let manager;
let office;
let companyId;
let runDailyReminders;
let isAllowedPushEndpoint;

const IST_TODAY = `(NOW() AT TIME ZONE 'Asia/Kolkata')::date`;

before(async () => {
  server = await startTestServer();
  ({ runDailyReminders, isAllowedPushEndpoint } = await import('../server/crm/reminders.js'));
  ravi = await signedInSalesperson(server.baseUrl, 'Ravi', createClient);
  priya = await signedInSalesperson(server.baseUrl, 'Priya', createClient);
  await createUser('manager', 'sales_manager');
  manager = createClient(server.baseUrl);
  await login(manager, 'manager');
  await createUser('office', 'office_staff');
  office = createClient(server.baseUrl);
  await login(office, 'office');
  companyId = await createCompany('Reminder Labs', { createdBy: ravi.userId });
});

after(async () => {
  await server?.close();
});

const GOOD_ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc123';

test('push subscriptions: only real push services, and only your own', async () => {
  assert.equal(isAllowedPushEndpoint('https://web.push.apple.com/x'), true);
  assert.equal(isAllowedPushEndpoint('http://fcm.googleapis.com/x'), false);
  assert.equal(isAllowedPushEndpoint('https://fcm.googleapis.com.evil.example/x'), false);
  assert.equal(isAllowedPushEndpoint('https://169.254.169.254/latest'), false);
  assert.equal(isAllowedPushEndpoint('not a url'), false);

  const keys = { p256dh: 'p', auth: 'a' };
  assert.equal((await ravi.client.request('POST', '/api/notifications/push/subscribe', { endpoint: 'https://evil.example/x', keys })).status, 400);
  assert.equal((await ravi.client.request('POST', '/api/notifications/push/subscribe', { endpoint: GOOD_ENDPOINT })).status, 400);
  assert.equal((await ravi.client.request('POST', '/api/notifications/push/subscribe', { endpoint: GOOD_ENDPOINT, keys })).status, 201);
  assert.equal((await ravi.client.request('POST', '/api/notifications/push/subscribe', { endpoint: GOOD_ENDPOINT, keys })).status, 201, 'subscribing again is fine');
  await priya.client.request('POST', '/api/notifications/push/unsubscribe', { endpoint: GOOD_ENDPOINT });
  assert.equal((await query(`SELECT COUNT(*)::int c FROM push_subscription WHERE endpoint = $1`, [GOOD_ENDPOINT]))[0].c, 1, 'someone else cannot remove it');
});

test('the daily digest: each person’s own work, once a day, pushed to their phone', async () => {
  const task = (await ravi.client.request('POST', '/api/tasks', { company_id: companyId, title: 'Due today', due_date: '2099-01-01' })).body;
  await query(`UPDATE task SET due_date = ${IST_TODAY} WHERE id = $1`, [task.id]);
  const late = (await ravi.client.request('POST', '/api/tasks', { company_id: companyId, title: 'Late', due_date: '2099-01-01' })).body;
  await query(`UPDATE task SET due_date = ${IST_TODAY} - 2 WHERE id = $1`, [late.id]);
  const fields = await dealFieldsFor('REM-1');
  const deal = (await ravi.client.request('POST', '/api/opportunities', { company_id: companyId, title: 'Late deal', ...fields })).body;
  await query(`UPDATE opportunity SET expected_close_date = ${IST_TODAY} - 1 WHERE id = $1`, [deal.id]);

  const sent = [];
  const first = await runDailyReminders({ send: async (subscription, payload) => sent.push({ endpoint: subscription.endpoint, payload }) });
  assert.equal(first.pushed, 1);
  assert.equal(sent[0].endpoint, GOOD_ENDPOINT);
  assert.equal(sent[0].payload.body, '1 follow-up due today, 1 follow-up overdue, 1 opportunity past closing date');

  const again = await runDailyReminders({ send: async (s, payload) => sent.push(payload) });
  assert.equal(again.created, 0, 'a restart or second run sends nothing new');
  assert.equal(sent.length, 1);

  const mine = (await ravi.client.request('GET', '/api/notifications')).body;
  assert.equal(mine.unread, 1);
  assert.match(mine.items[0].body, /1 opportunity past closing date/);
  assert.equal((await priya.client.request('GET', '/api/notifications')).body.items.length, 0, 'nothing due, so no digest');
  assert.equal((await office.request('GET', '/api/notifications')).body.items.length, 0, 'office staff own no follow-ups');

  const team = (await manager.request('GET', '/api/notifications')).body;
  assert.equal(team.items[0].title, 'Team today');
  assert.equal(team.items[0].body, '1 follow-up overdue, 1 opportunity past closing date');
  assert.equal(team.items[0].url, '/team');

  assert.equal((await ravi.client.request('POST', '/api/notifications/read-all')).status, 200);
  assert.equal((await ravi.client.request('GET', '/api/notifications')).body.unread, 0);
  assert.equal((await manager.request('GET', '/api/notifications')).body.unread, 1, 'only your own are marked read');
});

test('a subscription the browser ended is removed; a temporary failure keeps it', async () => {
  await query(`DELETE FROM notification`);
  await priya.client.request('POST', '/api/notifications/push/subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/ended', keys: { p256dh: 'p', auth: 'a' } });
  const task = (await priya.client.request('POST', '/api/tasks', { company_id: companyId, title: 'Due', due_date: '2099-01-01' })).body;
  await query(`UPDATE task SET due_date = ${IST_TODAY} WHERE id = $1`, [task.id]);
  const result = await runDailyReminders({
    send: async (subscription) => {
      const err = new Error('nope');
      err.statusCode = subscription.endpoint.endsWith('ended') ? 410 : 500;
      throw err;
    },
  });
  assert.equal(result.removed, 1);
  assert.equal((await query(`SELECT COUNT(*)::int c FROM push_subscription WHERE endpoint LIKE '%ended'`))[0].c, 0);
  assert.equal((await query(`SELECT COUNT(*)::int c FROM push_subscription WHERE endpoint = $1`, [GOOD_ENDPOINT]))[0].c, 1);
});

test('a retried change with the same key is applied once and answered the same', async () => {
  const key = randomUUID();
  const body = { company_id: companyId, title: 'Once only', due_date: '2099-02-02' };
  const first = await ravi.client.request('POST', '/api/tasks', body, { 'Idempotency-Key': key });
  assert.equal(first.status, 201);
  const retry = await ravi.client.request('POST', '/api/tasks', body, { 'Idempotency-Key': key });
  assert.equal(retry.status, 201);
  assert.equal(retry.body.id, first.body.id);
  assert.equal((await query(`SELECT COUNT(*)::int c FROM task WHERE title = 'Once only'`))[0].c, 1);

  // The key belongs to one person, and a malformed one is refused.
  const other = await priya.client.request('POST', '/api/tasks', { ...body, title: 'Priya too' }, { 'Idempotency-Key': key });
  assert.notEqual(other.body.id, first.body.id);
  assert.equal((await ravi.client.request('POST', '/api/tasks', body, { 'Idempotency-Key': 'nonsense' })).status, 400);

  // A failure isn't remembered: the same key can try again.
  const failKey = randomUUID();
  assert.equal((await ravi.client.request('POST', '/api/tasks', { company_id: companyId }, { 'Idempotency-Key': failKey })).status, 400);
  assert.equal((await ravi.client.request('POST', '/api/tasks', { company_id: companyId, title: 'Second try', due_date: '2099-02-02' }, { 'Idempotency-Key': failKey })).status, 201);

  // Completing a follow-up twice from a retry is not a conflict.
  const doneKey = randomUUID();
  assert.equal((await ravi.client.request('POST', `/api/tasks/${first.body.id}/complete`, {}, { 'Idempotency-Key': doneKey })).status, 200);
  assert.equal((await ravi.client.request('POST', `/api/tasks/${first.body.id}/complete`, {}, { 'Idempotency-Key': doneKey })).status, 200);
  assert.equal((await ravi.client.request('POST', `/api/tasks/${first.body.id}/complete`, {}, { 'Idempotency-Key': randomUUID() })).status, 409, 'a genuinely new attempt is');
});

test('conflicts: a follow-up changed elsewhere refuses a stale offline edit and says why', async () => {
  const { body: task } = await ravi.client.request('POST', '/api/tasks', { company_id: companyId, title: 'Moved by manager', due_date: '2099-03-03' });
  const moved = await manager.request('PUT', `/api/tasks/${task.id}`, { due_date: '2099-04-04' });
  assert.equal(moved.status, 200);
  const stale = await ravi.client.request('PUT', `/api/tasks/${task.id}`, { due_date: '2099-05-05', expected_updated_at: task.updated_at });
  assert.equal(stale.status, 409);
  assert.match(stale.body.error, /changed by someone else/);
  assert.match(stale.body.error, /2099-04-04/);
  const fresh = await ravi.client.request('PUT', `/api/tasks/${task.id}`, { due_date: '2099-05-05', expected_updated_at: moved.body.updated_at });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.due_date, '2099-05-05');
});

test('an offline visit: created and completed from a queue, with no duplicates on retry', async () => {
  const clientUuid = randomUUID();
  const body = { company_id: companyId, client_uuid: clientUuid, visited_at: new Date(Date.now() - 3600000).toISOString(), contact: { name: 'Dr. Offline', phone: '9222200001' } };
  const created = await ravi.client.request('POST', '/api/visits', body, { 'Idempotency-Key': randomUUID() });
  assert.equal(created.status, 201);
  assert.equal(new Date(created.body.visited_at).getTime(), new Date(body.visited_at).getTime(), 'keeps the time it really happened');
  const retried = await ravi.client.request('POST', '/api/visits', body, { 'Idempotency-Key': randomUUID() });
  assert.equal(retried.body.id, created.body.id, 'the client id stops a second visit even with a new key');
  const completeKey = randomUUID();
  const complete = { outcome: 'not_interested' };
  assert.equal((await ravi.client.request('POST', `/api/visits/${created.body.id}/complete`, complete, { 'Idempotency-Key': completeKey })).status, 200);
  assert.equal((await ravi.client.request('POST', `/api/visits/${created.body.id}/complete`, complete, { 'Idempotency-Key': completeKey })).status, 200);
});

test('the offline bootstrap: shared companies with contacts, your own drafts, for field staff only', async () => {
  await ravi.client.request('POST', '/api/visits', { company_id: companyId });
  await priya.client.request('POST', '/api/visits', { company_id: companyId });
  const hidden = await createCompany('Rejected For Bootstrap', { createdBy: ravi.userId, approvalStatus: 'pending' });
  await manager.request('POST', `/api/companies/${hidden}/reject`, { reason: 'No' });

  const mine = (await ravi.client.request('GET', '/api/offline/bootstrap')).body;
  const company = mine.companies.find((c) => c.id === companyId);
  assert.ok(company.contacts.some((c) => c.name === 'Dr. Offline'));
  assert.ok(!mine.companies.some((c) => c.id === hidden));
  assert.ok(mine.draft_visits.length >= 1);
  assert.ok(mine.draft_visits.every((v) => v.salesperson_id === ravi.salespersonId));
  assert.equal((await office.request('GET', '/api/offline/bootstrap')).status, 403);
});
