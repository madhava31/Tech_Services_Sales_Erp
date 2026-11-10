import { Router } from 'express';
import ExcelJS from 'exceljs';
import db from '../db/index.js';
import { recordAudit } from '../audit/log.js';
import {
  HttpError,
  canSeeSalesperson,
  isManaging,
  requireCrmWriter,
  requireQuotationRole,
  resolveOwner,
  scopeFilter,
  sendError,
} from '../crm/access.js';
import { TODAY_SQL, oneOf, optionalDate, optionalId, optionalNumber, optionalText, optionalUrl, requiredText } from '../crm/fields.js';
import {
  CLOSED_STAGES,
  DEFAULT_PROBABILITY,
  LOST_REASONS,
  OPEN_STAGES,
  QUOTATION_STATUSES,
  STAGE_KEYS,
  advanceIfBehind,
  isOpen,
  recordHistory,
} from '../crm/pipeline.js';
import { assertCompanyAcceptsDeals, insertOpportunity, parseDealFields, replaceDealLinks, resolveDealContact } from '../crm/deals.js';
import { auditHandover, transferDeals } from '../crm/handover.js';
import { DAYS_IN_STAGE_SQL, STUCK_AFTER_SQL, STUCK_SQL } from '../crm/stuck.js';

// Mounted at /api/opportunities. Deals move through the pipeline; every stage, owner and field change
// is kept in opportunity_history and written to the audit log.
const router = Router();

const OPEN_SQL = `o.stage NOT IN ('won', 'lost', 'abandoned')`;
const OVERDUE_SQL = `(${OPEN_SQL} AND o.expected_close_date < ${TODAY_SQL})`;

const OPPORTUNITY_SELECT = `
  SELECT o.id, o.company_id, c.name AS company_name, c.city AS company_city, o.title,
         o.owner_salesperson_id, sp.name AS owner_name,
         o.original_owner_salesperson_id, osp.name AS original_owner_name,
         o.stage, o.estimated_value, o.probability, o.probability_reason, o.tender, o.expected_close_date,
         o.source_visit_id, o.notes, o.won_value, o.lost_reason, o.close_reason, o.closed_at, o.created_at, o.updated_at,
         o.oem_id, e.name AS oem_name, o.contact_id, cc.name AS contact_name, cc.phone AS contact_phone,
         ${OVERDUE_SQL} AS is_overdue,
         ${DAYS_IN_STAGE_SQL} AS days_in_stage, ${STUCK_AFTER_SQL} AS stuck_after_days, ${STUCK_SQL} AS is_stuck,
         (SELECT COUNT(*)::int FROM quotation_link q WHERE q.opportunity_id = o.id) AS quotation_count,
         (SELECT COALESCE(json_agg(json_build_object('id', p.id, 'part_number', p.part_number, 'name', p.name, 'is_active', p.is_active) ORDER BY p.name), '[]')
          FROM opportunity_product op JOIN product p ON p.id = op.product_id WHERE op.opportunity_id = o.id) AS products,
         (SELECT COALESCE(json_agg(json_build_object('id', s.id, 'name', s.name, 'is_active', s.is_active) ORDER BY s.name), '[]')
          FROM opportunity_segment os JOIN market_segment s ON s.id = os.segment_id WHERE os.opportunity_id = o.id) AS segments
  FROM opportunity o
  JOIN company c ON c.id = o.company_id
  JOIN salesperson sp ON sp.id = o.owner_salesperson_id
  JOIN salesperson osp ON osp.id = o.original_owner_salesperson_id
  LEFT JOIN oem e ON e.id = o.oem_id
  LEFT JOIN company_contact cc ON cc.id = o.contact_id`;

export async function loadVisibleOpportunity(user, id) {
  const opp = await db.prepare(`${OPPORTUNITY_SELECT} WHERE o.id = ?`).get(id);
  if (!opp || !canSeeSalesperson(user, opp.owner_salesperson_id)) throw new HttpError(404, 'Opportunity not found');
  return opp;
}

