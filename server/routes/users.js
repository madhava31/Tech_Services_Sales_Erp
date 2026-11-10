import { Router } from 'express';
import db from '../db/index.js';
import { ROLES, MANAGER_ROLES, isAdminRole } from '../auth/roles.js';
import { hashPassword, isAcceptablePassword, PASSWORD_RULE } from '../auth/password.js';
import { recordAudit } from '../audit/log.js';

// Mounted at /api/admin/users behind requireAuth + requireAdmin.
const router = Router();

// Accounts are never deleted (docs/architecture-plan.md): they are deactivated, which signs
// them out everywhere and keeps every record they created attributed to them. Every change here is
// written to audit_log in the same transaction as the change itself.

const USER_SELECT = `
  SELECT u.id, u.username, u.role, u.is_active, u.deactivated_at, u.salesperson_id,
         u.manager_user_id, u.created_at,
         sp.name AS salesperson_name, sp.employee_code AS salesperson_code,
         m.username AS manager_username
  FROM app_user u
  LEFT JOIN salesperson sp ON sp.id = u.salesperson_id
  LEFT JOIN app_user m ON m.id = u.manager_user_id`;

function loadUser(id) {
  return db.prepare(`${USER_SELECT} WHERE u.id = ?`).get(id);
}

// The fields audit_log records for a user (never password hashes).
function auditSnapshot(u) {
  return {
    username: u.username,
    role: u.role,
    is_active: u.is_active,
    salesperson_id: u.salesperson_id,
    manager_user_id: u.manager_user_id,
  };
}

async function otherActiveAdminCount(userId) {
  const row = await db
    .prepare(`SELECT COUNT(*) c FROM app_user WHERE is_active AND role IN ('admin', 'managing_director') AND id <> ?`)
    .get(userId);
  return Number(row.c);
}

function optionalId(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : NaN;
}

// Returns an error message, or null when the role/salesperson/manager combination is valid.
async function validateAssignment({ userId = null, role, salespersonId, managerUserId }) {
  if (!ROLES.includes(role)) return `Role must be one of: ${ROLES.join(', ')}`;
  if (Number.isNaN(salespersonId)) return 'salesperson_id must be a positive integer';
  if (Number.isNaN(managerUserId)) return 'manager_user_id must be a positive integer';
  if (role === 'salesperson' && !salespersonId) return 'A salesperson account must be linked to a salesperson record.';

  if (salespersonId) {
    const person = await db.prepare(`SELECT id, is_active FROM salesperson WHERE id = ?`).get(salespersonId);
    if (!person) return 'Salesperson record not found.';
    if (!person.is_active) return 'That salesperson record is inactive.';
  }
  if (managerUserId) {
    if (managerUserId === userId) return 'A user cannot be their own manager.';
    const manager = await db.prepare(`SELECT role, is_active FROM app_user WHERE id = ?`).get(managerUserId);
    if (!manager || !manager.is_active) return 'Manager not found or inactive.';
    if (!MANAGER_ROLES.includes(manager.role)) return 'Manager must be a sales manager, managing director or admin.';
  }
  return null;
}

function uniqueViolationMessage(err) {
  if (err.constraint === 'app_user_salesperson_unique') return 'That salesperson is already linked to another login.';
  return 'That username is already taken';
}

