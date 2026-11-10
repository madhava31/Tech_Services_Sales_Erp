import { Router } from 'express';
import db from '../db/index.js';
import { recordAudit } from '../audit/log.js';
import { isAdminRole } from '../auth/roles.js';
import { HttpError, scopeFilter, sendError } from '../crm/access.js';
import { TODAY_SQL } from '../crm/fields.js';
import { OPEN_STAGES, isOpen } from '../crm/pipeline.js';

// Mounted at /api/analysis: the sales funnel, the monthly forecast and the stuck-deal limits. A
// salesperson gets their own deals; everyone else the team's, or one person's with ?salesperson_id=.
const router = Router();

const FUNNEL_STAGES = [...OPEN_STAGES, 'won'];
const FUNNEL_DAYS = [30, 90, 180, 365];

function dealFilter(req, params) {
  let where = scopeFilter(req.user, 'o.owner_salesperson_id', params);
  for (const [key, column] of [
    ['salesperson_id', 'o.owner_salesperson_id'],
    ['oem_id', 'o.oem_id'],
  ]) {
    if (req.query[key]) {
      const id = Number(req.query[key]);
      if (!Number.isInteger(id)) throw new HttpError(400, `${key} must be a number`);
      where += ` AND ${column} = ?`;
      params.push(id);
    }
  }
  return where;
}

const DAY_MS = 86400000;

// Deals opened in the period and how far each has got. A deal that skipped a stage still counts as
// having passed it, so each row can only be as big as the one before. Deals opened recently may still
// move on, so the later rows of a short period read low.
router.get('/funnel', async (req, res) => {
  try {
    const days = FUNNEL_DAYS.includes(Number(req.query.days)) ? Number(req.query.days) : 90;
    const { d: today } = await db.prepare(`SELECT ${TODAY_SQL}::text AS d`).get();
    const params = [days - 1];
    const filter = dealFilter(req, params);
    const deals = await db
      .prepare(
        `SELECT o.id, o.stage, o.estimated_value, o.won_value, o.closed_at,
                (SELECT json_agg(json_build_object('to', h.to_value, 'at', h.changed_at) ORDER BY h.changed_at, h.id)
                 FROM opportunity_history h WHERE h.opportunity_id = o.id AND h.change_type IN ('created', 'stage')) AS steps
         FROM opportunity o
         WHERE o.created_at >= ((${TODAY_SQL} - ?::int)::timestamp AT TIME ZONE 'Asia/Kolkata')${filter}`
      )
      .all(...params);

    const rows = FUNNEL_STAGES.map((stage) => ({ stage, reached: 0, reached_value: 0, open_now: 0, dropped: 0, days_total: 0, days_count: 0 }));
    const now = Date.now();
    for (const deal of deals) {
      const steps = deal.steps ?? [];
      const furthest = deal.stage === 'won' ? rows.length - 1 : Math.max(0, ...steps.map((s) => OPEN_STAGES.indexOf(s.to)));
      const value = deal.won_value ?? deal.estimated_value ?? 0;
      for (let i = 0; i <= furthest; i++) {
        rows[i].reached++;
        rows[i].reached_value += value;
      }
      if (isOpen(deal.stage)) rows[OPEN_STAGES.indexOf(deal.stage)].open_now++;
      else if (deal.stage !== 'won') rows[furthest].dropped++;
      // Time spent in each open stage, including the current one so far.
      steps.forEach((step, i) => {
        const index = OPEN_STAGES.indexOf(step.to);
        if (index < 0) return;
        const end = steps[i + 1]?.at ?? deal.closed_at ?? now;
        rows[index].days_total += (new Date(end).getTime() - new Date(step.at).getTime()) / DAY_MS;
        rows[index].days_count++;
      });
    }

    const openParams = [];
    const openFilter = dealFilter(req, openParams);
    const openByStage = await db
      .prepare(
        `SELECT o.stage, COUNT(*)::int AS deals, COALESCE(SUM(o.estimated_value), 0)::float AS value
         FROM opportunity o WHERE o.stage NOT IN ('won', 'lost', 'abandoned')${openFilter} GROUP BY o.stage`
      )
      .all(...openParams);

    res.json({
      days,
      today,
      total: deals.length,
      lost_or_abandoned: rows.reduce((sum, r) => sum + r.dropped, 0),
      stages: rows.map(({ days_total: total, days_count: count, ...row }, i) => ({
        ...row,
        // Of the deals that reached this stage, the share that reached the next one.
        to_next_pct: i < rows.length - 1 && row.reached ? Math.round((rows[i + 1].reached / row.reached) * 100) : null,
        avg_days: count ? Math.round((total / count) * 10) / 10 : null,
      })),
      open_by_stage: OPEN_STAGES.map((stage) => openByStage.find((s) => s.stage === stage) ?? { stage, deals: 0, value: 0 }),
    });
  } catch (err) {
    sendError(res, err);
  }
});

// A deal's confidence comes from its win probability, so nobody fills in a second field.
function category(probability) {
  if (probability >= 75) return 'commit';
  return probability >= 50 ? 'best_case' : 'pipeline';
}

const emptyBucket = () => ({ commit: 0, best_case: 0, pipeline: 0, total: 0, weighted: 0, count: 0, deals: [] });