function quotationFields(body, { partial }) {
  const fields = {};
  if (!partial || body.quotation_number !== undefined) fields.quotation_number = requiredText(body, 'quotation_number', { max: 50 });
  if (!partial || body.quotation_date !== undefined) fields.quotation_date = optionalDate(body, 'quotation_date');
  if (!partial || body.amount !== undefined) fields.amount = optionalNumber(body, 'amount');
  if (!partial || body.status !== undefined) fields.status = oneOf(body, 'status', QUOTATION_STATUSES, 'sent');
  if (!partial || body.erp_quotation_id !== undefined) fields.erp_quotation_id = optionalId(body, 'erp_quotation_id');
  if (!partial || body.document_url !== undefined) fields.document_url = optionalUrl(body, 'document_url');
  return fields;
}

// The filters shared by the deal list and its Excel export. A salesperson only ever gets their own.
function dealFilters(req) {
  const params = [];
  let where = 'WHERE TRUE';
  where += scopeFilter(req.user, 'o.owner_salesperson_id', params);
  const status = req.query.status ?? 'open';
  if (status === 'open') where += ` AND ${OPEN_SQL}`;
  else if (status === 'closed') where += ` AND NOT ${OPEN_SQL}`;
  else if (CLOSED_STAGES.includes(status)) {
    where += ' AND o.stage = ?';
    params.push(status);
  }
  if (STAGE_KEYS.includes(req.query.stage)) {
    where += ' AND o.stage = ?';
    params.push(req.query.stage);
  }
  if (req.query.overdue === '1') where += ` AND ${OVERDUE_SQL}`;
  if (req.query.stuck === '1') where += ` AND ${STUCK_SQL}`;
  for (const [key, column] of [
    ['owner_id', 'o.owner_salesperson_id'],
    ['company_id', 'o.company_id'],
    ['oem_id', 'o.oem_id'],
  ]) {
    if (req.query[key]) {
      where += ` AND ${column} = ?`;
      params.push(Number(req.query[key]));
    }
  }
  if (req.query.segment_id) {
    where += ' AND EXISTS (SELECT 1 FROM opportunity_segment os2 WHERE os2.opportunity_id = o.id AND os2.segment_id = ?)';
    params.push(Number(req.query.segment_id));
  }
  // Overdue deals first, then soonest to close; closed deals newest first.
  const order = status === 'open' ? `${OVERDUE_SQL} DESC, o.expected_close_date ASC NULLS LAST, o.updated_at DESC` : `${OVERDUE_SQL} DESC, o.closed_at DESC NULLS LAST, o.updated_at DESC`;
  return { where, params, order };
}

router.get('/', async (req, res) => {
  try {
    const { where, params, order } = dealFilters(req);
    params.push(Math.min(Math.max(Number(req.query.limit) || 200, 1), 500));
    res.json(await db.prepare(`${OPPORTUNITY_SELECT} ${where} ORDER BY ${order} LIMIT ?`).all(...params));
  } catch (err) {
    sendError(res, err);
  }
});

const STAGE_NAMES = {
  new_prospect: 'New prospect',
  visit_completed: 'Visited',
  qualified: 'Qualified',
  quotation_requested: 'Quote requested',
  quotation_sent: 'Quote sent',
  negotiation: 'Negotiation',
  won: 'Won',
  lost: 'Lost',
  abandoned: 'Abandoned',
};

// Indian digit grouping: 68,50,000 and 1,25,00,000.
const INR_FORMAT = '[>=10000000]##\\,##\\,##\\,##0;[>=100000]##\\,##\\,##0;##,##0';

