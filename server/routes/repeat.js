import { Router } from 'express';
import db from '../db/index.js';
import { recordAudit } from '../audit/log.js';
import { HttpError, resolveOwner, scopeFilter, sendError } from '../crm/access.js';
import { liveCompany } from '../crm/companies.js';
import { TODAY_SQL, optionalDate, optionalId, optionalNumber, optionalText, requiredDate, requiredText } from '../crm/fields.js';
import { assertCanEdit, closeAutoFollowups } from '../crm/repeat.js';

// Mounted at /api/installed-base and /api/reorders. Who owns what is a shared fact about a customer,
// so a company's page shows all of it; the working lists show a salesperson their own. Office staff keep
// these records too, because contracts and orders usually reach them first.

async function companyFor(body) {
  const id = optionalId(body, 'company_id');
  if (!id) throw new HttpError(400, 'company_id is required');
  const company = await liveCompany(id);
  if (!company) throw new HttpError(400, 'Company not found.');
  if (company.approval_status === 'rejected') throw new HttpError(409, `${company.name} was rejected.`);
  return company;
}

async function checkLinks(body, companyId) {
  const productId = optionalId(body, 'product_id');
  if (productId && !(await db.prepare(`SELECT id FROM product WHERE id = ?`).get(productId))) throw new HttpError(400, 'That product was not found.');
  const contactId = optionalId(body, 'contact_id');
  if (contactId && !(await db.prepare(`SELECT id FROM company_contact WHERE id = ? AND company_id = ? AND archived_at IS NULL`).get(contactId, companyId))) {
    throw new HttpError(400, 'That contact does not belong to this company.');
  }
  return { product_id: productId, contact_id: contactId };
}

// ---------- installed base ----------

export const installedRouter = Router();

const INSTRUMENT_SELECT = `
  SELECT i.id, i.company_id, c.name AS company_name, i.product_id, p.part_number, p.name AS product_name, e.name AS oem_name,
         i.description, i.serial_number, i.contact_id, cc.name AS contact_name, cc.phone AS contact_phone, i.opportunity_id,
         i.salesperson_id, sp.name AS salesperson_name, sp.is_active AS salesperson_is_active, i.installed_on, i.warranty_end_date, i.amc_end_date,
         i.notes, i.is_active, i.retired_reason, i.created_at
  FROM installed_instrument i
  JOIN company c ON c.id = i.company_id
  JOIN salesperson sp ON sp.id = i.salesperson_id
  LEFT JOIN product p ON p.id = i.product_id
  LEFT JOIN oem e ON e.id = p.oem_id
  LEFT JOIN company_contact cc ON cc.id = i.contact_id`;

installedRouter.get('/', async (req, res) => {
  try {
    const companyId = optionalId(req.query, 'company_id');
    if (!companyId) throw new HttpError(400, 'company_id is required');
    const includeRetired = req.query.include_retired === '1';
    res.json(
      await db
        .prepare(`${INSTRUMENT_SELECT} WHERE i.company_id = ?${includeRetired ? '' : ' AND i.is_active'} ORDER BY i.is_active DESC, i.installed_on DESC NULLS LAST, i.id DESC`)
        .all(companyId)
    );
  } catch (err) {
    sendError(res, err);
  }
});

// Warranties and AMCs ending soon, or that ended recently, soonest first. One row per date.
installedRouter.get('/renewals', async (req, res) => {
  try {
    const params = [];
    const scope = scopeFilter(req.user, 'i.salesperson_id', params);
    const within = Math.min(Math.max(Number(req.query.within) || 90, 1), 365);
    res.json(
      await db
        .prepare(
          `SELECT i.id, i.company_id, c.name AS company_name, i.description, i.serial_number, i.salesperson_id, sp.name AS salesperson_name,
                  sp.is_active AS salesperson_is_active, cc.name AS contact_name, cc.phone AS contact_phone, e.kind, e.end_date,
                  (e.end_date - ${TODAY_SQL}) AS days_left
           FROM installed_instrument i
           JOIN company c ON c.id = i.company_id
           JOIN salesperson sp ON sp.id = i.salesperson_id
           LEFT JOIN company_contact cc ON cc.id = i.contact_id
           CROSS JOIN LATERAL (VALUES ('warranty', i.warranty_end_date), ('amc', i.amc_end_date)) AS e(kind, end_date)
           WHERE i.is_active AND c.archived_at IS NULL AND e.end_date IS NOT NULL
             AND e.end_date BETWEEN ${TODAY_SQL} - 90 AND ${TODAY_SQL} + ${within}${scope}
           ORDER BY e.end_date, i.id`
        )
        .all(...params)
    );
  } catch (err) {
    sendError(res, err);
  }
});

