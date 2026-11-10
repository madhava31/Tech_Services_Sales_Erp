// Forward-only SQL migration runner. Migrations are `migrations/NNNN_name.sql`, applied in order,
// each in its own transaction, and recorded in `schema_migrations` with a checksum so an edited
// already-applied file is caught instead of silently diverging.
//
//   node api/db/migrate.js status   [--test]
//   node api/db/migrate.js latest   [--test]
//
// DATABASE_URL comes from .env at the repository root; --test uses TEST_DATABASE_URL from
// .env.test instead. Anything other than localhost is refused unless
// `--remote` is passed AND CONFIRM_REMOTE_DATABASE is set to that database's hostname.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { isLocalDatabaseUrl, sslConfig } from './ssl.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

const FILENAME_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;
// Arbitrary constant key so two concurrent runs can't apply the same migration twice.
const ADVISORY_LOCK_KEY = 727348;

export function loadMigrations(dir = MIGRATIONS_DIR) {
  const migrations = [];
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith('.sql')) continue;
    const match = FILENAME_PATTERN.exec(file);
    if (!match) throw new Error(`Invalid migration filename "${file}" (expected NNNN_lowercase_name.sql)`);
    // Normalize line endings before hashing: git's autocrlf would otherwise give the same file a
    // different checksum on Windows and Linux checkouts.
    const sql = fs.readFileSync(path.join(dir, file), 'utf-8').replace(/\r\n/g, '\n');
    const checksum = crypto.createHash('sha256').update(sql).digest('hex');
    migrations.push({ version: match[1], name: match[2], file, sql, checksum });
  }
  for (let i = 1; i < migrations.length; i++) {
    if (migrations[i].version === migrations[i - 1].version) {
      throw new Error(`Duplicate migration version ${migrations[i].version}`);
    }
  }
  return migrations;
}

export function assertSafeTarget(url, { remote = false, confirmHost = process.env.CONFIRM_REMOTE_DATABASE } = {}) {
  if (isLocalDatabaseUrl(url)) return;
  const host = new URL(url).hostname;
  if (!remote || confirmHost !== host) {
    throw new Error(
      `Refusing to migrate non-local database host "${host}". ` +
        'Pass --remote and set CONFIRM_REMOTE_DATABASE to that hostname to proceed.'
    );
  }
}

export function assertTestDatabaseUrl(url) {
  if (!url) throw new Error('TEST_DATABASE_URL is not set (copy .env.test.example to .env.test).');
  if (!isLocalDatabaseUrl(url)) throw new Error('TEST_DATABASE_URL must point at localhost.');
  const name = new URL(url).pathname.slice(1);
  if (!/^[a-z0-9_]+_test$/.test(name)) {
    throw new Error(`Test database name must be lowercase and end in "_test" (got "${name}").`);
  }
}

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function appliedMigrations(client) {
  const { rows } = await client.query(`SELECT version, name, checksum FROM schema_migrations ORDER BY version`);
  return new Map(rows.map((r) => [r.version, r]));
}

function verifyChecksums(migrations, applied) {
  for (const m of migrations) {
    const row = applied.get(m.version);
    if (row && row.checksum !== m.checksum) {
      throw new Error(`Migration ${m.file} was modified after being applied (checksum mismatch).`);
    }
  }
  const known = new Set(migrations.map((m) => m.version));
  for (const version of applied.keys()) {
    if (!known.has(version)) throw new Error(`Database has migration ${version} that is not in ${MIGRATIONS_DIR}.`);
  }
}

// Read-only: never creates schema_migrations, so `status` is safe to run against any database.
export async function getStatus(client, migrations = loadMigrations()) {
  const { rows } = await client.query(`SELECT to_regclass('public.schema_migrations') AS t`);
  const applied = rows[0].t ? await appliedMigrations(client) : new Map();
  verifyChecksums(migrations, applied);
  return migrations.map((m) => ({ version: m.version, name: m.name, applied: applied.has(m.version) }));
}

export async function migrateLatest(client, migrations = loadMigrations()) {
  await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
  try {
    await ensureMigrationsTable(client);
    const applied = await appliedMigrations(client);
    verifyChecksums(migrations, applied);

    const ran = [];
    for (const m of migrations) {
      if (applied.has(m.version)) continue;
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query(`INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)`, [
          m.version,
          m.name,
          m.checksum,
        ]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${m.file} failed: ${err.message}`);
      }
      ran.push(m.file);
    }
    return ran;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
  }
}

export { isLocalDatabaseUrl };

export function createClient(url) {
  return new pg.Client({
    connectionString: url,
    ssl: sslConfig(url),
  });
}

async function main(argv) {
  const [command = 'status', ...flags] = argv;
  const useTest = flags.includes('--test');
  const remote = flags.includes('--remote');

  const dotenv = (await import('dotenv')).default;
  const rootDir = path.resolve(__dirname, '../..');
  let url;
  if (useTest) {
    dotenv.config({ path: path.join(rootDir, '.env.test') });
    url = process.env.TEST_DATABASE_URL;
    assertTestDatabaseUrl(url);
  } else {
    dotenv.config({ path: path.join(rootDir, '.env') });
    url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set (.env).');
    assertSafeTarget(url, { remote });
  }

  const client = createClient(url);
  await client.connect();
  try {
    console.log(`Database: ${new URL(url).hostname}/${new URL(url).pathname.slice(1)}`);
    if (command === 'status') {
      for (const s of await getStatus(client)) console.log(`${s.applied ? 'applied' : 'PENDING'}  ${s.version}_${s.name}`);
    } else if (command === 'latest') {
      const ran = await migrateLatest(client);
      console.log(ran.length ? `Applied:\n  ${ran.join('\n  ')}` : 'Already up to date.');
    } else {
      throw new Error(`Unknown command "${command}" (expected status or latest).`);
    }
  } finally {
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
