import db from '../db/index.js';

// Appends one audit_log row. Uses db.prepare, so when called inside db.transaction() it commits or
// rolls back together with the change it describes.
export async function recordAudit({ actorUserId, action, entityType, entityId = null, summary = null, before = null, after = null }) {
  await db
    .prepare(
      `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, summary, before, after)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      actorUserId ?? null,
      action,
      entityType,
      entityId,
      summary,
      before === null ? null : JSON.stringify(before),
      after === null ? null : JSON.stringify(after)
    );
}
