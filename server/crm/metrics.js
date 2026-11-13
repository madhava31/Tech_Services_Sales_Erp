import db from '../db/index.js';
import { TODAY_SQL } from './fields.js';
import { STUCK_SQL } from './stuck.js';

// Sales metrics, defined once (docs/architecture-plan.md §6) so the salesperson, manager and MD
// views can never disagree. `salespersonIds` is null for "everyone"; dates are inclusive
// YYYY-MM-DD days in India time.
//
// Each metric is attributed to one salesperson column, chosen deliberately:
//  - visits, new prospects: who made the visit
//  - deals opened: who opened the deal (original owner) — it stays theirs after a transfer
//  - quotation requests, quotations sent, won/lost, pipeline: the deal's current owner
export async function computeMetrics({ salespersonIds = null, from, to }) {
  const params = [];
  const p = (value) => {
    params.push(value);
    return '?';
  };
  const scope = (column) => (salespersonIds === null ? '' : ` AND ${column} = ANY(${p(salespersonIds)}::int[])`);
  const start = () => `(${p(from)}::date::timestamp AT TIME ZONE 'Asia/Kolkata')`;
  const end = () => `((${p(to)}::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`;
  const inRange = (column) => `${column} >= ${start()} AND ${column} < ${end()}`;

  const sql = `
    SELECT
      (SELECT COUNT(*) FROM visit v
        WHERE v.status = 'completed' AND ${inRange('v.visited_at')}${scope('v.salesperson_id')}) AS visits,
      (SELECT COUNT(DISTINCT v.company_id) FROM visit v
        WHERE v.status = 'completed' AND ${inRange('v.visited_at')}${scope('v.salesperson_id')}) AS companies_visited,
      (SELECT COUNT(*) FROM (
         SELECT DISTINCT ON (v.company_id) v.company_id, v.salesperson_id, v.visited_at
         FROM visit v WHERE v.status = 'completed' ORDER BY v.company_id, v.visited_at, v.id) first_visit
        WHERE ${inRange('first_visit.visited_at')}${scope('first_visit.salesperson_id')}) AS new_prospects,
      (SELECT COUNT(*) FROM opportunity o
        WHERE ${inRange('o.created_at')}${scope('o.original_owner_salesperson_id')}) AS deals_opened,
      (SELECT COUNT(DISTINCT h.opportunity_id) FROM opportunity_history h JOIN opportunity o ON o.id = h.opportunity_id
        WHERE h.to_value = 'develop' AND h.change_type IN ('created', 'stage')
          AND ${inRange('h.changed_at')}${scope('o.owner_salesperson_id')}) AS quotation_requests,
      (SELECT COUNT(*) FROM quotation_link q JOIN opportunity o ON o.id = q.opportunity_id
        WHERE q.status <> 'draft'
          AND COALESCE(q.quotation_date, (q.created_at AT TIME ZONE 'Asia/Kolkata')::date) BETWEEN ${p(from)}::date AND ${p(to)}::date
          ${scope('o.owner_salesperson_id')}) AS quotations_sent,
      (SELECT COUNT(*) FROM opportunity o
        WHERE o.stage = 'won' AND ${inRange('o.closed_at')}${scope('o.owner_salesperson_id')}) AS deals_won,
      (SELECT COALESCE(SUM(o.won_value), 0) FROM opportunity o
        WHERE o.stage = 'won' AND ${inRange('o.closed_at')}${scope('o.owner_salesperson_id')}) AS won_value,
      (SELECT COUNT(*) FROM opportunity o
        WHERE o.stage = 'lost' AND ${inRange('o.closed_at')}${scope('o.owner_salesperson_id')}) AS deals_lost,
      (SELECT AVG(EXTRACT(EPOCH FROM (o.closed_at - o.created_at)) / 86400) FROM opportunity o
        WHERE o.stage = 'won' AND ${inRange('o.closed_at')}${scope('o.owner_salesperson_id')}) AS avg_days_to_win,
      (SELECT COUNT(*) FROM opportunity o
        WHERE o.stage NOT IN ('won', 'lost') AND o.expected_close_date < ${TODAY_SQL}${scope('o.owner_salesperson_id')}) AS overdue_deals,
      (SELECT COUNT(*) FROM opportunity o
        WHERE ${STUCK_SQL}${scope('o.owner_salesperson_id')}) AS stuck_deals,
      (SELECT COUNT(*) FROM opportunity o
        WHERE o.stage NOT IN ('won', 'lost')${scope('o.owner_salesperson_id')}) AS open_deals,
      (SELECT COALESCE(SUM(o.estimated_value), 0) FROM opportunity o
        WHERE o.stage NOT IN ('won', 'lost')${scope('o.owner_salesperson_id')}) AS pipeline_value,
      (SELECT COALESCE(SUM(o.estimated_value * o.probability / 100.0), 0) FROM opportunity o
        WHERE o.stage NOT IN ('won', 'lost')${scope('o.owner_salesperson_id')}) AS weighted_pipeline,
      (SELECT COUNT(*) FROM task t
        WHERE t.status = 'open' AND t.due_date < ${TODAY_SQL}${scope('t.assignee_salesperson_id')}) AS overdue_follow_ups`;

  const row = await db.prepare(sql).get(...params);
  const n = (v) => (v === null || v === undefined ? 0 : Number(v));
  const won = n(row.deals_won);
  const lost = n(row.deals_lost);

  const lostParams = [];
  const lp = (value) => {
    lostParams.push(value);
    return '?';
  };
  const lostReasons = await db
    .prepare(
      `SELECT o.lost_reason AS reason, COUNT(*)::int AS count FROM opportunity o
       WHERE o.stage = 'lost'
         AND o.closed_at >= (${lp(from)}::date::timestamp AT TIME ZONE 'Asia/Kolkata')
         AND o.closed_at < ((${lp(to)}::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')
         ${salespersonIds === null ? '' : `AND o.owner_salesperson_id = ANY(${lp(salespersonIds)}::int[])`}
       GROUP BY o.lost_reason ORDER BY count DESC`
    )
    .all(...lostParams);

  return {
    from,
    to,
    visits: n(row.visits),
    companies_visited: n(row.companies_visited),
    new_prospects: n(row.new_prospects),
    deals_opened: n(row.deals_opened),
    quotation_requests: n(row.quotation_requests),
    quotations_sent: n(row.quotations_sent),
    deals_won: won,
    won_value: n(row.won_value),
    deals_lost: lost,
    // Of the deals closed in the period, the share won. null when nothing closed.
    win_rate: won + lost > 0 ? Math.round((won / (won + lost)) * 1000) / 10 : null,
    avg_days_to_win: row.avg_days_to_win === null ? null : Math.round(Number(row.avg_days_to_win) * 10) / 10,
    lost_reasons: lostReasons,
    // Snapshot "now", independent of the period:
    open_deals: n(row.open_deals),
    overdue_deals: n(row.overdue_deals),
    stuck_deals: n(row.stuck_deals),
    pipeline_value: n(row.pipeline_value),
    weighted_pipeline: Math.round(n(row.weighted_pipeline) * 100) / 100,
    overdue_follow_ups: n(row.overdue_follow_ups),
  };
}
