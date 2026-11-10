import { Router } from 'express';
import db from '../db/index.js';
import { recordAudit } from '../audit/log.js';
import { normalizeCompanyName, phoneKey } from '../crm/normalize.js';
import { HttpError, isManaging, requireCrmWriter, scopeFilter, sendError } from '../crm/access.js';
import { assertValidParent, mergeCompanies } from '../crm/companies.js';
import { contactFields, findContactByPhone, insertContact, phoneTakenMessage } from '../crm/contacts.js';
import { TODAY_SQL, optionalEmail, optionalId, optionalText, requiredText } from '../crm/fields.js';

// Mounted at /api/companies (signed-in users). The registry itself is shared — everyone must be
// able to find an existing company — but the visits, tasks and requirements shown on a company
// are limited to what the user may see. A salesperson's new company waits for a manager's approval
// before a deal can be opened on it; rejected companies are kept but leave the search lists.
const router = Router();

const SIMILARITY_THRESHOLD = 0.4;
const PHONE_KEY_SQL = `right(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 10)`;

function companyFields(body, { partial }) {
  const fields = {
    name: partial && body.name === undefined ? undefined : requiredText(body, 'name', { max: 200 }),
    city: body.city === undefined && partial ? undefined : optionalText(body, 'city', { max: 100 }),
    address: body.address === undefined && partial ? undefined : optionalText(body, 'address', { max: 500 }),
    phone: body.phone === undefined && partial ? undefined : optionalText(body, 'phone', { max: 30 }),
    email: body.email === undefined && partial ? undefined : optionalEmail(body, 'email'),
    gstin: body.gstin === undefined && partial ? undefined : optionalText(body, 'gstin', { max: 20 }),
    category: body.category === undefined && partial ? undefined : optionalText(body, 'category', { max: 100 }),
    state: body.state === undefined && partial ? undefined : optionalText(body, 'state', { max: 100 }),
    contact_person: body.contact_person === undefined && partial ? undefined : optionalText(body, 'contact_person', { max: 120 }),
  };
  if (fields.gstin) fields.gstin = fields.gstin.toUpperCase();
  return fields;
}

// Possible duplicates of a company being created or renamed: similar normalized names, or the
// same phone number. `exact` is what the database also forbids: the same normalized name at the top
// level, or the same name and city under one parent. Rejected companies don't count: their name is
// free to be registered properly.
export async function findDuplicates({ name, phone, city = null, parentId = null, excludeId = null }) {
  const normalized = normalizeCompanyName(name);
  const phone10 = phoneKey(phone);
  const params = [normalized, normalized, SIMILARITY_THRESHOLD, phone10, phone10];
  let exclude = '';
  if (excludeId) {
    params.push(excludeId);
    exclude = 'AND c.id <> ?';
  }
  const rows = await db
    .prepare(
      `SELECT c.id, c.name, c.city, c.phone, c.normalized_name, c.parent_company_id, c.approval_status,
              round(similarity(c.normalized_name, ?)::numeric, 2)::float AS score
       FROM company c
       WHERE c.archived_at IS NULL AND c.approval_status <> 'rejected'
         AND (similarity(c.normalized_name, ?) >= ?
              OR (?::text IS NOT NULL AND ${PHONE_KEY_SQL} = ?))
         ${exclude}
       ORDER BY score DESC, c.name
       LIMIT 5`
    )
    .all(...params);
  const cityKey = (value) => (value ?? '').trim().toLowerCase();
  return rows.map(({ normalized_name, ...row }) => ({
    ...row,
    exact: normalized_name === normalized && row.parent_company_id === parentId && (!parentId || cityKey(row.city) === cityKey(city)),
    same_phone: phone10 !== null && phoneKey(row.phone) === phone10,
  }));
}

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const SUMMARY_COLUMNS = `c.id, c.name, c.city, c.state, c.phone, c.approval_status, c.rejection_reason, c.created_at, c.parent_company_id,
  (SELECT p.name FROM company p WHERE p.id = c.parent_company_id) AS parent_name`;

// Lists hide rejected companies unless asked for: ?approval=pending | approved | rejected.
function approvalFilter(value) {
  if (['pending', 'approved', 'rejected'].includes(value)) return { sql: ' AND c.approval_status = ?', params: [value] };
  return { sql: ` AND c.approval_status <> 'rejected'`, params: [] };
}

