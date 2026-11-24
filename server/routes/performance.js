import { Router } from 'express';
import { visibleSalespersonIds } from '../auth/roles.js';
import { sendError } from '../crm/access.js';
import { computeMetrics } from '../crm/metrics.js';
import { parsePeriod } from '../crm/period.js';

// Mounted at /api/performance. Salespeople get their own numbers; everyone else the team's, or
// one salesperson's with ?salesperson_id=. The side-by-side comparison is /api/team.
const router = Router();

const metricsCache = new Map();
const METRICS_TTL_MS = 30 * 1000;

router.get('/', async (req, res) => {
  try {
    const { from, to } = await parsePeriod(req.query);
    let salespersonIds = visibleSalespersonIds(req.user);
    if (req.query.salesperson_id) {
      const requested = Number(req.query.salesperson_id);
      // Asking for someone you can't see silently narrows to nothing visible.
      salespersonIds = salespersonIds === null || salespersonIds.includes(requested) ? [requested] : [];
    }
    const cacheKey = `${from}:${to}:${salespersonIds ? salespersonIds.join(',') : 'all'}`;
    const now = Date.now();
    const cached = metricsCache.get(cacheKey);
    if (cached && cached.expires > now) {
      return res.json(cached.data);
    }
    const result = await computeMetrics({ salespersonIds, from, to });
    metricsCache.set(cacheKey, { data: result, expires: now + METRICS_TTL_MS });
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
