// Load the product catalogue from a CSV into the LOCAL database.
//
//   npm run products:import                   (reads api/db/seeds/technicon_products_seed.csv)
//   npm run products:import -- path/to/file.csv
//
// Columns: part_number, product_name, make, category, key_features (separated by " | "). Products
// are added or updated by part number; nothing is removed. Refuses a non-local database.
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
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set (.env).');
  if (!isLocalDatabaseUrl(url)) throw new Error('Refusing: this only works on a local database.');
  const file = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_CSV;
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
  const rows = parseProductCsv(fs.readFileSync(file, 'utf-8'));

  const client = createClient(url);
  await client.connect();
  try {
    await client.query('BEGIN');
    const result = await upsertProducts(async (sql, params) => (await client.query(sql, params)).rows, rows);
    await client.query(`INSERT INTO audit_log (action, entity_type, summary) VALUES ('product.imported', 'product', $1)`, [
      `Imported ${rows.length} products from ${path.basename(file)}: ${result.added} added, ${result.updated} updated`,
    ]);
    await client.query('COMMIT');
    console.log(`${result.added} added, ${result.updated} updated.`);
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