function add(bucket, deal) {
  const value = deal.estimated_value ?? 0;
  bucket[category(deal.probability)] += value;
  bucket.total += value;
  bucket.weighted += (value * deal.probability) / 100;
  bucket.count++;
  bucket.deals.push(deal);
}

const FORECAST_MONTHS = 6;

// What is expected to close, by the month of each open deal's expected closing date. Deals already
// past their date are kept apart: counting them in this month would make it look better than it is.
router.get('/forecast', async (req, res) => {
  try {
    const { d: today } = await db.prepare(`SELECT ${TODAY_SQL}::text AS d`).get();
    const params = [];
    const filter = dealFilter(req, params);
    const deals = await db
      .prepare(
        `SELECT o.id, o.title, o.stage, o.estimated_value, o.probability, o.expected_close_date, c.name AS company_name,
                o.owner_salesperson_id, sp.name AS owner_name
         FROM opportunity o JOIN company c ON c.id = o.company_id JOIN salesperson sp ON sp.id = o.owner_salesperson_id
         WHERE o.stage NOT IN ('won', 'lost', 'abandoned')${filter}
         ORDER BY o.expected_close_date NULLS LAST, o.estimated_value DESC NULLS LAST`
      )
      .all(...params);

    const start = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
    const months = [];
    for (let i = 0; i < FORECAST_MONTHS; i++) {
      const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
      months.push({ month: d.toISOString().slice(0, 7), won_value: 0, won_deals: 0, ...emptyBucket() });
    }
    const overdue = emptyBucket();
    const later = emptyBucket();
    const noDate = emptyBucket();
    const owners = new Map();
    const lastMonth = months[months.length - 1].month;
    const nearMonths = months.slice(0, 3).map((m) => m.month);

    for (const deal of deals) {
      const date = deal.expected_close_date;
      if (!date) add(noDate, deal);
      else if (date < today) add(overdue, deal);
      else if (date.slice(0, 7) > lastMonth) add(later, deal);
      else add(months.find((m) => m.month === date.slice(0, 7)), deal);
      if (date && date >= today && nearMonths.includes(date.slice(0, 7))) {
        if (!owners.has(deal.owner_salesperson_id)) owners.set(deal.owner_salesperson_id, { salesperson_id: deal.owner_salesperson_id, name: deal.owner_name, ...emptyBucket() });
        add(owners.get(deal.owner_salesperson_id), deal);
      }
    }

    // Orders already won in the months shown, by closing date.
    const wonParams = [`${months[0].month}-01`];
    const wonFilter = dealFilter(req, wonParams);
    const won = await db
      .prepare(
        `SELECT to_char(o.closed_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') AS month, COUNT(*)::int AS deals, COALESCE(SUM(o.won_value), 0)::float AS value
         FROM opportunity o
         WHERE o.stage = 'won' AND o.closed_at >= (?::date::timestamp AT TIME ZONE 'Asia/Kolkata')${wonFilter} GROUP BY 1`
      )
      .all(...wonParams);
    for (const row of won) {
      const month = months.find((m) => m.month === row.month);
      if (month) {
        month.won_value = row.value;
        month.won_deals = row.deals;
      }
    }

    const round = (b) => ({ ...b, weighted: Math.round(b.weighted) });
    res.json({
      today,
      months: months.map(round),
      overdue: round(overdue),
      later: round(later),
      no_date: round(noDate),
      // Team view only: a salesperson's own numbers are the page itself.
      by_salesperson: req.user.role === 'salesperson' ? [] : [...owners.values()].map(({ deals: _deals, ...o }) => round(o)).sort((a, b) => b.total - a.total),
    });
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/stage-settings', async (req, res) => {
  try {
    const rows = await db.prepare(`SELECT stage, stuck_after_days FROM stage_setting`).all();
    res.json(OPEN_STAGES.map((stage) => rows.find((r) => r.stage === stage)));
  } catch (err) {
    sendError(res, err);
  }
});

router.put('/stage-settings/:stage', async (req, res) => {
  try {
    if (!isAdminRole(req.user.role)) throw new HttpError(403, 'Only an administrator can change this.');
    if (!OPEN_STAGES.includes(req.params.stage)) throw new HttpError(404, 'Not found');
    const days = Number(req.body?.stuck_after_days);
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new HttpError(400, 'Enter a whole number of days from 1 to 365.');
    const row = await db.transaction(async () => {
      const before = await db.prepare(`SELECT stuck_after_days FROM stage_setting WHERE stage = ?`).get(req.params.stage);
      await db.prepare(`UPDATE stage_setting SET stuck_after_days = ?, updated_at = NOW() WHERE stage = ?`).run(days, req.params.stage);
      await recordAudit({
        actorUserId: req.user.id,
        action: 'stage_setting.updated',
        entityType: 'stage_setting',
        summary: `Deals at ${req.params.stage} now count as stuck after ${days} days (was ${before.stuck_after_days})`,
        before,
        after: { stuck_after_days: days },
      });
      return db.prepare(`SELECT stage, stuck_after_days FROM stage_setting WHERE stage = ?`).get(req.params.stage);
    });
    res.json(row);
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