router.get('/', async (req, res) => {
  try {
    res.json(await db.prepare(`${USER_SELECT} ORDER BY u.is_active DESC, u.id`).all());
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !username.trim()) return res.status(400).json({ error: 'Username is required' });
    if (!isAcceptablePassword(password)) return res.status(400).json({ error: PASSWORD_RULE });
    const role = req.body.role;
    const salespersonId = optionalId(req.body.salesperson_id);
    const managerUserId = optionalId(req.body.manager_user_id);
    const invalid = await validateAssignment({ role, salespersonId, managerUserId });
    if (invalid) return res.status(400).json({ error: invalid });

    const { salt, hash } = hashPassword(password);
    const created = await db.transaction(async () => {
      const info = await db
        .prepare(
          `INSERT INTO app_user (username, password_hash, password_salt, role, salesperson_id, manager_user_id)
           VALUES (?, ?, ?, ?, ?, ?) RETURNING id`
        )
        .run(username.trim(), hash, salt, role, salespersonId, managerUserId);
      const user = await loadUser(info.lastInsertRowid);
      await recordAudit({
        actorUserId: req.user.id,
        action: 'user.created',
        entityType: 'app_user',
        entityId: user.id,
        summary: `Created ${role} account "${user.username}"`,
        after: auditSnapshot(user),
      });
      return user;
    });
    res.status(201).json(created);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: uniqueViolationMessage(err) });
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = await loadUser(id);
    if (!existing) return res.status(404).json({ error: 'User not found' });

    const role = req.body.role ?? existing.role;
    const salespersonId =
      req.body.salesperson_id !== undefined ? optionalId(req.body.salesperson_id) : existing.salesperson_id;
    const managerUserId =
      req.body.manager_user_id !== undefined ? optionalId(req.body.manager_user_id) : existing.manager_user_id;

    const invalid = await validateAssignment({ userId: id, role, salespersonId, managerUserId });
    if (invalid) return res.status(400).json({ error: invalid });

    const losesAdmin = isAdminRole(existing.role) && !isAdminRole(role);
    if (losesAdmin && id === req.user.id) return res.status(400).json({ error: 'You cannot remove your own admin access.' });
    if (losesAdmin && existing.is_active && (await otherActiveAdminCount(id)) === 0) {
      return res.status(400).json({ error: 'Cannot remove admin access from the last active administrator.' });
    }

    const updated = await db.transaction(async () => {
      await db
        .prepare(`UPDATE app_user SET role = ?, salesperson_id = ?, manager_user_id = ? WHERE id = ?`)
        .run(role, salespersonId, managerUserId, id);
      const user = await loadUser(id);
      await recordAudit({
        actorUserId: req.user.id,
        action: 'user.updated',
        entityType: 'app_user',
        entityId: id,
        summary: `Updated account "${user.username}"`,
        before: auditSnapshot(existing),
        after: auditSnapshot(user),
      });
      return user;
    });
    res.json(updated);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: uniqueViolationMessage(err) });
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.post('/:id/deactivate', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (id === req.user.id) return res.status(400).json({ error: 'You cannot deactivate your own account' });
    const existing = await loadUser(id);
    if (!existing) return res.status(404).json({ error: 'User not found' });
    if (!existing.is_active) return res.status(409).json({ error: 'This account is already deactivated' });
    if (isAdminRole(existing.role) && (await otherActiveAdminCount(id)) === 0) {
      return res.status(400).json({ error: 'Cannot deactivate the last active administrator' });
    }
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : '';

    const updated = await db.transaction(async () => {
      await db
        .prepare(`UPDATE app_user SET is_active = FALSE, deactivated_at = NOW(), deactivated_by = ? WHERE id = ?`)
        .run(req.user.id, id);
      await db.prepare(`DELETE FROM session WHERE user_id = ?`).run(id);
      const user = await loadUser(id);
      await recordAudit({
        actorUserId: req.user.id,
        action: 'user.deactivated',
        entityType: 'app_user',
        entityId: id,
        summary: `Deactivated account "${user.username}"${reason ? `: ${reason}` : ''}`,
        before: auditSnapshot(existing),
        after: auditSnapshot(user),
      });
      return user;
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.post('/:id/reactivate', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = await loadUser(id);
    if (!existing) return res.status(404).json({ error: 'User not found' });
    if (existing.is_active) return res.status(409).json({ error: 'This account is already active' });
    // The linked salesperson record or manager may have been deactivated in the meantime.
    const invalid = await validateAssignment({
      userId: id,
      role: existing.role,
      salespersonId: existing.salesperson_id,
      managerUserId: existing.manager_user_id,
    });
    if (invalid) return res.status(400).json({ error: `${invalid} Update the account before reactivating it.` });

    const updated = await db.transaction(async () => {
      await db
        .prepare(`UPDATE app_user SET is_active = TRUE, deactivated_at = NULL, deactivated_by = NULL WHERE id = ?`)
        .run(id);
      const user = await loadUser(id);
      await recordAudit({
        actorUserId: req.user.id,
        action: 'user.reactivated',
        entityType: 'app_user',
        entityId: id,
        summary: `Reactivated account "${user.username}"`,
        before: auditSnapshot(existing),
        after: auditSnapshot(user),
      });
      return user;
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.delete('/:id', (req, res) => {
  res.status(405).json({ error: 'User accounts cannot be deleted. Deactivate the account instead.' });
});

router.post('/:id/reset-password', async (req, res) => {
  try {
    const { password } = req.body;
    if (!isAcceptablePassword(password)) return res.status(400).json({ error: PASSWORD_RULE });

    const target = await loadUser(Number(req.params.id));
    if (!target) return res.status(404).json({ error: 'User not found' });

    const { salt, hash } = hashPassword(password);
    await db.transaction(async () => {
      await db.prepare(`UPDATE app_user SET password_hash = ?, password_salt = ? WHERE id = ?`).run(hash, salt, target.id);
      await db.prepare(`DELETE FROM session WHERE user_id = ?`).run(target.id);
      await recordAudit({
        actorUserId: req.user.id,
        action: 'user.password_reset',
        entityType: 'app_user',
        entityId: target.id,
        summary: `Reset password for "${target.username}"`,
      });
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

export default router;