// The deal list as a spreadsheet, with the same filters and access as the list.
router.get('/export.xlsx', async (req, res) => {
  try {
    const { where, params, order } = dealFilters(req);
    const deals = await db.prepare(`${OPPORTUNITY_SELECT} ${where} ORDER BY ${order} LIMIT 10000`).all(...params);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Deals', { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.columns = [
      { header: 'Created date', key: 'created', width: 13, style: { numFmt: 'dd-mmm-yyyy' } },
      { header: 'Deal', key: 'deal', width: 34 },
      { header: 'Company', key: 'company', width: 30 },
      { header: 'Contact', key: 'contact', width: 22 },
      { header: 'Phone', key: 'phone', width: 16 },
      { header: 'Salesperson', key: 'salesperson', width: 20 },
      { header: 'OEM', key: 'oem', width: 16 },
      { header: 'Products', key: 'products', width: 40 },
      { header: 'Stage', key: 'stage', width: 16 },
      { header: 'Expected closing date', key: 'closing', width: 14, style: { numFmt: 'dd-mmm-yyyy' } },
      { header: 'Win probability %', key: 'probability', width: 11 },
      { header: 'Probability reason', key: 'probability_reason', width: 28 },
      { header: 'Order value (INR)', key: 'value', width: 16, style: { numFmt: INR_FORMAT } },
      { header: 'Weighted value', key: 'weighted', width: 16, style: { numFmt: INR_FORMAT } },
      { header: 'Tender', key: 'tender', width: 8 },
      { header: 'Market segment', key: 'segment', width: 26 },
      { header: 'Outcome', key: 'outcome', width: 11 },
      { header: 'Overdue', key: 'overdue', width: 9 },
      { header: 'Close reason / comments', key: 'remarks', width: 44 },
    ];
    sheet.getRow(1).font = { bold: true };
    for (const d of deals) {
      const open = isOpen(d.stage);
      const value = d.won_value ?? d.estimated_value;
      sheet.addRow({
        created: new Date(d.created_at),
        deal: d.title,
        company: d.company_name,
        contact: d.contact_name,
        phone: d.contact_phone,
        salesperson: d.owner_name,
        oem: d.oem_name,
        products: d.products.map((p) => p.name).join(', '),
        stage: STAGE_NAMES[d.stage],
        closing: d.expected_close_date ? new Date(`${d.expected_close_date}T00:00:00Z`) : null,
        probability: d.probability,
        probability_reason: d.probability_reason,
        value,
        weighted: value == null ? null : Math.round((value * d.probability) / 100),
        tender: d.tender ? 'Yes' : 'No',
        segment: d.segments.map((s) => s.name).join(', '),
        outcome: open ? '' : STAGE_NAMES[d.stage],
        overdue: d.is_overdue ? 'Yes' : 'No',
        remarks: [d.close_reason, d.notes].filter(Boolean).join(' / '),
      });
    }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="technicon-deals.xlsx"');
    res.send(Buffer.from(await workbook.xlsx.writeBuffer()));
  } catch (err) {
    sendError(res, err);
  }
});

