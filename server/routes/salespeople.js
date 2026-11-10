import { Router } from 'express';
import db from '../db/index.js';
import { recordAudit } from '../audit/log.js';

// Mounted at /api/admin/salespeople behind requireAuth + requireAdmin.
// The salesperson register: the people who own CRM records. Like logins, salespeople are
// deactivated rather than deleted so their history stays attributed.
const router = Router();

const SALESPERSON_SELECT = `
  SELECT sp.id, sp.employee_code, sp.name, sp.phone, sp.email, sp.is_active, sp.erp_sales_engineer_id,
         sp.created_at, sp.updated_at, u.id AS user_id, u.username, u.is_active AS user_is_active
  FROM salesperson sp
  LEFT JOIN app_user u ON u.salesperson_id = sp.id`;

function loadSalesperson(id) {
  return db.prepare(`${SALESPERSON_SELECT} WHERE sp.id = ?`).get(id);
}

function auditSnapshot(sp) {
  return {
    employee_code: sp.employee_code,
    name: sp.name,
    phone: sp.phone,
    email: sp.email,
    is_active: sp.is_active,
    erp_sales_engineer_id: sp.erp_sales_engineer_id,
  };
}

function cleanText(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
}

// Returns { fields } or { error } for create (all required fields) and update (partial).
function parseFields(body, { partial }) {
  const fields = {
    employee_code: cleanText(body.employee_code),
    name: cleanText(body.name),
    phone: cleanText(body.phone),
    email: cleanText(body.email),
  };
  if (body.erp_sales_engineer_id !== undefined) {
    const raw = body.erp_sales_engineer_id;
    const n = raw === null || raw === '' ? null : Number(raw);
    if (n !== null && !(Number.isInteger(n) && n > 0)) return { error: 'erp_sales_engineer_id must be a positive integer' };
    fields.erp_sales_engineer_id = n;
  }
  for (const key of ['employee_code', 'name']) {
    if ((!partial || fields[key] !== undefined) && !fields[key]) return { error: `${key} is required` };
  }
  if (fields.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email)) return { error: 'email is not valid' };
  return { fields };
}

function uniqueViolationMessage(err) {
  if (err.constraint === 'salesperson_erp_sales_engineer_id_key') return 'That ERP sales engineer is already linked to another salesperson.';
  return 'That employee code is already in use.';
}

router.get('/', async (req, res) => {
  try {
    res.json(await db.prepare(`${SALESPERSON_SELECT} ORDER BY sp.is_active DESC, sp.name`).all());
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { fields, error } = parseFields(req.body, { partial: false });
    if (error) return res.status(400).json({ error });
    const created = await db.transaction(async () => {
      const info = await db
        .prepare(
          `INSERT INTO salesperson (employee_code, name, phone, email, erp_sales_engineer_id)
           VALUES (?, ?, ?, ?, ?) RETURNING id`
        )
        .run(fields.employee_code, fields.name, fields.phone ?? null, fields.email ?? null, fields.erp_sales_engineer_id ?? null);
      const sp = await loadSalesperson(info.lastInsertRowid);
      await recordAudit({
        actorUserId: req.user.id,
        action: 'salesperson.created',
        entityType: 'salesperson',
        entityId: sp.id,
        summary: `Added salesperson ${sp.name} (${sp.employee_code})`,
        after: auditSnapshot(sp),
      });
      return sp;
    });
    res.status(201).json(created);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: uniqueViolationMessage(err) });
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = await loadSalesperson(id);
    if (!existing) return res.status(404).json({ error: 'Salesperson not found' });
    const { fields, error } = parseFields(req.body, { partial: true });
    if (error) return res.status(400).json({ error });
    const merged = { ...auditSnapshot(existing) };
    for (const [key, value] of Object.entries(fields)) if (value !== undefined) merged[key] = value;

    const updated = await db.transaction(async () => {
      await db
        .prepare(
          `UPDATE salesperson SET employee_code = ?, name = ?, phone = ?, email = ?, erp_sales_engineer_id = ?, updated_at = NOW()
           WHERE id = ?`
        )
        .run(merged.employee_code, merged.name, merged.phone, merged.email, merged.erp_sales_engineer_id, id);
      const sp = await loadSalesperson(id);
      await recordAudit({
        actorUserId: req.user.id,
        action: 'salesperson.updated',
        entityType: 'salesperson',
        entityId: id,
        summary: `Updated salesperson ${sp.name}`,
        before: auditSnapshot(existing),
        after: auditSnapshot(sp),
      });
      return sp;
    });
    res.json(updated);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: uniqueViolationMessage(err) });
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

async function setActive(req, res, active) {
  try {
    const id = Number(req.params.id);
    const existing = await loadSalesperson(id);
    if (!existing) return res.status(404).json({ error: 'Salesperson not found' });
    if (existing.is_active === active) {
      return res.status(409).json({ error: `This salesperson is already ${active ? 'active' : 'inactive'}` });
    }
    // Deactivate the login first, so nobody keeps working as an inactive salesperson.
    if (!active && existing.user_is_active) {
      return res.status(409).json({ error: `Deactivate the login "${existing.username}" before deactivating this salesperson.` });
    }
    // Nothing may be left on an inactive salesperson's list: hand it over first.
    if (!active) {
      const open = await db
        .prepare(
          `SELECT (SELECT COUNT(*)::int FROM opportunity WHERE owner_salesperson_id = ? AND stage NOT IN ('won', 'lost', 'abandoned')) AS deals,
                  (SELECT COUNT(*)::int FROM task WHERE assignee_salesperson_id = ? AND status = 'open') AS tasks,
                  (SELECT COUNT(*)::int FROM installed_instrument WHERE salesperson_id = ? AND is_active) + (SELECT COUNT(*)::int FROM reorder_plan WHERE salesperson_id = ? AND is_active) AS accounts`
        )
        .get(id, id, id, id);
      if (open.deals || open.tasks || open.accounts) {
        return res.status(409).json({
          error: `${existing.name} still has ${open.deals} open deal(s), ${open.tasks} open follow-up(s) and ${open.accounts} instrument(s) or reorder(s). Hand them over first.`,
          open_deals: open.deals,
          open_tasks: open.tasks,
        });
      }
    }
    const updated = await db.transaction(async () => {
      await db.prepare(`UPDATE salesperson SET is_active = ?, updated_at = NOW() WHERE id = ?`).run(active, id);
      const sp = await loadSalesperson(id);
      await recordAudit({
        actorUserId: req.user.id,
        action: active ? 'salesperson.reactivated' : 'salesperson.deactivated',
        entityType: 'salesperson',
        entityId: id,
        summary: `${active ? 'Reactivated' : 'Deactivated'} salesperson ${sp.name}`,
        before: auditSnapshot(existing),
        after: auditSnapshot(sp),
      });
      return sp;
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}

router.post('/:id/deactivate', (req, res) => setActive(req, res, false));
router.post('/:id/reactivate', (req, res) => setActive(req, res, true));

router.delete('/:id', (req, res) => {
  res.status(405).json({ error: 'Salespeople cannot be deleted. Deactivate them instead.' });
});

export default router;
