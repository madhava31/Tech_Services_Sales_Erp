import db from '../db/index.js';
import { parseCsvRecords } from './csv.js';

const PRODUCT_SELECT = `
  SELECT p.id, p.part_number, p.name, p.oem_id, o.name AS oem_name, p.category, p.key_features, p.is_active, p.created_at, p.updated_at
  FROM product p JOIN oem o ON o.id = p.oem_id`;

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export async function listProducts({ q = '', oemId = null, includeInactive = false, limit = 200 }) {
  const params = [];
  let where = 'WHERE TRUE';
  if (!includeInactive) where += ' AND p.is_active';
  if (oemId) {
    where += ' AND p.oem_id = ?';
    params.push(oemId);
  }
  if (q) {
    where += ' AND (p.part_number ILIKE ? OR p.name ILIKE ?)';
    params.push(`%${escapeLike(q)}%`, `%${escapeLike(q)}%`);
  }
  params.push(limit);
  return db.prepare(`${PRODUCT_SELECT} ${where} ORDER BY o.name, p.name LIMIT ?`).all(...params);
}

export async function getProduct(id) {
  return db.prepare(`${PRODUCT_SELECT} WHERE p.id = ?`).get(id);
}

// technicon_products_seed.csv: part_number, product_name, make, category, key_features (" | ").
// Handles quoted fields, so names and features may contain commas.
export function parseProductCsv(text) {
  const [header, ...rows] = parseCsvRecords(text);
  const columns = (header ?? []).map((h) => h.trim().toLowerCase());
  for (const required of ['part_number', 'product_name', 'make', 'category', 'key_features']) {
    if (!columns.includes(required)) throw new Error(`The file has no "${required}" column.`);
  }
  return rows.map((row, i) => {
    const value = (name) => (row[columns.indexOf(name)] ?? '').trim();
    const parsed = {
      part_number: value('part_number'),
      name: value('product_name'),
      make: value('make'),
      category: value('category') || null,
      key_features: value('key_features').split('|').map((f) => f.trim()).filter(Boolean),
    };
    if (!parsed.part_number || !parsed.name || !parsed.make) throw new Error(`Row ${i + 2}: part_number, product_name and make are required.`);
    return parsed;
  });
}

// Adds or updates products by part number. `query(sql, params)` returns rows; the caller decides the
// connection and the transaction. A make that isn't an OEM stops the import rather than adding one.
export async function upsertProducts(query, rows) {
  const oems = await query(`SELECT id, name FROM oem`);
  const oemByName = new Map(oems.map((o) => [o.name.toLowerCase(), o.id]));
  const unknown = [...new Set(rows.filter((r) => !oemByName.has(r.make.toLowerCase())).map((r) => r.make))];
  if (unknown.length) throw new Error(`Unknown make in the file: ${unknown.join(', ')}. Add it under Admin → OEMs first.`);
  let added = 0;
  let updated = 0;
  for (const r of rows) {
    const [row] = await query(
      `INSERT INTO product (part_number, name, oem_id, category, key_features) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (part_number) DO UPDATE SET name = EXCLUDED.name, oem_id = EXCLUDED.oem_id, category = EXCLUDED.category,
         key_features = EXCLUDED.key_features, updated_at = NOW()
       RETURNING (xmax = 0) AS inserted`,
      [r.part_number, r.name, oemByName.get(r.make.toLowerCase()), r.category, r.key_features]
    );
    if (row.inserted) added++;
    else updated++;
  }
  return { added, updated };
}
