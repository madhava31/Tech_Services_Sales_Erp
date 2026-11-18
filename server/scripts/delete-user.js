// Remove one deactivated login (and, if asked, its salesperson record) from the database.
//
//   node server/scripts/delete-user.js --username=vinnu [--with-salesperson] [--dry-run | --confirm=DELETE] [--remote]
//
// A login that has done things is part of the history (companies, deals, visits, the audit log all point
// at it), so it can only go when nothing but its own sessions, reminders and phone subscriptions remain.
// Otherwise the script lists what holds it and deletes nothing: keep it deactivated.
// --dry-run does everything inside a transaction, prints it, and rolls back. A real delete needs --confirm=DELETE.
//
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const { createClient, isLocalDatabaseUrl } = await import('../db/migrate.js');

// Tables that only hold a login's own sessions and reminders: safe to clear along with it.
const OWN_TABLES = new Set(['session', 'notification', 'push_subscription', 'request_idempotency', 'otp_challenge']);

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set (.env).');
  const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const username = arg('username');
  if (!username) throw new Error('--username=<name> is required, e.g. --username=vinnu');
  const dryRun = process.argv.includes('--dry-run');
  const confirmed = process.argv.includes('--confirm=DELETE');
  const withSalesperson = process.argv.includes('--with-salesperson');
  const allowRemote = process.argv.includes('--remote') || process.env.ALLOW_REMOTE_DEMO === '1';
  if (!isLocalDatabaseUrl(url) && !allowRemote) throw new Error('Refusing: pass --remote to run against a remote database.');
  if (!dryRun && !confirmed) throw new Error('Refusing: add --dry-run to preview, or --confirm=DELETE to delete for real.');

  console.log(`Database: ${new URL(url).host}${new URL(url).pathname}`);
  const client = createClient(url);
  await client.connect();
  const q = async (sql, params = []) => (await client.query(sql, params)).rows;

  try {
    const [user] = await q(`SELECT id, username, role, is_active, salesperson_id FROM app_user WHERE username = $1`, [username]);
    if (!user) throw new Error(`No login named "${username}".`);
    if (user.is_active) throw new Error(`"${username}" is still active. Deactivate it first.`);
    console.log(`Login #${user.id} "${user.username}" (${user.role}), deactivated.`);

    const refs = await q(
      `SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
         FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.contype = 'f' AND c.confrelid = 'app_user'::regclass AND c.conrelid <> 'app_user'::regclass`
    );
    // app_user points at itself: who reports to this login, who it deactivated.
    const selfRefs = await q(
      `SELECT a.attname AS col FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.contype = 'f' AND c.confrelid = 'app_user'::regclass AND c.conrelid = 'app_user'::regclass AND a.attname <> 'salesperson_id'`
    );

    const own = [];
    const blockers = [];
    for (const { tbl, col } of refs) {
      const [{ n }] = await q(`SELECT COUNT(*)::int AS n FROM ${tbl} WHERE ${col} = $1`, [user.id]);
      if (n === 0) continue;
      (OWN_TABLES.has(tbl) ? own : blockers).push({ tbl, col, n });
    }
    for (const { col } of selfRefs) {
      const [{ n }] = await q(`SELECT COUNT(*)::int AS n FROM app_user WHERE ${col} = $1 AND id <> $1`, [user.id]);
      if (n > 0) blockers.push({ tbl: 'app_user', col, n });
    }

    let salesperson = null;
    if (withSalesperson && user.salesperson_id) {
      [salesperson] = await q(`SELECT id, name FROM salesperson WHERE id = $1`, [user.salesperson_id]);
      const spRefs = await q(
        `SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
           FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
          WHERE c.contype = 'f' AND c.confrelid = 'salesperson'::regclass`
      );
      for (const { tbl, col } of spRefs) {
        const [{ n }] = await q(`SELECT COUNT(*)::int AS n FROM ${tbl} WHERE ${col} = $1 ${tbl === 'app_user' ? 'AND id <> $2' : ''}`, tbl === 'app_user' ? [salesperson.id, user.id] : [salesperson.id]);
        if (n > 0) blockers.push({ tbl, col: `${col} (salesperson ${salesperson.name})`, n });
      }
    } else if (withSalesperson) {
      console.log('This login has no salesperson record.');
    }

    if (own.length) console.log('Its own sessions and reminders, cleared with it:\n' + own.map((r) => `  ${r.tbl}.${r.col}: ${r.n}`).join('\n'));
    if (blockers.length) {
      console.log('\nCannot be deleted: records still point at it.\n' + blockers.map((r) => `  ${r.tbl}.${r.col}: ${r.n}`).join('\n'));
      console.log('\nIt is part of the history, so keep it deactivated. Nothing was deleted.');
      process.exitCode = 2;
      return;
    }

    await client.query('BEGIN');
    for (const { tbl, col } of own) await q(`DELETE FROM ${tbl} WHERE ${col} = $1`, [user.id]);
    await q(`DELETE FROM login_attempt WHERE lower(username) = lower($1)`, [user.username]).catch(() => {});
    await q(`DELETE FROM app_user WHERE id = $1`, [user.id]);
    if (salesperson) await q(`DELETE FROM salesperson WHERE id = $1`, [salesperson.id]);
    console.log(`\n${dryRun ? 'Would delete' : 'Deleted'}: login "${user.username}"${salesperson ? ` and salesperson "${salesperson.name}"` : ''}.`);
    if (dryRun) {
      await client.query('ROLLBACK');
      console.log('Dry run: rolled back, nothing changed.');
    } else {
      await client.query('COMMIT');
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
