import db from '../db/index.js';
import { visibleSalespersonIds } from '../auth/roles.js';

// Roles that record field activity. Office staff can read CRM data but not change it.
export const CRM_WRITER_ROLES = ['admin', 'managing_director', 'sales_manager', 'salesperson'];

// Roles that may act for another salesperson (record on their behalf, reassign their tasks).
export const MANAGING_ROLES = ['admin', 'managing_director', 'sales_manager'];

// Roles that record quotations against deals (quotations are prepared by the office, decision D6).
export const QUOTATION_ROLES = ['admin', 'managing_director', 'sales_manager', 'office_staff'];

export function requireQuotationRole(req, res, next) {
  if (!QUOTATION_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Quotations are recorded by the office or a manager.' });
  }
  next();
}

export function requireCrmWriter(req, res, next) {
  if (!CRM_WRITER_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Your role can view this but not change it.' });
  }
  next();
}

export function isManaging(user) {
  return MANAGING_ROLES.includes(user.role);
}

// SQL fragment limiting `column` to rows this user may see. Returns '' (no restriction) for roles
// that see everything. Always parameterized; the id list never comes from the request.
export function scopeFilter(user, column, params) {
  const ids = visibleSalespersonIds(user);
  if (ids === null) return '';
  params.push(ids);
  return ` AND ${column} = ANY(?::int[])`;
}

export function canSeeSalesperson(user, salespersonId) {
  const ids = visibleSalespersonIds(user);
  return ids === null || ids.includes(salespersonId);
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Which salesperson a new record belongs to. Salespeople always get their own (anything sent in
// the request is ignored); managers may name one, or default to their own linked record.
export async function resolveOwner(user, requestedId) {
  let id;
  if (user.role === 'salesperson') {
    if (!user.salesperson_id) throw new HttpError(403, 'Your login is not linked to a salesperson record.');
    id = user.salesperson_id;
  } else {
    id = requestedId ? Number(requestedId) : user.salesperson_id;
    if (!id) throw new HttpError(400, 'Choose which salesperson this belongs to (salesperson_id).');
  }
  const row = await db.prepare(`SELECT id, is_active FROM salesperson WHERE id = ?`).get(id);
  if (!row) throw new HttpError(400, 'Salesperson not found.');
  if (!row.is_active) throw new HttpError(400, 'That salesperson is inactive.');
  return id;
}

// Shared error responder for CRM routes: HttpError → its status, Postgres check/foreign-key
// violations → 400, anything else → 500.
export function sendError(res, err) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.code === '23514' || err.code === '23503' || err.code === '22P02' || err.code === '22007' || err.code === '22008') {
    return res.status(400).json({ error: 'Some of the values are not valid.' });
  }
  console.error(err);
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
}
