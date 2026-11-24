import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import db from './db/index.js';

import { requireAuth, requireAdmin } from './auth/middleware.js';
import { ensureServiceReportSchema } from './db/serviceReportSchema.js';
import { ensureOtherOemSchema } from './db/otherOemSchema.js';
import cronRouter from './routes/cron.js';
import authRouter from './routes/auth.js';
import serviceReportsRouter from './routes/serviceReports.js';
import passwordOtpRouter from './routes/passwordOtp.js';
import usersRouter from './routes/users.js';
import salespeopleRouter from './routes/salespeople.js';
import auditRouter from './routes/audit.js';
import companyDeletionsRouter from './routes/companyDeletions.js';
import companiesRouter, { contactsRouter } from './routes/companies.js';
import visitsRouter from './routes/visits.js';
import tasksRouter from './routes/tasks.js';
import requirementsRouter from './routes/requirements.js';
import todayRouter from './routes/today.js';
import directoryRouter from './routes/directory.js';
import opportunitiesRouter, { quotationLinksRouter } from './routes/opportunities.js';
import performanceRouter from './routes/performance.js';
import teamRouter from './routes/team.js';
import handoverRouter from './routes/handover.js';
import { oemsRouter, productsRouter, segmentsRouter } from './routes/catalogue.js';
import analysisRouter from './routes/analysis.js';
import searchRouter from './routes/search.js';
import erpSyncRouter from './routes/erpSync.js';
import importRouter from './routes/import.js';
import reportsRouter from './routes/reports.js';
import { installedRouter, reordersRouter } from './routes/repeat.js';
import tendersRouter from './routes/tenders.js';
import notificationsRouter from './routes/notifications.js';
import offlineRouter from './routes/offline.js';
import { idempotency } from './crm/idempotency.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.set('trust proxy', 1);

// Same-origin by default: no CORS headers are sent. CLIENT_ORIGIN (comma-separated) allow-lists
// other origins, with credentials, only if the web app is ever served from a different domain.
function allowedOrigins() {
  return (process.env.CLIENT_ORIGIN || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

app.use(
  cors({
    origin: (origin, callback) => callback(null, Boolean(origin) && allowedOrigins().includes(origin)),
    credentials: true,
  })
);
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// Support /api/... paths rewritten on serverless platforms (Vercel)
app.use((req, res, next) => {
  if (req.query && req.query.slug) {
    delete req.query.slug;
  }
  if (req.query && req.query.__path !== undefined) {
    let sub = String(req.query.__path || '');
    delete req.query.__path;
    if (sub.startsWith('/')) sub = sub.slice(1);
    const searchParams = new URLSearchParams(req.query).toString();
    req.url = '/api/' + sub + (searchParams ? '?' + searchParams : '');
  } else if (req.headers['x-forwarded-uri'] && req.headers['x-forwarded-uri'].startsWith('/api')) {
    req.url = req.headers['x-forwarded-uri'];
  } else if (req.headers['x-matched-path'] && req.headers['x-matched-path'].startsWith('/api')) {
    req.url = req.headers['x-matched-path'];
  } else if (!req.url.startsWith('/api') && !req.url.startsWith('/favicon.ico')) {
    req.url = '/api' + (req.url.startsWith('/') ? req.url : '/' + req.url);
  }
  next();
});

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'private, no-store');
  next();
});

app.get('/api/health', async (req, res) => {
  let dbOk = false;
  try {
    const row = await db.prepare('SELECT 1 as connected').get();
    dbOk = Boolean(row?.connected);
  } catch (err) {
    // The reason goes to the server log (Vercel → Logs), not to whoever opens this page.
    console.error('Health check: database not reachable:', err.message);
  }
  res.json({ ok: true, database: dbOk });
});

// Scheduled jobs on Vercel, signed with CRON_SECRET rather than a login.
app.use('/api/cron', cronRouter);

app.use('/api/auth', authRouter);
app.use('/api/auth', passwordOtpRouter);

// Everything below requires a signed-in, active user. Each router then checks the role.
app.use('/api', requireAuth);
app.use('/api', idempotency);
app.use('/api/admin/users', requireAdmin, usersRouter);
app.use('/api/admin/salespeople', requireAdmin, salespeopleRouter);
app.use('/api/admin/audit', requireAdmin, auditRouter);
app.use('/api/admin/import', requireAdmin, importRouter);
app.use('/api/admin/erp', requireAdmin, erpSyncRouter);
app.use('/api/companies', companyDeletionsRouter);

