import { Router } from 'express';
import db from '../db/index.js';
import { recordAudit } from '../audit/log.js';
import { HttpError, isManaging, requireCrmWriter, sendError } from '../crm/access.js';
import { optionalText, requiredText } from '../crm/fields.js';
import { addNotifications, approverIds, markHandled, personName, pushNotifications } from '../crm/notify.js';
import { archiveCompany, branchesMessage, companyImpact, impactText } from '../crm/companyDeletion.js';

// Mounted at /api/companies, ahead of the company routes. Deleting a company: a salesperson asks for one
// they added, and a manager or admin decides. A manager or admin deleting one themselves needs no second
// opinion. Deleted means archived: hidden from lists and search, with its history kept.
const router = Router();

const placeOf = (company) => `${company.name}${company.city ? ` (${company.city})` : ''}`;

export const DELETION_SELECT = `SELECT r.id, r.company_id, r.reason, r.created_at, c.name AS company_name, c.city AS company_city,
         COALESCE(sp.name, u.username) AS requested_by_name
  FROM company_deletion_request r
  JOIN company c ON c.id = r.company_id
  JOIN app_user u ON u.id = r.requested_by
  LEFT JOIN salesperson sp ON sp.id = u.salesperson_id`;

// Waiting requests, oldest first, with what each company holds.
router.get('/deletion-requests', async (req, res) => {
  try {
    if (!isManaging(req.user)) throw new HttpError(403, 'Only a manager can decide on deleting a company.');
    const rows = await db.prepare(`${DELETION_SELECT} WHERE r.status = 'pending' AND c.archived_at IS NULL ORDER BY r.created_at`).all();
    for (const r of rows) r.impact = await companyImpact(r.company_id);
    res.json(rows);
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/:id/delete-request', requireCrmWriter, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const company = await db.prepare(`SELECT id, name, city, created_by FROM company WHERE id = ? AND archived_at IS NULL`).get(id);
    if (!company) throw new HttpError(404, 'Company not found');
    const reason = requiredText(req.body, 'reason', { max: 300 });
    const place = placeOf(company);
    const impact = await companyImpact(id);
    if (impact.branches > 0) throw new HttpError(409, branchesMessage(company, impact.branches));

    if (isManaging(req.user)) {
      await db.transaction(async () => {
        await archiveCompany({ company, userId: req.user.id, reason });
      });
      return res.json({ archived: true });
    }
    if (company.created_by !== req.user.id) throw new HttpError(403, 'Only the person who added a company can ask for it to be deleted.');
    const waiting = await db.prepare(`SELECT id FROM company_deletion_request WHERE company_id = ? AND status = 'pending'`).get(id);
    if (waiting) throw new HttpError(409, 'Deleting this company is already waiting for approval.');

    let toPush = [];
    const requestId = await db.transaction(async () => {
      const info = await db.prepare(`INSERT INTO company_deletion_request (company_id, requested_by, reason) VALUES (?, ?, ?) RETURNING id`).run(id, req.user.id, reason);
      const newId = info.lastInsertRowid;
      await recordAudit({
        actorUserId: req.user.id,
        action: 'company.deletion_requested',
        entityType: 'company',
        entityId: id,
        summary: `Asked to delete company ${place}: ${reason}`,
      });
      const asker = await personName(req.user.id);
      toPush = [
        ...(await addNotifications({
          userIds: [req.user.id],
          kind: 'approval_sent',
          title: 'Deletion sent for approval',
          body: `${place} will be deleted once a manager approves. You’ll be told the answer.`,
          url: `/companies/${id}`,
          refType: 'company_deletion',
          refId: newId,
        })),
        ...(await addNotifications({
          userIds: await approverIds(req.user.id),
          kind: 'approval_request',
          title: 'Company deletion requested',
          body: `${asker} asks to delete ${place}: ${reason}. ${impactText(impact)}`,
          url: '/approvals',
          refType: 'company_deletion',
          refId: newId,
        })),
      ];
      return newId;
    });
    await pushNotifications(toPush);
    res.status(201).json({ id: requestId, status: 'pending' });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Deleting this company is already waiting for approval.' });
    sendError(res, err);
  }
});

async function decide(req, res, status) {
  try {
    if (!isManaging(req.user)) throw new HttpError(403, 'Only a manager can decide on deleting a company.');
    const requestId = Number(req.params.id);
    const request = await db.prepare(`SELECT id, company_id, requested_by, reason, status FROM company_deletion_request WHERE id = ?`).get(requestId);
    if (!request) throw new HttpError(404, 'Request not found');
    if (request.status !== 'pending') throw new HttpError(409, `That request was already ${request.status}.`);
    const note = status === 'rejected' ? requiredText(req.body, 'reason', { max: 300 }) : optionalText(req.body, 'reason', { max: 300 });
    let toPush = [];
    await db.transaction(async () => {
      const company = await db.prepare(`SELECT id, name, city FROM company WHERE id = ? AND archived_at IS NULL`).get(request.company_id);
      if (status === 'approved') {
        if (!company) throw new HttpError(409, 'That company is already gone.');
        await archiveCompany({ company, userId: req.user.id, reason: request.reason });
      }
      await db
        .prepare(`UPDATE company_deletion_request SET status = ?, decided_by = ?, decided_at = NOW(), decision_note = ? WHERE id = ?`)
        .run(status, req.user.id, note, requestId);
      await markHandled('company_deletion', requestId);
      const decider = await personName(req.user.id);
      const name = company?.name ?? 'The company';
      const place = company ? placeOf(company) : name;
      toPush = await addNotifications({
        userIds: [request.requested_by],
        kind: 'approval_decided',
        title: status === 'approved' ? `Deleted: ${name}` : `Not deleted: ${name}`,
        body: status === 'approved' ? `${decider} approved deleting ${place}.` : `${decider} did not approve deleting ${place}: ${note}`,
        url: status === 'approved' ? '/companies' : `/companies/${request.company_id}`,
        refType: 'company_deletion',
        refId: requestId,
      });
    });
    await pushNotifications(toPush);
    res.json({ id: requestId, status });
  } catch (err) {
    sendError(res, err);
  }
}

router.post('/deletion-requests/:id/approve', requireCrmWriter, (req, res) => decide(req, res, 'approved'));
router.post('/deletion-requests/:id/reject', requireCrmWriter, (req, res) => decide(req, res, 'rejected'));

export default router;
