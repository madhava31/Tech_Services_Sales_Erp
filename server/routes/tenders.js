import { Router } from 'express';
import db from '../db/index.js';
import { recordAudit } from '../audit/log.js';
import { HttpError, requireCrmWriter, scopeFilter, sendError } from '../crm/access.js';
import { TODAY_SQL, oneOf, optionalDate, optionalNumber, optionalText, optionalUrl, requiredDate, requiredText } from '../crm/fields.js';
import { recordHistory } from '../crm/pipeline.js';
import { loadVisibleOpportunity } from './opportunities.js';

// Mounted at /api/tenders: bids and their deadlines, and bid deposits (EMD) still to come back.
// Details stay editable after the deal closes, because the deposit usually returns later.
const router = Router();

const EMD_STATUSES = ['not_required', 'pending', 'paid', 'refunded', 'forfeited'];
const BID_STATUSES = ['preparing', 'submitted', 'won', 'lost', 'cancelled'];

// Paid, and the bid is decided or the deal closed, so it should be on its way back.
export const EMD_TO_RECOVER_SQL = `(t.emd_status = 'paid' AND (t.bid_status IN ('won', 'lost', 'cancelled') OR o.closed_at IS NOT NULL))`;

const TENDER_SELECT = `
  SELECT t.opportunity_id, t.tender_number, t.issuing_authority, t.bid_due_date, t.pre_bid_date, t.emd_amount, t.emd_status, t.bid_status,
         t.document_url, t.notes, t.updated_at, o.title AS deal_title, o.stage, o.estimated_value, c.id AS company_id, c.name AS company_name,
         sp.name AS owner_name, (t.bid_due_date - ${TODAY_SQL}) AS days_left,
         (t.bid_status = 'preparing' AND t.bid_due_date < ${TODAY_SQL}) AS is_late,
         ${EMD_TO_RECOVER_SQL} AS emd_to_recover
  FROM tender t
  JOIN opportunity o ON o.id = t.opportunity_id
  JOIN company c ON c.id = o.company_id
  JOIN salesperson sp ON sp.id = o.owner_salesperson_id`;

router.get('/', async (req, res) => {
  try {
    const params = [];
    let where = `WHERE o.tender${scopeFilter(req.user, 'o.owner_salesperson_id', params)}`;
    let order = 't.bid_due_date DESC';
    if (req.query.view === 'open') {
      where += ` AND t.bid_status = 'preparing' AND o.closed_at IS NULL`;
      order = 't.bid_due_date ASC';
    } else if (req.query.view === 'submitted') {
      where += ` AND t.bid_status = 'submitted'`;
      order = 't.bid_due_date ASC';
    } else if (req.query.view === 'emd') {
      where += ` AND ${EMD_TO_RECOVER_SQL}`;
      order = 't.bid_due_date ASC';
    }
    res.json(await db.prepare(`${TENDER_SELECT} ${where} ORDER BY ${order} LIMIT 300`).all(...params));
  } catch (err) {
    sendError(res, err);
  }
});

const LABELS = {
  tender_number: 'Tender number',
  issuing_authority: 'Issuing authority',
  bid_due_date: 'Bid due date',
  pre_bid_date: 'Pre-bid date',
  emd_amount: 'EMD amount',
  emd_status: 'EMD status',
  bid_status: 'Bid status',
  document_url: 'Tender document',
  notes: 'Tender notes',
};

function tenderFields(body) {
  const fields = {
    tender_number: requiredText(body, 'tender_number', { max: 100 }),
    issuing_authority: optionalText(body, 'issuing_authority', { max: 200 }),
    bid_due_date: requiredDate(body, 'bid_due_date'),
    pre_bid_date: optionalDate(body, 'pre_bid_date'),
    emd_amount: optionalNumber(body, 'emd_amount'),
    emd_status: oneOf(body, 'emd_status', EMD_STATUSES, 'not_required'),
    bid_status: oneOf(body, 'bid_status', BID_STATUSES, 'preparing'),
    document_url: optionalUrl(body, 'document_url'),
    notes: optionalText(body, 'notes', { max: 2000 }),
  };
  if (fields.emd_status !== 'not_required' && fields.emd_amount === null) throw new HttpError(400, 'Enter the EMD amount.');
  return fields;
}

// Adds or updates a deal's tender details. Saving them also marks the deal as a tender.
router.put('/deal/:opportunityId', requireCrmWriter, async (req, res) => {
  try {
    const opp = await loadVisibleOpportunity(req.user, Number(req.params.opportunityId));
    const fields = tenderFields(req.body);
    await db.transaction(async () => {
      const before = await db.prepare(`SELECT * FROM tender WHERE opportunity_id = ? FOR UPDATE`).get(opp.id);
      await db
        .prepare(
          `INSERT INTO tender (opportunity_id, tender_number, issuing_authority, bid_due_date, pre_bid_date, emd_amount, emd_status, bid_status, document_url, notes, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (opportunity_id) DO UPDATE SET tender_number = EXCLUDED.tender_number, issuing_authority = EXCLUDED.issuing_authority,
             bid_due_date = EXCLUDED.bid_due_date, pre_bid_date = EXCLUDED.pre_bid_date, emd_amount = EXCLUDED.emd_amount, emd_status = EXCLUDED.emd_status,
             bid_status = EXCLUDED.bid_status, document_url = EXCLUDED.document_url, notes = EXCLUDED.notes, updated_at = NOW()`
        )
        .run(opp.id, fields.tender_number, fields.issuing_authority, fields.bid_due_date, fields.pre_bid_date, fields.emd_amount, fields.emd_status, fields.bid_status, fields.document_url, fields.notes, req.user.id);
      if (!opp.tender) await db.prepare(`UPDATE opportunity SET tender = TRUE, updated_at = NOW() WHERE id = ?`).run(opp.id);

      const changed = Object.keys(fields).filter((key) => String(before?.[key] ?? '') !== String(fields[key] ?? ''));
      if (before) {
        for (const key of changed) {
          await recordHistory({ opportunityId: opp.id, changeType: 'field', field: LABELS[key], from: before[key] === null ? null : String(before[key]), to: String(fields[key] ?? '—'), userId: req.user.id });
        }
      } else {
        await recordHistory({ opportunityId: opp.id, changeType: 'field', field: 'Tender', to: `${fields.tender_number}, bid due ${fields.bid_due_date}`, userId: req.user.id });
      }
      if (!before || changed.length) {
        await recordAudit({
          actorUserId: req.user.id,
          action: before ? 'tender.updated' : 'tender.created',
          entityType: 'opportunity',
          entityId: opp.id,
          summary: `${before ? 'Updated' : 'Added'} tender ${fields.tender_number} on "${opp.title}"${before && changed.length ? `: ${changed.map((k) => LABELS[k]).join(', ')}` : ''}`,
          before: before ? Object.fromEntries(changed.map((k) => [k, before[k]])) : null,
          after: before ? Object.fromEntries(changed.map((k) => [k, fields[k]])) : fields,
        });
      }
    });
    res.json(await db.prepare(`${TENDER_SELECT} WHERE t.opportunity_id = ?`).get(opp.id));
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
