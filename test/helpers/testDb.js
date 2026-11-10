// Test database lifecycle. Every test file starts from an empty schema with all migrations
// applied, so tests never depend on each other or on leftover local data.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { assertTestDatabaseUrl, createClient, migrateLatest } from '../../server/db/migrate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env.test') });

export function testDatabaseUrl() {
  const url = process.env.TEST_DATABASE_URL;
  assertTestDatabaseUrl(url);
  return url;
}

async function ensureDatabaseExists(url) {
  const name = new URL(url).pathname.slice(1);
  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const client = createClient(adminUrl.toString());
  await client.connect();
  try {
    const { rows } = await client.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [name]);
    // Name is safe to interpolate: assertTestDatabaseUrl restricts it to [a-z0-9_]+_test.
    if (rows.length === 0) await client.query(`CREATE DATABASE "${name}"`);
  } finally {
    await client.end();
  }
}

export async function resetTestDatabase() {
  const url = testDatabaseUrl();
  await ensureDatabaseExists(url);
  const client = createClient(url);
  await client.connect();
  try {
    await client.query('DROP SCHEMA public CASCADE');
    await client.query('CREATE SCHEMA public');
    await migrateLatest(client);
  } finally {
    await client.end();
  }
  return url;
}

// Runs one-off SQL against the test database (setup and assertions in tests).
export async function query(sql, params = []) {
  const client = createClient(testDatabaseUrl());
  await client.connect();
  try {
    return (await client.query(sql, params)).rows;
  } finally {
    await client.end();
  }
}