function instrumentFields(body) {
  return {
    description: requiredText(body, 'description', { max: 200 }),
    serial_number: optionalText(body, 'serial_number', { max: 100 }),
    installed_on: optionalDate(body, 'installed_on'),
    warranty_end_date: optionalDate(body, 'warranty_end_date'),
    amc_end_date: optionalDate(body, 'amc_end_date'),
    notes: optionalText(body, 'notes', { max: 2000 }),
  };
}

installedRouter.post('/', async (req, res) => {
  try {
    const company = await companyFor(req.body);
    const salespersonId = await resolveOwner(req.user, req.body.salesperson_id);
    const fields = instrumentFields(req.body);
    const links = await checkLinks(req.body, company.id);
    const opportunityId = optionalId(req.body, 'opportunity_id');
    if (opportunityId && !(await db.prepare(`SELECT id FROM opportunity WHERE id = ? AND company_id = ?`).get(opportunityId, company.id))) {
      throw new HttpError(400, 'That opportunity does not belong to this company.');
    }
    const id = await db.transaction(async () => {
      const info = await db
        .prepare(
          `INSERT INTO installed_instrument (company_id, product_id, description, serial_number, contact_id, opportunity_id, salesperson_id, installed_on, warranty_end_date, amc_end_date, notes, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
        )
        .run(company.id, links.product_id, fields.description, fields.serial_number, links.contact_id, opportunityId, salespersonId, fields.installed_on, fields.warranty_end_date, fields.amc_end_date, fields.notes, req.user.id);
      await recordAudit({ actorUserId: req.user.id, action: 'instrument.created', entityType: 'installed_instrument', entityId: info.lastInsertRowid, summary: `Recorded ${fields.description} at ${company.name}`, after: fields });
      return info.lastInsertRowid;
    });
    res.status(201).json(await db.prepare(`${INSTRUMENT_SELECT} WHERE i.id = ?`).get(id));
  } catch (err) {
    sendError(res, err);
  }
});

async function loadInstrument(id) {
  const row = await db.prepare(`SELECT * FROM installed_instrument WHERE id = ?`).get(id);
  if (!row) throw new HttpError(404, 'Instrument not found');
  return row;
}

installedRouter.put('/:id', async (req, res) => {
  try {
    const existing = await loadInstrument(Number(req.params.id));
    assertCanEdit(req.user, existing.salesperson_id);
    if (!existing.is_active) throw new HttpError(409, 'This instrument is retired.');
    const merged = { ...existing, ...req.body };
    const fields = instrumentFields(merged);
    const links = await checkLinks(merged, existing.company_id);
    await db.transaction(async () => {
      await db
        .prepare(
          `UPDATE installed_instrument SET product_id = ?, description = ?, serial_number = ?, contact_id = ?, installed_on = ?, warranty_end_date = ?, amc_end_date = ?, notes = ?, updated_at = NOW() WHERE id = ?`
        )
        .run(links.product_id, fields.description, fields.serial_number, links.contact_id, fields.installed_on, fields.warranty_end_date, fields.amc_end_date, fields.notes, existing.id);
      // A later end date means it was renewed, so the reminder about the old date is finished.
      const extended = [
        ['warranty', existing.warranty_end_date, fields.warranty_end_date],
        ['amc', existing.amc_end_date, fields.amc_end_date],
      ].filter(([, from, to]) => from && to && to > from);
      for (const [kind, , to] of extended) {
        await closeAutoFollowups({ kinds: [kind], refId: existing.id, status: 'done', note: `Renewed until ${to}`, userId: req.user.id });
      }
      const pick = ({ description, serial_number, installed_on, warranty_end_date, amc_end_date, notes }) => ({ description, serial_number, installed_on, warranty_end_date, amc_end_date, notes });
      await recordAudit({
        actorUserId: req.user.id,
        action: extended.length ? 'instrument.renewed' : 'instrument.updated',
        entityType: 'installed_instrument',
        entityId: existing.id,
        summary: `${extended.length ? 'Renewed' : 'Updated'} ${fields.description}${extended.map(([kind, , to]) => `: ${kind === 'amc' ? 'AMC' : 'warranty'} until ${to}`).join('')}`,
        before: pick(existing),
        after: pick(fields),
      });
    });
    res.json(await db.prepare(`${INSTRUMENT_SELECT} WHERE i.id = ?`).get(existing.id));
  } catch (err) {
    sendError(res, err);
  }
});

installedRouter.post('/:id/retire', async (req, res) => {
  try {
    const existing = await loadInstrument(Number(req.params.id));
    assertCanEdit(req.user, existing.salesperson_id);
    if (!existing.is_active) throw new HttpError(409, 'This instrument is already retired.');
    const reason = requiredText(req.body, 'reason', { max: 500 });
    await db.transaction(async () => {
      await db.prepare(`UPDATE installed_instrument SET is_active = FALSE, retired_reason = ?, updated_at = NOW() WHERE id = ?`).run(reason, existing.id);
      await closeAutoFollowups({ kinds: ['warranty', 'amc'], refId: existing.id, status: 'cancelled', note: `Instrument retired: ${reason}`, userId: req.user.id });
      await recordAudit({ actorUserId: req.user.id, action: 'instrument.retired', entityType: 'installed_instrument', entityId: existing.id, summary: `Retired ${existing.description}: ${reason}` });
    });
    res.json(await db.prepare(`${INSTRUMENT_SELECT} WHERE i.id = ?`).get(existing.id));
  } catch (err) {
    sendError(res, err);
  }
});

// ---------- consumables reorders ----------

export const reordersRouter = Router();

const REORDER_SELECT = `
  SELECT r.id, r.company_id, c.name AS company_name, r.product_id, p.part_number, p.name AS product_name, r.item, r.contact_id, cc.name AS contact_name, cc.phone AS contact_phone,
         r.salesperson_id, sp.name AS salesperson_name, sp.is_active AS salesperson_is_active, r.interval_days, r.last_order_date, r.next_due_date, r.typical_value, r.notes,
         r.is_active, r.stopped_reason, (r.next_due_date - ${TODAY_SQL}) AS days_left
  FROM reorder_plan r
  JOIN company c ON c.id = r.company_id
  JOIN salesperson sp ON sp.id = r.salesperson_id
  LEFT JOIN product p ON p.id = r.product_id
  LEFT JOIN company_contact cc ON cc.id = r.contact_id`;

reordersRouter.get('/', async (req, res) => {
  try {
    const companyId = optionalId(req.query, 'company_id');
    if (companyId) {
      res.json(await db.prepare(`${REORDER_SELECT} WHERE r.company_id = ? AND r.is_active ORDER BY r.next_due_date`).all(companyId));
      return;
    }
    const params = [];
    const scope = scopeFilter(req.user, 'r.salesperson_id', params);
    res.json(await db.prepare(`${REORDER_SELECT} WHERE r.is_active AND c.archived_at IS NULL${scope} ORDER BY r.next_due_date LIMIT 300`).all(...params));
  } catch (err) {
    sendError(res, err);
  }
});

function intervalFrom(body) {
  const days = Number(body.interval_days);
  if (!Number.isInteger(days) || days < 1 || days > 730) throw new HttpError(400, 'Enter how often they reorder, in days (1 to 730).');
  return days;
}

const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

async function istToday() {
  return (await db.prepare(`SELECT ${TODAY_SQL}::text AS d`).get()).d;
}

reordersRouter.post('/', async (req, res) => {
  try {
    const company = await companyFor(req.body);
    const salespersonId = await resolveOwner(req.user, req.body.salesperson_id);
    const item = requiredText(req.body, 'item', { max: 200 });
    const interval = intervalFrom(req.body);
    const lastOrder = optionalDate(req.body, 'last_order_date');
    const links = await checkLinks(req.body, company.id);
    const typical = optionalNumber(req.body, 'typical_value');
    const notes = optionalText(req.body, 'notes', { max: 2000 });
    const nextDue = optionalDate(req.body, 'next_due_date') ?? addDays(lastOrder ?? (await istToday()), interval);
    const id = await db.transaction(async () => {
      const info = await db
        .prepare(
          `INSERT INTO reorder_plan (company_id, product_id, item, contact_id, salesperson_id, interval_days, last_order_date, next_due_date, typical_value, notes, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
        )
        .run(company.id, links.product_id, item, links.contact_id, salespersonId, interval, lastOrder, nextDue, typical, notes, req.user.id);
      await recordAudit({ actorUserId: req.user.id, action: 'reorder.created', entityType: 'reorder_plan', entityId: info.lastInsertRowid, summary: `Added reorder of ${item} every ${interval} days at ${company.name}` });
      return info.lastInsertRowid;
    });
    res.status(201).json(await db.prepare(`${REORDER_SELECT} WHERE r.id = ?`).get(id));
  } catch (err) {
    sendError(res, err);
  }
});

async function loadPlan(req) {
  const plan = await db.prepare(`SELECT * FROM reorder_plan WHERE id = ?`).get(Number(req.params.id));
  if (!plan) throw new HttpError(404, 'Reorder not found');
  assertCanEdit(req.user, plan.salesperson_id);
  if (!plan.is_active) throw new HttpError(409, 'This reorder has been stopped.');
  return plan;
}

// Change how often, or move the next date ("call me next month").
reordersRouter.put('/:id', async (req, res) => {
  try {
    const plan = await loadPlan(req);
    const interval = req.body.interval_days !== undefined ? intervalFrom(req.body) : plan.interval_days;
    const nextDue = req.body.next_due_date !== undefined ? requiredDate(req.body, 'next_due_date') : plan.next_due_date;
    const item = req.body.item !== undefined ? requiredText(req.body, 'item', { max: 200 }) : plan.item;
    const notes = req.body.notes !== undefined ? optionalText(req.body, 'notes', { max: 2000 }) : plan.notes;
    await db.transaction(async () => {
      await db.prepare(`UPDATE reorder_plan SET item = ?, interval_days = ?, next_due_date = ?, notes = ?, updated_at = NOW() WHERE id = ?`).run(item, interval, nextDue, notes, plan.id);
      if (nextDue !== plan.next_due_date) await closeAutoFollowups({ kinds: ['reorder'], refId: plan.id, status: 'cancelled', note: `Moved to ${nextDue}`, userId: req.user.id });
      await recordAudit({
        actorUserId: req.user.id,
        action: 'reorder.updated',
        entityType: 'reorder_plan',
        entityId: plan.id,
        summary: `Updated reorder of ${item}`,
        before: { interval_days: plan.interval_days, next_due_date: plan.next_due_date },
        after: { interval_days: interval, next_due_date: nextDue },
      });
    });
    res.json(await db.prepare(`${REORDER_SELECT} WHERE r.id = ?`).get(plan.id));
  } catch (err) {
    sendError(res, err);
  }
});

// They ordered: the next reminder counts from this order, and the current reminder is finished.
reordersRouter.post('/:id/ordered', async (req, res) => {
  try {
    const plan = await loadPlan(req);
    const today = await istToday();
    const orderedOn = optionalDate(req.body, 'ordered_on') ?? today;
    if (orderedOn > today) throw new HttpError(400, 'The order date cannot be in the future.');
    const nextDue = addDays(orderedOn, plan.interval_days);
    const value = optionalNumber(req.body, 'value');
    await db.transaction(async () => {
      await db.prepare(`UPDATE reorder_plan SET last_order_date = ?, next_due_date = ?, typical_value = COALESCE(?, typical_value), updated_at = NOW() WHERE id = ?`).run(orderedOn, nextDue, value, plan.id);
      await closeAutoFollowups({ kinds: ['reorder'], refId: plan.id, status: 'done', note: `Ordered on ${orderedOn}`, userId: req.user.id });
      await recordAudit({
        actorUserId: req.user.id,
        action: 'reorder.ordered',
        entityType: 'reorder_plan',
        entityId: plan.id,
        summary: `Reorder of ${plan.item} placed on ${orderedOn}${value ? ` for ₹${value.toLocaleString('en-IN')}` : ''}. Next due ${nextDue}`,
        after: { ordered_on: orderedOn, value, next_due_date: nextDue },
      });
    });
    res.json(await db.prepare(`${REORDER_SELECT} WHERE r.id = ?`).get(plan.id));
  } catch (err) {
    sendError(res, err);
  }
});

reordersRouter.post('/:id/stop', async (req, res) => {
  try {
    const plan = await loadPlan(req);
    const reason = requiredText(req.body, 'reason', { max: 500 });
    await db.transaction(async () => {
      await db.prepare(`UPDATE reorder_plan SET is_active = FALSE, stopped_reason = ?, updated_at = NOW() WHERE id = ?`).run(reason, plan.id);
      await closeAutoFollowups({ kinds: ['reorder'], refId: plan.id, status: 'cancelled', note: `Reorder stopped: ${reason}`, userId: req.user.id });
      await recordAudit({ actorUserId: req.user.id, action: 'reorder.stopped', entityType: 'reorder_plan', entityId: plan.id, summary: `Stopped reorder of ${plan.item}: ${reason}` });
    });
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});
