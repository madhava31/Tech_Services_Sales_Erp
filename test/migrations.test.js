import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadMigrations,
  migrateLatest,
  getStatus,
  assertSafeTarget,
  assertTestDatabaseUrl,
  createClient,
} from '../server/db/migrate.js';
import { sslConfig } from '../server/db/ssl.js';
import { resetTestDatabase, testDatabaseUrl, query } from './helpers/testDb.js';

async function withClient(fn) {
  const client = createClient(testDatabaseUrl());
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function tempMigrationsDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-erp-migrations-'));
  for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
  return dir;
}

before(async () => {
  await resetTestDatabase();
});

test('a fresh database ends up with every migration applied', async () => {
  const status = await withClient((c) => getStatus(c));
  assert.ok(status.length >= 3);
  assert.ok(status.every((s) => s.applied), JSON.stringify(status));
  const [tables] = await query(
    `SELECT to_regclass('public.app_user') AS app_user, to_regclass('public.salesperson') AS salesperson,
            to_regclass('public.audit_log') AS audit_log`
  );
  assert.deepEqual(tables, { app_user: 'app_user', salesperson: 'salesperson', audit_log: 'audit_log' });
});

test('running latest again applies nothing', async () => {
  assert.deepEqual(await withClient((c) => migrateLatest(c)), []);
});

test('an edited, already-applied migration is rejected', async () => {
  const migrations = loadMigrations();
  migrations[1] = { ...migrations[1], checksum: 'tampered' };
  await assert.rejects(withClient((c) => migrateLatest(c, migrations)), /checksum mismatch/);
});

test('a failing migration rolls back and is not recorded', async () => {
  const migrations = [
    ...loadMigrations(),
    ...loadMigrations(
      tempMigrationsDir({ '9999_broken.sql': 'CREATE TABLE half_done (id INT);\nSELECT * FROM no_such_table;' })
    ),
  ];
  await assert.rejects(withClient((c) => migrateLatest(c, migrations)), /9999_broken\.sql failed/);
  const [row] = await query(
    `SELECT to_regclass('public.half_done') AS t, (SELECT COUNT(*)::int FROM schema_migrations WHERE version = '9999') AS recorded`
  );
  assert.equal(row.t, null);
  assert.equal(row.recorded, 0);
});

test('a database with a migration the code does not know about is rejected', async () => {
  await query(`INSERT INTO schema_migrations (version, name, checksum) VALUES ('8888', 'from_the_future', 'x')`);
  await assert.rejects(withClient((c) => migrateLatest(c)), /8888/);
  await query(`DELETE FROM schema_migrations WHERE version = '8888'`);
});

test('status is read-only on a database that has never been migrated', async () => {
  await query('DROP SCHEMA public CASCADE');
  await query('CREATE SCHEMA public');
  const status = await withClient((c) => getStatus(c));
  assert.ok(status.every((s) => !s.applied));
  const [row] = await query(`SELECT to_regclass('public.schema_migrations') AS t`);
  assert.equal(row.t, null);
});

test('migration filenames are validated', () => {
  assert.throws(() => loadMigrations(tempMigrationsDir({ 'add-thing.sql': 'SELECT 1;' })), /Invalid migration filename/);
  assert.throws(
    () => loadMigrations(tempMigrationsDir({ '0001_a.sql': 'SELECT 1;', '0001_b.sql': 'SELECT 1;' })),
    /Duplicate migration version/
  );
});

test('checksums ignore CRLF vs LF line endings', () => {
  const lf = loadMigrations(tempMigrationsDir({ '0001_x.sql': 'SELECT 1;\nSELECT 2;\n' }))[0];
  const crlf = loadMigrations(tempMigrationsDir({ '0001_x.sql': 'SELECT 1;\r\nSELECT 2;\r\n' }))[0];
  assert.equal(lf.checksum, crlf.checksum);
});

test('remote databases are refused without explicit confirmation', () => {
  const remote = 'postgres://u:p@db.example.supabase.co:6543/postgres';
  assert.doesNotThrow(() => assertSafeTarget('postgres://u:p@localhost:5432/dev'));
  assert.throws(() => assertSafeTarget(remote, { confirmHost: undefined }), /Refusing/);
  assert.throws(() => assertSafeTarget(remote, { remote: true, confirmHost: 'other.host' }), /Refusing/);
  assert.throws(() => assertSafeTarget(remote, { remote: false, confirmHost: 'db.example.supabase.co' }), /Refusing/);
  assert.doesNotThrow(() => assertSafeTarget(remote, { remote: true, confirmHost: 'db.example.supabase.co' }));
});

test('test database URL must be local and end in _test', () => {
  assert.throws(() => assertTestDatabaseUrl(undefined), /not set/);
  assert.throws(() => assertTestDatabaseUrl('postgres://u:p@db.example.com:5432/x_test'), /localhost/);
  assert.throws(() => assertTestDatabaseUrl('postgres://u:p@127.0.0.1:5432/technicon'), /_test/);
  assert.doesNotThrow(() => assertTestDatabaseUrl('postgres://u:p@127.0.0.1:5432/technicon_sales_erp_test'));
});

test('remote connections always verify TLS certificates', () => {
  assert.equal(sslConfig('postgres://u:p@localhost:5432/dev'), false);
  const remote = sslConfig('postgres://u:p@db.example.supabase.co:6543/postgres');
  assert.equal(remote.rejectUnauthorized, true, 'the certificate is always checked');
  assert.match(remote.ca, /BEGIN CERTIFICATE/, 'checked against the Supabase root certificate built into the app');
});