app.post('/api/admin/clean-demo', requireAdmin, async (req, res) => {
  const pool = db.pool;
  let step = '';
  try {
    step = 'auto_followup';
    await pool.query(`DELETE FROM auto_followup WHERE task_id IN (SELECT id FROM task WHERE company_id IN (SELECT id FROM company WHERE category LIKE '%(Demo)'))`);

    step = 'contact_log';
    await pool.query(`DELETE FROM contact_log WHERE company_id IN (SELECT id FROM company WHERE category LIKE '%(Demo)')`);

    step = 'installed_instrument';
    await pool.query(`DELETE FROM installed_instrument WHERE company_id IN (SELECT id FROM company WHERE category LIKE '%(Demo)')`);

    step = 'reorder_plan';
    await pool.query(`DELETE FROM reorder_plan WHERE company_id IN (SELECT id FROM company WHERE category LIKE '%(Demo)')`);

    step = 'tender';
    await pool.query(`DELETE FROM tender WHERE opportunity_id IN (SELECT id FROM opportunity WHERE company_id IN (SELECT id FROM company WHERE category LIKE '%(Demo)'))`);

    step = 'quotation_link';
    await pool.query(`DELETE FROM quotation_link WHERE opportunity_id IN (SELECT id FROM opportunity WHERE company_id IN (SELECT id FROM company WHERE category LIKE '%(Demo)'))`);

    step = 'opportunity_product';
    await pool.query(`DELETE FROM opportunity_product WHERE opportunity_id IN (SELECT id FROM opportunity WHERE company_id IN (SELECT id FROM company WHERE category LIKE '%(Demo)'))`);

    step = 'opportunity_segment';
    await pool.query(`DELETE FROM opportunity_segment WHERE opportunity_id IN (SELECT id FROM opportunity WHERE company_id IN (SELECT id FROM company WHERE category LIKE '%(Demo)'))`);

    step = 'opportunity_history';
    await pool.query(`DELETE FROM opportunity_history WHERE opportunity_id IN (SELECT id FROM opportunity WHERE company_id IN (SELECT id FROM company WHERE category LIKE '%(Demo)'))`);

    step = 'task';
    await pool.query(`DELETE FROM task WHERE company_id IN (SELECT id FROM company WHERE category LIKE '%(Demo)') OR opportunity_id IN (SELECT id FROM opportunity WHERE company_id IN (SELECT id FROM company WHERE category LIKE '%(Demo)'))`);

    step = 'requirement';
    await pool.query(`DELETE FROM requirement WHERE company_id IN (SELECT id FROM company WHERE category LIKE '%(Demo)')`);

    step = 'unlink_visit_opp';
    await pool.query(`UPDATE visit SET opportunity_id = NULL WHERE company_id IN (SELECT id FROM company WHERE category LIKE '%(Demo)')`);

    step = 'opportunity';
    await pool.query(`DELETE FROM opportunity WHERE company_id IN (SELECT id FROM company WHERE category LIKE '%(Demo)')`);

    step = 'visit';
    await pool.query(`DELETE FROM visit WHERE company_id IN (SELECT id FROM company WHERE category LIKE '%(Demo)')`);

    step = 'company_contact';
    await pool.query(`DELETE FROM company_contact WHERE company_id IN (SELECT id FROM company WHERE category LIKE '%(Demo)')`);

    step = 'unlink_company_parents';
    await pool.query(`UPDATE company SET parent_company_id = NULL, merged_into_company_id = NULL WHERE category LIKE '%(Demo)'`);

    step = 'company';
    const cRes = await pool.query(`DELETE FROM company WHERE category LIKE '%(Demo)'`);

    step = 'salesperson';
    await pool.query(`DELETE FROM salesperson WHERE employee_code IN ('SE-001', 'SE-002', 'SE-003', 'SE-004', 'SE-005') AND id NOT IN (SELECT salesperson_id FROM app_user WHERE salesperson_id IS NOT NULL)`);

    step = 'product';
    await pool.query(`DELETE FROM product WHERE part_number LIKE 'DEMO-%'`);

    if (req.body?.cleanUserTests) {
      step = 'cleanUserTests_auto_followup';
      await pool.query(`DELETE FROM auto_followup`);
      step = 'cleanUserTests_contact_log';
      await pool.query(`DELETE FROM contact_log`);
      step = 'cleanUserTests_installed_instrument';
      await pool.query(`DELETE FROM installed_instrument`);
      step = 'cleanUserTests_reorder_plan';
      await pool.query(`DELETE FROM reorder_plan`);
      step = 'cleanUserTests_unlink_visit';
      await pool.query(`UPDATE visit SET opportunity_id = NULL`);
      step = 'cleanUserTests_task';
      await pool.query(`DELETE FROM task`);
      step = 'cleanUserTests_requirement';
      await pool.query(`DELETE FROM requirement`);
      step = 'cleanUserTests_quotation_link';
      await pool.query(`DELETE FROM quotation_link`);
      step = 'cleanUserTests_tender';
      await pool.query(`DELETE FROM tender`);
      step = 'cleanUserTests_opportunity_product';
      await pool.query(`DELETE FROM opportunity_product`);
      step = 'cleanUserTests_opportunity_segment';
      await pool.query(`DELETE FROM opportunity_segment`);
      step = 'cleanUserTests_opportunity_history';
      await pool.query(`DELETE FROM opportunity_history`);
      step = 'cleanUserTests_opportunity';
      await pool.query(`DELETE FROM opportunity`);
      step = 'cleanUserTests_visit';
      await pool.query(`DELETE FROM visit`);
      step = 'cleanUserTests_company_contact';
      await pool.query(`DELETE FROM company_contact`);
      step = 'cleanUserTests_unlink_company';
      await pool.query(`UPDATE company SET parent_company_id = NULL, merged_into_company_id = NULL`);
      step = 'cleanUserTests_company';
      await pool.query(`DELETE FROM company`);
    }

    res.json({ ok: true, step: 'done', deletedDemoCompanies: cRes.rowCount });
  } catch (err) {
    console.error(`Failed at step "${step}":`, err);
    res.status(500).json({ error: err.message, step });
  }
});

