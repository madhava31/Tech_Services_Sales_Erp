import db from '../db/index.js';
import { recordAudit } from '../audit/log.js';
import { HttpError } from '../crm/access.js';
import { normalizeCompanyName } from '../crm/normalize.js';
import { QUOTATION_STATUSES, advanceIfBehind, isOpen } from '../crm/pipeline.js';
import { erpAdapter, erpProblem } from './adapter.js';

// Brings ERP data into this app, in one direction only: nothing here ever writes to the ERP. Each part
// runs on its own, so a failure in one still lets the others finish. A deal is never closed by the
// sync: an order in the ERP only says so on the deal, because winning needs a person's reason.
const EVERY_MS = 30 * 60 * 1000;

const LIST = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === 'string') : []);

async function syncCustomers(adapter, counts) {
  const rows = await adapter.customers();
  for (const r of rows) {
    await db
      .prepare(
        `INSERT INTO erp_customer (id, name, normalized_name, address, state, gstin, contact_person, phone, email) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, normalized_name = EXCLUDED.normalized_name, address = EXCLUDED.address, state = EXCLUDED.state,
           gstin = EXCLUDED.gstin, contact_person = EXCLUDED.contact_person, phone = EXCLUDED.phone, email = EXCLUDED.email, seen_at = NOW()`
      )
      .run(r.id, r.name, normalizeCompanyName(r.name), r.address ?? null, r.state ?? null, r.gstin ?? null, r.contact_person ?? null, r.phone ?? null, r.email ?? null);
  }
  counts.customers = rows.length;

  // Link only when there is exactly one possible match both ways: same GSTIN, or same name. Anything
  // less certain waits for a person on the sync screen.
  const unlinked = await db.prepare(`SELECT e.* FROM erp_customer e WHERE NOT e.ignored AND NOT EXISTS (SELECT 1 FROM company c WHERE c.erp_company_id = e.id)`).all();
  let linked = 0;
  for (const e of unlinked) {
    const candidates = await db
      .prepare(
        `SELECT id, name FROM company c
         WHERE c.archived_at IS NULL AND c.approval_status <> 'rejected' AND c.erp_company_id IS NULL AND c.parent_company_id IS NULL
           AND (c.normalized_name = ? OR (?::text IS NOT NULL AND upper(c.gstin) = upper(?)))`
      )
      .all(e.normalized_name, e.gstin, e.gstin);
    if (candidates.length !== 1) continue;
    await db.prepare(`UPDATE company SET erp_company_id = ?, updated_at = NOW() WHERE id = ? AND erp_company_id IS NULL`).run(e.id, candidates[0].id);
    await recordAudit({ actorUserId: null, action: 'company.erp_linked', entityType: 'company', entityId: candidates[0].id, summary: `Linked ${candidates[0].name} to ERP customer ${e.name}` });
    linked++;
  }
  counts.customers_linked = linked;
}

async function syncProducts(adapter, counts) {
  const rows = await adapter.products();
  const oems = new Map((await db.prepare(`SELECT id, name FROM oem`).all()).map((o) => [o.name.toLowerCase(), o.id]));
  let saved = 0;
  const unknown = new Set();
  for (const r of rows) {
    const oemId = oems.get(String(r.make ?? '').trim().toLowerCase());
    if (!oemId) {
      unknown.add(r.make || '(no make)');
      continue;
    }
    // Matched by part number. Category and active/inactive stay as they are here: the ERP has neither.
    await db
      .prepare(
        `INSERT INTO product (part_number, name, oem_id, key_features, erp_product_id) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (part_number) DO UPDATE SET name = EXCLUDED.name, oem_id = EXCLUDED.oem_id, key_features = EXCLUDED.key_features,
           erp_product_id = EXCLUDED.erp_product_id, updated_at = NOW()`
      )
      .run(r.part_no, r.description, oemId, LIST(r.key_features), r.id);
    saved++;
  }
  counts.products = saved;
  counts.products_skipped = rows.length - saved;
  if (unknown.size) counts.unknown_makes = [...unknown].slice(0, 20);
}

