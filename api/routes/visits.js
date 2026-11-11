import { Router } from 'express';
import db from '../db/index.js';
import { recordAudit } from '../audit/log.js';
import { HttpError, canSeeSalesperson, requireCrmWriter, resolveOwner, scopeFilter, sendError } from '../crm/access.js';
import {
  oneOf,
  optionalId,
  optionalText,
  optionalTimestamp,
  optionalUuid,
} from '../crm/fields.js';
import { insertRequirement, parseRequirementList } from '../crm/requirements.js';
import { insertTask, taskFields } from '../crm/tasks.js';
import { advanceIfBehind, isOpen } from '../crm/pipeline.js';
import { liveCompany } from '../crm/companies.js';
import { contactFields, insertContact, resolveContactByPhone } from '../crm/contacts.js';
import { assertCompanyAcceptsDeals, insertOpportunity, parseDealFields } from '../crm/deals.js';
import { loadVisibleOpportunity } from './opportunities.js';

// Mounted at /api/visits. A visit is created as a draft on arrival and completed after the
// meeting with an outcome, the customer's requirements and the next follow-up — all in one
// transaction, so a completed visit never exists without them.
const router = Router();

export const OUTCOMES = ['interested', 'follow_up_needed', 'quotation_requested', 'not_interested', 'no_meeting'];
// Outcomes that mean an active opportunity: the customer's need must be written down.
const NEEDS_REQUIREMENT = ['interested', 'follow_up_needed', 'quotation_requested'];
// Every outcome except a clear "not interested" needs a next step on someone's list.
const NEEDS_FOLLOW_UP = ['interested', 'follow_up_needed', 'quotation_requested', 'no_meeting'];

const VISIT_SELECT = `
  SELECT v.id, v.company_id, c.name AS company_name, c.city AS company_city, c.approval_status AS company_approval_status,
         v.contact_id, cc.name AS contact_name, cc.designation AS contact_designation, cc.phone AS contact_phone,
         v.salesperson_id, sp.name AS salesperson_name,
         v.visited_at, v.status, v.outcome, v.notes, v.completed_at, v.client_uuid, v.created_at, v.updated_at,
         v.opportunity_id, o.title AS opportunity_title, o.stage AS opportunity_stage
  FROM visit v
  JOIN company c ON c.id = v.company_id
  JOIN salesperson sp ON sp.id = v.salesperson_id
  LEFT JOIN company_contact cc ON cc.id = v.contact_id
  LEFT JOIN opportunity o ON o.id = v.opportunity_id`;

// Loads a visit the user may see, or throws 404 (never 403, so existence isn't revealed).
async function loadVisibleVisit(user, id) {
  const visit = await db.prepare(`${VISIT_SELECT} WHERE v.id = ?`).get(id);
  if (!visit || !canSeeSalesperson(user, visit.salesperson_id)) throw new HttpError(404, 'Opportunity not found');
  return visit;
}

// Uses an existing contact of the company, or creates one from `contact: {name, ...}`.
async function resolveContact(body, companyId, userId) {
  const contactId = optionalId(body, 'contact_id');
  if (contactId) {
    const row = await db.prepare(`SELECT id FROM company_contact WHERE id = ? AND company_id = ? AND archived_at IS NULL`).get(contactId, companyId);
    if (!row) throw new HttpError(400, 'That contact does not belong to this company.');
    return contactId;
  }
  if (body.contact && typeof body.contact === 'object') {
    const fields = contactFields(body.contact);
    if (fields.phone) return resolveContactByPhone({ companyId, fields, userId });
    return insertContact({ companyId, fields, userId });
  }
  return null;
}

