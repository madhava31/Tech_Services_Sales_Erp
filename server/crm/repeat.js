import db from '../db/index.js';
import { recordAudit } from '../audit/log.js';
import { HttpError, canSeeSalesperson } from './access.js';
import { TODAY_SQL } from './fields.js';

// Repeat business: warranties and AMCs that are ending, and consumables due for reordering. The daily
// job turns each into an ordinary follow-up on the responsible salesperson's list.

// How long before the date the follow-up appears.
export const RENEWAL_LEAD_DAYS = 60;
export const REORDER_LEAD_DAYS = 7;
// Older than this and the moment has passed: adding an old instrument shouldn't create a pile of tasks.
const TOO_LATE_DAYS = 30;

// Salespeople change only their own; managers and the office keep these records for anyone.
export function assertCanEdit(user, salespersonId) {
  if (!canSeeSalesperson(user, salespersonId)) throw new HttpError(403, 'This belongs to another salesperson.');
}

// Closes the follow-ups created for this record once they're no longer needed.
export async function closeAutoFollowups({ kinds, refId, status, note, userId }) {
  await db
    .prepare(
      `UPDATE task t SET status = ?, outcome_notes = ?, completed_at = NOW(), completed_by = ?, updated_at = NOW()
       FROM auto_followup a
       WHERE a.task_id = t.id AND a.kind = ANY(?::text[]) AND a.ref_id = ? AND t.status = 'open'`
    )
    .run(status, note, userId, kinds, refId);
}

async function createFollowup({ kind, refId, targetDate, companyId, assigneeId, title, dueDate, taskType, priority, createdBy }) {
  await db.transaction(async () => {
    const claimed = await db
      .prepare(`INSERT INTO auto_followup (kind, ref_id, target_date) VALUES (?, ?, ?) ON CONFLICT DO NOTHING RETURNING ref_id`)
      .get(kind, refId, targetDate);
    if (!claimed) return;
    const task = await db
      .prepare(
        `INSERT INTO task (company_id, assignee_salesperson_id, task_type, title, due_date, priority, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`
      )
      .run(companyId, assigneeId, taskType, title, dueDate, priority, createdBy);
    await db.prepare(`UPDATE auto_followup SET task_id = ? WHERE kind = ? AND ref_id = ? AND target_date = ?`).run(task.lastInsertRowid, kind, refId, targetDate);
    await recordAudit({
      actorUserId: null,
      action: 'task.created',
      entityType: 'task',
      entityId: task.lastInsertRowid,
      summary: `Automatic follow-up: ${title}`,
    });
  });
}

// Safe to run repeatedly: each date creates one follow-up. Records whose salesperson has left wait
// until they're handed over, and appear on the Renewals screen meanwhile.
export async function createRepeatFollowups() {
  let created = 0;
  const [{ count: before }] = await db.prepare(`SELECT COUNT(*)::int AS count FROM auto_followup`).all();

  const endings = await db
    .prepare(
      `SELECT i.id, i.company_id, i.description, i.salesperson_id, i.created_by, c.name AS company_name, e.kind, e.end_date::text AS end_date,
              (e.end_date - ${TODAY_SQL}) AS days_left
       FROM installed_instrument i
       JOIN company c ON c.id = i.company_id
       JOIN salesperson sp ON sp.id = i.salesperson_id AND sp.is_active
       CROSS JOIN LATERAL (VALUES ('warranty', i.warranty_end_date), ('amc', i.amc_end_date)) AS e(kind, end_date)
       WHERE i.is_active AND c.archived_at IS NULL
         AND e.end_date BETWEEN ${TODAY_SQL} - ${TOO_LATE_DAYS} AND ${TODAY_SQL} + ${RENEWAL_LEAD_DAYS}`
    )
    .all();
  for (const row of endings) {
    const label = row.kind === 'amc' ? 'AMC' : 'Warranty';
    await createFollowup({
      kind: row.kind,
      refId: row.id,
      targetDate: row.end_date,
      companyId: row.company_id,
      assigneeId: row.salesperson_id,
      title: `${label} ${row.days_left < 0 ? 'ended' : 'ends'} ${row.end_date}: ${row.description}, ${row.company_name}`,
      // A week to act, sooner if it's about to end.
      dueDate: `${await inDays(Math.max(0, Math.min(7, row.days_left)))}`,
      taskType: 'renewal',
      priority: row.days_left <= 14 ? 'high' : 'normal',
      createdBy: row.created_by,
    });
  }

  const reorders = await db
    .prepare(
      `SELECT r.id, r.company_id, r.item, r.salesperson_id, r.created_by, c.name AS company_name, r.next_due_date::text AS next_due_date,
              (r.next_due_date - ${TODAY_SQL}) AS days_left
       FROM reorder_plan r
       JOIN company c ON c.id = r.company_id
       JOIN salesperson sp ON sp.id = r.salesperson_id AND sp.is_active
       WHERE r.is_active AND c.archived_at IS NULL
         AND r.next_due_date BETWEEN ${TODAY_SQL} - ${TOO_LATE_DAYS} AND ${TODAY_SQL} + ${REORDER_LEAD_DAYS}`
    )
    .all();
  for (const row of reorders) {
    await createFollowup({
      kind: 'reorder',
      refId: row.id,
      targetDate: row.next_due_date,
      companyId: row.company_id,
      assigneeId: row.salesperson_id,
      title: `Reorder call: ${row.item}, ${row.company_name}`,
      dueDate: row.days_left < 0 ? await inDays(0) : row.next_due_date,
      taskType: 'reorder',
      priority: 'normal',
      createdBy: row.created_by,
    });
  }

  const [{ count: after }] = await db.prepare(`SELECT COUNT(*)::int AS count FROM auto_followup`).all();
  created = after - before;
  return created;
}

async function inDays(days) {
  const { d } = await db.prepare(`SELECT (${TODAY_SQL} + ?::int)::text AS d`).get(days);
  return d;
}
