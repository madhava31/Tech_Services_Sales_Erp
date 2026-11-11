import { Router } from 'express';
import { visibleSalespersonIds } from '../auth/roles.js';
import { sendError } from '../crm/access.js';
import { computeMetrics } from '../crm/metrics.js';
import { parsePeriod } from '../crm/period.js';

// Mounted at /api/performance. Salespeople get their own numbers; everyone else the team's, or
// one salesperson's with ?salesperson_id=. The side-by-side comparison is /api/team.
const router = Router();

router.get('/', async (req, res) => {
  try {
    const { from, to } = await parsePeriod(req.query);
    let salespersonIds = visibleSalespersonIds(req.user);
    if (req.query.salesperson_id) {
      const requested = Number(req.query.salesperson_id);
      // Asking for someone you can't see silently narrows to nothing visible.
      salespersonIds = salespersonIds === null || salespersonIds.includes(requested) ? [requested] : [];
    }
    res.json(await computeMetrics({ salespersonIds, from, to }));
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
