import db from '../db/index.js';
import { oneOf, optionalText, requiredDate, requiredText } from './fields.js';

// The best number to reach someone about a follow-up, for queries where the task is aliased `t`: the
// deal's contact, then the visit's, then the instrument's or reorder's, then anyone at the company,
// then the company's own line.
export const TASK_CONTACT_JOIN = `
  LEFT JOIN LATERAL (
    SELECT x.name AS contact_name, x.phone AS contact_phone FROM (
      SELECT cc.name, cc.phone, 1 AS rank FROM opportunity o JOIN company_contact cc ON cc.id = o.contact_id
        WHERE o.id = t.opportunity_id AND cc.phone IS NOT NULL AND cc.archived_at IS NULL
      UNION ALL
      SELECT cc.name, cc.phone, 2 FROM visit v JOIN company_contact cc ON cc.id = v.contact_id
        WHERE v.id = t.visit_id AND cc.phone IS NOT NULL AND cc.archived_at IS NULL
      UNION ALL
      SELECT cc.name, cc.phone, 3 FROM auto_followup a JOIN installed_instrument i ON i.id = a.ref_id JOIN company_contact cc ON cc.id = i.contact_id
        WHERE a.task_id = t.id AND a.kind IN ('warranty', 'amc') AND cc.phone IS NOT NULL AND cc.archived_at IS NULL
      UNION ALL
      SELECT cc.name, cc.phone, 3 FROM auto_followup a JOIN reorder_plan r ON r.id = a.ref_id JOIN company_contact cc ON cc.id = r.contact_id
        WHERE a.task_id = t.id AND a.kind = 'reorder' AND cc.phone IS NOT NULL AND cc.archived_at IS NULL
      UNION ALL
      (SELECT cc.name, cc.phone, 4 FROM company_contact cc
        WHERE cc.company_id = t.company_id AND cc.phone IS NOT NULL AND cc.archived_at IS NULL ORDER BY cc.id LIMIT 1)
      UNION ALL
      SELECT NULL, co.phone, 5 FROM company co WHERE co.id = t.company_id AND co.phone IS NOT NULL
    ) x ORDER BY x.rank LIMIT 1
  ) tc ON TRUE`;

export const TASK_TYPES = ['call', 'visit', 'demo', 'technical_discussion', 'send_quotation', 'renewal', 'reorder', 'other'];
export const PRIORITIES = ['normal', 'high'];

export function taskFields(body, { defaultType = 'call' } = {}) {
  return {
    task_type: oneOf(body, 'task_type', TASK_TYPES, defaultType),
    title: requiredText(body, 'title', { max: 200 }),
    due_date: requiredDate(body, 'due_date'),
    priority: oneOf(body, 'priority', PRIORITIES, 'normal'),
    notes: optionalText(body, 'notes', { max: 2000 }),
  };
}

// Inserts inside the caller's transaction.
export async function insertTask({ companyId, visitId = null, opportunityId = null, assigneeId, userId, fields }) {
  const info = await db
    .prepare(
      `INSERT INTO task (company_id, visit_id, opportunity_id, assignee_salesperson_id, task_type, title, due_date, priority, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    )
    .run(companyId, visitId, opportunityId, assigneeId, fields.task_type, fields.title, fields.due_date, fields.priority, fields.notes, userId);
  return info.lastInsertRowid;
}
