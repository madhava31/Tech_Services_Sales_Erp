import { TODAY_SQL } from './fields.js';

// SQL for how long a deal has been in its current stage, for queries where the deal is aliased `o`.
// Other edits don't restart the clock, and neither does a transfer: only a stage change does.
const STAGE_ENTERED_SQL = `COALESCE(
  (SELECT MAX(sh.changed_at) FROM opportunity_history sh
   WHERE sh.opportunity_id = o.id AND sh.change_type IN ('created', 'stage') AND sh.to_value = o.stage),
  o.created_at)`;

export const DAYS_IN_STAGE_SQL = `(${TODAY_SQL} - (${STAGE_ENTERED_SQL} AT TIME ZONE 'Asia/Kolkata')::date)`;

export const STUCK_AFTER_SQL = `(SELECT ss.stuck_after_days FROM stage_setting ss WHERE ss.stage = o.stage)`;

// Closed stages have no setting, so a closed deal is never stuck.
export const STUCK_SQL = `COALESCE(${DAYS_IN_STAGE_SQL} > ${STUCK_AFTER_SQL}, FALSE)`;
