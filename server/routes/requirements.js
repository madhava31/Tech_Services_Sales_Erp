import { Router } from 'express';
import db from '../db/index.js';
import { recordAudit } from '../audit/log.js';
import { HttpError, requireCrmWriter, resolveOwner, scopeFilter, sendError } from '../crm/access.js';
import { optionalId } from '../crm/fields.js';
import { insertRequirement, requirementFields } from '../crm/requirements.js';

// Mounted at /api/requirements. Most requirements arrive with a completed visit; this adds one
// later (e.g. after a phone call) and lists them.
const router = Router();

const REQUIREMENT_SELECT = `
  SELECT r.*, c.name AS company_name, sp.name AS salesperson_name
  FROM requirement r
  JOIN company c ON c.id = r.company_id
  JOIN salesperson sp ON sp.id = r.salesperson_id`;

router.get('/', async (req, res) => {
  try {
    const params = [];
    let where = 'WHERE TRUE';
    where += scopeFilter(req.user, 'r.salesperson_id', params);
    if (req.query.company_id) {
      where += ' AND r.company_id = ?';
      params.push(Number(req.query.company_id));
    }
    params.push(Math.min(Math.max(Number(req.query.limit) || 50, 1), 200));
    res.json(await db.prepare(`${REQUIREMENT_SELECT} ${where} ORDER BY r.created_at DESC LIMIT ?`).all(...params));
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/', requireCrmWriter, async (req, res) => {
  try {
    const companyId = optionalId(req.body, 'company_id');
    if (!companyId) throw new HttpError(400, 'company_id is required');
    const company = await db.prepare(`SELECT id FROM company WHERE id = ? AND archived_at IS NULL`).get(companyId);
    if (!company) throw new HttpError(400, 'Company not found.');
    const salespersonId = await resolveOwner(req.user, req.body.salesperson_id);
    const fields = requirementFields(req.body);
    const id = await db.transaction(async () => {
      const newId = await insertRequirement({ companyId, salespersonId, userId: req.user.id, fields });
      await recordAudit({ actorUserId: req.user.id, action: 'requirement.created', entityType: 'requirement', entityId: newId, summary: `Added requirement: ${fields.description.slice(0, 120)}`, after: fields });
      return newId;
    });
    res.status(201).json(await db.prepare(`${REQUIREMENT_SELECT} WHERE r.id = ?`).get(id));
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
