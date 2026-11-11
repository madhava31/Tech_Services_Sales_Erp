import { Router } from 'express';
import db from '../db/index.js';
import { recordAudit } from '../audit/log.js';
import { HttpError, sendError } from '../crm/access.js';
import { optionalId } from '../crm/fields.js';
import { normalizeCompanyName } from '../crm/normalize.js';
import { erpProblem } from '../erp/adapter.js';
import { runErpSync } from '../erp/sync.js';

// Mounted at /api/admin/erp behind requireAuth + requireAdmin: the state of the ERP connection, and the
// customers the sync couldn't match by itself.
const router = Router();

router.get('/', async (req, res) => {
  try {
    const runs = await db.prepare(`SELECT id, trigger, started_at, finished_at, status, counts, errors FROM erp_sync_run ORDER BY id DESC LIMIT 10`).all();
    const [totals] = await db
      .prepare(
        `SELECT (SELECT COUNT(*)::int FROM erp_customer) AS customers,
                (SELECT COUNT(*)::int FROM company WHERE erp_company_id IS NOT NULL AND archived_at IS NULL) AS linked,
                (SELECT COUNT(*)::int FROM erp_quotation) AS quotations,
                (SELECT COUNT(*)::int FROM erp_order) AS orders,
                (SELECT COUNT(*)::int FROM product WHERE erp_product_id IS NOT NULL) AS products`
      )
      .all();
    res.json({ problem: erpProblem(), runs, totals });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/run', async (req, res) => {
  try {
    res.json(await runErpSync({ trigger: 'manual' }));
  } catch (err) {
    sendError(res, err);
  }
});

// ERP customers with no company here, each with the closest names to help decide.
router.get('/customers', async (req, res) => {
  try {
    const rows = await db
      .prepare(
        `SELECT e.id, e.name, e.state, e.gstin, e.phone,
                (SELECT COALESCE(json_agg(s), '[]') FROM (
                   SELECT c.id, c.name, c.city FROM company c
                   WHERE c.archived_at IS NULL AND c.approval_status <> 'rejected' AND c.erp_company_id IS NULL AND similarity(c.normalized_name, e.normalized_name) >= 0.3
                   ORDER BY similarity(c.normalized_name, e.normalized_name) DESC LIMIT 3) s) AS suggestions
         FROM erp_customer e
         WHERE NOT e.ignored AND NOT EXISTS (SELECT 1 FROM company c WHERE c.erp_company_id = e.id)
         ORDER BY e.name LIMIT 200`
      )
      .all();
    res.json(rows);
  } catch (err) {
    sendError(res, err);
  }
});

async function loadCustomer(req) {
  const customer = await db.prepare(`SELECT * FROM erp_customer WHERE id = ?`).get(Number(req.params.id));
  if (!customer) throw new HttpError(404, 'ERP customer not found');
  const linked = await db.prepare(`SELECT name FROM company WHERE erp_company_id = ?`).get(customer.id);
  if (linked) throw new HttpError(409, `${customer.name} is already linked to ${linked.name}.`);
  return customer;
}

router.post('/customers/:id/link', async (req, res) => {
  try {
    const customer = await loadCustomer(req);
    const companyId = optionalId(req.body, 'company_id');
    if (!companyId) throw new HttpError(400, 'Choose the company.');
    const company = await db.prepare(`SELECT id, name, erp_company_id FROM company WHERE id = ? AND archived_at IS NULL`).get(companyId);
    if (!company) throw new HttpError(400, 'Company not found.');
    if (company.erp_company_id) throw new HttpError(409, `${company.name} is already linked to another ERP customer.`);
    await db.transaction(async () => {
      await db.prepare(`UPDATE company SET erp_company_id = ?, updated_at = NOW() WHERE id = ?`).run(customer.id, company.id);
      await recordAudit({ actorUserId: req.user.id, action: 'company.erp_linked', entityType: 'company', entityId: company.id, summary: `Linked ${company.name} to ERP customer ${customer.name}` });
    });
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/customers/:id/add', async (req, res) => {
  try {
    const customer = await loadCustomer(req);
    const id = await db.transaction(async () => {
      const info = await db
        .prepare(
          `INSERT INTO company (name, normalized_name, state, address, phone, email, contact_person, gstin, erp_company_id, approval_status, approved_by, approved_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, NOW(), ?) RETURNING id`
        )
        .run(customer.name, normalizeCompanyName(customer.name), customer.state, customer.address, customer.phone, customer.email, customer.contact_person, customer.gstin, customer.id, req.user.id, req.user.id);
      await recordAudit({ actorUserId: req.user.id, action: 'company.created', entityType: 'company', entityId: info.lastInsertRowid, summary: `Added company ${customer.name} from the ERP` });
      return info.lastInsertRowid;
    });
    res.status(201).json({ id });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: `A company with this name already exists. Link it instead.` });
    sendError(res, err);
  }
});

router.post('/customers/:id/ignore', async (req, res) => {
  try {
    const customer = await loadCustomer(req);
    await db.transaction(async () => {
      await db.prepare(`UPDATE erp_customer SET ignored = TRUE WHERE id = ?`).run(customer.id);
      await recordAudit({ actorUserId: req.user.id, action: 'erp_customer.ignored', entityType: 'erp_customer', entityId: customer.id, summary: `Set aside ERP customer ${customer.name}` });
    });
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