router.get('/', async (req, res) => {
  try {
    const params = [];
    let where = 'WHERE TRUE';
    where += scopeFilter(req.user, 'v.salesperson_id', params);
    if (req.query.status === 'draft' || req.query.status === 'completed') {
      where += ' AND v.status = ?';
      params.push(req.query.status);
    }
    if (req.query.salesperson_id) {
      where += ' AND v.salesperson_id = ?';
      params.push(Number(req.query.salesperson_id));
    }
    if (req.query.company_id) {
      where += ' AND v.company_id = ?';
      params.push(Number(req.query.company_id));
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.from ?? '')) {
      where += ` AND v.visited_at >= (?::date::timestamp AT TIME ZONE 'Asia/Kolkata')`;
      params.push(req.query.from);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.to ?? '')) {
      where += ` AND v.visited_at < ((?::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`;
      params.push(req.query.to);
    }
    params.push(Math.min(Math.max(Number(req.query.limit) || 50, 1), 200));
    res.json(await db.prepare(`${VISIT_SELECT} ${where} ORDER BY v.visited_at DESC, v.id DESC LIMIT ?`).all(...params));
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/:id', async (req, res) => {
  try {
    const visit = await loadVisibleVisit(req.user, Number(req.params.id));
    const requirements = await db.prepare(`SELECT * FROM requirement WHERE visit_id = ? ORDER BY id`).all(visit.id);
    const tasks = await db.prepare(`SELECT * FROM task WHERE visit_id = ? ORDER BY id`).all(visit.id);
    res.json({ ...visit, requirements, tasks });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/', requireCrmWriter, async (req, res) => {
  try {
    const clientUuid = optionalUuid(req.body, 'client_uuid');
    if (clientUuid) {
      // A retried submit: return the visit already created for this uuid.
      const existing = await db.prepare(`SELECT id, salesperson_id FROM visit WHERE client_uuid = ?`).get(clientUuid);
      if (existing) {
        if (!canSeeSalesperson(req.user, existing.salesperson_id)) throw new HttpError(409, 'client_uuid already used.');
        return res.status(200).json(await loadVisibleVisit(req.user, existing.id));
      }
    }
    const requestedCompanyId = optionalId(req.body, 'company_id');
    if (!requestedCompanyId) throw new HttpError(400, 'company_id is required');
    const company = await liveCompany(requestedCompanyId);
    if (!company) throw new HttpError(400, 'Company not found.');
    const companyId = company.id;
    if (company.approval_status === 'rejected') throw new HttpError(409, `${company.name} was rejected, so opportunities cannot be logged against it.`);
    const salespersonId = await resolveOwner(req.user, req.body.salesperson_id);
    const visitedAt = optionalTimestamp(req.body, 'visited_at');
    const notes = optionalText(req.body, 'notes', { max: 5000 });

    const id = await db.transaction(async () => {
      const contactId = await resolveContact(req.body, companyId, req.user.id);
      const info = await db
        .prepare(
          `INSERT INTO visit (company_id, contact_id, salesperson_id, visited_at, notes, client_uuid, created_by)
           VALUES (?, ?, ?, COALESCE(?::timestamptz, NOW()), ?, ?, ?) RETURNING id`
        )
        .run(companyId, contactId, salespersonId, visitedAt, notes, clientUuid, req.user.id);
      await recordAudit({
        actorUserId: req.user.id,
        action: 'visit.created',
        entityType: 'visit',
        entityId: info.lastInsertRowid,
        summary: `Started an opportunity to ${company.name}`,
      });
      return info.lastInsertRowid;
    });
    res.status(201).json(await loadVisibleVisit(req.user, id));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: err.constraint === 'company_contact_phone_unique' ? 'That phone number already belongs to another contact.' : 'This opportunity was already submitted.' });
    sendError(res, err);
  }
});

