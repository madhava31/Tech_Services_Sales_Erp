import { Router } from 'express';
import db from '../db/index.js';
import { HttpError, sendError } from '../crm/access.js';
import { isAllowedPushEndpoint, pushPublicKey } from '../crm/reminders.js';

// Mounted at /api/notifications: each person's own reminders and their phone's push subscription.
const router = Router();

router.get('/', async (req, res) => {
  try {
    const items = await db.prepare(`SELECT id, title, body, url, read_at, created_at FROM notification WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 30`).all(req.user.id);
    const { c } = await db.prepare(`SELECT COUNT(*)::int AS c FROM notification WHERE user_id = ? AND read_at IS NULL`).get(req.user.id);
    res.json({ items, unread: c, push_public_key: pushPublicKey() });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/read-all', async (req, res) => {
  try {
    await db.prepare(`UPDATE notification SET read_at = NOW() WHERE user_id = ? AND read_at IS NULL`).run(req.user.id);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/push/subscribe', async (req, res) => {
  try {
    const { endpoint, keys } = req.body ?? {};
    if (typeof endpoint !== 'string' || !isAllowedPushEndpoint(endpoint)) throw new HttpError(400, 'That push service is not supported.');
    if (typeof keys?.p256dh !== 'string' || typeof keys?.auth !== 'string') throw new HttpError(400, 'The push subscription is incomplete.');
    // A shared phone: the subscription follows whoever signed in last.
    await db
      .prepare(
        `INSERT INTO push_subscription (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
         ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`
      )
      .run(req.user.id, endpoint, keys.p256dh, keys.auth);
    res.status(201).json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/push/unsubscribe', async (req, res) => {
  try {
    if (typeof req.body?.endpoint !== 'string') throw new HttpError(400, 'endpoint is required');
    await db.prepare(`DELETE FROM push_subscription WHERE endpoint = ? AND user_id = ?`).run(req.body.endpoint, req.user.id);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