async function syncQuotations(adapter, counts) {
  const rows = await adapter.quotations();
  for (const r of rows) {
    await db
      .prepare(
        `INSERT INTO erp_quotation (id, number, quote_date, status, total, erp_customer_id) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET number = EXCLUDED.number, quote_date = EXCLUDED.quote_date, status = EXCLUDED.status, total = EXCLUDED.total,
           erp_customer_id = EXCLUDED.erp_customer_id, seen_at = NOW()`
      )
      .run(r.id, r.number, r.date ?? null, r.status ?? null, r.total ?? null, r.company_id ?? null);
  }
  counts.quotations = rows.length;

  // Quotations recorded on deals: by the ERP id once known, otherwise by number, but never across
  // customers, because numbers typed by hand can be wrong.
  const links = await db
    .prepare(
      `SELECT q.*, e.id AS e_id, e.number AS e_number, e.quote_date AS e_date, e.status AS e_status, e.total AS e_total, e.erp_customer_id,
              o.title, o.stage, c.erp_company_id
       FROM quotation_link q
       JOIN opportunity o ON o.id = q.opportunity_id
       JOIN company c ON c.id = o.company_id
       JOIN erp_quotation e ON e.id = q.erp_quotation_id OR (q.erp_quotation_id IS NULL AND e.number = q.quotation_number)`
    )
    .all();
  let updated = 0;
  let mismatched = 0;
  for (const link of links) {
    if (link.erp_quotation_id === null && link.erp_company_id !== null && link.erp_customer_id !== link.erp_company_id) {
      mismatched++;
      continue;
    }
    const status = QUOTATION_STATUSES.includes(link.e_status) ? link.e_status : link.status;
    const unchanged =
      link.source === 'erp' && link.erp_quotation_id === link.e_id && link.quotation_number === link.e_number && link.quotation_date === link.e_date && Number(link.amount) === Number(link.e_total) && link.status === status;
    if (unchanged) continue;
    const taken = link.erp_quotation_id === null && (await db.prepare(`SELECT id FROM quotation_link WHERE erp_quotation_id = ?`).get(link.e_id));
    if (taken) {
      mismatched++;
      continue;
    }
    await db.transaction(async () => {
      await db
        .prepare(`UPDATE quotation_link SET erp_quotation_id = ?, source = 'erp', quotation_number = ?, quotation_date = ?, amount = ?, status = ?, updated_at = NOW() WHERE id = ?`)
        .run(link.e_id, link.e_number, link.e_date, link.e_total, status, link.id);
      if (status !== 'draft' && isOpen(link.stage)) {
        await advanceIfBehind({ opportunity: { id: link.opportunity_id, title: link.title, stage: link.stage }, stage: 'quotation_sent', userId: null, note: `Quotation ${link.e_number} in the ERP` });
      }
      await recordAudit({
        actorUserId: null,
        action: 'quotation.synced',
        entityType: 'opportunity',
        entityId: link.opportunity_id,
        summary: `Quotation ${link.e_number} on "${link.title}" updated from the ERP`,
        before: { quotation_number: link.quotation_number, quotation_date: link.quotation_date, amount: link.amount, status: link.status },
        after: { quotation_number: link.e_number, quotation_date: link.e_date, amount: link.e_total, status },
      });
    });
    updated++;
  }
  counts.quotations_updated = updated;
  counts.quotations_mismatched = mismatched;
}

async function syncOrders(adapter, counts) {
  const rows = await adapter.orders();
  for (const r of rows) {
    await db
      .prepare(
        `INSERT INTO erp_order (id, number, order_date, erp_quotation_id, client_po_ref, status) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET number = EXCLUDED.number, order_date = EXCLUDED.order_date, erp_quotation_id = EXCLUDED.erp_quotation_id,
           client_po_ref = EXCLUDED.client_po_ref, status = EXCLUDED.status, seen_at = NOW()`
      )
      .run(r.id, r.number, r.date ?? null, r.quotation_id ?? null, r.client_po_ref ?? null, r.status ?? null);
  }
  counts.orders = rows.length;
}

const PARTS = [
  ['Customers', syncCustomers],
  ['Products', syncProducts],
  ['Quotations', syncQuotations],
  ['Orders', syncOrders],
];

let running = false;

// `adapter` is replaceable for tests. One run at a time, so a slow run can't overlap the next.
export async function runErpSync({ trigger = 'schedule', adapter = erpAdapter() } = {}) {
  if (adapter.name === 'local') throw new HttpError(409, erpProblem() ?? 'The ERP connection is not set up.');
  if (running) throw new HttpError(409, 'A sync is already running.');
  running = true;
  try {
    const run = await db.prepare(`INSERT INTO erp_sync_run (trigger) VALUES (?) RETURNING id`).get(trigger);
    const counts = {};
    const errors = [];
    for (const [part, fn] of PARTS) {
      try {
        await fn(adapter, counts);
      } catch (err) {
        console.error(`ERP sync, ${part}:`, err.message);
        errors.push({ part, message: String(err.message).slice(0, 300) });
      }
    }
    const status = errors.length === 0 ? 'ok' : errors.length === PARTS.length ? 'failed' : 'partial';
    await db.prepare(`UPDATE erp_sync_run SET finished_at = NOW(), status = ?, counts = ?, errors = ? WHERE id = ?`).run(status, JSON.stringify(counts), JSON.stringify(errors), run.id);
    return { id: run.id, status, counts, errors };
  } finally {
    running = false;
  }
}

// Does nothing until the connection is set up, then keeps to one sync every half hour.
export function startErpSyncSchedule() {
  const tick = () => {
    if (erpProblem()) return;
    runErpSync().catch((err) => console.error('ERP sync failed:', err.message));
  };
  tick();
  return setInterval(tick, EVERY_MS);
}
