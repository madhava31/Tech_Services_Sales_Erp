import { Router } from 'express';
import db from '../db/index.js';
import { recordAudit } from '../audit/log.js';
import { HttpError, canSeeSalesperson, isManaging, requireCrmWriter, resolveOwner, scopeFilter, sendError } from '../crm/access.js';
import { optionalDate, optionalId, optionalNumber, optionalText, optionalUuid, requiredDate, requiredText } from '../crm/fields.js';
import { liveCompany } from '../crm/companies.js';

// Mounted at /api/service-reports. A field service report is what the engineer found and did at a customer's
// site: the call dates, the instrument, the problem, the parts needed or replaced, and both signatures. A
// draft can be changed freely. A completed one is signed by the engineer and the customer and is locked;
// only a manager can reopen it.
const router = Router();
const MAX_SIGNATURE = 60000;

const SELECT = `
  SELECT r.*, sp.name AS salesperson_name, o.code AS opportunity_code
  FROM service_report r
  JOIN salesperson sp ON sp.id = r.salesperson_id
  LEFT JOIN opportunity o ON o.id = r.opportunity_id`;

async function loadVisible(user, id) {
  const report = await db.prepare(`${SELECT} WHERE r.id = ?`).get(id);
  if (!report || !canSeeSalesperson(user, report.salesperson_id)) throw new HttpError(404, 'Service report not found');
  report.parts = await db.prepare(`SELECT id, product_id, part_no, description, qty::float AS qty FROM service_report_part WHERE report_id = ? ORDER BY position, id`).all(id);
  return report;
}

function signature(body, key) {
  const value = body?.[key];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !value.startsWith('data:image/png;base64,') || value.length > MAX_SIGNATURE) {
    throw new HttpError(400, `${key} must be a small PNG image`);
  }
  return value;
}

function parseParts(body) {
  if (body.parts === undefined) return null;
  if (!Array.isArray(body.parts)) throw new HttpError(400, 'parts must be a list');
  return body.parts
    .filter((p) => p && (String(p.description ?? '').trim() || String(p.part_no ?? '').trim()))
    .map((p, i) => ({
      product_id: optionalId(p, 'product_id'),
      part_no: optionalText(p, 'part_no', { max: 80 }),
      description: requiredText({ description: p.description || p.part_no }, 'description', { max: 300 }),
      qty: optionalNumber(p, 'qty', { min: 0.01 }) ?? 1,
      position: i,
    }));
}

// Everything the report says, from the request. `existing` is the stored report on an update.
async function parseReport(body, existing) {
  const companyId = existing?.company_id ?? optionalId(body, 'company_id');
  if (!companyId) throw new HttpError(400, 'company_id is required');
  const company = existing ? { id: companyId } : await liveCompany(companyId);
  if (!company) throw new HttpError(400, 'That company was not found.');
  if (!existing && company.approval_status === 'rejected') throw new HttpError(400, 'That company was rejected.');
  return {
    company_id: company.id,
    contact_id: optionalId(body, 'contact_id'),
    instrument_id: optionalId(body, 'instrument_id'),
    company_name: requiredText(body, 'company_name', { max: 200 }),
    company_address: optionalText(body, 'company_address', { max: 500 }),
    user_name: optionalText(body, 'user_name', { max: 120 }),
    user_designation: optionalText(body, 'user_designation', { max: 120 }),
    user_department: optionalText(body, 'user_department', { max: 120 }),
    user_phone: optionalText(body, 'user_phone', { max: 60 }),
    user_email: optionalText(body, 'user_email', { max: 160 }),
    instrument_make: optionalText(body, 'instrument_make', { max: 120 }),
    instrument_name: requiredText(body, 'instrument_name', { max: 200 }),
    model_no: optionalText(body, 'model_no', { max: 120 }),
    serial_no: optionalText(body, 'serial_no', { max: 160 }),
    lab: optionalText(body, 'lab', { max: 120 }),
    call_reported_date: requiredDate(body, 'call_reported_date'),
    call_attended_date: requiredDate(body, 'call_attended_date'),
    call_completed_date: optionalDate(body, 'call_completed_date'),
    problem_reported: requiredText(body, 'problem_reported', { max: 4000 }),
    work_done: optionalText(body, 'work_done', { max: 4000 }),
    user_comments: optionalText(body, 'user_comments', { max: 2000 }),
    engineer_name: requiredText(body, 'engineer_name', { max: 120 }),
    engineer_signature: signature(body, 'engineer_signature'),
    customer_name: optionalText(body, 'customer_name', { max: 120 }),
    customer_signature: signature(body, 'customer_signature'),
  };
}

