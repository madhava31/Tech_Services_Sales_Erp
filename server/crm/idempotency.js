import db from '../db/index.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A phone that loses signal can't tell whether its last change arrived, so it sends the change again
// with the same Idempotency-Key. A key this user already completed returns the first answer instead of
// applying the change twice. Failures aren't kept: they may succeed on retry.
export async function idempotency(req, res, next) {
  const key = req.get('Idempotency-Key');
  if (!key || !['POST', 'PUT'].includes(req.method)) return next();
  if (!UUID.test(key)) return res.status(400).json({ error: 'Idempotency-Key must be a UUID' });
  try {
    const done = await db.prepare(`SELECT status, body FROM request_idempotency WHERE user_id = ? AND key = ?`).get(req.user.id, key);
    if (done) return res.status(done.status).json(done.body);
  } catch (err) {
    return next(err);
  }
  const send = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 300) return send(body);
    // Saved before answering, so a retry can never arrive ahead of the record.
    db.prepare(`INSERT INTO request_idempotency (user_id, key, status, body) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`)
      .run(req.user.id, key, res.statusCode, JSON.stringify(body ?? null))
      .catch((err) => console.error('Could not record the request key:', err))
      .finally(() => send(body));
    return res;
  };
  next();
}