// Companies waiting for a decision, oldest first, with who added them.
router.get('/approvals', async (req, res) => {
  try {
    if (!isManaging(req.user)) throw new HttpError(403, 'Only a manager can approve companies.');
    res.json(
      await db
        .prepare(
          `SELECT ${SUMMARY_COLUMNS}, c.category, c.contact_person, c.address, u.username AS created_by_username
           FROM company c JOIN app_user u ON u.id = c.created_by
           WHERE c.archived_at IS NULL AND c.approval_status = 'pending' ORDER BY c.created_at`
        )
        .all()
    );
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/', async (req, res) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
    const approval = approvalFilter(req.query.approval);
    if (!q) {
      const rows = await db
        .prepare(`SELECT ${SUMMARY_COLUMNS} FROM company c WHERE c.archived_at IS NULL${approval.sql} ORDER BY c.name LIMIT ?`)
        .all(...approval.params, limit);
      return res.json(rows);
    }
    const normalized = normalizeCompanyName(q);
    const digits = q.replace(/\D/g, '');
    const rows = await db
      .prepare(
        `SELECT ${SUMMARY_COLUMNS}
         FROM company c
         WHERE c.archived_at IS NULL${approval.sql}
           AND (c.normalized_name % ? OR c.name ILIKE ? OR c.city ILIKE ?
                OR (length(?) >= 4 AND ${PHONE_KEY_SQL} LIKE ?))
         ORDER BY (c.name ILIKE ?) DESC, similarity(c.normalized_name, ?) DESC, c.name
         LIMIT ?`
      )
      .all(...approval.params, normalized, `%${escapeLike(q)}%`, `${escapeLike(q)}%`, digits, `%${digits}%`, `${escapeLike(q)}%`, normalized, limit);
    res.json(rows);
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/check-duplicates', async (req, res) => {
  try {
    const name = typeof req.query.name === 'string' ? req.query.name.trim() : '';
    if (!name) return res.json([]);
    res.json(
      await findDuplicates({
        name,
        phone: typeof req.query.phone === 'string' ? req.query.phone : null,
        city: typeof req.query.city === 'string' ? req.query.city : null,
        parentId: optionalId(req.query, 'parent_company_id'),
        excludeId: Number(req.query.exclude_id) || null,
      })
    );
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const company = await db
      .prepare(
        `SELECT c.*, u.username AS created_by_username, a.username AS approved_by_username
         FROM company c JOIN app_user u ON u.id = c.created_by LEFT JOIN app_user a ON a.id = c.approved_by
         WHERE c.id = ? AND c.archived_at IS NULL`
      )
      .get(id);
    if (!company) {
      // Someone may follow an old link to a company that was merged: say where it went.
      const merged = await db.prepare(`SELECT merged_into_company_id FROM company WHERE id = ? AND merged_into_company_id IS NOT NULL`).get(id);
      return res.status(404).json({ error: 'Company not found', merged_into_company_id: merged?.merged_into_company_id ?? null });
    }

    const parent = company.parent_company_id ? await db.prepare(`SELECT id, name, city FROM company WHERE id = ?`).get(company.parent_company_id) : null;
    const branchParams = [];
    const branchScope = scopeFilter(req.user, 'o.owner_salesperson_id', branchParams);
    const branches = await db
      .prepare(
        `SELECT b.id, b.name, b.city, b.approval_status,
                (SELECT COUNT(*)::int FROM opportunity o WHERE o.company_id = b.id AND o.stage NOT IN ('won', 'lost', 'abandoned')${branchScope}) AS open_deals,
                (SELECT COALESCE(SUM(o.estimated_value), 0)::float FROM opportunity o WHERE o.company_id = b.id AND o.stage NOT IN ('won', 'lost', 'abandoned')${branchScope}) AS pipeline_value
         FROM company b WHERE b.parent_company_id = ? AND b.archived_at IS NULL AND b.approval_status <> 'rejected' ORDER BY b.city, b.name`
      )
      .all(...branchParams, ...branchParams, id);

    const contacts = await db
      .prepare(
        `SELECT id, name, designation, phone, email, created_at FROM company_contact
         WHERE company_id = ? AND archived_at IS NULL ORDER BY name`
      )
      .all(id);

    const visitParams = [id];
    const visitScope = scopeFilter(req.user, 'v.salesperson_id', visitParams);
    const visits = await db
      .prepare(
        `SELECT v.id, v.visited_at, v.status, v.outcome, v.notes, sp.name AS salesperson_name, cc.name AS contact_name
         FROM visit v
         JOIN salesperson sp ON sp.id = v.salesperson_id
         LEFT JOIN company_contact cc ON cc.id = v.contact_id
         WHERE v.company_id = ?${visitScope}
         ORDER BY v.visited_at DESC LIMIT 50`
      )
      .all(...visitParams);

    const taskParams = [id];
    const taskScope = scopeFilter(req.user, 't.assignee_salesperson_id', taskParams);
    const tasks = await db
      .prepare(
        `SELECT t.id, t.title, t.task_type, t.due_date, t.priority, t.status, sp.name AS assignee_name
         FROM task t JOIN salesperson sp ON sp.id = t.assignee_salesperson_id
         WHERE t.company_id = ? AND t.status = 'open'${taskScope}
         ORDER BY t.due_date`
      )
      .all(...taskParams);

    const reqParams = [id];
    const reqScope = scopeFilter(req.user, 'r.salesperson_id', reqParams);
    const requirements = await db
      .prepare(
        `SELECT r.id, r.product_category, r.description, r.specification, r.quantity, r.unit, r.budget, r.urgency,
                r.purchase_timeline, r.decision_maker, r.created_at, r.visit_id, sp.name AS salesperson_name
         FROM requirement r JOIN salesperson sp ON sp.id = r.salesperson_id
         WHERE r.company_id = ?${reqScope}
         ORDER BY r.created_at DESC LIMIT 50`
      )
      .all(...reqParams);

    const oppParams = [id];
    const oppScope = scopeFilter(req.user, 'o.owner_salesperson_id', oppParams);
    const opportunities = await db
      .prepare(
        `SELECT o.id, o.title, o.stage, o.estimated_value, o.won_value, o.expected_close_date, o.closed_at, sp.name AS owner_name,
                (o.stage NOT IN ('won', 'lost', 'abandoned') AND o.expected_close_date < ${TODAY_SQL}) AS is_overdue
         FROM opportunity o JOIN salesperson sp ON sp.id = o.owner_salesperson_id
         WHERE o.company_id = ?${oppScope}
         ORDER BY (o.stage NOT IN ('won', 'lost', 'abandoned') AND o.expected_close_date < ${TODAY_SQL}) DESC,
                  (o.stage NOT IN ('won', 'lost', 'abandoned')) DESC, o.updated_at DESC`
      )
      .all(...oppParams);

    const logParams = [id];
    const logScope = scopeFilter(req.user, 'l.salesperson_id', logParams);
    const contactLog = await db
      .prepare(
        `SELECT l.id, l.channel, l.result, l.contact_name, l.phone, l.notes, l.created_at, sp.name AS salesperson_name
         FROM contact_log l JOIN salesperson sp ON sp.id = l.salesperson_id
         WHERE l.company_id = ?${logScope} ORDER BY l.created_at DESC, l.id DESC LIMIT 30`
      )
      .all(...logParams);

    res.json({ ...company, contact_log: contactLog, parent, branches, contacts, visits, tasks, requirements, opportunities });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/', requireCrmWriter, async (req, res) => {
  try {
    const fields = companyFields(req.body, { partial: false });
    const parentId = optionalId(req.body, 'parent_company_id');
    if (parentId) await assertValidParent(parentId);
    const duplicates = await findDuplicates({ ...fields, parentId });
    const exact = duplicates.find((d) => d.exact);
    if (exact) {
      return res.status(409).json({ error: `"${exact.name}"${exact.city ? ` in ${exact.city}` : ''} already exists. If this is another branch, register it as a branch.`, duplicates });
    }
    if (duplicates.length && req.body.confirm_new !== true) {
      return res.status(409).json({ error: 'Similar companies already exist. Use one of them, or confirm this is a new company.', duplicates, requires_confirmation: true });
    }
    const contact = req.body.contact && req.body.contact.name ? contactFields(req.body.contact) : null;
    if (contact?.phone) {
      const owner = await findContactByPhone(contact.phone);
      if (owner) throw new HttpError(409, phoneTakenMessage(owner, contact.phone));
    }
    // A manager's own entry needs no second opinion.
    const approved = isManaging(req.user);

    const created = await db.transaction(async () => {
      const info = await db
        .prepare(
          `INSERT INTO company (name, normalized_name, city, state, address, phone, email, contact_person, gstin, category, parent_company_id, approval_status, approved_by, approved_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ?::boolean THEN NOW() END, ?) RETURNING id`
        )
        .run(fields.name, normalizeCompanyName(fields.name), fields.city, fields.state, fields.address, fields.phone, fields.email, fields.contact_person, fields.gstin, fields.category, parentId, approved ? 'approved' : 'pending', approved ? req.user.id : null, approved, req.user.id);
      const companyId = info.lastInsertRowid;
      let contactId = null;
      if (contact) {
        contactId = await insertContact({ companyId, fields: contact, userId: req.user.id });
      }
      await recordAudit({
        actorUserId: req.user.id,
        action: 'company.created',
        entityType: 'company',
        entityId: companyId,
        summary: `Registered company ${fields.name}${fields.city ? ` (${fields.city})` : ''}${duplicates.length ? ' after confirming it is not a duplicate' : ''}${approved ? '' : ', waiting for approval'}`,
        after: { ...fields, contact },
      });
      const row = await db.prepare(`SELECT * FROM company WHERE id = ?`).get(companyId);
      return { ...row, primary_contact_id: contactId };
    });
    res.status(201).json(created);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: err.constraint === 'company_contact_phone_unique' ? 'That phone number already belongs to another contact.' : 'A company with this name already exists.' });
    sendError(res, err);
  }
});

