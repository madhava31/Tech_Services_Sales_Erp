import db from '../db/index.js';
import { recordAudit } from '../audit/log.js';
import { HttpError } from './access.js';
import { optionalEmail, optionalText, requiredText } from './fields.js';
import { phoneKey } from './normalize.js';

export function contactFields(body) {
  return {
    name: requiredText(body, 'name', { max: 120 }),
    designation: optionalText(body, 'designation', { max: 120 }),
    phone: optionalText(body, 'phone', { max: 30 }),
    email: optionalEmail(body, 'email'),
  };
}

// The live contact holding this phone number, with the company it belongs to.
export async function findContactByPhone(phone, { excludeId = null } = {}) {
  const key = phoneKey(phone);
  if (!key) return null;
  return db
    .prepare(
      `SELECT cc.id, cc.name, cc.company_id, c.name AS company_name
       FROM company_contact cc JOIN company c ON c.id = cc.company_id
       WHERE cc.archived_at IS NULL AND right(regexp_replace(cc.phone, '[^0-9]', '', 'g'), 10) = ?
         ${excludeId ? 'AND cc.id <> ?' : ''}
       LIMIT 1`
    )
    .get(...(excludeId ? [key, excludeId] : [key]));
}

export function phoneTakenMessage(owner, phone) {
  return `${phone} already belongs to ${owner.name} at ${owner.company_name}.`;
}

// Inserts inside the caller's transaction.
export async function insertContact({ companyId, fields, userId }) {
  const info = await db
    .prepare(`INSERT INTO company_contact (company_id, name, designation, phone, email, created_by) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`)
    .run(companyId, fields.name, fields.designation, fields.phone, fields.email, userId);
  await recordAudit({
    actorUserId: userId,
    action: 'contact.created',
    entityType: 'company_contact',
    entityId: info.lastInsertRowid,
    summary: `Added contact ${fields.name}${fields.phone ? ` (${fields.phone})` : ''}`,
    after: fields,
  });
  return info.lastInsertRowid;
}

// "+ Add customer number" and the first contact typed on a visit: a number already on this company
// selects that contact; a number on another company is refused, naming that company.
export async function resolveContactByPhone({ companyId, fields, userId }) {
  const owner = await findContactByPhone(fields.phone);
  if (owner) {
    if (owner.company_id !== companyId) throw new HttpError(409, phoneTakenMessage(owner, fields.phone));
    return owner.id;
  }
  return insertContact({ companyId, fields, userId });
}
