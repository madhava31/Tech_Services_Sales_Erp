import db from '../db/index.js';
import { recordAudit } from '../audit/log.js';
import { HttpError } from './access.js';
import { recordHistory } from './pipeline.js';

// Moves open deals (and their open follow-ups) from one salesperson to another inside the
// caller's transaction. The original owner and all past activity keep their attribution; each
// deal gets an 'owner' history row. Returns what moved.
export async function transferDeals({ fromId, toId, opportunityIds, reason, userId }) {
  const from = await db.prepare(`SELECT id, name FROM salesperson WHERE id = ?`).get(fromId);
  const to = await db.prepare(`SELECT id, name, is_active FROM salesperson WHERE id = ?`).get(toId);
  if (!from) throw new HttpError(400, 'The salesperson handing over was not found.');
  if (!to || !to.is_active) throw new HttpError(400, 'Choose an active salesperson to take over.');
  if (from.id === to.id) throw new HttpError(400, 'Choose a different salesperson to take over.');

  // Lock the rows so a concurrent edit can't slip between the check and the update.
  const deals = await db
    .prepare(
      `SELECT id, title FROM opportunity
       WHERE owner_salesperson_id = ? AND stage NOT IN ('won', 'lost', 'abandoned')
         ${opportunityIds ? 'AND id = ANY(?::int[])' : ''}
       ORDER BY id FOR UPDATE`
    )
    .all(...(opportunityIds ? [fromId, opportunityIds] : [fromId]));
  if (opportunityIds && deals.length !== new Set(opportunityIds).size) {
    throw new HttpError(409, `Some of those deals are no longer open deals of ${from.name}. Reload and try again.`);
  }

  const dealIds = deals.map((d) => d.id);
  for (const deal of deals) {
    await db.prepare(`UPDATE opportunity SET owner_salesperson_id = ?, updated_at = NOW() WHERE id = ?`).run(to.id, deal.id);
    await recordHistory({ opportunityId: deal.id, changeType: 'owner', from: from.name, to: to.name, note: reason, userId });
  }
  const movedTasks = dealIds.length
    ? await db
        .prepare(
          `UPDATE task SET assignee_salesperson_id = ?, updated_at = NOW()
           WHERE opportunity_id = ANY(?::int[]) AND assignee_salesperson_id = ? AND status = 'open' RETURNING id`
        )
        .all(to.id, dealIds, from.id)
    : [];
  return { from, to, dealIds, taskIds: movedTasks.map((t) => t.id) };
}

// Open follow-ups of `fromId` that are not attached to a deal (e.g. revisits) — moved during a
// full handover so nothing is left on a leaver's list.
export async function transferLooseTasks({ fromId, toId }) {
  const rows = await db
    .prepare(
      `UPDATE task SET assignee_salesperson_id = ?, updated_at = NOW()
       WHERE assignee_salesperson_id = ? AND status = 'open' AND opportunity_id IS NULL RETURNING id`
    )
    .all(toId, fromId);
  return rows.map((r) => r.id);
}

// A leaver's customers' instruments and reorders: the person responsible for them changes.
export async function transferAccounts({ fromId, toId }) {
  const move = async (table) => (await db.prepare(`UPDATE ${table} SET salesperson_id = ?, updated_at = NOW() WHERE salesperson_id = ? AND is_active RETURNING id`).all(toId, fromId)).map((r) => r.id);
  return { instrumentIds: await move('installed_instrument'), reorderIds: await move('reorder_plan') };
}

export async function auditHandover({ userId, from, to, dealIds, taskIds, reason, single = false, instrumentIds = [], reorderIds = [] }) {
  await recordAudit({
    actorUserId: userId,
    action: single ? 'opportunity.transferred' : 'handover.completed',
    entityType: single ? 'opportunity' : 'salesperson',
    entityId: single ? dealIds[0] : from.id,
    summary: single
      ? `Transferred deal to ${to.name} from ${from.name}: ${reason}`
      : `Handed over ${dealIds.length} deal(s), ${taskIds.length} follow-up(s), ${instrumentIds.length} instrument(s) and ${reorderIds.length} reorder(s) from ${from.name} to ${to.name}: ${reason}`,
    before: { owner_salesperson_id: from.id },
    after: { owner_salesperson_id: to.id, opportunity_ids: dealIds, task_ids: taskIds, instrument_ids: instrumentIds, reorder_ids: reorderIds },
  });
}
