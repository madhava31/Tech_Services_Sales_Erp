// Load the product catalogue from a CSV.
//
//   npm run products:import                                  (reads server/db/seeds/technicon_products_seed.csv, local database)
//   npm run products:import -- path/to/file.csv
//   node server/scripts/import-products.js [file.csv] [--dry-run] [--add-missing-oems] [--remote --confirm=IMPORT]
//
// Columns: part_number, product_name, make, category, key_features (separated by " | "). Products
// are added or updated by part number; nothing is removed.
//   --dry-run            does it all inside a transaction, prints what would happen, and rolls it back.
//   --add-missing-oems   adds a make that is not an OEM yet (otherwise the import stops on it).
//   --remote             needed for any database that is not on this computer, together with --confirm=IMPORT
//                        (not needed for a --dry-run, which changes nothing).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// Imported after .env is loaded: crm/products.js pulls in db/index.js, which needs DATABASE_URL.
const { createClient, isLocalDatabaseUrl } = await import('../db/migrate.js');
const { parseProductCsv, upsertProducts } = await import('../crm/products.js');

export const DEFAULT_CSV = path.resolve(__dirname, '../db/seeds/technicon_products_seed.csv');

async function main() {
  const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
  const fileArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const dryRun = flags.includes('--dry-run');
  const addOems = flags.includes('--add-missing-oems');
  const remote = flags.includes('--remote');
  const confirmed = flags.includes('--confirm=IMPORT');

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set (.env).');
  if (!isLocalDatabaseUrl(url) && !remote) throw new Error('Refusing: pass --remote to use a database that is not on this computer.');
  if (!isLocalDatabaseUrl(url) && !dryRun && !confirmed) throw new Error('Refusing: add --dry-run to preview, or --confirm=IMPORT to import for real.');
  const file = fileArg ? path.resolve(fileArg) : DEFAULT_CSV;
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
  const rows = parseProductCsv(fs.readFileSync(file, 'utf-8'));
  const target = new URL(url);
  console.log(`Database: ${target.host}${target.pathname}`);
  console.log(`File: ${path.basename(file)}, ${rows.length} products${dryRun ? ' (dry run)' : ''}`);

  const client = createClient(url);
  await client.connect();
  try {
    await client.query('BEGIN');
    const query = async (sql, params) => (await client.query(sql, params)).rows;

    const known = new Set((await query(`SELECT lower(name) AS n FROM oem`)).map((o) => o.n));
    const missing = [...new Set(rows.map((r) => r.make))].filter((m) => !known.has(m.toLowerCase()));
    if (missing.length && addOems) {
      for (const name of missing) await query(`INSERT INTO oem (name) VALUES ($1)`, [name]);
      console.log(`OEMs added: ${missing.join(', ')}`);
    } else if (missing.length) {
      console.log(`OEMs missing (the import will stop): ${missing.join(', ')}. Add --add-missing-oems to create them.`);
    }

    const before = (await query(`SELECT COUNT(*)::int AS n FROM product`))[0].n;
    const result = await upsertProducts(query, rows);
    await query(`INSERT INTO audit_log (action, entity_type, summary) VALUES ('product.imported', 'product', $1)`, [
      `Imported ${rows.length} products from ${path.basename(file)}: ${result.added} added, ${result.updated} updated${missing.length && addOems ? `; OEMs added: ${missing.join(', ')}` : ''}`,
    ]);
    const perMake = new Map();
    for (const r of rows) perMake.set(r.make, (perMake.get(r.make) ?? 0) + 1);
    const after = (await query(`SELECT COUNT(*)::int AS n FROM product`))[0].n;

    if (dryRun) await client.query('ROLLBACK');
    else await client.query('COMMIT');
    console.log(`${dryRun ? 'DRY RUN, nothing was saved. Would be' : 'Done:'} ${result.added} added, ${result.updated} updated.`);
    for (const [make, n] of perMake) console.log(`  ${make.padEnd(20)} ${n}`);
    console.log(`Products in the database: ${before} before, ${dryRun ? `${after} if imported` : `${after} now`}.`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
