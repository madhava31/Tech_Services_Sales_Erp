import db from '../db/index.js';
import { HttpError } from './access.js';
import { TODAY_SQL } from './fields.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Reporting period from ?from=&to= (inclusive India-time days) or ?days=7|30|90 ending today.
export async function parsePeriod(query) {
  const today = (await db.prepare(`SELECT ${TODAY_SQL}::text AS d`).get()).d;
  if (query.from || query.to) {
    if (!DATE.test(query.from ?? '') || !DATE.test(query.to ?? '')) throw new HttpError(400, 'from and to must both be dates (YYYY-MM-DD)');
    if (query.from > query.to) throw new HttpError(400, 'from must be on or before to');
    return { from: query.from, to: query.to, today };
  }
  const days = [7, 30, 90].includes(Number(query.days)) ? Number(query.days) : 30;
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return { from: d.toISOString().slice(0, 10), to: today, today };
}
