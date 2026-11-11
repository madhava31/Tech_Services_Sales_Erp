import { Router } from 'express';
import db from '../db/index.js';
import { recordAudit } from '../audit/log.js';
import { HttpError, canSeeSalesperson, isManaging, requireCrmWriter, resolveOwner, scopeFilter, sendError } from '../crm/access.js';
import { liveCompany } from '../crm/companies.js';
import { TODAY_SQL, oneOf, optionalId, optionalText, requiredDate } from '../crm/fields.js';
import { PRIORITIES, TASK_CONTACT_JOIN, TASK_TYPES, insertTask, taskFields } from '../crm/tasks.js';
import { bulkIds } from './opportunities.js';

// Mounted at /api/tasks. Follow-ups stay open until done or cancelled; only managers move a task
// to another salesperson, and every move is audited.
const router = Router();

const TASK_SELECT = `
  SELECT t.id, t.company_id, c.name AS company_name, c.city AS company_city, t.visit_id, t.opportunity_id, tc.contact_name, tc.contact_phone,
         t.assignee_salesperson_id, sp.name AS assignee_name, t.task_type, t.title, t.due_date, t.priority,
         t.status, t.notes, t.outcome_notes, t.completed_at, t.created_at, t.updated_at,
         (t.status = 'open' AND t.due_date < ${TODAY_SQL}) AS is_overdue
  FROM task t
  JOIN company c ON c.id = t.company_id
  JOIN salesperson sp ON sp.id = t.assignee_salesperson_id${TASK_CONTACT_JOIN}`;

async function loadVisibleTask(user, id) {
  const task = await db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id);
  if (!task || !canSeeSalesperson(user, task.assignee_salesperson_id)) throw new HttpError(404, 'Task not found');
  return task;
}

router.get('/', async (req, res) => {
  try {
    const params = [];
    let where = 'WHERE TRUE';
    where += scopeFilter(req.user, 't.assignee_salesperson_id', params);
    const status = req.query.status ?? 'open';
    if (['open', 'done', 'cancelled'].includes(status)) {
      where += ' AND t.status = ?';
      params.push(status);
    }
    if (req.query.due === 'overdue') where += ` AND t.due_date < ${TODAY_SQL}`;
    else if (req.query.due === 'today') where += ` AND t.due_date = ${TODAY_SQL}`;
    else if (req.query.due === 'upcoming') where += ` AND t.due_date > ${TODAY_SQL}`;
    if (req.query.assignee_id) {
      where += ' AND t.assignee_salesperson_id = ?';
      params.push(Number(req.query.assignee_id));
    }
    if (req.query.company_id) {
      where += ' AND t.company_id = ?';
      params.push(Number(req.query.company_id));
    }
    params.push(Math.min(Math.max(Number(req.query.limit) || 100, 1), 300));
    const order = status === 'open' ? 't.due_date ASC, t.priority DESC, t.id' : 't.completed_at DESC, t.id DESC';
    res.json(await db.prepare(`${TASK_SELECT} ${where} ORDER BY ${order} LIMIT ?`).all(...params));
  } catch (err) {
    sendError(res, err);
  }
});

