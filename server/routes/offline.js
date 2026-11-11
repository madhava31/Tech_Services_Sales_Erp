import { Router } from 'express';
import db from '../db/index.js';
import { requireCrmWriter, scopeFilter, sendError } from '../crm/access.js';
import { TODAY_SQL } from '../crm/fields.js';

// Mounted at /api/offline. What a phone keeps so a visit or follow-up can be recorded without signal:
// the shared company list with contacts, and the follow-ups and unfinished visits this person may see.
const router = Router();

router.get('/bootstrap', requireCrmWriter, async (req, res) => {
  try {
    const companies = await db
      .prepare(
        `SELECT c.id, c.name, c.city, c.state, c.phone, c.approval_status, c.parent_company_id,
                (SELECT COALESCE(json_agg(json_build_object('id', cc.id, 'name', cc.name, 'designation', cc.designation, 'department', cc.department, 'phone', cc.phone, 'email', cc.email) ORDER BY cc.name), '[]')
                 FROM company_contact cc WHERE cc.company_id = c.id AND cc.archived_at IS NULL) AS contacts
         FROM company c WHERE c.archived_at IS NULL AND c.approval_status <> 'rejected' ORDER BY c.name LIMIT 5000`
      )
      .all();
    const visitParams = [];
    const visitScope = scopeFilter(req.user, 'v.salesperson_id', visitParams);
    const draftVisits = await db
      .prepare(
        `SELECT v.id, v.company_id, c.name AS company_name, c.city AS company_city, c.approval_status AS company_approval_status,
                v.contact_id, cc.name AS contact_name, cc.designation AS contact_designation, cc.phone AS contact_phone,
                v.salesperson_id, sp.name AS salesperson_name, v.visited_at, v.status, v.outcome, v.notes, v.completed_at,
                v.opportunity_id, NULL AS opportunity_title, NULL AS opportunity_stage
         FROM visit v JOIN company c ON c.id = v.company_id JOIN salesperson sp ON sp.id = v.salesperson_id
         LEFT JOIN company_contact cc ON cc.id = v.contact_id
         WHERE v.status = 'draft'${visitScope} ORDER BY v.visited_at DESC LIMIT 100`
      )
      .all(...visitParams);
    const { d: today } = await db.prepare(`SELECT ${TODAY_SQL}::text AS d`).get();
    res.json({ today, companies, draft_visits: draftVisits });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
