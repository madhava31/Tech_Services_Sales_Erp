import db from '../db/index.js';
import { MANAGING_ROLES } from './access.js';
import { pushToUser } from './reminders.js';

// Notifications for things that happen (a company sent for approval, approved or rejected): kept in the
// bell, shown as a pop-up in the app, and pushed to any phone that agreed. `add` runs inside the
// caller's transaction; `push` goes after it commits, so a phone never hears about a change that was
// rolled back.

export async function addNotifications({ userIds, kind, title, body, url, refType = null, refId = null }) {
  const today = (await db.prepare(`SELECT ((NOW() AT TIME ZONE 'Asia/Kolkata')::date)::text AS d`).get()).d;
  const rows = [];
  for (const userId of new Set(userIds)) {
    await db
      .prepare(`INSERT INTO notification (user_id, kind, for_date, title, body, url, ref_type, ref_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(userId, kind, today, title, body, url, refType, refId);
    rows.push({ userId, title, body, url });
  }
  return rows;
}

// Pushes never hold up or fail the request: a phone that can't be reached just misses the push, and
// the notification is still in the bell.
export async function pushNotifications(rows) {
  await Promise.all(rows.map((r) => pushToUser(r.userId, { title: r.title, body: r.body, url: r.url }).catch((err) => console.error('Push failed:', err.message))));
}

// Everyone who can approve a company, except the person who asked.
export async function approverIds(exceptUserId) {
  const rows = await db.prepare(`SELECT id FROM app_user WHERE is_active AND role = ANY(?::text[]) AND id <> ?`).all(MANAGING_ROLES, exceptUserId);
  return rows.map((r) => r.id);
}

// "Who is asking": the salesperson's name when the login has one, otherwise the username.
export async function personName(userId) {
  const row = await db.prepare(`SELECT COALESCE(sp.name, u.username) AS name FROM app_user u LEFT JOIN salesperson sp ON sp.id = u.salesperson_id WHERE u.id = ?`).get(userId);
  return row?.name ?? 'Someone';
}

// Approval requests already dealt with stop counting as unread for the other approvers.
export async function markHandled(refType, refId) {
  await db.prepare(`UPDATE notification SET read_at = NOW() WHERE ref_type = ? AND ref_id = ? AND kind = 'approval_request' AND read_at IS NULL`).run(refType, refId);
}
