import { Router } from 'express';
import db from '../db/index.js';

// Mounted at /api/admin/audit behind requireAuth + requireAdmin. Read-only.
const router = Router();

router.get('/', async (req, res) => {
  try {
    const where = [];
    const params = [];
    if (req.query.entity_type) {
      where.push('a.entity_type = ?');
      params.push(String(req.query.entity_type));
    }
    if (req.query.entity_id) {
      const id = Number(req.query.entity_id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'entity_id must be an integer' });
      where.push('a.entity_id = ?');
      params.push(id);
    }
    if (req.query.actor_user_id) {
      const id = Number(req.query.actor_user_id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'actor_user_id must be an integer' });
      where.push('a.actor_user_id = ?');
      params.push(id);
    }
    for (const [key, sql] of [
      ['from', `a.at >= (?::date::timestamp AT TIME ZONE 'Asia/Kolkata')`],
      ['to', `a.at < ((?::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`],
    ]) {
      if (req.query[key] === undefined || req.query[key] === '') continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(req.query[key])) return res.status(400).json({ error: `${key} must be a date (YYYY-MM-DD)` });
      where.push(sql);
      params.push(req.query[key]);
    }
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    params.push(limit);
    const rows = await db
      .prepare(
        `SELECT a.id, a.at, a.action, a.entity_type, a.entity_id, a.summary, a.before, a.after,
                a.actor_user_id, u.username AS actor_username
         FROM audit_log a LEFT JOIN app_user u ON u.id = a.actor_user_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY a.id DESC LIMIT ?`
      )
      .all(...params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

export default router;
