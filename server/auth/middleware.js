import db from '../db/index.js';
import { isAdminRole } from './roles.js';

export async function getSessionUser(token) {
  if (!token) return null;
  const row = await db
    .prepare(
      `SELECT u.id, u.username, u.role, u.is_active, u.salesperson_id, s.expires_at
       FROM session s JOIN app_user u ON u.id = s.user_id
       WHERE s.token = ?`
    )
    .get(token);
  if (!row) return null;
  if (new Date(row.expires_at) < new Date() || !row.is_active) {
    await db.prepare(`DELETE FROM session WHERE token = ?`).run(token);
    return null;
  }
  return toSessionUser(row);
}

export function toSessionUser(row) {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    salesperson_id: row.salesperson_id ?? null,
  };
}

export async function requireAuth(req, res, next) {
  try {
    const user = await getSessionUser(req.cookies?.session);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    req.user = user;
    next();
  } catch (err) {
    // As Express 4 middleware, an unhandled rejection here would bypass route error handling.
    // Fails CLOSED: req.user is never set and next() is never called, so a database outage can
    // never be mistaken for "authenticated".
    res.status(500).json({ error: 'Unable to verify authentication. Please try again.' });
  }
}

// Use after requireAuth.
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Your role does not have access to this.' });
    next();
  };
}

export function requireAdmin(req, res, next) {
  if (!isAdminRole(req.user.role)) return res.status(403).json({ error: 'Admin access required' });
  next();
}
