import { Router } from 'express';
import crypto from 'node:crypto';
import db from '../db/index.js';
import { hashPassword, verifyPassword, isAcceptablePassword, PASSWORD_RULE } from '../auth/password.js';
import { getSessionUser, toSessionUser } from '../auth/middleware.js';
import { recordAudit } from '../audit/log.js';

const router = Router();
const SESSION_DAYS = 30;
const COOKIE_NAME = 'session';
const isProduction = process.env.NODE_ENV === 'production';

// Password-guessing throttle, backed by the login_attempt table. A username is locked after
// MAX_FAILURES_PER_USERNAME failures since its last successful sign-in within the window; an IP
// after MAX_FAILURES_PER_IP failures across all usernames.
const LOGIN_WINDOW_MINUTES = 15;
const MAX_FAILURES_PER_USERNAME = 5;
const MAX_FAILURES_PER_IP = 20;

async function isLoginThrottled(username, ip) {
  const row = await db
    .prepare(
      `SELECT
         COUNT(*) FILTER (
           WHERE username = ?
             AND at > COALESCE((SELECT MAX(at) FROM login_attempt WHERE username = ? AND succeeded), '-infinity')
         ) AS username_failures,
         COUNT(*) FILTER (WHERE ip = ?) AS ip_failures
       FROM login_attempt
       WHERE NOT succeeded AND at > NOW() - make_interval(mins => ?)`
    )
    .get(username, username, ip, LOGIN_WINDOW_MINUTES);
  return Number(row.username_failures) >= MAX_FAILURES_PER_USERNAME || Number(row.ip_failures) >= MAX_FAILURES_PER_IP;
}

async function recordLoginAttempt(username, ip, succeeded) {
  await db.prepare(`INSERT INTO login_attempt (username, ip, succeeded) VALUES (?, ?, ?)`).run(username, ip, succeeded);
}

async function createSession(userId, res) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await db.prepare(`INSERT INTO session (token, user_id, expires_at) VALUES (?, ?, ?)`).run(token, userId, expiresAt);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    // Web app and API are served from one origin, so 'lax' is sufficient and keeps the cookie off
    // cross-site requests.
    secure: isProduction,
    sameSite: 'lax',
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

router.get('/me', async (req, res) => {
  try {
    const userCount = (await db.prepare(`SELECT COUNT(*) c FROM app_user`).get()).c;
    if (Number(userCount) === 0) return res.json({ needsSetup: true });

    const user = await getSessionUser(req.cookies?.session);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: 'Unable to check authentication status. Please try again.' });
  }
});

router.post('/setup', async (req, res) => {
  try {
    const userCount = (await db.prepare(`SELECT COUNT(*) c FROM app_user`).get()).c;
    if (Number(userCount) > 0) return res.status(403).json({ error: 'Setup already completed' });

    const { username, password } = req.body;
    if (!username || !username.trim()) return res.status(400).json({ error: 'Username is required' });
    if (!isAcceptablePassword(password)) return res.status(400).json({ error: PASSWORD_RULE });

    const { salt, hash } = hashPassword(password);
    const info = await db
      .prepare(`INSERT INTO app_user (username, password_hash, password_salt, role) VALUES (?, ?, ?, 'admin') RETURNING id`)
      .run(username.trim(), hash, salt);

    await createSession(info.lastInsertRowid, res);
    res.status(201).json({ user: { id: info.lastInsertRowid, username: username.trim(), role: 'admin', salesperson_id: null } });
  } catch (err) {
    res.status(500).json({ error: 'Unable to complete setup. Please try again.' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });

    // Throttle key is case-insensitive so "Admin"/"admin" can't be used to multiply attempts.
    const throttleKey = username.trim().toLowerCase();
    if (await isLoginThrottled(throttleKey, req.ip)) {
      return res
        .status(429)
        .json({ error: `Too many failed sign-in attempts. Try again in ${LOGIN_WINDOW_MINUTES} minutes.` });
    }

    const row = await db.prepare(`SELECT * FROM app_user WHERE username = ?`).get(username.trim());
    if (!row || !verifyPassword(password, row.password_salt, row.password_hash)) {
      await recordLoginAttempt(throttleKey, req.ip, false);
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    await recordLoginAttempt(throttleKey, req.ip, true);
    if (!row.is_active) {
      return res.status(403).json({ error: 'This account has been deactivated. Contact your administrator.' });
    }
    await createSession(row.id, res);
    res.json({ user: toSessionUser(row) });
  } catch (err) {
    res.status(500).json({ error: 'Unable to sign in. Please try again.' });
  }
});

// Anyone signed in can change their own password: the current one is needed, and wrong guesses count
// toward the same throttle as sign-in. Their other sessions (other phones and browsers) are signed out.
router.post('/change-password', async (req, res) => {
  try {
    const token = req.cookies?.session;
    const sessionUser = await getSessionUser(token);
    if (!sessionUser) return res.status(401).json({ error: 'Not authenticated' });
    const { current_password: current, new_password: next } = req.body ?? {};
    if (!current || !next) return res.status(400).json({ error: 'Enter your current password and a new one.' });
    if (!isAcceptablePassword(next)) return res.status(400).json({ error: PASSWORD_RULE });
    if (next === current) return res.status(400).json({ error: 'The new password must be different from the current one.' });

    const row = await db.prepare(`SELECT * FROM app_user WHERE id = ?`).get(sessionUser.id);
    const throttleKey = row.username.trim().toLowerCase();
    if (await isLoginThrottled(throttleKey, req.ip)) {
      return res.status(429).json({ error: `Too many failed attempts. Try again in ${LOGIN_WINDOW_MINUTES} minutes.` });
    }
    if (!verifyPassword(current, row.password_salt, row.password_hash)) {
      await recordLoginAttempt(throttleKey, req.ip, false);
      return res.status(400).json({ error: 'Your current password is not right.' });
    }

    const { salt, hash } = hashPassword(next);
    await db.transaction(async () => {
      await db.prepare(`UPDATE app_user SET password_hash = ?, password_salt = ? WHERE id = ?`).run(hash, salt, row.id);
      await db.prepare(`DELETE FROM session WHERE user_id = ? AND token <> ?`).run(row.id, token);
      await recordAudit({ actorUserId: row.id, action: 'user.password_changed', entityType: 'app_user', entityId: row.id, summary: `"${row.username}" changed their own password` });
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Unable to change the password. Please try again.' });
  }
});

router.post('/logout', async (req, res) => {
  try {
    const token = req.cookies?.session;
    if (token) await db.prepare(`DELETE FROM session WHERE token = ?`).run(token);
    res.clearCookie(COOKIE_NAME, { path: '/', secure: isProduction, sameSite: 'lax' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Unable to sign out. Please try again.' });
  }
});

export default router;
