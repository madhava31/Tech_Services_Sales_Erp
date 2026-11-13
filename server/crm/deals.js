import db from '../db/index.js';
import { recordAudit } from '../audit/log.js';
import { HttpError } from './access.js';
import { contactFields, resolveContactByPhone } from './contacts.js';
import { optionalId, optionalNumber, optionalText, requiredDate, requiredText } from './fields.js';
import { DEFAULT_PROBABILITY, WIN_PROBABILITIES, recordHistory } from './pipeline.js';

export const COMPETITOR_CHOICES = ['no_idea', 'no_competitor', 'other'];

function idList(body, key) {
  const list = body?.[key];
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.some((id) => !Number.isInteger(id) || id <= 0)) throw new HttpError(400, `${key} must be a list of ids`);
  return [...new Set(list)];
}

// A company must be approved before a deal can be opened on it. Pending companies can be visited.
export async function assertCompanyAcceptsDeals(companyId) {
  const company = await db.prepare(`SELECT id, name, approval_status FROM company WHERE id = ? AND archived_at IS NULL`).get(companyId);
  if (!company) throw new HttpError(400, 'Company not found.');
  if (company.approval_status !== 'approved') {
    throw new HttpError(
      409,
      company.approval_status === 'pending'
        ? `${company.name} is waiting for approval. An opportunity can be opened once a manager approves it.`
        : `${company.name} was rejected, so an opportunity cannot be opened on it.`
    );
  }
  return company;
}

// Parses and checks every deal field against the catalogue. `body` is the whole deal: on an edit the
// caller merges the request over the current values first. The keep* options are the deal's current
// choices, still allowed even if since deactivated.
export async function parseDealFields(body, { companyId, keepOemIds = [], keepProductIds = [], keepSegmentIds = [] }) {
  const estimatedValue = optionalNumber(body, 'estimated_value');
  if (!estimatedValue || estimatedValue <= 0) throw new HttpError(400, 'Enter the order value.');
  const probability = body.probability === undefined || body.probability === null ? DEFAULT_PROBABILITY : Number(body.probability);
  if (!WIN_PROBABILITIES.includes(probability)) throw new HttpError(400, `probability must be one of: ${WIN_PROBABILITIES.join(', ')}`);
  if (body.tender !== undefined && typeof body.tender !== 'boolean') throw new HttpError(400, 'tender must be true or false');

  // One or more OEMs (oem_id alone is still accepted from older clients), each with its own products.
  const oemIds = body.oem_ids !== undefined ? idList(body, 'oem_ids') : optionalId(body, 'oem_id') ? [optionalId(body, 'oem_id')] : [];
  if (oemIds.length === 0) throw new HttpError(400, 'Choose the OEM.');
  const oems = await db.prepare(`SELECT id, name, is_active FROM oem WHERE id = ANY(?::int[])`).all(oemIds);
  if (oems.length !== oemIds.length) throw new HttpError(400, 'That OEM was not found.');
  for (const oem of oems) if (!oem.is_active && !keepOemIds.includes(oem.id)) throw new HttpError(400, `${oem.name} is no longer active.`);

  const productIds = idList(body, 'product_ids');
  if (productIds.length === 0) throw new HttpError(400, 'Choose at least one product.');
  const products = await db.prepare(`SELECT id, name, oem_id, is_active FROM product WHERE id = ANY(?::int[])`).all(productIds);
  if (products.length !== productIds.length) throw new HttpError(400, 'One of those products was not found.');
  const oemNames = oems.map((o) => o.name).join(' or ');
  for (const p of products) {
    if (!oemIds.includes(p.oem_id)) throw new HttpError(400, `${p.name} is not a ${oemNames} product.`);
    if (!p.is_active && !keepProductIds.includes(p.id)) throw new HttpError(400, `${p.name} is no longer active.`);
  }
  for (const oem of oems) {
    if (!products.some((p) => p.oem_id === oem.id)) throw new HttpError(400, `Choose at least one ${oem.name} product, or remove ${oem.name}.`);
  }

  // Who else is bidding: not known, nobody, or a named competitor.
  const competitor = body.competitor === undefined || body.competitor === null || body.competitor === '' ? null : body.competitor;
  if (competitor !== null && !COMPETITOR_CHOICES.includes(competitor)) throw new HttpError(400, `competitor must be one of: ${COMPETITOR_CHOICES.join(', ')}`);
  const competitorNote = competitor === 'other' ? optionalText(body, 'competitor_note', { max: 300 }) : null;
  if (competitor === 'other' && !competitorNote) throw new HttpError(400, 'Name the competitor.');

  const segmentIds = idList(body, 'segment_ids');
  if (segmentIds.length) {
    const segments = await db.prepare(`SELECT id, name, is_active FROM market_segment WHERE id = ANY(?::int[])`).all(segmentIds);
    if (segments.length !== segmentIds.length) throw new HttpError(400, 'One of those market segments was not found.');
    for (const s of segments) if (!s.is_active && !keepSegmentIds.includes(s.id)) throw new HttpError(400, `${s.name} is no longer active.`);
  }

  const contactId = optionalId(body, 'contact_id');
  if (contactId) {
    const contact = await db.prepare(`SELECT id FROM company_contact WHERE id = ? AND company_id = ? AND archived_at IS NULL`).get(contactId, companyId);
    if (!contact) throw new HttpError(400, 'That contact does not belong to this company.');
  }
  let newContact = null;
  if (body.new_contact && typeof body.new_contact === 'object') {
    newContact = contactFields(body.new_contact);
    if (!newContact.phone) throw new HttpError(400, 'Enter the customer’s phone number.');
  }

  return {
    title: requiredText(body, 'title', { max: 200 }),
    estimated_value: estimatedValue,
    expected_close_date: requiredDate(body, 'expected_close_date'),
    probability,
    probability_reason: optionalText(body, 'probability_reason', { max: 300 }),
    tender: body.tender === true,
    notes: optionalText(body, 'notes', { max: 5000 }),
    oem_ids: oemIds,
    product_ids: productIds,
    competitor,
    competitor_note: competitorNote,
    segment_ids: segmentIds,
    contact_id: contactId,
    new_contact: newContact,
  };
}

