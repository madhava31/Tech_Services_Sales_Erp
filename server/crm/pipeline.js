import db from '../db/index.js';
import { recordAudit } from '../audit/log.js';

// Pipeline stages in order. Win probability is chosen on the deal, not derived from its stage.
export const OPEN_STAGES = ['new_prospect', 'visit_completed', 'qualified', 'quotation_requested', 'quotation_sent', 'negotiation'];
export const CLOSED_STAGES = ['won', 'lost', 'abandoned'];
export const STAGE_KEYS = [...OPEN_STAGES, ...CLOSED_STAGES];
export const WIN_PROBABILITIES = [25, 50, 75, 100];
export const DEFAULT_PROBABILITY = 25;
export const LOST_REASONS = ['price', 'competitor', 'no_budget', 'no_requirement', 'timing', 'product_fit', 'no_response', 'other'];
export const QUOTATION_STATUSES = ['draft', 'sent', 'accepted', 'rejected'];

export function stageOrder(stage) {
  return STAGE_KEYS.indexOf(stage);
}

export function isOpen(stage) {
  return OPEN_STAGES.includes(stage);
}

// userId is null for the ERP sync, which keeps the history's who-did-it honest.
export async function recordHistory({ opportunityId, changeType, from = null, to, note = null, field = null, userId }) {
  await db
    .prepare(
      `INSERT INTO opportunity_history (opportunity_id, change_type, field, from_value, to_value, note, changed_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(opportunityId, changeType, field, from, to, note, userId);
}

// Moves an open deal forward to `stage` if it is currently earlier in the pipeline — used when
// something that happened (a quotation request, a quotation sent) implies the deal progressed.
// Never moves a deal backwards and never touches a closed deal. Runs in the caller's transaction.
export async function advanceIfBehind({ opportunity, stage, userId, note }) {
  if (!isOpen(opportunity.stage) || stageOrder(opportunity.stage) >= stageOrder(stage)) return false;
  await db.prepare(`UPDATE opportunity SET stage = ?, updated_at = NOW() WHERE id = ?`).run(stage, opportunity.id);
  await recordHistory({ opportunityId: opportunity.id, changeType: 'stage', from: opportunity.stage, to: stage, note, userId });
  await recordAudit({
    actorUserId: userId,
    action: 'opportunity.stage_changed',
    entityType: 'opportunity',
    entityId: opportunity.id,
    summary: `"${opportunity.title}" moved from ${opportunity.stage} to ${stage}${note ? `: ${note}` : ''}`,
    before: { stage: opportunity.stage },
    after: { stage },
  });
  return true;
}
