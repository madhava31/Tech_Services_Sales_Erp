import { Router } from 'express';
import db from '../db/index.js';
import { recordAudit } from '../audit/log.js';
import { isAdminRole } from '../auth/roles.js';
import { HttpError, isManaging, sendError } from '../crm/access.js';
import { optionalEmail, optionalText } from '../crm/fields.js';
import { emailReport, runWeeklyReport } from '../crm/weeklyReport.js';
import { requireTeamView } from './team.js';

// Mounted at /api/reports: the weekly report, for roles with the team view. MD/Admin keep the email list.
const router = Router();

router.use(requireTeamView);

function requireAdminRole(req) {
  if (!isAdminRole(req.user.role)) throw new HttpError(403, 'Only an administrator can do this.');
}

router.get('/', async (req, res) => {
  try {
    const email = Boolean(process.env.SMTP_HOST && process.env.MAIL_FROM);
    const reports = await db
      .prepare(`SELECT id, week_start, week_end, emailed_at, email_error, created_at FROM weekly_report ORDER BY week_start DESC LIMIT 26`)
      .all();
    res.json({ email_configured: email, reports });
  } catch (err) {
    sendError(res, err);
  }
});

// Normally made on Monday morning; this makes last week's straight away if it's missing.
router.post('/generate', async (req, res) => {
  try {
    if (!isManaging(req.user)) throw new HttpError(403, 'Only a manager can do this.');
    res.status(201).json(await runWeeklyReport());
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/recipients', async (req, res) => {
  try {
    requireAdminRole(req);
    res.json(await db.prepare(`SELECT id, email, name, is_active FROM report_recipient ORDER BY is_active DESC, email`).all());
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/recipients', async (req, res) => {
  try {
    requireAdminRole(req);
    const email = optionalEmail(req.body, 'email');
    if (!email) throw new HttpError(400, 'Enter an email address.');
    const name = optionalText(req.body, 'name', { max: 120 });
    const row = await db.transaction(async () => {
      const created = await db.prepare(`INSERT INTO report_recipient (email, name) VALUES (?, ?) RETURNING id, email, name, is_active`).get(email, name);
      await recordAudit({ actorUserId: req.user.id, action: 'report_recipient.created', entityType: 'report_recipient', entityId: created.id, summary: `Added ${email} to the weekly report list` });
      return created;
    });
    res.status(201).json(row);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That address is already on the list.' });
    sendError(res, err);
  }
});

router.put('/recipients/:id', async (req, res) => {
  try {
    requireAdminRole(req);
    if (typeof req.body?.is_active !== 'boolean') throw new HttpError(400, 'is_active must be true or false');
    const row = await db.transaction(async () => {
      const updated = await db.prepare(`UPDATE report_recipient SET is_active = ?, updated_at = NOW() WHERE id = ? RETURNING id, email, name, is_active`).get(req.body.is_active, Number(req.params.id));
      if (!updated) throw new HttpError(404, 'Not found');
      await recordAudit({ actorUserId: req.user.id, action: 'report_recipient.updated', entityType: 'report_recipient', entityId: updated.id, summary: `${updated.is_active ? 'Added back' : 'Removed'} ${updated.email} ${updated.is_active ? 'to' : 'from'} the weekly report list` });
      return updated;
    });
    res.json(row);
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/:id', async (req, res) => {
  try {
    const report = await db.prepare(`SELECT * FROM weekly_report WHERE id = ?`).get(Number(req.params.id));
    if (!report) throw new HttpError(404, 'Report not found');
    res.json(report);
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/:id/email', async (req, res) => {
  try {
    requireAdminRole(req);
    const report = await db.prepare(`SELECT * FROM weekly_report WHERE id = ?`).get(Number(req.params.id));
    if (!report) throw new HttpError(404, 'Report not found');
    const result = await emailReport(report);
    if (result.skipped) throw new HttpError(409, result.skipped);
    if (result.error) throw new HttpError(502, `The email could not be sent: ${result.error}`);
    await recordAudit({ actorUserId: req.user.id, action: 'report.emailed', entityType: 'weekly_report', entityId: report.id, summary: `Sent the weekly report to ${result.sent} address(es)` });
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
