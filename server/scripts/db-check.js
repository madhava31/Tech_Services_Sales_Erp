// Read-only health check of the database. Changes nothing: the whole run is one READ ONLY transaction.
//
//   node server/scripts/db-check.js [--remote]
//
// Reports the connection headroom, the migrations, whether every constraint and index is valid, that the
// protective triggers are in place, and that the data agrees with the app's own rules.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const { createClient, isLocalDatabaseUrl } = await import('../db/migrate.js');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set.');
  if (!isLocalDatabaseUrl(url) && !process.argv.includes('--remote')) throw new Error('Refusing: pass --remote to check a remote database.');
  const target = new URL(url);
  console.log(`Database: ${target.host}${target.pathname}`);
  const client = createClient(url);
  await client.connect();
  const q = async (sql, params = []) => (await client.query(sql, params)).rows;
  const one = async (sql, params) => (await q(sql, params))[0];
  try {
    await client.query('BEGIN READ ONLY');

    const t0 = Date.now();
    await q('SELECT 1');
    const info = await one(`SELECT version() AS v, pg_size_pretty(pg_database_size(current_database())) AS size, current_setting('max_connections')::int AS max_conn`);
    console.log(`Server: ${info.v.split(',')[0]}, size ${info.size}, round trip ${Date.now() - t0} ms\n`);

    // Connections: how close the database is to its limit, and anything stuck.
    const conns = await q(`SELECT COALESCE(state, 'background') AS state, COUNT(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() GROUP BY 1`);
    const total = conns.reduce((a, c) => a + c.n, 0);
    check('connections are well below the limit', total < info.max_conn * 0.7, `${total} open of ${info.max_conn} allowed: ${conns.map((c) => `${c.state} ${c.n}`).join(', ')}`);
    const stuck = await one(`SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction' AND state_change < NOW() - INTERVAL '5 minutes'`);
    check('no connection is stuck inside a transaction', stuck.n === 0, `${stuck.n} stuck`);

    // Migrations: every file applied, none edited since.
    const dir = path.resolve(__dirname, '../db/migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const applied = await q(`SELECT version, name FROM schema_migrations ORDER BY version`);
    const missing = files.filter((f) => !applied.some((a) => f.startsWith(String(a.version).padStart(4, '0'))));
    check('every migration file is applied', missing.length === 0, missing.length ? `pending: ${missing.join(', ')}` : `${applied.length} applied`);

    // Structure.
    const badConstraints = await q(`SELECT conrelid::regclass::text AS t, conname FROM pg_constraint WHERE NOT convalidated AND connamespace = 'public'::regnamespace`);
    check('every constraint of the app is validated', badConstraints.length === 0, badConstraints.map((c) => `${c.t}.${c.conname}`).join(', '));
    const badIndexes = await q(`SELECT indexrelid::regclass::text AS i FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid WHERE (NOT i.indisvalid OR NOT i.indisready) AND c.relnamespace = 'public'::regnamespace`);
    check('every index of the app is valid', badIndexes.length === 0, badIndexes.map((i) => i.i).join(', '));
    const triggers = await q(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgenabled <> 'D'`);
    const names = new Set(triggers.map((t) => t.tgname));
    const needed = ['opportunity_history_no_update_delete', 'opportunity_fill_code', 'opportunity_code_fixed', 'salesperson_fill_id_prefix'];
    const lacking = needed.filter((n) => !names.has(n));
    check('protective triggers are enabled (append-only history, opportunity IDs)', lacking.length === 0, lacking.join(', '));
    const auditGuard = (await q(`SELECT tgname FROM pg_trigger WHERE tgrelid = 'audit_log'::regclass AND NOT tgisinternal AND tgenabled <> 'D'`)).length;
    check('the audit log is protected from edits and deletes', auditGuard >= 1, `${auditGuard} guards`);

    // Supabase publishes public tables to anyone holding the project's public key unless row security is on.
    // This app never uses that API, so every table must have row security on and no access for anon / authenticated.
    const open = await q(`SELECT c.relname AS t FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity ORDER BY 1`);
    check('row security is on for every table (so the public API shows nothing)', open.length === 0, open.slice(0, 8).map((r) => r.t).join(', ') + (open.length > 8 ? ` and ${open.length - 8} more` : ''));
    const granted = await q(
      `SELECT DISTINCT table_name AS t, grantee FROM information_schema.role_table_grants WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated') ORDER BY 1`
    );
    check('the public roles (anon, authenticated) have no access to any table', granted.length === 0, granted.slice(0, 6).map((g) => `${g.t}→${g.grantee}`).join(', ') + (granted.length > 6 ? ` and ${granted.length - 6} more` : ''));

    // Data against the app's own rules.
    const rules = [
      ['every opportunity has its ID, in the form TS-<letters>-<4 digits>', `SELECT COUNT(*)::int AS n FROM opportunity WHERE code IS NULL OR code !~ '^TS-[A-Z0-9]+-[0-9]{4,}$'`],
      ['opportunity IDs are unique', `SELECT COUNT(*)::int AS n FROM (SELECT code FROM opportunity GROUP BY code HAVING COUNT(*) > 1) d`],
      ['every opportunity has at least one OEM', `SELECT COUNT(*)::int AS n FROM opportunity o WHERE NOT EXISTS (SELECT 1 FROM opportunity_oem x WHERE x.opportunity_id = o.id)`],
      ['every opportunity has at least one product (catalogue or typed in)', `SELECT COUNT(*)::int AS n FROM opportunity o WHERE NOT EXISTS (SELECT 1 FROM opportunity_product p WHERE p.opportunity_id = o.id) AND NOT EXISTS (SELECT 1 FROM opportunity_custom_product c WHERE c.opportunity_id = o.id)`],
      ['every OEM on an opportunity has a product', `SELECT COUNT(*)::int AS n FROM opportunity_oem x WHERE NOT EXISTS (SELECT 1 FROM opportunity_product p JOIN product pr ON pr.id = p.product_id WHERE p.opportunity_id = x.opportunity_id AND pr.oem_id = x.oem_id) AND NOT EXISTS (SELECT 1 FROM opportunity_custom_product c WHERE c.opportunity_id = x.opportunity_id AND c.oem_id = x.oem_id)`],
      ['closed opportunities have a reason; open ones have none', `SELECT COUNT(*)::int AS n FROM opportunity WHERE (stage IN ('won','lost') AND close_reason IS NULL) OR (stage NOT IN ('won','lost') AND (won_value IS NOT NULL OR lost_reason IS NOT NULL OR close_reason IS NOT NULL))`],
      ['every opportunity belongs to an approved company', `SELECT COUNT(*)::int AS n FROM opportunity o JOIN company c ON c.id = o.company_id WHERE c.approval_status <> 'approved'`],
      ['every salesperson has ID letters, and they are unique', `SELECT (SELECT COUNT(*) FROM salesperson WHERE id_prefix IS NULL) + (SELECT COUNT(*) FROM (SELECT id_prefix FROM salesperson GROUP BY id_prefix HAVING COUNT(*) > 1) d) AS n`],
      ['no salesperson is behind the opportunity numbers already used', `SELECT COUNT(*)::int AS n FROM salesperson s WHERE s.next_opportunity_no <= COALESCE((SELECT MAX(split_part(o.code, '-', 3)::int) FROM opportunity o WHERE o.owner_salesperson_id = s.id AND o.code LIKE 'TS-' || s.id_prefix || '-%'), 0)`],
      ['no two live contacts share a phone number', `SELECT COUNT(*)::int AS n FROM (SELECT right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) AS k FROM company_contact WHERE archived_at IS NULL AND phone IS NOT NULL GROUP BY 1 HAVING COUNT(*) > 1) d`],
      ['every company state is on the Indian list', `SELECT COUNT(*)::int AS n FROM company WHERE state IS NOT NULL AND archived_at IS NULL AND state NOT IN (${INDIAN_STATES_SQL()})`, `SELECT name || ' (' || state || ')' AS label FROM company WHERE state IS NOT NULL AND archived_at IS NULL AND state NOT IN (${INDIAN_STATES_SQL()}) ORDER BY id LIMIT 8`],
      ['every user has a valid role', `SELECT COUNT(*)::int AS n FROM app_user WHERE role IS NULL OR btrim(role) = ''`],
    ];
    for (const [name, sql, detailSql] of rules) {
      try {
        const n = (await one(sql)).n;
        let detail = Number(n) ? `${n} found` : '';
        if (Number(n) && detailSql) detail += ': ' + (await q(detailSql)).map((r) => r.label).join('; ');
        check(name, Number(n) === 0, detail);
      } catch (err) {
        check(name, false, `could not run: ${err.message}`);
      }
    }

    // Sizes, for the record.
    console.log('\nRows per table (largest first):');
    const sizes = await q(`SELECT relname AS t, n_live_tup::int AS rows, pg_size_pretty(pg_total_relation_size(relid)) AS size FROM pg_stat_user_tables WHERE schemaname = 'public' ORDER BY pg_total_relation_size(relid) DESC LIMIT 12`);
    for (const s of sizes) console.log(`  ${s.t.padEnd(28)} ${String(s.rows).padStart(8)} rows  ${s.size}`);

    await client.query('ROLLBACK');
  } finally {
    await client.end();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed${failed.length ? `, ${failed.length} FAILED` : ''}.`);
  process.exitCode = failed.length ? 1 : 0;
}

// The list is kept in one place for the app; the check reads it from there.
function INDIAN_STATES_SQL() {
  return INDIAN_STATES.map((s) => `'${s.replace(/'/g, "''")}'`).join(', ');
}
import { INDIAN_STATES } from '../crm/states.js';

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