app.post('/api/admin/migrate', requireAdmin, async (req, res) => {
  try {
    await ensureServiceReportSchema(db.pool);
    await ensureOtherOemSchema(db.pool);
    res.json({ ok: true, message: 'All migrations up to 0024 ensured successfully.' });
  } catch (err) {
    console.error('Migration error:', err);
    res.status(500).json({ error: err.message });
  }
});
app.use('/api/companies', companiesRouter);
app.use('/api/contacts', contactsRouter);
app.use('/api/visits', visitsRouter);
app.use('/api/service-reports', serviceReportsRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/requirements', requirementsRouter);
app.use('/api/today', todayRouter);
app.use('/api/salespeople', directoryRouter);
app.use('/api/opportunities', opportunitiesRouter);
app.use('/api/quotation-links', quotationLinksRouter);
app.use('/api/performance', performanceRouter);
app.use('/api/team', teamRouter);
app.use('/api/handover', handoverRouter);
app.use('/api/products', productsRouter);
app.use('/api/oems', oemsRouter);
app.use('/api/market-segments', segmentsRouter);
app.use('/api/analysis', analysisRouter);
app.use('/api/search', searchRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/tenders', tendersRouter);
app.use('/api/installed-base', installedRouter);
app.use('/api/reorders', reordersRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/offline', offlineRouter);

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Production: serve the built web app (npm run build) from the same origin as the API, with
// client-side routes falling back to index.html.
const webDist = path.resolve(__dirname, '../web/dist');
if (process.env.NODE_ENV === 'production' && fs.existsSync(webDist)) {
  app.use(
    express.static(webDist, {
      index: false,
      maxAge: '1h',
      // Phones must always find out about a new version of the app.
      setHeaders(res, filePath) {
        if (/(sw\.js|manifest\.webmanifest)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
      },
    })
  );
  // /api/* never reaches here: the 404 handler above answers it.
  app.get('*', (req, res) => res.sendFile(path.join(webDist, 'index.html')));
}

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That file is too large. The limit is 6 MB.' });
  console.error('Unhandled API error:', err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

export default app;
