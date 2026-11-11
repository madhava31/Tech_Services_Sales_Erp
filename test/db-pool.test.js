// The connection pool never leaves a request waiting forever, and a connection that breaks in the
// middle of a transaction is thrown away instead of being handed to the next request.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers/server.js';
import { poolOptions } from '../api/db/poolOptions.js';

let server;
let db;

before(async () => {
  server = await startTestServer();
  db = (await import('../api/db/index.js')).default;
});

after(async () => {
  await server?.close();
});

test('pool settings: a wait limit, and a size that can be lowered for serverless hosting', () => {
  const url = 'postgres://u:p@127.0.0.1:5432/x_test';
  const defaults = poolOptions({ DATABASE_URL: url });
  assert.equal(defaults.max, 10);
  assert.equal(defaults.connectionTimeoutMillis, 10_000, 'a request gives up after 10 s instead of hanging');
  assert.ok(defaults.idleTimeoutMillis > 0);
  assert.equal(poolOptions({ DATABASE_URL: url, DATABASE_POOL_MAX: '2' }).max, 2);
  assert.equal(poolOptions({ DATABASE_URL: url, DATABASE_POOL_MAX: 'lots' }).max, 10, 'a bad value falls back to the default');
  assert.equal(poolOptions({ DATABASE_URL: url, DATABASE_POOL_MAX: '0' }).max, 10);
});

test('a connection that dies inside a transaction is not reused', async () => {
  await assert.rejects(
    db.transaction(async () => {
      // The database ends this very connection, as when the network drops mid-save.
      await db.prepare('SELECT pg_terminate_backend(pg_backend_pid())').get();
    })
  );
  // Every following request still works: the dead connection was discarded.
  const results = await Promise.all(Array.from({ length: 20 }, () => db.prepare('SELECT 1 AS ok').get()));
  assert.ok(results.every((r) => r.ok === 1));
});

test('a failed transaction leaves nothing behind', async () => {
  await db.prepare(`CREATE TABLE IF NOT EXISTS pool_probe (id INT)`).run();
  await assert.rejects(
    db.transaction(async () => {
      await db.prepare('INSERT INTO pool_probe (id) VALUES (1)').run();
      throw new Error('save failed half-way');
    }),
    /save failed half-way/
  );
  assert.equal(Number((await db.prepare('SELECT COUNT(*) AS n FROM pool_probe').get()).n), 0);
});
