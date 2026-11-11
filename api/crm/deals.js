import db from '../db/index.js';
import { recordAudit } from '../audit/log.js';
import { HttpError } from './access.js';
import { contactFields, resolveContactByPhone } from './contacts.js';
import { optionalId, optionalNumber, optionalText, requiredDate, requiredText } from './fields.js';
import { DEFAULT_PROBABILITY, WIN_PROBABILITIES, recordHistory } from './pipeline.js';

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
export async function parseDealFields(body, { companyId, keepOemId = null, keepProductIds = [], keepSegmentIds = [] }) {
  const estimatedValue = optionalNumber(body, 'estimated_value');
  if (!estimatedValue || estimatedValue <= 0) throw new HttpError(400, 'Enter the order value.');
  const probability = body.probability === undefined || body.probability === null ? DEFAULT_PROBABILITY : Number(body.probability);
  if (!WIN_PROBABILITIES.includes(probability)) throw new HttpError(400, `probability must be one of: ${WIN_PROBABILITIES.join(', ')}`);
  if (body.tender !== undefined && typeof body.tender !== 'boolean') throw new HttpError(400, 'tender must be true or false');

  const oemId = optionalId(body, 'oem_id');
  if (!oemId) throw new HttpError(400, 'Choose the OEM.');
  const oem = await db.prepare(`SELECT id, name, is_active FROM oem WHERE id = ?`).get(oemId);
  if (!oem) throw new HttpError(400, 'That OEM was not found.');
  if (!oem.is_active && oemId !== keepOemId) throw new HttpError(400, `${oem.name} is no longer active.`);

  const productIds = idList(body, 'product_ids');
  if (productIds.length === 0) throw new HttpError(400, 'Choose at least one product.');
  const products = await db.prepare(`SELECT id, name, oem_id, is_active FROM product WHERE id = ANY(?::int[])`).all(productIds);
  if (products.length !== productIds.length) throw new HttpError(400, 'One of those products was not found.');
  for (const p of products) {
    if (p.oem_id !== oemId) throw new HttpError(400, `${p.name} is not a ${oem.name} product.`);
    if (!p.is_active && !keepProductIds.includes(p.id)) throw new HttpError(400, `${p.name} is no longer active.`);
  }

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
    oem_id: oemId,
    product_ids: productIds,
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

export async function replaceDealLinks(opportunityId, { product_ids: productIds, segment_ids: segmentIds }) {
  // Link rows carry no history of their own: the change is kept in opportunity_history.
  await db.prepare(`DELETE FROM opportunity_product WHERE opportunity_id = ?`).run(opportunityId);
  await db.prepare(`DELETE FROM opportunity_segment WHERE opportunity_id = ?`).run(opportunityId);
  for (const id of productIds) await db.prepare(`INSERT INTO opportunity_product (opportunity_id, product_id) VALUES (?, ?)`).run(opportunityId, id);
  for (const id of segmentIds) await db.prepare(`INSERT INTO opportunity_segment (opportunity_id, segment_id) VALUES (?, ?)`).run(opportunityId, id);
}

// Inserts a deal, its links and its "created" history row, inside the caller's transaction.
export async function insertOpportunity({ companyId, companyName, ownerId, stage, fields, sourceVisitId = null, userId }) {
  const contactId = await resolveDealContact(fields, companyId, userId);
  const info = await db
    .prepare(
      `INSERT INTO opportunity (company_id, title, owner_salesperson_id, original_owner_salesperson_id, stage, estimated_value, probability,
                                probability_reason, tender, expected_close_date, oem_id, contact_id, source_visit_id, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    )
    .run(
      companyId,
      fields.title,
      ownerId,
      ownerId,
      stage,
      fields.estimated_value,
      fields.probability,
      fields.probability_reason,
      fields.tender,
      fields.expected_close_date,
      fields.oem_id,
      contactId,
      sourceVisitId,
      fields.notes,
      userId
    );
  const id = info.lastInsertRowid;
  await replaceDealLinks(id, fields);
  await recordHistory({ opportunityId: id, changeType: 'created', to: stage, userId });
  await recordAudit({
    actorUserId: userId,
    action: 'opportunity.created',
    entityType: 'opportunity',
    entityId: id,
    summary: `Opened opportunity "${fields.title}" with ${companyName}`,
    after: { ...fields, new_contact: undefined, contact_id: contactId },
  });
  return id;
}
