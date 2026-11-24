import db from '../db/index.js';
import { recordAudit } from '../audit/log.js';
import { addNotifications, pushNotifications } from './notify.js';

// Salespeople sign in every day. One who hasn't signed in for 72 hours gets a reminder (in the bell, and
// pushed to any phone that agreed), once per quiet spell, and the audit log records it. Signing in again
// clears it. A login that has never been used counts from the day it was made.
export const INACTIVE_AFTER_HOURS = 72;

export async function runInactivityCheck() {
  const quiet = await db
    .prepare(
      `SELECT u.id, COALESCE(sp.name, u.username) AS name,
              (EXTRACT(EPOCH FROM NOW() - COALESCE(u.last_login_at, u.created_at)) / 3600)::float AS hours
         FROM app_user u LEFT JOIN salesperson sp ON sp.id = u.salesperson_id
        WHERE u.is_active AND u.role = 'salesperson' AND u.inactive_alerted_at IS NULL
          AND COALESCE(u.last_login_at, u.created_at) < NOW() - make_interval(hours => ?)
        ORDER BY u.id`
    )
    .all(INACTIVE_AFTER_HOURS);

  const toPush = [];
  for (const person of quiet) {
    const days = Math.floor(person.hours / 24);
    const rows = await db.transaction(async () => {
      const added = await addNotifications({
        userIds: [person.id],
        kind: 'inactive_reminder',
        title: `You haven’t signed in for ${days} days`,
        body: 'Sign in to see your follow-ups and log your visits. Salespeople sign in every day.',
        url: '/',
      });
      await db.prepare(`UPDATE app_user SET inactive_alerted_at = NOW() WHERE id = ?`).run(person.id);
      await recordAudit({
        actorUserId: null,
        action: 'user.inactive_reminder',
        entityType: 'app_user',
        entityId: person.id,
        summary: `${person.name} has not signed in for ${days} days; a reminder was sent`,
      });
      return added;
    });
    toPush.push(...rows);
  }
  await pushNotifications(toPush);
  return { reminded: quiet.length };
}
