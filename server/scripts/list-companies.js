// Read-only: lists every company with what is attached to it, so test entries can be picked out by id
// before anything is deleted. Changes nothing.
//
//   node server/scripts/list-companies.js [--remote]
//
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const { createClient, isLocalDatabaseUrl } = await import('../db/migrate.js');

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set.');
  if (!isLocalDatabaseUrl(url) && !process.argv.includes('--remote')) throw new Error('Refusing: pass --remote to read a remote database.');
  const client = createClient(url);
  await client.connect();
  try {
    console.log(`Database: ${new URL(url).host}${new URL(url).pathname}`);
    const { rows } = await client.query(`
      SELECT c.id, c.name, c.city, c.category, c.approval_status, u.username AS created_by, c.created_at::date AS created,
             (SELECT COUNT(*)::int FROM opportunity o WHERE o.company_id = c.id) AS deals,
             (SELECT COUNT(*)::int FROM visit v WHERE v.company_id = c.id) AS visits,
             (SELECT COUNT(*)::int FROM company_contact cc WHERE cc.company_id = c.id AND cc.archived_at IS NULL) AS contacts
      FROM company c LEFT JOIN app_user u ON u.id = c.created_by
      WHERE c.archived_at IS NULL
      ORDER BY c.id`);
    console.log(`${rows.length} companies. (Demo) = loaded by the demo seed.\n`);
    console.log('id   | name | city | category | status | by | created | deals/visits/contacts');
    for (const r of rows) {
      const demo = /\(Demo\)$/.test(r.category ?? '') ? ' (DEMO)' : '';
      console.log(`#${r.id} | ${r.name} | ${r.city ?? '-'} | ${r.category ?? '-'}${demo} | ${r.approval_status} | ${r.created_by ?? '-'} | ${r.created.toISOString().slice(0, 10)} | ${r.deals}/${r.visits}/${r.contacts}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
