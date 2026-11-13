import { Router } from 'express';
import db from '../db/index.js';
import { scopeFilter, sendError } from '../crm/access.js';
import { TODAY_SQL } from '../crm/fields.js';
import { TASK_CONTACT_JOIN } from '../crm/tasks.js';
import { DAYS_IN_STAGE_SQL, STUCK_AFTER_SQL, STUCK_SQL } from '../crm/stuck.js';

// Mounted at /api/today. The first screen after sign-in: what needs doing now, and how the week
// is going. Salespeople see their own; everyone else sees the whole team.
const router = Router();

const TASK_COLUMNS = `t.id, t.title, t.task_type, t.due_date, t.priority, t.company_id, c.name AS company_name,
                      sp.name AS assignee_name, t.updated_at, (t.due_date < ${TODAY_SQL}) AS is_overdue, tc.contact_name, tc.contact_phone`;

router.get('/', async (req, res) => {
  try {
    const today = (await db.prepare(`SELECT ${TODAY_SQL}::text AS d`).get()).d;

    const taskParams = [];
    const taskScope = scopeFilter(req.user, 't.assignee_salesperson_id', taskParams);
    const dueTasks = await db
      .prepare(
        `SELECT ${TASK_COLUMNS}
         FROM task t JOIN company c ON c.id = t.company_id JOIN salesperson sp ON sp.id = t.assignee_salesperson_id${TASK_CONTACT_JOIN}
         WHERE t.status = 'open' AND t.due_date <= ${TODAY_SQL} + 7${taskScope}
         ORDER BY t.due_date, t.priority DESC, t.id
         LIMIT 200`
      )
      .all(...taskParams);

    const draftParams = [];
    const draftScope = scopeFilter(req.user, 'v.salesperson_id', draftParams);
    const draftVisits = await db
      .prepare(
        `SELECT v.id, v.visited_at, v.company_id, c.name AS company_name, sp.name AS salesperson_name
         FROM visit v JOIN company c ON c.id = v.company_id JOIN salesperson sp ON sp.id = v.salesperson_id
         WHERE v.status = 'draft'${draftScope}
         ORDER BY v.visited_at DESC LIMIT 20`
      )
      .all(...draftParams);

    const recentParams = [];
    const recentScope = scopeFilter(req.user, 'v.salesperson_id', recentParams);
    const recentVisits = await db
      .prepare(
        `SELECT v.id, v.visited_at, v.outcome, v.company_id, c.name AS company_name, sp.name AS salesperson_name
         FROM visit v JOIN company c ON c.id = v.company_id JOIN salesperson sp ON sp.id = v.salesperson_id
         WHERE v.status = 'completed'${recentScope}
         ORDER BY v.completed_at DESC LIMIT 5`
      )
      .all(...recentParams);

    // Week = Monday to today, in India time.
    const statParams = [];
    const statScope = scopeFilter(req.user, 'v.salesperson_id', statParams);
    const stats = await db
      .prepare(
        `SELECT
           COUNT(*) FILTER (WHERE v.visited_at >= (date_trunc('week', ${TODAY_SQL}::timestamp) AT TIME ZONE 'Asia/Kolkata')) AS visits_this_week,
           COUNT(DISTINCT v.company_id) FILTER (WHERE v.visited_at >= ((${TODAY_SQL} - 29)::timestamp AT TIME ZONE 'Asia/Kolkata')) AS companies_visited_30d,
           COUNT(*) FILTER (WHERE v.outcome = 'quotation_requested' AND v.visited_at >= ((${TODAY_SQL} - 29)::timestamp AT TIME ZONE 'Asia/Kolkata')) AS quotation_requests_30d
         FROM visit v
         WHERE v.status = 'completed'${statScope}`
      )
      .get(...statParams);

    const overdueParams = [];
    const overdueScope = scopeFilter(req.user, 't.assignee_salesperson_id', overdueParams);
    const overdueCount = await db
      .prepare(`SELECT COUNT(*) AS c FROM task t WHERE t.status = 'open' AND t.due_date < ${TODAY_SQL}${overdueScope}`)
      .get(...overdueParams);

    const dealParams = [];
    const dealScope = scopeFilter(req.user, 'o.owner_salesperson_id', dealParams);
    const overdueDeals = await db
      .prepare(
        `SELECT o.id, o.title, o.stage, o.estimated_value, o.expected_close_date, c.name AS company_name, sp.name AS owner_name
         FROM opportunity o JOIN company c ON c.id = o.company_id JOIN salesperson sp ON sp.id = o.owner_salesperson_id
         WHERE o.stage NOT IN ('won', 'lost') AND o.expected_close_date < ${TODAY_SQL}${dealScope}
         ORDER BY o.expected_close_date, o.id LIMIT 50`
      )
      .all(...dealParams);

    // Deals already listed as overdue aren't repeated here.
    const stuckParams = [];
    const stuckScope = scopeFilter(req.user, 'o.owner_salesperson_id', stuckParams);
    const stuckDeals = await db
      .prepare(
        `SELECT o.id, o.title, o.stage, o.estimated_value, c.name AS company_name, sp.name AS owner_name,
                ${DAYS_IN_STAGE_SQL} AS days_in_stage, ${STUCK_AFTER_SQL} AS stuck_after_days
         FROM opportunity o JOIN company c ON c.id = o.company_id JOIN salesperson sp ON sp.id = o.owner_salesperson_id
         WHERE ${STUCK_SQL} AND NOT COALESCE(o.expected_close_date < ${TODAY_SQL}, FALSE)${stuckScope}
         ORDER BY days_in_stage DESC, o.id LIMIT 50`
      )
      .all(...stuckParams);

    const tenderParams = [];
    const tenderScope = scopeFilter(req.user, 'o.owner_salesperson_id', tenderParams);
    const tendersDue = await db
      .prepare(
        `SELECT t.opportunity_id, t.tender_number, t.bid_due_date, (t.bid_due_date - ${TODAY_SQL}) AS days_left, o.title, c.name AS company_name, sp.name AS owner_name
         FROM tender t JOIN opportunity o ON o.id = t.opportunity_id JOIN company c ON c.id = o.company_id JOIN salesperson sp ON sp.id = o.owner_salesperson_id
         WHERE o.tender AND o.closed_at IS NULL AND t.bid_status = 'preparing' AND t.bid_due_date <= ${TODAY_SQL} + 7${tenderScope}
         ORDER BY t.bid_due_date LIMIT 30`
      )
      .all(...tenderParams);

    // Customers have ordered, but the deal is still open: only a person can close it.
    const orderParams = [];
    const orderScope = scopeFilter(req.user, 'o.owner_salesperson_id', orderParams);
    const erpOrders = await db
      .prepare(
        `SELECT DISTINCT ON (o.id) o.id, o.title, c.name AS company_name, sp.name AS owner_name, eo.number AS order_number, eo.client_po_ref
         FROM opportunity o
         JOIN quotation_link q ON q.opportunity_id = o.id
         JOIN erp_order eo ON eo.erp_quotation_id = q.erp_quotation_id
         JOIN company c ON c.id = o.company_id JOIN salesperson sp ON sp.id = o.owner_salesperson_id
         WHERE o.stage NOT IN ('won', 'lost')${orderScope}
         ORDER BY o.id, eo.id DESC LIMIT 30`
      )
      .all(...orderParams);

    res.json({
      today,
      overdue: dueTasks.filter((t) => t.due_date < today),
      due_today: dueTasks.filter((t) => t.due_date === today),
      upcoming: dueTasks.filter((t) => t.due_date > today),
      overdue_deals: overdueDeals,
      stuck_deals: stuckDeals,
      tenders_due: tendersDue,
      erp_orders: erpOrders,
      draft_visits: draftVisits,
      recent_visits: recentVisits,
      stats: {
        visits_this_week: Number(stats.visits_this_week),
        companies_visited_30d: Number(stats.companies_visited_30d),
        quotation_requests_30d: Number(stats.quotation_requests_30d),
        overdue_follow_ups: Number(overdueCount.c),
      },
    });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
