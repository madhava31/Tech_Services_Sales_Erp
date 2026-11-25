import db from '../db/index.js';
import { QUOTATION_ROLES } from '../crm/access.js';
import { addNotifications, personName, pushNotifications } from '../crm/notify.js';
import { erpWriteProblem, sendQuotationRequestToErp } from './adapter.js';

// A quotation request: made when an opportunity enters Develop. It is written down in the same transaction as the
// move, so it can't be lost. Afterwards, outside the transaction, `processQuotationRequests` tells the office
// staff here and sends the request to the ERP, and tries again later if the ERP can't be reached.

// One open request per opportunity: asking again while one is open does nothing.
export async function queueQuotationRequest({ opportunityId, userId }) {
  await db
    .prepare(`INSERT INTO quotation_request (opportunity_id, requested_by) VALUES (?, ?) ON CONFLICT (opportunity_id) WHERE done_at IS NULL DO NOTHING`)
    .run(opportunityId, userId);
}

// A quotation has been recorded on the opportunity: its request is finished.
export async function closeQuotationRequest(opportunityId) {
  await db.prepare(`UPDATE quotation_request SET done_at = NOW() WHERE opportunity_id = ? AND done_at IS NULL`).run(opportunityId);
}

// Everything the ERP staff need to prepare the quotation, as it is now.
export async function buildRequestPayload(request) {
  const opp = await db
    .prepare(
      `SELECT o.id, o.code, o.title, o.estimated_value, o.expected_close_date, o.notes,
              c.name AS company_name, c.city, c.state, c.address, c.gstin, c.erp_company_id,
              sp.name AS owner_name, cc.name AS contact_name, cc.phone AS contact_phone, cc.email AS contact_email
         FROM opportunity o
         JOIN company c ON c.id = o.company_id
         JOIN salesperson sp ON sp.id = o.owner_salesperson_id
         LEFT JOIN company_contact cc ON cc.id = o.contact_id
        WHERE o.id = ?`
    )
    .get(request.opportunity_id);
  const oems = await db.prepare(`SELECT e.name FROM opportunity_oem oo JOIN oem e ON e.id = oo.oem_id WHERE oo.opportunity_id = ? ORDER BY e.name`).all(request.opportunity_id);
  const catalogue = await db
    .prepare(`SELECT p.part_number, p.name, e.name AS oem FROM opportunity_product op JOIN product p ON p.id = op.product_id JOIN oem e ON e.id = p.oem_id WHERE op.opportunity_id = ? ORDER BY e.name, p.name`)
    .all(request.opportunity_id);
  const typed = await db
    .prepare(`SELECT cp.name, cp.make, e.name AS oem FROM opportunity_custom_product cp JOIN oem e ON e.id = cp.oem_id WHERE cp.opportunity_id = ? ORDER BY e.name, cp.name`)
    .all(request.opportunity_id);
  return {
    // The ERP keeps one request per this id, so a retry never makes a second.
    sales_request_id: request.id,
    opportunity_code: opp.code,
    opportunity_title: opp.title,
    requested_by: await personName(request.requested_by),
    salesperson: opp.owner_name,
    requested_at: request.requested_at,
    company: {
      name: opp.company_name,
      city: opp.city,
      state: opp.state,
      address: opp.address,
      gstin: opp.gstin,
      erp_company_id: opp.erp_company_id,
    },
    contact: { name: opp.contact_name, phone: opp.contact_phone, email: opp.contact_email },
    oems: oems.map((o) => o.name),
    products: [
      ...catalogue.map((p) => ({ part_no: p.part_number, name: p.name, oem: p.oem })),
      ...typed.map((p) => ({ part_no: null, name: p.name, oem: p.make || p.oem })),
    ],
    estimated_value: opp.estimated_value === null ? null : Number(opp.estimated_value),
    expected_close_date: opp.expected_close_date,
    notes: opp.notes,
  };
}

const money = (n) => (n === null || n === undefined ? '' : `, ₹${Number(n).toLocaleString('en-IN')}`);

// "Ravi asks for a quotation for Mahi Drugs: HPLC column, pH electrode (TS-R-0007), ₹1,20,000"
function summary(payload) {
  const names = payload.products.map((p) => p.name);
  const shown = names.slice(0, 3).join(', ') + (names.length > 3 ? ` and ${names.length - 3} more` : '');
  return `${payload.requested_by} asks for a quotation for ${payload.company.name}${shown ? `: ${shown}` : ''} (${payload.opportunity_code})${money(payload.estimated_value)}`;
}