// Approve or reject a company a salesperson added. Rejected companies are kept and marked.
async function decide(req, res, status) {
  try {
    if (!isManaging(req.user)) throw new HttpError(403, 'Only a manager can approve companies.');
    const id = Number(req.params.id);
    const company = await db.prepare(`SELECT id, name, approval_status FROM company WHERE id = ? AND archived_at IS NULL`).get(id);
    if (!company) throw new HttpError(404, 'Company not found');
    if (company.approval_status !== 'pending') throw new HttpError(409, `${company.name} is already ${company.approval_status}.`);
    const reason = status === 'rejected' ? requiredText(req.body, 'reason', { max: 500 }) : null;
    const updated = await db.transaction(async () => {
      await db
        .prepare(`UPDATE company SET approval_status = ?, approved_by = ?, approved_at = NOW(), rejection_reason = ?, updated_at = NOW() WHERE id = ?`)
        .run(status, req.user.id, reason, id);
      await recordAudit({
        actorUserId: req.user.id,
        action: status === 'approved' ? 'company.approved' : 'company.rejected',
        entityType: 'company',
        entityId: id,
        summary: status === 'approved' ? `Approved company ${company.name}` : `Rejected company ${company.name}: ${reason}`,
        before: { approval_status: company.approval_status },
        after: { approval_status: status, rejection_reason: reason },
      });
      return db.prepare(`SELECT * FROM company WHERE id = ?`).get(id);
    });
    res.json(updated);
  } catch (err) {
    sendError(res, err);
  }
}