// The office's queue: deals waiting for a quotation to be prepared.
router.get('/quotation-requests', async (req, res) => {
  try {
    const params = [];
    const scope = scopeFilter(req.user, 'o.owner_salesperson_id', params);
    res.json(
      await db
        .prepare(
          `${OPPORTUNITY_SELECT},
           LATERAL (SELECT MAX(h.changed_at) AS requested_at FROM opportunity_history h
                    WHERE h.opportunity_id = o.id AND h.change_type IN ('created', 'stage') AND h.to_value = 'quotation_requested') req
           WHERE o.stage = 'quotation_requested'
             AND NOT EXISTS (SELECT 1 FROM quotation_link q WHERE q.opportunity_id = o.id)${scope}
           ORDER BY req.requested_at ASC NULLS LAST`
        )
        .all(...params)
    );
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/:id', async (req, res) => {
  try {
    const opp = await loadVisibleOpportunity(req.user, Number(req.params.id));
    const [history, quotations, requirements, tasks, visits] = await Promise.all([
      db
        .prepare(
          `SELECT h.id, h.change_type, h.field, h.from_value, h.to_value, h.note, h.changed_at, COALESCE(u.username, 'ERP sync') AS changed_by_username
           FROM opportunity_history h LEFT JOIN app_user u ON u.id = h.changed_by
           WHERE h.opportunity_id = ? ORDER BY h.changed_at DESC, h.id DESC`
        )
        .all(opp.id),
      db.prepare(`SELECT * FROM quotation_link WHERE opportunity_id = ? ORDER BY created_at DESC`).all(opp.id),
      db.prepare(`SELECT * FROM requirement WHERE opportunity_id = ? ORDER BY created_at DESC`).all(opp.id),
      db
        .prepare(
          `SELECT t.id, t.title, t.task_type, t.due_date, t.status, t.priority, sp.name AS assignee_name
           FROM task t JOIN salesperson sp ON sp.id = t.assignee_salesperson_id
           WHERE t.opportunity_id = ? ORDER BY (t.status = 'open') DESC, t.due_date`
        )
        .all(opp.id),
      db
        .prepare(
          `SELECT v.id, v.visited_at, v.status, v.outcome, sp.name AS salesperson_name
           FROM visit v JOIN salesperson sp ON sp.id = v.salesperson_id
           WHERE v.opportunity_id = ? ORDER BY v.visited_at DESC`
        )
        .all(opp.id),
    ]);
    const tenderDetails = await db
      .prepare(`SELECT t.*, (t.bid_due_date - ${TODAY_SQL}) AS days_left, (t.bid_status = 'preparing' AND t.bid_due_date < ${TODAY_SQL}) AS is_late FROM tender t WHERE t.opportunity_id = ?`)
      .get(opp.id);
    const contactLog = await db
      .prepare(
        `SELECT l.id, l.channel, l.result, l.contact_name, l.phone, l.notes, l.created_at, sp.name AS salesperson_name
         FROM contact_log l JOIN salesperson sp ON sp.id = l.salesperson_id WHERE l.opportunity_id = ? ORDER BY l.created_at DESC, l.id DESC LIMIT 30`
      )
      .all(opp.id);
    const erpOrders = await db
      .prepare(
        `SELECT eo.id, eo.number, eo.order_date, eo.client_po_ref, eo.status, q.quotation_number
         FROM quotation_link q JOIN erp_order eo ON eo.erp_quotation_id = q.erp_quotation_id
         WHERE q.opportunity_id = ? ORDER BY eo.order_date DESC NULLS LAST, eo.id DESC`
      )
      .all(opp.id);
    res.json({ ...opp, tender_details: tenderDetails ?? null, contact_log: contactLog, erp_orders: erpOrders, history, quotations, requirements, tasks, visits });
  } catch (err) {
    sendError(res, err);
  }
});

function phoneConflict(res, err) {
  if (err.code === '23505' && err.constraint === 'company_contact_phone_unique') {
    res.status(409).json({ error: 'That phone number already belongs to another contact.' });
    return true;
  }
  return false;
}

router.post('/', requireCrmWriter, async (req, res) => {
  try {
    const companyId = optionalId(req.body, 'company_id');
    if (!companyId) throw new HttpError(400, 'company_id is required');
    const company = await assertCompanyAcceptsDeals(companyId);
    const ownerId = await resolveOwner(req.user, req.body.owner_salesperson_id);
    const stage = oneOf(req.body, 'stage', ['new_prospect', 'visit_completed', 'qualified'], 'new_prospect');
    const fields = await parseDealFields(req.body, { companyId });
    const id = await db.transaction(() => insertOpportunity({ companyId, companyName: company.name, ownerId, stage, fields, userId: req.user.id }));
    res.status(201).json(await loadVisibleOpportunity(req.user, id));
  } catch (err) {
    if (phoneConflict(res, err)) return;
    sendError(res, err);
  }
});

const BULK_LIMIT = 200;

export function bulkIds(body) {
  const ids = body?.ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => !Number.isInteger(id) || id <= 0)) throw new HttpError(400, 'Choose at least one.');
  if (ids.length > BULK_LIMIT) throw new HttpError(400, `Choose at most ${BULK_LIMIT} at a time.`);
  return [...new Set(ids)];
}

