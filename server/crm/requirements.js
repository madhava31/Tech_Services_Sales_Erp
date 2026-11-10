import db from '../db/index.js';
import { HttpError } from './access.js';
import { oneOf, optionalNumber, optionalText, requiredText } from './fields.js';

export const URGENCIES = ['low', 'normal', 'high', 'urgent'];

export function requirementFields(body) {
  return {
    product_category: optionalText(body, 'product_category', { max: 120 }),
    description: requiredText(body, 'description', { max: 2000 }),
    specification: optionalText(body, 'specification', { max: 2000 }),
    quantity: optionalNumber(body, 'quantity', { min: Number.MIN_VALUE }),
    unit: optionalText(body, 'unit', { max: 30 }),
    budget: optionalNumber(body, 'budget'),
    urgency: oneOf(body, 'urgency', URGENCIES, 'normal'),
    purchase_timeline: optionalText(body, 'purchase_timeline', { max: 120 }),
    decision_maker: optionalText(body, 'decision_maker', { max: 120 }),
  };
}

export function parseRequirementList(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new HttpError(400, 'requirements must be a list');
  if (list.length > 20) throw new HttpError(400, 'At most 20 requirements per visit');
  return list.map((item, i) => {
    try {
      return requirementFields(item);
    } catch (err) {
      if (err instanceof HttpError) throw new HttpError(400, `Requirement ${i + 1}: ${err.message}`);
      throw err;
    }
  });
}

// Inserts inside the caller's transaction (db.prepare joins it automatically).
export async function insertRequirement({ companyId, visitId = null, opportunityId = null, salespersonId, userId, fields }) {
  const info = await db
    .prepare(
      `INSERT INTO requirement (company_id, visit_id, opportunity_id, salesperson_id, product_category, description, specification,
                                quantity, unit, budget, urgency, purchase_timeline, decision_maker, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    )
    .run(
      companyId,
      visitId,
      opportunityId,
      salespersonId,
      fields.product_category,
      fields.description,
      fields.specification,
      fields.quantity,
      fields.unit,
      fields.budget,
      fields.urgency,
      fields.purchase_timeline,
      fields.decision_maker,
      userId
    );
  return info.lastInsertRowid;
}
