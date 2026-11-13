import { Router } from 'express';
import db from '../db/index.js';
import { scopeFilter, sendError } from '../crm/access.js';
import { normalizeCompanyName } from '../crm/normalize.js';

// Mounted at /api/search: the universal search in the top bar. One box finds opportunities (by ID,
// name or company), companies and contacts. A salesperson finds only the opportunities they can open;
// companies and contacts are shared, as they are everywhere else in the app.
const router = Router();

const PER_GROUP = 8;

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

router.get('/', async (req, res) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
    if (q.length < 2) return res.json({ q, opportunities: [], companies: [], contacts: [] });
    const like = `%${escapeLike(q)}%`;
    const prefix = `${escapeLike(q)}%`;
    // Phone numbers only for a search that is a number: "TS-A-0009" isn't looking for a phone.
    const digits = /[a-z]/i.test(q) ? '' : q.replace(/\D/g, '');
    // "tsg12", "TS G 12" and "ts-g-0012" all find TS-G-0012.
    const codeKey = q.toUpperCase().replace(/[^A-Z0-9]/g, '');

    // Values in the order of the ? marks: the WHERE's, the visibility filter's, then the ORDER BY's.
    const oppParams = [codeKey, codeKey, `%${codeKey}%`, like, like];
    const scope = scopeFilter(req.user, 'o.owner_salesperson_id', oppParams);
    oppParams.push(codeKey);
    const opportunities = await db
      .prepare(
        `SELECT o.id, o.code, o.title, o.stage, o.estimated_value, o.won_value, c.name AS company_name, sp.name AS owner_name
         FROM opportunity o
         JOIN company c ON c.id = o.company_id
         JOIN salesperson sp ON sp.id = o.owner_salesperson_id
         WHERE (replace(o.code, '-', '') = ? OR (length(?) >= 3 AND replace(o.code, '-', '') LIKE ?)
                OR o.title ILIKE ? OR c.name ILIKE ?)${scope}
         ORDER BY (replace(o.code, '-', '') = ?) DESC, (o.stage NOT IN ('won', 'lost')) DESC, o.updated_at DESC
         LIMIT ${PER_GROUP}`
      )
      .all(...oppParams);

    const normalized = normalizeCompanyName(q);
    const companies = await db
      .prepare(
        `SELECT c.id, c.name, c.city, c.approval_status
         FROM company c
         WHERE c.archived_at IS NULL AND c.approval_status <> 'rejected'
           AND (c.normalized_name % ? OR c.name ILIKE ? OR c.city ILIKE ?)
         ORDER BY (c.name ILIKE ?) DESC, similarity(c.normalized_name, ?) DESC, c.name
         LIMIT ${PER_GROUP}`
      )
      .all(normalized, like, prefix, prefix, normalized);

    const contacts = await db
      .prepare(
        `SELECT cc.id, cc.name, cc.phone, cc.designation, cc.department, c.id AS company_id, c.name AS company_name
         FROM company_contact cc JOIN company c ON c.id = cc.company_id
         WHERE cc.archived_at IS NULL AND c.archived_at IS NULL
           AND (cc.name ILIKE ? OR (length(?) >= 4 AND regexp_replace(coalesce(cc.phone, ''), '[^0-9]', '', 'g') LIKE ?))
         ORDER BY (cc.name ILIKE ?) DESC, cc.name
         LIMIT ${PER_GROUP}`
      )
      .all(like, digits, `%${digits}%`, prefix);

    res.json({ q, opportunities, companies, contacts });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
