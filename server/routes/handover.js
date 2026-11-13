import { Router } from 'express';
import db from '../db/index.js';
import { HttpError, isManaging, sendError } from '../crm/access.js';
import { TODAY_SQL, optionalId, requiredText } from '../crm/fields.js';
import { auditHandover, transferAccounts, transferDeals, transferLooseTasks } from '../crm/handover.js';
import { STUCK_SQL } from '../crm/stuck.js';

// Mounted at /api/handover. When a salesperson leaves (or a territory changes) a manager moves
// their open deals and follow-ups to someone else in one step. Nothing is deleted: closed deals,
// visits and history stay with the original salesperson.
const router = Router();

router.use((req, res, next) => {
  if (!isManaging(req.user)) return res.status(403).json({ error: 'Only a manager can hand over work.' });
  next();
});

// What would move: the salesperson's open deals, open follow-ups and unfinished visits.
router.get('/preview', async (req, res) => {
  try {
    const fromId = optionalId(req.query, 'from_salesperson_id');
    if (!fromId) throw new HttpError(400, 'from_salesperson_id is required');
    const person = await db
      .prepare(
        `SELECT sp.id, sp.name, sp.is_active, u.username, u.is_active AS user_is_active
         FROM salesperson sp LEFT JOIN app_user u ON u.salesperson_id = sp.id WHERE sp.id = ?`
      )
      .get(fromId);
    if (!person) throw new HttpError(404, 'Salesperson not found');
    const deals = await db
      .prepare(
        `SELECT o.id, o.title, o.stage, o.estimated_value, o.expected_close_date, c.name AS company_name,
                (o.expected_close_date < ${TODAY_SQL}) AS is_overdue, ${STUCK_SQL} AS is_stuck,
                (SELECT COUNT(*)::int FROM task t WHERE t.opportunity_id = o.id AND t.status = 'open' AND t.assignee_salesperson_id = o.owner_salesperson_id) AS open_tasks
         FROM opportunity o JOIN company c ON c.id = o.company_id
         WHERE o.owner_salesperson_id = ? AND o.stage NOT IN ('won', 'lost')
         ORDER BY o.estimated_value DESC NULLS LAST, o.id`
      )
      .all(fromId);
    const [{ loose_tasks: looseTasks }] = await db
      .prepare(`SELECT COUNT(*)::int AS loose_tasks FROM task WHERE assignee_salesperson_id = ? AND status = 'open' AND opportunity_id IS NULL`)
      .all(fromId);
    const [{ drafts }] = await db.prepare(`SELECT COUNT(*)::int AS drafts FROM visit WHERE salesperson_id = ? AND status = 'draft'`).all(fromId);
    const [{ instruments, reorders }] = await db
      .prepare(
        `SELECT (SELECT COUNT(*)::int FROM installed_instrument WHERE salesperson_id = ? AND is_active) AS instruments,
                (SELECT COUNT(*)::int FROM reorder_plan WHERE salesperson_id = ? AND is_active) AS reorders`
      )
      .all(fromId, fromId);
    res.json({ salesperson: person, deals, loose_tasks: looseTasks, draft_visits: drafts, instruments, reorders });
  } catch (err) {
    sendError(res, err);
  }
});

// Body: from_salesperson_id, to_salesperson_id, reason, opportunity_ids (optional — default all
// open deals), include_loose_tasks (default true).
router.post('/', async (req, res) => {
  try {
    const fromId = optionalId(req.body, 'from_salesperson_id');
    const toId = optionalId(req.body, 'to_salesperson_id');
    if (!fromId || !toId) throw new HttpError(400, 'from_salesperson_id and to_salesperson_id are required');
    const reason = requiredText(req.body, 'reason', { max: 500 });
    let opportunityIds = null;
    if (req.body.opportunity_ids !== undefined) {
      if (!Array.isArray(req.body.opportunity_ids) || req.body.opportunity_ids.some((id) => !Number.isInteger(id) || id <= 0)) {
        throw new HttpError(400, 'opportunity_ids must be a list of opportunity ids');
      }
      opportunityIds = req.body.opportunity_ids;
    }
    const includeLoose = req.body.include_loose_tasks !== false;

    const result = await db.transaction(async () => {
      const moved = await transferDeals({ fromId, toId, opportunityIds, reason, userId: req.user.id });
      const looseIds = includeLoose ? await transferLooseTasks({ fromId, toId }) : [];
      const accounts = includeLoose ? await transferAccounts({ fromId, toId }) : { instrumentIds: [], reorderIds: [] };
      const taskIds = [...moved.taskIds, ...looseIds];
      if (moved.dealIds.length + taskIds.length + accounts.instrumentIds.length + accounts.reorderIds.length === 0) {
        throw new HttpError(409, `${moved.from.name} has no open opportunities or follow-ups to hand over.`);
      }
      await auditHandover({ userId: req.user.id, from: moved.from, to: moved.to, dealIds: moved.dealIds, taskIds, reason, ...accounts });
      return {
        from: moved.from.name,
        to: moved.to.name,
        deals_moved: moved.dealIds.length,
        follow_ups_moved: taskIds.length,
        instruments_moved: accounts.instrumentIds.length,
        reorders_moved: accounts.reorderIds.length,
      };
    });
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
