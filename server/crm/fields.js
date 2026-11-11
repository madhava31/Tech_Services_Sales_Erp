// Request-body field parsing for CRM routes. Each helper returns the cleaned value or throws an
// HttpError(400) naming the field.
import { HttpError } from './access.js';

// "Today" for due dates and dashboards is the business day in India, not the server's UTC day.
export const TODAY_SQL = `(NOW() AT TIME ZONE 'Asia/Kolkata')::date`;

export function optionalText(body, key, { max = 2000 } = {}) {
  const value = body?.[key];
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  if (trimmed.length > max) throw new HttpError(400, `${key} is too long (max ${max} characters)`);
  return trimmed === '' ? null : trimmed;
}

export function requiredText(body, key, opts) {
  const value = optionalText(body, key, opts);
  if (!value) throw new HttpError(400, `${key} is required`);
  return value;
}

export function oneOf(body, key, allowed, fallback) {
  const value = body?.[key] ?? fallback;
  if (!allowed.includes(value)) throw new HttpError(400, `${key} must be one of: ${allowed.join(', ')}`);
  return value;
}

export function optionalNumber(body, key, { min = 0 } = {}) {
  const value = body?.[key];
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) throw new HttpError(400, `${key} must be a number${min === 0 ? ' (0 or more)' : ''}`);
  return n;
}

export function optionalId(body, key) {
  const value = body?.[key];
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${key} must be a positive integer`);
  return n;
}

export function requiredDate(body, key) {
  const value = body?.[key];
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new HttpError(400, `${key} must be a date (YYYY-MM-DD)`);
  }
  return value;
}

export function optionalDate(body, key) {
  const value = body?.[key];
  if (value === undefined || value === null || value === '') return null;
  return requiredDate(body, key);
}

export function optionalTimestamp(body, key) {
  const value = body?.[key];
  if (value === undefined || value === null || value === '') return null;
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new HttpError(400, `${key} must be a date and time`);
  if (t > Date.now() + 5 * 60 * 1000) throw new HttpError(400, `${key} cannot be in the future`);
  return new Date(t).toISOString();
}

export function optionalEmail(body, key) {
  const value = optionalText(body, key, { max: 254 });
  if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new HttpError(400, `${key} is not a valid email`);
  return value;
}

// A link people will click, so only http(s): never javascript: or the like.
export function optionalUrl(body, key) {
  const value = optionalText(body, key, { max: 1000 });
  if (value && !/^https?:\/\/\S+$/i.test(value)) throw new HttpError(400, 'The link must start with http:// or https://');
  return value;
}

export function optionalUuid(body, key) {
  const value = body?.[key];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new HttpError(400, `${key} must be a UUID`);
  }
  return value.toLowerCase();
}
