import db from '../db/index.js';
import { recordAudit } from '../audit/log.js';
import { HttpError } from './access.js';
import { oneOf, optionalNumber, optionalText } from './fields.js';

// Pipeline stages in order: Create, Qualify, Develop, Prove, Negotiation, then Closed as Won or Lost.
// Win probability is chosen on the opportunity, not derived from its stage.
export const OPEN_STAGES = ['create', 'qualify', 'develop', 'prove', 'negotiation'];
export const CLOSED_STAGES = ['won', 'lost'];
// For SQL where the opportunity is aliased o: open and closed, without spelling the stages out again.
export const OPEN_SQL = `o.stage NOT IN ('won', 'lost')`;
export const CLOSED_SQL = `o.stage IN ('won', 'lost')`;
// Stages that need a quotation on the opportunity first.
export const QUOTED_STAGES = ['prove', 'negotiation'];
// The stages before 12-11-2026, for spreadsheets and links that still use them.
export const OLD_STAGE_NAMES = {
  new_prospect: 'create',
  visit_completed: 'qualify',
  qualified: 'qualify',
  quotation_requested: 'develop',
  quotation_sent: 'prove',
  abandoned: 'lost',
};
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

// What closing an opportunity needs, the same whether it is closed on creation or moved there later:
// Won needs the order value, Lost the reason, and both a written explanation.
export function closeFields(body, stage) {
  if (!CLOSED_STAGES.includes(stage)) return { wonValue: null, lostReason: null, closeReason: null };
  let wonValue = null;
  let lostReason = null;
  if (stage === 'won') {
    wonValue = optionalNumber(body, 'won_value');
    if (!wonValue || wonValue <= 0) throw new HttpError(400, 'Enter the won value (the order amount).');
  }
  if (stage === 'lost') lostReason = oneOf(body, 'lost_reason', LOST_REASONS);
  const closeReason = optionalText(body, 'close_reason', { max: 2000 });
  if (!closeReason) throw new HttpError(400, `Write why the opportunity is being closed as ${stage}.`);
  return { wonValue, lostReason, closeReason };
}