// One change to many follow-ups: a new date, marked done, or a new assignee. Same rules and records as
// changing one; one that can't change is reported and the rest go ahead.
router.post('/bulk', requireCrmWriter, async (req, res) => {
  try {
    const ids = bulkIds(req.body);
    const dueDate = req.body.due_date !== undefined ? requiredDate(req.body, 'due_date') : null;
    const complete = req.body.complete === true;
    const assigneeId = req.body.assignee_salesperson_id !== undefined ? optionalId(req.body, 'assignee_salesperson_id') : null;
    if ([dueDate, complete, assigneeId].filter(Boolean).length !== 1) throw new HttpError(400, 'Choose one change: a new date, done, or a new assignee.');
    if (assigneeId) {
      if (!isManaging(req.user)) throw new HttpError(403, 'Only a manager can reassign a task.');
      await resolveOwner(req.user, assigneeId);
    }
    const notes = optionalText(req.body, 'outcome_notes', { max: 2000 });
    const assignee = assigneeId ? await db.prepare(`SELECT name FROM salesperson WHERE id = ?`).get(assigneeId) : null;

    const result = await db.transaction(async () => {
      let updated = 0;
      const skipped = [];
      for (const id of ids) {
        const task = await loadVisibleTask(req.user, id).catch((err) => {
          if (err.status === 404) return null;
          throw err;
        });
        const skip = (why) => skipped.push({ id, title: task ? task.title : `#${id}`, reason: why });
        if (!task) skip('not found');
        else if (task.status !== 'open') skip('already closed');
        else if (dueDate) {
          await db.prepare(`UPDATE task SET due_date = ?, updated_at = NOW() WHERE id = ?`).run(dueDate, id);
          await recordAudit({ actorUserId: req.user.id, action: 'task.updated', entityType: 'task', entityId: id, summary: `Updated follow-up "${task.title}" (${task.company_name})`, before: { due_date: task.due_date }, after: { due_date: dueDate } });
          updated++;
        } else if (complete) {
          await db.prepare(`UPDATE task SET status = 'done', outcome_notes = ?, completed_at = NOW(), completed_by = ?, updated_at = NOW() WHERE id = ?`).run(notes, req.user.id, id);
          await recordAudit({ actorUserId: req.user.id, action: 'task.completed', entityType: 'task', entityId: id, summary: `Completed follow-up "${task.title}" (${task.company_name})${notes ? `: ${notes}` : ''}` });
          updated++;
        } else if (task.assignee_salesperson_id === assigneeId) skip('already theirs');
        else {
          await db.prepare(`UPDATE task SET assignee_salesperson_id = ?, updated_at = NOW() WHERE id = ?`).run(assigneeId, id);
          await recordAudit({
            actorUserId: req.user.id,
            action: 'task.reassigned',
            entityType: 'task',
            entityId: id,
            summary: `Moved "${task.title}" (${task.company_name}) from ${task.assignee_name} to ${assignee.name}`,
            before: { assignee_salesperson_id: task.assignee_salesperson_id },
            after: { assignee_salesperson_id: assigneeId },
          });
          updated++;
        }
      }
      return { updated, skipped };
    });
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

// What happened when they called or messaged. Reached finishes the follow-up, with an optional next
// one; no answer keeps it open on a later date.
router.post('/:id/log', requireCrmWriter, async (req, res) => {
  try {
    const task = await loadVisibleTask(req.user, Number(req.params.id));
    if (task.status !== 'open') throw new HttpError(409, `"${task.title}" is already ${task.status}.`);
    if (req.body.expected_updated_at && new Date(req.body.expected_updated_at).getTime() !== new Date(task.updated_at).getTime()) {
      throw new HttpError(409, `"${task.title}" was changed by someone else while you were offline. It is now due ${task.due_date}.`);
    }
    const channel = oneOf(req.body, 'channel', ['call', 'whatsapp']);
    const result = oneOf(req.body, 'result', ['reached', 'no_answer']);
    const notes = optionalText(req.body, 'notes', { max: 2000 });
    const chosenDate = req.body.next_due_date ? requiredDate(req.body, 'next_due_date') : null;
    const { d: tomorrow } = await db.prepare(`SELECT (${TODAY_SQL} + 1)::text AS d`).get();

    const nextTaskId = await db.transaction(async () => {
      await db
        .prepare(
          `INSERT INTO contact_log (company_id, opportunity_id, task_id, salesperson_id, channel, result, contact_name, phone, notes, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(task.company_id, task.opportunity_id, task.id, task.assignee_salesperson_id, channel, result, task.contact_name, task.contact_phone, notes, req.user.id);
      await recordAudit({
        actorUserId: req.user.id,
        action: 'contact.logged',
        entityType: 'task',
        entityId: task.id,
        summary: `${channel === 'call' ? 'Call' : 'WhatsApp'} to ${task.company_name}: ${result === 'reached' ? 'reached' : 'no answer'}${notes ? `. ${notes}` : ''}`,
      });
      if (result === 'no_answer') {
        await db.prepare(`UPDATE task SET due_date = ?, updated_at = NOW() WHERE id = ?`).run(chosenDate ?? tomorrow, task.id);
        return null;
      }
      await db.prepare(`UPDATE task SET status = 'done', outcome_notes = ?, completed_at = NOW(), completed_by = ?, updated_at = NOW() WHERE id = ? AND status = 'open'`).run(notes, req.user.id, task.id);
      await recordAudit({ actorUserId: req.user.id, action: 'task.completed', entityType: 'task', entityId: task.id, summary: `Completed follow-up "${task.title}" (${task.company_name})${notes ? `: ${notes}` : ''}` });
      if (!chosenDate) return null;
      const id = await insertTask({
        companyId: task.company_id,
        opportunityId: task.opportunity_id,
        assigneeId: task.assignee_salesperson_id,
        userId: req.user.id,
        fields: { task_type: 'call', title: `Follow up with ${task.company_name}`, due_date: chosenDate, priority: task.priority, notes: null },
      });
      await recordAudit({ actorUserId: req.user.id, action: 'task.created', entityType: 'task', entityId: id, summary: `Added follow-up after a ${channel === 'call' ? 'call' : 'message'}, due ${chosenDate}` });
      return id;
    });
    res.json({ task: await loadVisibleTask(req.user, task.id), next_task: nextTaskId ? await loadVisibleTask(req.user, nextTaskId) : null });
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/:id', async (req, res) => {
  try {
    res.json(await loadVisibleTask(req.user, Number(req.params.id)));
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/', requireCrmWriter, async (req, res) => {
  try {
    const requestedCompanyId = optionalId(req.body, 'company_id');
    if (!requestedCompanyId) throw new HttpError(400, 'company_id is required');
    const company = await liveCompany(requestedCompanyId);
    if (!company) throw new HttpError(400, 'Company not found.');
    const companyId = company.id;
    const assigneeId = await resolveOwner(req.user, req.body.assignee_salesperson_id);
    const fields = taskFields(req.body);
    const id = await db.transaction(async () => {
      const newId = await insertTask({ companyId, assigneeId, userId: req.user.id, fields });
      await recordAudit({ actorUserId: req.user.id, action: 'task.created', entityType: 'task', entityId: newId, summary: `Added follow-up "${fields.title}", due ${fields.due_date}`, after: fields });
      return newId;
    });
    res.status(201).json(await loadVisibleTask(req.user, id));
  } catch (err) {
    sendError(res, err);
  }
});

// Reschedule or edit. Changing the assignee is a manager action and is audited.
router.put('/:id', requireCrmWriter, async (req, res) => {
  try {
    const task = await loadVisibleTask(req.user, Number(req.params.id));
    if (task.status !== 'open') throw new HttpError(409, 'Only open tasks can be changed.');
    // A change made offline says which version it was made from, so it can't silently overwrite
    // something a manager changed in the meantime.
    if (req.body.expected_updated_at && new Date(req.body.expected_updated_at).getTime() !== new Date(task.updated_at).getTime()) {
      throw new HttpError(409, `"${task.title}" was changed by someone else while you were offline. It is now due ${task.due_date}.`);
    }
    const next = {
      title: req.body.title !== undefined ? optionalText(req.body, 'title', { max: 200 }) : task.title,
      due_date: req.body.due_date !== undefined ? requiredDate(req.body, 'due_date') : task.due_date,
      task_type: req.body.task_type !== undefined ? oneOf(req.body, 'task_type', TASK_TYPES) : task.task_type,
      priority: req.body.priority !== undefined ? oneOf(req.body, 'priority', PRIORITIES) : task.priority,
      notes: req.body.notes !== undefined ? optionalText(req.body, 'notes', { max: 2000 }) : task.notes,
      assignee: task.assignee_salesperson_id,
    };
    if (!next.title) throw new HttpError(400, 'title is required');
    const requestedAssignee = optionalId(req.body, 'assignee_salesperson_id');
    if (requestedAssignee && requestedAssignee !== task.assignee_salesperson_id) {
      if (!isManaging(req.user)) throw new HttpError(403, 'Only a manager can reassign a task.');
      next.assignee = await resolveOwner(req.user, requestedAssignee);
    }

    await db.transaction(async () => {
      await db
        .prepare(
          `UPDATE task SET title = ?, due_date = ?, task_type = ?, priority = ?, notes = ?, assignee_salesperson_id = ?, updated_at = NOW()
           WHERE id = ? AND status = 'open'`
        )
        .run(next.title, next.due_date, next.task_type, next.priority, next.notes, next.assignee, task.id);
      const pick = ({ title, due_date, task_type, priority, notes }) => ({ title, due_date, task_type, priority, notes });
      if (JSON.stringify(pick(task)) !== JSON.stringify(pick(next))) {
        await recordAudit({
          actorUserId: req.user.id,
          action: 'task.updated',
          entityType: 'task',
          entityId: task.id,
          summary: `Updated follow-up "${next.title}" (${task.company_name})`,
          before: pick(task),
          after: pick(next),
        });
      }
      if (next.assignee !== task.assignee_salesperson_id) {
        const to = await db.prepare(`SELECT name FROM salesperson WHERE id = ?`).get(next.assignee);
        await recordAudit({
          actorUserId: req.user.id,
          action: 'task.reassigned',
          entityType: 'task',
          entityId: task.id,
          summary: `Moved "${task.title}" (${task.company_name}) from ${task.assignee_name} to ${to.name}`,
          before: { assignee_salesperson_id: task.assignee_salesperson_id },
          after: { assignee_salesperson_id: next.assignee },
        });
      }
    });
    res.json(await loadVisibleTask(req.user, task.id));
  } catch (err) {
    sendError(res, err);
  }
});

async function close(req, res, status) {
  try {
    const task = await loadVisibleTask(req.user, Number(req.params.id));
    if (task.status !== 'open') throw new HttpError(409, `This task is already ${task.status}.`);
    const outcomeNotes = optionalText(req.body, status === 'done' ? 'outcome_notes' : 'reason', { max: 2000 });
    if (status === 'cancelled' && !outcomeNotes) throw new HttpError(400, 'Say why the task is being cancelled (reason).');
    await db.transaction(async () => {
      const done = await db
        .prepare(
          `UPDATE task SET status = ?, outcome_notes = ?, completed_at = NOW(), completed_by = ?, updated_at = NOW()
           WHERE id = ? AND status = 'open'`
        )
        .run(status, outcomeNotes, req.user.id, task.id);
      if (done.changes !== 1) throw new HttpError(409, 'This task was already closed.');
      await recordAudit({
        actorUserId: req.user.id,
        action: status === 'done' ? 'task.completed' : 'task.cancelled',
        entityType: 'task',
        entityId: task.id,
        summary: `${status === 'done' ? 'Completed' : 'Cancelled'} follow-up "${task.title}" (${task.company_name})${outcomeNotes ? `: ${outcomeNotes}` : ''}`,
      });
    });
    res.json(await loadVisibleTask(req.user, task.id));
  } catch (err) {
    sendError(res, err);
  }
}

router.post('/:id/complete', requireCrmWriter, (req, res) => close(req, res, 'done'));
router.post('/:id/cancel', requireCrmWriter, (req, res) => close(req, res, 'cancelled'));

export default router;
