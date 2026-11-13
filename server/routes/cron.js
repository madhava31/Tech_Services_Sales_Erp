import crypto from 'node:crypto';
import { Router } from 'express';
import { runReminderJob } from '../crm/reminders.js';
import { runErpSync } from '../erp/sync.js';
import { erpProblem } from '../erp/adapter.js';

// Mounted at /api/cron, before sign-in. Vercel has no always-on process, so the reminders and the ERP
// sync that a long-running server starts on a timer (server/index.js) are started here instead, by
// Vercel Cron (vercel.json). Vercel sends `Authorization: Bearer <CRON_SECRET>`; without the secret
// set, or with a wrong one, nothing runs.
const router = Router();

function requireCronSecret(req, res, next) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(503).json({ error: 'Scheduled jobs are not set up.' });
  const given = Buffer.from(String(req.headers.authorization ?? ''));
  const expected = Buffer.from(`Bearer ${secret}`);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return res.status(401).json({ error: 'Not authorised.' });
  next();
}

router.use(requireCronSecret);

// The morning digest, repeat follow-ups and the weekly report. Safe to run more than once a day: each
// is created once.
router.get('/reminders', async (req, res) => {
  try {
    res.json(await runReminderJob());
  } catch (err) {
    console.error('Cron reminders failed:', err);
    res.status(500).json({ error: 'The reminders did not run.' });
  }
});

router.get('/erp-sync', async (req, res) => {
  try {
    if (erpProblem()) return res.json({ skipped: true });
    const { id, status, counts } = await runErpSync({ trigger: 'schedule' });
    res.json({ id, status, counts });
  } catch (err) {
    console.error('Cron ERP sync failed:', err.message);
    res.status(err.status === 409 ? 200 : 500).json({ error: 'The ERP sync did not run.' });
  }
});

export default router;