// A duplicate's contacts, visits, follow-ups, requirements and deals all move to the company kept.
router.post('/:id/merge', requireCrmWriter, async (req, res) => {
  try {
    if (!isManaging(req.user)) throw new HttpError(403, 'Only a manager can merge companies.');
    const targetId = optionalId(req.body, 'into_company_id');
    if (!targetId) throw new HttpError(400, 'Choose the company to keep.');
    const reason = requiredText(req.body, 'reason', { max: 500 });
    res.json(await mergeCompanies({ sourceId: Number(req.params.id), targetId, reason, userId: req.user.id }));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Two branches would end up with the same name and city. Rename one first.' });
    sendError(res, err);
  }
});

router.post('/:id/approve', requireCrmWriter, (req, res) => decide(req, res, 'approved'));
router.post('/:id/reject', requireCrmWriter, (req, res) => decide(req, res, 'rejected'));

router.put('/:id', requireCrmWriter, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = await db.prepare(`SELECT * FROM company WHERE id = ? AND archived_at IS NULL`).get(id);
    if (!existing) return res.status(404).json({ error: 'Company not found' });
    const changes = companyFields(req.body, { partial: true });
    const merged = { ...existing };
    for (const [key, value] of Object.entries(changes)) if (value !== undefined) merged[key] = value;
    if (req.body.parent_company_id !== undefined) {
      if (!isManaging(req.user)) throw new HttpError(403, 'Only a manager can change a company’s parent.');
      merged.parent_company_id = optionalId(req.body, 'parent_company_id');
      if (merged.parent_company_id) await assertValidParent(merged.parent_company_id, { companyId: id });
    }

    const updated = await db.transaction(async () => {
      await db
        .prepare(
          `UPDATE company SET name = ?, normalized_name = ?, city = ?, state = ?, address = ?, phone = ?, email = ?, contact_person = ?, gstin = ?, category = ?, parent_company_id = ?, updated_at = NOW()
           WHERE id = ?`
        )
        .run(merged.name, normalizeCompanyName(merged.name), merged.city, merged.state, merged.address, merged.phone, merged.email, merged.contact_person, merged.gstin, merged.category, merged.parent_company_id, id);
      const pick = ({ name, city, state, address, phone, email, contact_person, gstin, category, parent_company_id }) => ({ name, city, state, address, phone, email, contact_person, gstin, category, parent_company_id });
      await recordAudit({
        actorUserId: req.user.id,
        action: 'company.updated',
        entityType: 'company',
        entityId: id,
        summary: `Updated company ${merged.name}`,
        before: pick(existing),
        after: pick(merged),
      });
      return db.prepare(`SELECT * FROM company WHERE id = ?`).get(id);
    });
    res.json(updated);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A company with this name already exists.' });
    sendError(res, err);
  }
});

