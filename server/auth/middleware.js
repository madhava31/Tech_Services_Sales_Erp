import db from '../db/index.js';
import { isAdminRole } from './roles.js';

const sessionCache = new Map();
const SESSION_CACHE_TTL_MS = 60 * 1000;

export function invalidateSession(token) {
  if (token) sessionCache.delete(token);
}

export function clearSessionCache() {
  sessionCache.clear();
}

export async function getSessionUser(token) {
  if (!token) return null;
  const now = Date.now();
  const cached = sessionCache.get(token);
  if (cached && cached.expires > now) {
    return cached.user;
  }

  const row = await db
    .prepare(
      `SELECT u.id, u.username, u.role, u.is_active, u.salesperson_id, u.must_change_password, s.expires_at
       FROM session s JOIN app_user u ON u.id = s.user_id
       WHERE s.token = ?`
    )
    .get(token);
  if (!row) {
    sessionCache.delete(token);
    return null;
  }
  if (new Date(row.expires_at) < new Date() || !row.is_active) {
    sessionCache.delete(token);
    await db.prepare(`DELETE FROM session WHERE token = ?`).run(token);
    return null;
  }
  const user = toSessionUser(row);
  sessionCache.set(token, {
    user,
    expires: Math.min(now + SESSION_CACHE_TTL_MS, new Date(row.expires_at).getTime()),
  });
  return user;
}

export function toSessionUser(row) {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    salesperson_id: row.salesperson_id ?? null,
    // After an admin created or reset the login: the temporary password has to be replaced first.
    must_change_password: Boolean(row.must_change_password),
  };
}

export async function requireAuth(req, res, next) {
  try {
    const user = await getSessionUser(req.cookies?.session);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    // Until the temporary password is replaced, nothing else opens (the set-password routes don't use this).
    if (user.must_change_password) return res.status(403).json({ error: 'Set your own password first.', code: 'password_change_required' });
    req.user = user;
    next();
  } catch (err) {
    console.error('requireAuth error:', err);
    res.status(500).json({ error: 'Unable to verify authentication. Please try again.', detail: err.message });
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