// A customer's instrument typed in on the report joins their installed base, so the next report can pick it.
async function resolveInstrument(f, ownerId, userId) {
  if (f.instrument_id) {
    const row = await db.prepare(`SELECT id FROM installed_instrument WHERE id = ? AND company_id = ?`).get(f.instrument_id, f.company_id);
    if (!row) throw new HttpError(400, 'That instrument does not belong to this company.');
    return row.id;
  }
  if (f.serial_no) {
    const same = await db.prepare(`SELECT id FROM installed_instrument WHERE company_id = ? AND is_active AND lower(btrim(serial_number)) = lower(btrim(?))`).get(f.company_id, f.serial_no);
    if (same) return same.id;
  }
  const description = [f.instrument_make, f.instrument_name, f.model_no].filter(Boolean).join(' ');
  const info = await db
    .prepare(`INSERT INTO installed_instrument (company_id, description, serial_number, contact_id, salesperson_id, created_by) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`)
    .run(f.company_id, description, f.serial_no, f.contact_id, ownerId, userId);
  return info.lastInsertRowid;
}

async function writeParts(reportId, parts) {
  await db.prepare(`DELETE FROM service_report_part WHERE report_id = ?`).run(reportId);
  for (const p of parts) {
    await db
      .prepare(`INSERT INTO service_report_part (report_id, product_id, part_no, description, qty, position) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(reportId, p.product_id, p.part_no, p.description, p.qty, p.position);
  }
}

// What completing needs: both signatures, the customer's name, and the completed date.
function assertCompletable(f) {
  if (!f.call_completed_date) throw new HttpError(400, 'Enter the date the call was completed.');
  if (!f.engineer_signature) throw new HttpError(400, 'The engineer needs to sign.');
  if (!f.customer_name) throw new HttpError(400, 'Enter the customer’s name.');
  if (!f.customer_signature) throw new HttpError(400, 'The customer needs to sign.');
}

router.get('/', async (req, res) => {
  try {
    const params = [];
    let where = 'WHERE TRUE';
    where += scopeFilter(req.user, 'r.salesperson_id', params);
    if (req.query.status === 'draft' || req.query.status === 'completed') {
      where += ' AND r.status = ?';
      params.push(req.query.status);
    }
    for (const key of ['company_id', 'instrument_id', 'salesperson_id']) {
      const n = Number(req.query[key]);
      if (Number.isInteger(n) && n > 0) {
        where += ` AND r.${key} = ?`;
        params.push(n);
      }
    }
    const q = String(req.query.q ?? '').trim();
    if (q) {
      where += ` AND (r.code ILIKE ? OR r.company_name ILIKE ? OR r.instrument_name ILIKE ? OR r.serial_no ILIKE ? OR r.user_name ILIKE ?)`;
      params.push(...Array(5).fill(`%${q}%`));
    }
    res.json(
      await db
        .prepare(
          `SELECT r.id, r.code, r.status, r.company_id, r.company_name, r.instrument_name, r.instrument_make, r.serial_no, r.user_name,
                  r.call_attended_date, r.call_completed_date, r.engineer_name, r.salesperson_id, sp.name AS salesperson_name,
                  (SELECT COUNT(*)::int FROM service_report_part p WHERE p.report_id = r.id) AS part_count
           FROM service_report r JOIN salesperson sp ON sp.id = r.salesperson_id
           ${where} ORDER BY r.call_attended_date DESC, r.id DESC LIMIT 300`
        )
        .all(...params)
    );
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/:id', async (req, res) => {
  try {
    res.json(await loadVisible(req.user, Number(req.params.id)));
  } catch (err) {
    sendError(res, err);
  }
});

// Creates a report: a draft, or completed straight away when it is signed by both (`complete: true`).
router.post('/', requireCrmWriter, async (req, res) => {
  try {
    const body = req.body ?? {};
    const ownerId = await resolveOwner(req.user, optionalId(body, 'salesperson_id'));
    const clientUuid = optionalUuid(body, 'client_uuid');
    if (clientUuid) {
      // A retry of a save that already went through returns what it made.
      const done = await db.prepare(`SELECT id FROM service_report WHERE client_uuid = ?`).get(clientUuid);
      if (done) return res.status(200).json(await loadVisible(req.user, done.id));
    }
    const f = await parseReport(body, null);
    const parts = parseParts(body) ?? [];
    const complete = body.complete === true;
    if (complete) assertCompletable(f);

    const id = await db.transaction(async () => {
      const instrumentId = await resolveInstrument(f, ownerId, req.user.id);
      const info = await db
        .prepare(
          `INSERT INTO service_report (salesperson_id, company_id, contact_id, instrument_id, status, company_name, company_address,
             user_name, user_designation, user_department, user_phone, user_email, instrument_make, instrument_name, model_no, serial_no, lab,
             call_reported_date, call_attended_date, call_completed_date, problem_reported, work_done, user_comments,
             engineer_name, engineer_signature, engineer_signed_at, customer_name, customer_signature, customer_signed_at,
             client_uuid, created_by, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${f.engineer_signature ? 'NOW()' : 'NULL'}, ?, ?, ${f.customer_signature ? 'NOW()' : 'NULL'}, ?, ?, ${complete ? 'NOW()' : 'NULL'})
           RETURNING id`
        )
        .run(
          ownerId, f.company_id, f.contact_id, instrumentId, complete ? 'completed' : 'draft', f.company_name, f.company_address,
          f.user_name, f.user_designation, f.user_department, f.user_phone, f.user_email, f.instrument_make, f.instrument_name, f.model_no, f.serial_no, f.lab,
          f.call_reported_date, f.call_attended_date, f.call_completed_date, f.problem_reported, f.work_done, f.user_comments,
          f.engineer_name, f.engineer_signature, f.customer_name, f.customer_signature, clientUuid, req.user.id
        );
      const reportId = info.lastInsertRowid;
      await writeParts(reportId, parts);
      const { code } = await db.prepare(`SELECT code FROM service_report WHERE id = ?`).get(reportId);
      await recordAudit({
        actorUserId: req.user.id,
        action: complete ? 'service_report.completed' : 'service_report.created',
        entityType: 'service_report',
        entityId: reportId,
        summary: `${complete ? 'Completed' : 'Started'} service report ${code} for ${f.company_name}: ${f.instrument_name}`,
      });
      return reportId;
    });
    res.status(201).json(await loadVisible(req.user, id));
  } catch (err) {
    sendError(res, err);
  }
});

// Changes a draft (and completes it when `complete: true`). A completed report is locked.
router.put('/:id', requireCrmWriter, async (req, res) => {
  try {
    const existing = await loadVisible(req.user, Number(req.params.id));
    if (existing.status === 'completed') throw new HttpError(409, 'This report is signed and complete. A manager can reopen it.');
    const body = req.body ?? {};
    const f = await parseReport({ ...body, company_id: existing.company_id }, existing);
    const parts = parseParts(body);
    const complete = body.complete === true;
    if (complete) assertCompletable(f);

    await db.transaction(async () => {
      const instrumentId = await resolveInstrument(f, existing.salesperson_id, req.user.id);
      await db
        .prepare(
          `UPDATE service_report SET contact_id = ?, instrument_id = ?, status = ?, company_name = ?, company_address = ?,
             user_name = ?, user_designation = ?, user_department = ?, user_phone = ?, user_email = ?,
             instrument_make = ?, instrument_name = ?, model_no = ?, serial_no = ?, lab = ?,
             call_reported_date = ?, call_attended_date = ?, call_completed_date = ?, problem_reported = ?, work_done = ?, user_comments = ?,
             engineer_name = ?, engineer_signature = ?, engineer_signed_at = CASE WHEN ?::text IS NULL THEN NULL WHEN engineer_signature IS DISTINCT FROM ? THEN NOW() ELSE engineer_signed_at END,
             customer_name = ?, customer_signature = ?, customer_signed_at = CASE WHEN ?::text IS NULL THEN NULL WHEN customer_signature IS DISTINCT FROM ? THEN NOW() ELSE customer_signed_at END,
             completed_at = ${complete ? 'NOW()' : 'NULL'}, updated_at = NOW()
           WHERE id = ?`
        )
        .run(
          f.contact_id, instrumentId, complete ? 'completed' : 'draft', f.company_name, f.company_address,
          f.user_name, f.user_designation, f.user_department, f.user_phone, f.user_email,
          f.instrument_make, f.instrument_name, f.model_no, f.serial_no, f.lab,
          f.call_reported_date, f.call_attended_date, f.call_completed_date, f.problem_reported, f.work_done, f.user_comments,
          f.engineer_name, f.engineer_signature, f.engineer_signature, f.engineer_signature,
          f.customer_name, f.customer_signature, f.customer_signature, f.customer_signature,
          existing.id
        );
      if (parts) await writeParts(existing.id, parts);
      await recordAudit({
        actorUserId: req.user.id,
        action: complete ? 'service_report.completed' : 'service_report.updated',
        entityType: 'service_report',
        entityId: existing.id,
        summary: `${complete ? 'Completed' : 'Updated'} service report ${existing.code} for ${f.company_name}`,
      });
    });
    res.json(await loadVisible(req.user, existing.id));
  } catch (err) {
    sendError(res, err);
  }
});

// A manager reopens a signed report to correct it; the signatures are cleared and must be taken again.
router.post('/:id/reopen', requireCrmWriter, async (req, res) => {
  try {
    if (!isManaging(req.user)) throw new HttpError(403, 'Only a manager can reopen a completed service report.');
    const existing = await loadVisible(req.user, Number(req.params.id));
    if (existing.status !== 'completed') throw new HttpError(409, 'This report is not complete.');
    const reason = requiredText(req.body ?? {}, 'reason', { max: 300 });
    await db.transaction(async () => {
      await db
        .prepare(
          `UPDATE service_report SET status = 'draft', completed_at = NULL, engineer_signature = NULL, engineer_signed_at = NULL,
             customer_signature = NULL, customer_signed_at = NULL, updated_at = NOW() WHERE id = ?`
        )
        .run(existing.id);
      await recordAudit({
        actorUserId: req.user.id,
        action: 'service_report.reopened',
        entityType: 'service_report',
        entityId: existing.id,
        summary: `Reopened service report ${existing.code} for ${existing.company_name}: ${reason}`,
      });
    });
    res.json(await loadVisible(req.user, existing.id));
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
