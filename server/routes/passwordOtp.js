// Setting your own password with a one-time code sent to your registered mobile.
//
//  - First sign-in after an admin created or reset the login (must_change_password): the temporary password
//    works only to get here. The registered number is shown, never editable; a code goes to it; the right code
//    plus a new password finishes it.
//  - Forgot password (signed out): the username asks for a code, which goes to the registered number.
//
// The number is the one on the salesperson's record, entered by the admin. Without text messages set up, or
// without a valid number, the first sign-in still works with the current password so nobody is locked out, and
// forgot-password says to ask the admin.
import { Router } from 'express';
import db from '../db/index.js';
import { recordAudit } from '../audit/log.js';
import { HttpError, sendError } from '../crm/access.js';
import { clearSessionCache, getSessionUser } from '../auth/middleware.js';
import { hashPassword, verifyPassword, isAcceptablePassword, PASSWORD_RULE } from '../auth/password.js';
import { checkCode, registeredMobile, sendCode, showPhone } from '../auth/otp.js';
import { smsConfigured } from '../auth/sms.js';

const router = Router();
const BAD_CODE = 'That code is not right or has expired. Ask for a new one.';

async function signedIn(req) {
  const user = await getSessionUser(req.cookies?.session);
  if (!user) throw new HttpError(401, 'Not authenticated');
  return user;
}

async function setPassword(userId, password, { keepToken = null, action, summary }) {
  const { salt, hash } = hashPassword(password);
  await db.transaction(async () => {
    await db.prepare(`UPDATE app_user SET password_hash = ?, password_salt = ?, must_change_password = FALSE WHERE id = ?`).run(hash, salt, userId);
    await db.prepare(`DELETE FROM session WHERE user_id = ? AND token IS DISTINCT FROM ?`).run(userId, keepToken);
    await recordAudit({ actorUserId: userId, action, entityType: 'app_user', entityId: userId, summary });
  });
  // The server remembers who is signed in for a minute; forget it, so the new password and the ended sessions apply now.
  clearSessionCache();
}

// What the set-password screen shows: the registered number (read-only) and whether a code can be sent.
router.get('/otp-info', async (req, res) => {
  try {
    const user = await signedIn(req);
    const phone = await registeredMobile(user.id);
    res.json({ phone: phone ? showPhone(phone) : null, can_send: Boolean(phone) && smsConfigured() });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/first-login/send', async (req, res) => {
  try {
    const user = await signedIn(req);
    const phone = await registeredMobile(user.id);
    if (!phone) throw new HttpError(409, 'No mobile number is registered for you. Ask your administrator to add it.');
    if (!smsConfigured()) throw new HttpError(409, 'Text messages are not set up yet.');
    await sendCode({ userId: user.id, purpose: 'first_login', phone, ip: req.ip });
    res.json({ sent: true });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/first-login/complete', async (req, res) => {
  try {
    const user = await signedIn(req);
    const { otp, current_password: current, new_password: next } = req.body ?? {};
    if (!isAcceptablePassword(next)) throw new HttpError(400, PASSWORD_RULE);
    const row = await db.prepare(`SELECT * FROM app_user WHERE id = ?`).get(user.id);
    if (!row.must_change_password) throw new HttpError(409, 'Your password is already set. Use Change password in the account menu.');
    const phone = await registeredMobile(user.id);
    if (phone && smsConfigured()) {
      if (!otp) throw new HttpError(400, 'Enter the code sent to your mobile.');
      if (!(await checkCode({ userId: user.id, purpose: 'first_login', code: otp }))) throw new HttpError(400, BAD_CODE);
    } else if (!current || !verifyPassword(current, row.password_salt, row.password_hash)) {
      throw new HttpError(400, 'Enter your current (temporary) password.');
    }
    if (verifyPassword(next, row.password_salt, row.password_hash)) throw new HttpError(400, 'Choose a password different from the temporary one.');
    await setPassword(user.id, next, { keepToken: req.cookies.session, action: 'user.password_set', summary: `"${row.username}" set their own password${phone && smsConfigured() ? ', verified by a code to their registered mobile' : ''}` });
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// Signed out. The answer is the same whether or not the username exists, so it can't be used to find logins.
router.post('/forgot/send', async (req, res) => {
  try {
    if (!smsConfigured()) throw new HttpError(503, 'Text messages are not set up yet. Ask your administrator to reset your password.');
    const username = String(req.body?.username ?? '').trim();
    if (!username) throw new HttpError(400, 'Enter your username.');
    const user = await db.prepare(`SELECT id FROM app_user WHERE username = ? AND is_active`).get(username);
    const phone = user ? await registeredMobile(user.id) : null;
    if (user && phone) {
      try {
        await sendCode({ userId: user.id, purpose: 'forgot', phone, ip: req.ip });
      } catch (err) {
        if (err.status === 429) throw err;
        console.error('Could not send a password code:', err.message);
      }
    }
    res.json({ sent: true });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/forgot/reset', async (req, res) => {
  try {
    const username = String(req.body?.username ?? '').trim();
    const { otp, new_password: next } = req.body ?? {};
    if (!username || !otp) throw new HttpError(400, 'Enter your username and the code.');
    if (!isAcceptablePassword(next)) throw new HttpError(400, PASSWORD_RULE);
    const user = await db.prepare(`SELECT id, username FROM app_user WHERE username = ? AND is_active`).get(username);
    if (!user || !(await checkCode({ userId: user.id, purpose: 'forgot', code: otp }))) throw new HttpError(400, BAD_CODE);
    await setPassword(user.id, next, { action: 'user.password_forgot_reset', summary: `"${user.username}" reset their password with a code sent to their registered mobile` });
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