// Tells the office staff here, once.
async function notifyOffice(request, payload) {
  const staff = await db.prepare(`SELECT id FROM app_user WHERE is_active AND role = ANY(?::text[]) AND id <> ?`).all(QUOTATION_ROLES, request.requested_by);
  const rows = await addNotifications({
    userIds: staff.map((s) => s.id),
    kind: 'quotation_request',
    title: `Quotation requested: ${payload.company.name}`,
    body: summary(payload),
    url: `/pipeline/${request.opportunity_id}`,
    refType: 'opportunity',
    refId: request.opportunity_id,
  });
  await db.prepare(`UPDATE quotation_request SET notified_at = NOW() WHERE id = ?`).run(request.id);
  return rows;
}

// Does the work behind the queue. Safe to run any time and as often as wanted: each request is announced once
// and sent until the ERP has it. Never throws, so a failure here can't undo the change that caused it.
export async function processQuotationRequests({ limit = 5 } = {}) {
  const result = { notified: 0, sent: 0, failed: 0 };
  try {
    const open = await db
      .prepare(`SELECT * FROM quotation_request WHERE done_at IS NULL AND (notified_at IS NULL OR sent_at IS NULL) ORDER BY id LIMIT ?`)
      .all(limit);
    const pushes = [];
    for (const request of open) {
      let payload = null;
      try {
        payload = await buildRequestPayload(request);
      } catch (err) {
        console.error('Quotation request payload failed:', err.message);
        continue;
      }
      if (!request.notified_at) {
        pushes.push(...(await notifyOffice(request, payload)));
        result.notified++;
      }
      if (!request.sent_at && !erpWriteProblem()) {
        try {
          const sent = await sendQuotationRequestToErp(payload);
          await db.prepare(`UPDATE quotation_request SET sent_at = NOW(), erp_request_id = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?`).run(sent.id, request.id);
          result.sent++;
        } catch (err) {
          await db.prepare(`UPDATE quotation_request SET attempts = attempts + 1, last_error = ? WHERE id = ?`).run(String(err.message).slice(0, 300), request.id);
          result.failed++;
        }
      }
    }
    await pushNotifications(pushes);
  } catch (err) {
    console.error('Processing quotation requests failed:', err.message);
  }
  return result;
}

// A quotation has been recorded on the opportunity: tell the salesperson who owns it (unless they recorded it).
export async function notifyQuotationReady(opp, recordedBy) {
  try {
    const owner = await db.prepare(`SELECT id FROM app_user WHERE salesperson_id = ? AND is_active AND id <> ?`).get(opp.owner_salesperson_id, recordedBy);
    if (!owner) return;
    const q = await db.prepare(`SELECT quotation_number, amount, status FROM quotation_link WHERE opportunity_id = ? ORDER BY id DESC LIMIT 1`).get(opp.id);
    if (!q) return;
    const rows = await addNotifications({
      userIds: [owner.id],
      kind: 'quotation_ready',
      title: `Quotation ready: ${opp.company_name}`,
      body: `Quotation ${q.quotation_number}${q.amount != null ? `, ₹${Number(q.amount).toLocaleString('en-IN')}` : ''} is recorded on ${opp.title} (${opp.code}).`,
      url: `/pipeline/${opp.id}`,
      refType: 'opportunity',
      refId: opp.id,
    });
    await pushNotifications(rows);
  } catch (err) {
    console.error('Quotation-ready notification failed:', err.message);
  }
}

// What the opportunity page shows about its request.
export async function requestStatus(opportunityId) {
  const row = await db
    .prepare(`SELECT id, requested_at, sent_at, done_at, attempts, last_error FROM quotation_request WHERE opportunity_id = ? ORDER BY id DESC LIMIT 1`)
    .get(opportunityId);
  if (!row) return null;
  const problem = erpWriteProblem();
  return {
    requested_at: row.requested_at,
    state: row.done_at ? 'done' : row.sent_at ? 'sent' : 'waiting',
    sent_at: row.sent_at,
    // Why it hasn't been sent, for a person to read.
    note: row.done_at || row.sent_at ? null : problem ? 'The link to the ERP for requests is not set up yet. The office here has been told.' : row.last_error ? `Will try again. ${row.last_error}` : null,
  };
}