// One change to many deals: a new closing date, a stage or a new owner. Each deal follows the same
// rules and leaves the same records as changing it alone. One that can't change is reported and the
// rest go ahead. Closing isn't offered: each close needs its own reason.
router.post('/bulk', requireCrmWriter, async (req, res) => {
  try {
    const ids = bulkIds(req.body);
    const date = req.body.expected_close_date !== undefined ? optionalDate(req.body, 'expected_close_date') : null;
    const stage = req.body.stage !== undefined ? oneOf(req.body, 'stage', OPEN_STAGES) : null;
    const toId = req.body.to_salesperson_id !== undefined ? optionalId(req.body, 'to_salesperson_id') : null;
    if ([date, stage, toId].filter(Boolean).length !== 1) throw new HttpError(400, 'Choose one change: a closing date, a stage or a new owner.');
    let reason = null;
    if (toId) {
      if (!isManaging(req.user)) throw new HttpError(403, 'Only a manager can transfer deals.');
      reason = requiredText(req.body, 'reason', { max: 500 });
    }

    const result = await db.transaction(async () => {
      let updated = 0;
      const skipped = [];
      for (const id of ids) {
        // Not visible looks the same as not there, as it does everywhere else.
        const opp = await loadVisibleOpportunity(req.user, id).catch((err) => {
          if (err.status === 404) return null;
          throw err;
        });
        const skip = (why) => skipped.push({ id, title: opp ? opp.title : `#${id}`, reason: why });
        if (!opp) skip('not found');
        else if (!isOpen(opp.stage)) skip('closed');
        else if (date) {
          if (opp.expected_close_date === date) skip('already that date');
          else {
            await db.prepare(`UPDATE opportunity SET expected_close_date = ?, updated_at = NOW() WHERE id = ?`).run(date, id);
            await recordHistory({ opportunityId: id, changeType: 'field', field: 'Expected closing date', from: opp.expected_close_date, to: date, userId: req.user.id });
            await recordAudit({
              actorUserId: req.user.id,
              action: 'opportunity.updated',
              entityType: 'opportunity',
              entityId: id,
              summary: `Updated "${opp.title}" (${opp.company_name}): Expected closing date`,
              before: { expected_close_date: opp.expected_close_date },
              after: { expected_close_date: date },
            });
            updated++;
          }
        } else if (stage) {
          if (opp.stage === stage) skip('already there');
          else if (['quotation_sent', 'negotiation'].includes(stage) && opp.quotation_count === 0) skip('needs a quotation first');
          else {
            await db.prepare(`UPDATE opportunity SET stage = ?, updated_at = NOW() WHERE id = ?`).run(stage, id);
            await recordHistory({ opportunityId: id, changeType: 'stage', from: opp.stage, to: stage, userId: req.user.id });
            await recordAudit({
              actorUserId: req.user.id,
              action: 'opportunity.stage_changed',
              entityType: 'opportunity',
              entityId: id,
              summary: `"${opp.title}" (${opp.company_name}) moved from ${opp.stage} to ${stage}`,
              before: { stage: opp.stage },
              after: { stage },
            });
            updated++;
          }
        } else if (opp.owner_salesperson_id === toId) skip('already theirs');
        else {
          const moved = await transferDeals({ fromId: opp.owner_salesperson_id, toId, opportunityIds: [id], reason, userId: req.user.id });
          await auditHandover({ userId: req.user.id, from: moved.from, to: moved.to, dealIds: moved.dealIds, taskIds: moved.taskIds, reason, single: true });
          updated++;
        }
      }
      return { updated, skipped };
    });
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

const names = (list) => list.map((item) => item.name).sort().join(', ');

router.put('/:id', requireCrmWriter, async (req, res) => {
  try {
    const opp = await loadVisibleOpportunity(req.user, Number(req.params.id));
    if (!isOpen(opp.stage)) throw new HttpError(409, 'Closed deals cannot be edited. Reopen it first.');
    const currentProducts = opp.products.map((p) => p.id);
    const currentSegments = opp.segments.map((s) => s.id);
    // Changing the OEM clears the products unless new ones were chosen.
    const oemChanged = req.body.oem_id !== undefined && Number(req.body.oem_id) !== opp.oem_id;
    const merged = {
      title: opp.title,
      estimated_value: opp.estimated_value,
      expected_close_date: opp.expected_close_date,
      probability: opp.probability,
      probability_reason: opp.probability_reason,
      tender: opp.tender,
      notes: opp.notes,
      oem_id: opp.oem_id,
      product_ids: oemChanged ? [] : currentProducts,
      segment_ids: currentSegments,
      contact_id: opp.contact_id,
      ...req.body,
    };
    const fields = await parseDealFields(merged, { companyId: opp.company_id, keepOemId: opp.oem_id, keepProductIds: currentProducts, keepSegmentIds: currentSegments });

    await db.transaction(async () => {
      const contactId = await resolveDealContact(fields, opp.company_id, req.user.id);
      await db
        .prepare(
          `UPDATE opportunity SET title = ?, estimated_value = ?, expected_close_date = ?, probability = ?, probability_reason = ?, tender = ?,
                                  notes = ?, oem_id = ?, contact_id = ?, updated_at = NOW()
           WHERE id = ?`
        )
        .run(fields.title, fields.estimated_value, fields.expected_close_date, fields.probability, fields.probability_reason, fields.tender, fields.notes, fields.oem_id, contactId, opp.id);
      await replaceDealLinks(opp.id, fields);

      const updated = await loadVisibleOpportunity(req.user, opp.id);
      const snapshot = (d) => ({
        'Deal name': d.title,
        'Order value': d.estimated_value,
        'Expected closing date': d.expected_close_date,
        'Win probability': d.probability,
        'Probability reason': d.probability_reason,
        Tender: d.tender ? 'Yes' : 'No',
        Comments: d.notes,
        OEM: d.oem_name,
        Products: names(d.products),
        'Market segment': names(d.segments),
        Contact: d.contact_name ? `${d.contact_name}${d.contact_phone ? ` · ${d.contact_phone}` : ''}` : null,
      });
      const before = snapshot(opp);
      const after = snapshot(updated);
      const changed = Object.keys(after).filter((key) => String(before[key] ?? '') !== String(after[key] ?? ''));
      for (const field of changed) {
        await recordHistory({ opportunityId: opp.id, changeType: 'field', field, from: before[field] === null ? null : String(before[field]), to: String(after[field] ?? '—'), userId: req.user.id });
      }
      if (changed.length) {
        await recordAudit({
          actorUserId: req.user.id,
          action: 'opportunity.updated',
          entityType: 'opportunity',
          entityId: opp.id,
          summary: `Updated "${fields.title}" (${opp.company_name}): ${changed.join(', ')}`,
          before: Object.fromEntries(changed.map((key) => [key, before[key]])),
          after: Object.fromEntries(changed.map((key) => [key, after[key]])),
        });
      }
    });
    res.json(await loadVisibleOpportunity(req.user, opp.id));
  } catch (err) {
    if (phoneConflict(res, err)) return;
    sendError(res, err);
  }
});

router.post('/:id/stage', requireCrmWriter, async (req, res) => {
  try {
    const opp = await loadVisibleOpportunity(req.user, Number(req.params.id));
    const stage = oneOf(req.body, 'stage', STAGE_KEYS);
    const note = optionalText(req.body, 'note', { max: 1000 });
    if (stage === opp.stage) throw new HttpError(409, 'The deal is already at that stage.');

    const reopening = !isOpen(opp.stage);
    const closing = CLOSED_STAGES.includes(stage);
    if (reopening && !isManaging(req.user)) throw new HttpError(403, 'Only a manager can reopen a closed deal.');
    if (reopening && closing) throw new HttpError(400, 'Reopen the deal to an open stage first.');
    if (['quotation_sent', 'negotiation'].includes(stage) && opp.quotation_count === 0) {
      throw new HttpError(400, 'Record the quotation first — the office or a manager adds it on this deal.');
    }

    let wonValue = null;
    let lostReason = null;
    let closeReason = null;
    if (stage === 'won') {
      wonValue = optionalNumber(req.body, 'won_value');
      if (!wonValue || wonValue <= 0) throw new HttpError(400, 'Enter the won value (the order amount).');
    }
    if (stage === 'lost') lostReason = oneOf(req.body, 'lost_reason', LOST_REASONS);
    if (closing) {
      closeReason = optionalText(req.body, 'close_reason', { max: 2000 });
      if (!closeReason) throw new HttpError(400, `Write why the deal is being closed as ${stage}.`);
    }
    // Won is certain and lost or abandoned is not going to happen. A reopened deal starts over at the
    // default. Any other move keeps the probability the salesperson chose.
    const probability = stage === 'won' ? 100 : closing ? 0 : reopening ? DEFAULT_PROBABILITY : opp.probability;

    await db.transaction(async () => {
      await db
        .prepare(
          `UPDATE opportunity
           SET stage = ?, probability = ?, won_value = ?, lost_reason = ?, close_reason = ?,
               closed_at = CASE WHEN ? THEN NOW() ELSE NULL END, updated_at = NOW()
           WHERE id = ?`
        )
        .run(stage, probability, wonValue, lostReason, closeReason, closing, opp.id);
      await recordHistory({ opportunityId: opp.id, changeType: 'stage', from: opp.stage, to: stage, note: note ?? closeReason, userId: req.user.id });
      const money = (value) => `₹${value.toLocaleString('en-IN')}`;
      await recordAudit({
        actorUserId: req.user.id,
        action: reopening ? 'opportunity.reopened' : closing ? `opportunity.${stage}` : 'opportunity.stage_changed',
        entityType: 'opportunity',
        entityId: opp.id,
        summary: reopening
          ? `Reopened "${opp.title}" (${opp.company_name}) from ${opp.stage} to ${stage}`
          : stage === 'won'
            ? `Won "${opp.title}" (${opp.company_name}) for ${money(wonValue)}: ${closeReason}`
            : closing
              ? `${stage === 'lost' ? 'Lost' : 'Abandoned'} "${opp.title}" (${opp.company_name}): ${closeReason}`
              : `"${opp.title}" (${opp.company_name}) moved from ${opp.stage} to ${stage}`,
        before: { stage: opp.stage, probability: opp.probability, won_value: opp.won_value, lost_reason: opp.lost_reason, close_reason: opp.close_reason },
        after: { stage, probability, won_value: wonValue, lost_reason: lostReason, close_reason: closeReason },
      });
    });
    res.json(await loadVisibleOpportunity(req.user, opp.id));
  } catch (err) {
    sendError(res, err);
  }
});

// Move one deal (and its open follow-ups) to another salesperson. Manager action, audited.
router.post('/:id/owner', requireCrmWriter, async (req, res) => {
  try {
    if (!isManaging(req.user)) throw new HttpError(403, 'Only a manager can transfer a deal.');
    const opp = await loadVisibleOpportunity(req.user, Number(req.params.id));
    if (!isOpen(opp.stage)) throw new HttpError(409, 'Closed deals keep their owner.');
    const toId = optionalId(req.body, 'to_salesperson_id');
    if (!toId) throw new HttpError(400, 'to_salesperson_id is required');
    const reason = requiredText(req.body, 'reason', { max: 500 });
    await db.transaction(async () => {
      const moved = await transferDeals({ fromId: opp.owner_salesperson_id, toId, opportunityIds: [opp.id], reason, userId: req.user.id });
      await auditHandover({ userId: req.user.id, from: moved.from, to: moved.to, dealIds: moved.dealIds, taskIds: moved.taskIds, reason, single: true });
    });
    res.json(await loadVisibleOpportunity(req.user, opp.id));
  } catch (err) {
    sendError(res, err);
  }
});

// Quotations in the ERP for this deal's customer that aren't on a deal yet, to pick from instead of
// retyping. Empty until the company is linked to its ERP customer.
router.get('/:id/erp-quotations', async (req, res) => {
  try {
    const opp = await loadVisibleOpportunity(req.user, Number(req.params.id));
    res.json(
      await db
        .prepare(
          `SELECT e.id, e.number, e.quote_date, e.status, e.total
           FROM erp_quotation e JOIN company c ON c.erp_company_id = e.erp_customer_id
           WHERE c.id = ? AND NOT EXISTS (SELECT 1 FROM quotation_link q WHERE q.erp_quotation_id = e.id)
           ORDER BY e.quote_date DESC NULLS LAST, e.id DESC LIMIT 50`
        )
        .all(opp.company_id)
    );
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/:id/quotations', requireQuotationRole, async (req, res) => {
  try {
    const opp = await loadVisibleOpportunity(req.user, Number(req.params.id));
    if (!isOpen(opp.stage)) throw new HttpError(409, 'This deal is closed.');
    // Picked from the ERP: everything but the document link comes from there.
    const erpId = optionalId(req.body, 'erp_quotation_id');
    let source = 'manual';
    let body = req.body;
    if (erpId) {
      const erp = await db.prepare(`SELECT * FROM erp_quotation WHERE id = ?`).get(erpId);
      if (!erp) throw new HttpError(400, 'That quotation isn’t in the ERP data here. Sync and try again.');
      const company = await db.prepare(`SELECT erp_company_id FROM company WHERE id = ?`).get(opp.company_id);
      if (company.erp_company_id !== erp.erp_customer_id) throw new HttpError(409, `Quotation ${erp.number} is for a different customer in the ERP.`);
      body = { quotation_number: erp.number, quotation_date: erp.quote_date, amount: erp.total, status: QUOTATION_STATUSES.includes(erp.status) ? erp.status : 'sent', erp_quotation_id: erpId, document_url: req.body.document_url };
      source = 'erp';
    }
    const fields = quotationFields(body, { partial: false });
    const linkId = await db.transaction(async () => {
      const info = await db
        .prepare(
          `INSERT INTO quotation_link (opportunity_id, quotation_number, quotation_date, amount, status, erp_quotation_id, document_url, source, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
        )
        .run(opp.id, fields.quotation_number, fields.quotation_date, fields.amount, fields.status, fields.erp_quotation_id, fields.document_url, source, req.user.id);
      if (fields.status !== 'draft') {
        await advanceIfBehind({ opportunity: opp, stage: 'quotation_sent', userId: req.user.id, note: `Quotation ${fields.quotation_number} recorded` });
      }
      await recordAudit({
        actorUserId: req.user.id,
        action: 'quotation.linked',
        entityType: 'opportunity',
        entityId: opp.id,
        summary: `Recorded quotation ${fields.quotation_number}${fields.amount != null ? ` for ₹${fields.amount.toLocaleString('en-IN')}` : ''} on "${opp.title}"`,
        after: fields,
      });
      return info.lastInsertRowid;
    });
    res.status(201).json(await db.prepare(`SELECT * FROM quotation_link WHERE id = ?`).get(linkId));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That quotation is already recorded.' });
    sendError(res, err);
  }
});

export const quotationLinksRouter = Router();

quotationLinksRouter.put('/:id', requireQuotationRole, async (req, res) => {
  try {
    const link = await db.prepare(`SELECT * FROM quotation_link WHERE id = ?`).get(Number(req.params.id));
    if (!link) throw new HttpError(404, 'Quotation not found');
    const opp = await loadVisibleOpportunity(req.user, link.opportunity_id);
    const changes = quotationFields(req.body, { partial: true });
    // The ERP owns these once linked. Only the document link is kept here.
    if (link.source === 'erp' && Object.keys(changes).some((key) => key !== 'document_url' && String(changes[key] ?? '') !== String(link[key] ?? ''))) {
      throw new HttpError(409, 'This quotation comes from the ERP. Change it there.');
    }
    const next = { ...link, ...changes };
    await db.transaction(async () => {
      await db
        .prepare(
          `UPDATE quotation_link SET quotation_number = ?, quotation_date = ?, amount = ?, status = ?, erp_quotation_id = ?, document_url = ?, updated_at = NOW()
           WHERE id = ?`
        )
        .run(next.quotation_number, next.quotation_date, next.amount, next.status, next.erp_quotation_id, next.document_url, link.id);
      if (next.status !== 'draft') {
        await advanceIfBehind({ opportunity: opp, stage: 'quotation_sent', userId: req.user.id, note: `Quotation ${next.quotation_number} ${next.status}` });
      }
      const pick = ({ quotation_number, quotation_date, amount, status, document_url }) => ({ quotation_number, quotation_date, amount, status, document_url });
      await recordAudit({
        actorUserId: req.user.id,
        action: 'quotation.updated',
        entityType: 'opportunity',
        entityId: opp.id,
        summary: `Updated quotation ${next.quotation_number} on "${opp.title}"${changes.status && changes.status !== link.status ? `: ${link.status} → ${changes.status}` : ''}`,
        before: pick(link),
        after: pick(next),
      });
    });
    res.json(await db.prepare(`SELECT * FROM quotation_link WHERE id = ?`).get(link.id));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That quotation number is already recorded on this deal.' });
    sendError(res, err);
  }
});

export default router;