router.post('/:id/contacts', requireCrmWriter, async (req, res) => {
  try {
    const companyId = Number(req.params.id);
    const company = await db.prepare(`SELECT id, name FROM company WHERE id = ? AND archived_at IS NULL`).get(companyId);
    if (!company) return res.status(404).json({ error: 'Company not found' });
    const fields = contactFields(req.body);
    const owner = await findContactByPhone(fields.phone);
    if (owner) throw new HttpError(409, phoneTakenMessage(owner, fields.phone));
    const created = await db.transaction(async () => {
      const contactId = await insertContact({ companyId, fields, userId: req.user.id });
      return db.prepare(`SELECT * FROM company_contact WHERE id = ?`).get(contactId);
    });
    res.status(201).json(created);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That phone number already belongs to another contact.' });
    sendError(res, err);
  }
});

export const contactsRouter = Router();

contactsRouter.put('/:id', requireCrmWriter, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = await db.prepare(`SELECT * FROM company_contact WHERE id = ? AND archived_at IS NULL`).get(id);
    if (!existing) return res.status(404).json({ error: 'Contact not found' });
    const fields = contactFields({ ...existing, ...req.body });
    const owner = await findContactByPhone(fields.phone, { excludeId: id });
    if (owner) throw new HttpError(409, phoneTakenMessage(owner, fields.phone));
    const updated = await db.transaction(async () => {
      await db
        .prepare(`UPDATE company_contact SET name = ?, designation = ?, phone = ?, email = ?, updated_at = NOW() WHERE id = ?`)
        .run(fields.name, fields.designation, fields.phone, fields.email, id);
      const pick = ({ name, designation, phone, email }) => ({ name, designation, phone, email });
      await recordAudit({
        actorUserId: req.user.id,
        action: 'contact.updated',
        entityType: 'company_contact',
        entityId: id,
        summary: `Updated contact ${fields.name}`,
        before: pick(existing),
        after: fields,
      });
      return db.prepare(`SELECT * FROM company_contact WHERE id = ?`).get(id);
    });
    res.json(updated);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That phone number already belongs to another contact.' });
    sendError(res, err);
  }
});

// Contacts who left the customer are archived, not deleted: past visits still name them.
contactsRouter.post('/:id/archive', requireCrmWriter, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = await db.prepare(`SELECT * FROM company_contact WHERE id = ? AND archived_at IS NULL`).get(id);
    if (!existing) return res.status(404).json({ error: 'Contact not found' });
    await db.transaction(async () => {
      await db.prepare(`UPDATE company_contact SET archived_at = NOW(), updated_at = NOW() WHERE id = ?`).run(id);
      await recordAudit({
        actorUserId: req.user.id,
        action: 'contact.archived',
        entityType: 'company_contact',
        entityId: id,
        summary: `Archived contact ${existing.name}`,
      });
    });
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
