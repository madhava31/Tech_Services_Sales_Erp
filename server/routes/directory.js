import { Router } from 'express';
import db from '../db/index.js';
import { isManaging, scopeFilter, sendError } from '../crm/access.js';

// Mounted at /api/salespeople: active salespeople for pickers ("record on behalf of", "assign
// to"). Salespeople only get themselves. Managing the register is /api/admin/salespeople.
const router = Router();

// ?include_inactive=1 (managers, for handover) also lists people who have left.
router.get('/', async (req, res) => {
  try {
    const params = [];
    const scope = scopeFilter(req.user, 'sp.id', params);
    const includeInactive = req.query.include_inactive === '1' && isManaging(req.user);
    res.json(
      await db
        .prepare(
          `SELECT sp.id, sp.name, sp.employee_code, sp.is_active FROM salesperson sp
           WHERE ${includeInactive ? 'TRUE' : 'sp.is_active'}${scope} ORDER BY sp.is_active DESC, sp.name`
        )
        .all(...params)
    );
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