router.put('/:id', requireCrmWriter, async (req, res) => {
  try {
    const visit = await loadVisibleVisit(req.user, Number(req.params.id));
    if (visit.status !== 'draft') throw new HttpError(409, 'Completed opportunities cannot be changed.');
    const notes = req.body.notes !== undefined ? optionalText(req.body, 'notes', { max: 5000 }) : visit.notes;
    const visitedAt = req.body.visited_at !== undefined ? optionalTimestamp(req.body, 'visited_at') ?? visit.visited_at : visit.visited_at;

    await db.transaction(async () => {
      const contactId =
        req.body.contact_id !== undefined || req.body.contact !== undefined
          ? await resolveContact(req.body, visit.company_id, req.user.id)
          : visit.contact_id;
      await db
        .prepare(`UPDATE visit SET contact_id = ?, visited_at = ?, notes = ?, updated_at = NOW() WHERE id = ? AND status = 'draft'`)
        .run(contactId, visitedAt, notes, visit.id);
      await recordAudit({
        actorUserId: req.user.id,
        action: 'visit.updated',
        entityType: 'visit',
        entityId: visit.id,
        summary: `Updated the unfinished opportunity to ${visit.company_name}`,
        before: { contact_id: visit.contact_id, notes: visit.notes },
        after: { contact_id: contactId, notes },
      });
    });
    res.json(await loadVisibleVisit(req.user, visit.id));
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/:id/complete', requireCrmWriter, async (req, res) => {
  try {
    const visit = await loadVisibleVisit(req.user, Number(req.params.id));
    if (visit.status !== 'draft') throw new HttpError(409, 'This opportunity is already completed.');
    const outcome = oneOf(req.body, 'outcome', OUTCOMES);
    const notes = req.body.notes !== undefined ? optionalText(req.body, 'notes', { max: 5000 }) : visit.notes;
    const requirements = parseRequirementList(req.body.requirements);
    const followUp =
      req.body.follow_up && typeof req.body.follow_up === 'object'
        ? taskFields(req.body.follow_up, { defaultType: outcome === 'quotation_requested' ? 'send_quotation' : outcome === 'no_meeting' ? 'visit' : 'call' })
        : null;

    if (NEEDS_REQUIREMENT.includes(outcome) && requirements.length === 0) {
      throw new HttpError(400, 'Add at least one requirement — what does the customer need?');
    }
    if (NEEDS_FOLLOW_UP.includes(outcome) && !followUp) {
      throw new HttpError(400, 'Schedule the next follow-up for this customer.');
    }
    const dealLink = await parseDealLink(req, visit, outcome);

    await db.transaction(async () => {
      const done = await db
        .prepare(`UPDATE visit SET status = 'completed', outcome = ?, notes = ?, completed_at = NOW(), updated_at = NOW() WHERE id = ? AND status = 'draft'`)
        .run(outcome, notes, visit.id);
      // Lost a race with another completion of the same draft.
      if (done.changes !== 1) throw new HttpError(409, 'This opportunity is already completed.');
      const opportunityId = await applyDealLink(dealLink, visit, outcome, req.user.id);
      for (const fields of requirements) {
        await insertRequirement({ companyId: visit.company_id, visitId: visit.id, opportunityId, salespersonId: visit.salesperson_id, userId: req.user.id, fields });
      }
      if (followUp) {
        await insertTask({ companyId: visit.company_id, visitId: visit.id, opportunityId, assigneeId: visit.salesperson_id, userId: req.user.id, fields: followUp });
      }
      await recordAudit({
        actorUserId: req.user.id,
        action: 'visit.completed',
        entityType: 'visit',
        entityId: visit.id,
        summary: `${visit.salesperson_name} visited ${visit.company_name}: ${outcome.replace(/_/g, ' ')}`,
      });
    });
    const updated = await loadVisibleVisit(req.user, visit.id);
    const savedRequirements = await db.prepare(`SELECT * FROM requirement WHERE visit_id = ? ORDER BY id`).all(visit.id);
    const tasks = await db.prepare(`SELECT * FROM task WHERE visit_id = ? ORDER BY id`).all(visit.id);
    res.json({ ...updated, requirements: savedRequirements, tasks });
  } catch (err) {
    sendError(res, err);
  }
});

// Where a completed visit moves its deal. Outcomes that say nothing new about the deal (no
// meeting, not interested) link the visit without moving the stage — marking a deal lost is a
// deliberate action on the deal itself.
const OUTCOME_STAGE = {
  interested: 'qualified',
  follow_up_needed: 'visit_completed',
  quotation_requested: 'quotation_requested',
};

// `opportunity: { id }` links an existing open deal of this company; `opportunity: { title, ... }`
// opens a new one, with the same required fields and approved-company rule as any other deal.
// Validated before the transaction starts.
async function parseDealLink(req, visit, outcome) {
  const body = req.body.opportunity;
  if (body === undefined || body === null) return null;
  if (typeof body !== 'object') throw new HttpError(400, 'opportunity must be an object');
  const id = optionalId(body, 'id');
  if (id) {
    const opp = await loadVisibleOpportunity(req.user, id).catch(() => null);
    if (!opp || opp.company_id !== visit.company_id) throw new HttpError(400, 'That opportunity is not one of this company’s.');
    if (!isOpen(opp.stage)) throw new HttpError(400, 'That opportunity is closed.');
    return { existing: opp };
  }
  if (!OUTCOME_STAGE[outcome]) throw new HttpError(400, 'Open an opportunity only when the customer has a real need.');
  const company = await assertCompanyAcceptsDeals(visit.company_id);
  return { companyName: company.name, create: await parseDealFields(body, { companyId: visit.company_id }) };
}

// Runs inside the completion transaction; returns the deal id the visit now belongs to.
async function applyDealLink(link, visit, outcome, userId) {
  if (!link) return null;
  const target = OUTCOME_STAGE[outcome];
  let opportunityId;
  if (link.existing) {
    opportunityId = link.existing.id;
    if (target) await advanceIfBehind({ opportunity: link.existing, stage: target, userId, note: `Opportunity on ${new Date(visit.visited_at).toISOString().slice(0, 10)}` });
  } else {
    opportunityId = await insertOpportunity({
      companyId: visit.company_id,
      companyName: link.companyName,
      ownerId: visit.salesperson_id,
      stage: target,
      fields: link.create,
      sourceVisitId: visit.id,
      userId,
    });
  }
  await db.prepare(`UPDATE visit SET opportunity_id = ? WHERE id = ?`).run(opportunityId, visit.id);
  return opportunityId;
}

export default router;