// The inline "+ Add customer number", resolved inside the caller's transaction.
export async function resolveDealContact(fields, companyId, userId) {
  if (fields.new_contact) return resolveContactByPhone({ companyId, fields: fields.new_contact, userId });
  return fields.contact_id;
}

export async function replaceDealLinks(opportunityId, { oem_ids: oemIds, product_ids: productIds, segment_ids: segmentIds }) {
  // Link rows carry no history of their own: the change is kept in opportunity_history.
  await db.prepare(`DELETE FROM opportunity_oem WHERE opportunity_id = ?`).run(opportunityId);
  for (const id of oemIds) await db.prepare(`INSERT INTO opportunity_oem (opportunity_id, oem_id) VALUES (?, ?)`).run(opportunityId, id);
  await db.prepare(`DELETE FROM opportunity_product WHERE opportunity_id = ?`).run(opportunityId);
  await db.prepare(`DELETE FROM opportunity_segment WHERE opportunity_id = ?`).run(opportunityId);
  for (const id of productIds) await db.prepare(`INSERT INTO opportunity_product (opportunity_id, product_id) VALUES (?, ?)`).run(opportunityId, id);
  for (const id of segmentIds) await db.prepare(`INSERT INTO opportunity_segment (opportunity_id, segment_id) VALUES (?, ?)`).run(opportunityId, id);
}

// Inserts a deal, its links and its "created" history row, inside the caller's transaction. The
// database gives it its ID (TS-G-0001). `close` (from closeFields) is given when it is created
// already Won or Lost.
export async function insertOpportunity({ companyId, companyName, ownerId, stage, fields, close = null, sourceVisitId = null, userId }) {
  const contactId = await resolveDealContact(fields, companyId, userId);
  const closed = stage === 'won' || stage === 'lost';
  if (closed && !close) throw new Error('insertOpportunity: a closed stage needs its close fields');
  const probability = stage === 'won' ? 100 : stage === 'lost' ? 0 : fields.probability;
  const info = await db
    .prepare(
      `INSERT INTO opportunity (company_id, title, owner_salesperson_id, original_owner_salesperson_id, stage, estimated_value, probability,
                                probability_reason, tender, expected_close_date, contact_id, source_visit_id, notes, competitor, competitor_note,
                                won_value, lost_reason, close_reason, closed_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ?::boolean THEN NOW() END, ?) RETURNING id`
    )
    .run(
      companyId,
      fields.title,
      ownerId,
      ownerId,
      stage,
      fields.estimated_value,
      probability,
      fields.probability_reason,
      fields.tender,
      fields.expected_close_date,
      contactId,
      sourceVisitId,
      fields.notes,
      fields.competitor ?? null,
      fields.competitor_note ?? null,
      closed ? close.wonValue : null,
      closed ? close.lostReason : null,
      closed ? close.closeReason : null,
      closed,
      userId
    );
  const id = info.lastInsertRowid;
  const { code } = await db.prepare(`SELECT code FROM opportunity WHERE id = ?`).get(id);
  await replaceDealLinks(id, fields);
  await recordHistory({ opportunityId: id, changeType: 'created', to: stage, note: closed ? close.closeReason : null, userId });
  await recordAudit({
    actorUserId: userId,
    action: 'opportunity.created',
    entityType: 'opportunity',
    entityId: id,
    summary: `Opened opportunity ${code} "${fields.title}" with ${companyName}${closed ? ` (closed as ${stage}: ${close.closeReason})` : ''}`,
    after: { ...fields, new_contact: undefined, contact_id: contactId },
  });
  return id;
}
