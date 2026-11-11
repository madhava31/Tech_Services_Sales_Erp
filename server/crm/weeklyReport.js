import nodemailer from 'nodemailer';
import db from '../db/index.js';
import { recordAudit } from '../audit/log.js';
import { TODAY_SQL } from './fields.js';
import { computeMetrics } from './metrics.js';
import { DAYS_IN_STAGE_SQL, STUCK_SQL } from './stuck.js';

// The Monday report for management: last week's results, where the pipeline stands, and what needs
// attention this week. Kept in the app for everyone with the team view, and emailed if email is set up.

const OPEN = `o.stage NOT IN ('won', 'lost', 'abandoned')`;
const TOP = 5;

// The last finished week, Monday to Sunday, India time.
export async function lastFinishedWeek() {
  return db
    .prepare(
      `SELECT (date_trunc('week', ${TODAY_SQL}::timestamp) - interval '7 days')::date::text AS from_date,
              (date_trunc('week', ${TODAY_SQL}::timestamp) - interval '1 day')::date::text AS to_date,
              (date_trunc('week', ${TODAY_SQL}::timestamp) - interval '14 days')::date::text AS prev_from,
              (date_trunc('week', ${TODAY_SQL}::timestamp) - interval '8 days')::date::text AS prev_to`
    )
    .get();
}

export async function buildReportData({ from_date: from, to_date: to, prev_from: prevFrom, prev_to: prevTo }) {
  const totals = await computeMetrics({ salespersonIds: null, from, to });
  const previous = await computeMetrics({ salespersonIds: null, from: prevFrom, to: prevTo });
  const people = await db.prepare(`SELECT id, name FROM salesperson WHERE is_active ORDER BY name`).all();
  const salespeople = [];
  for (const p of people) {
    const m = await computeMetrics({ salespersonIds: [p.id], from, to });
    salespeople.push({
      id: p.id,
      name: p.name,
      visits: m.visits,
      deals_won: m.deals_won,
      won_value: m.won_value,
      open_deals: m.open_deals,
      pipeline_value: m.pipeline_value,
      overdue_deals: m.overdue_deals,
      stuck_deals: m.stuck_deals,
      overdue_follow_ups: m.overdue_follow_ups,
    });
  }

  const wins = await db
    .prepare(
      `SELECT o.id, o.title, c.name AS company_name, sp.name AS owner_name, o.won_value AS value
       FROM opportunity o JOIN company c ON c.id = o.company_id JOIN salesperson sp ON sp.id = o.owner_salesperson_id
       WHERE o.stage = 'won' AND o.closed_at >= (?::date::timestamp AT TIME ZONE 'Asia/Kolkata') AND o.closed_at < ((?::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')
       ORDER BY o.won_value DESC LIMIT ${TOP}`
    )
    .all(from, to);
  const closing = await db
    .prepare(
      `SELECT o.id, o.title, c.name AS company_name, sp.name AS owner_name, o.estimated_value AS value, o.probability, o.expected_close_date::text AS date
       FROM opportunity o JOIN company c ON c.id = o.company_id JOIN salesperson sp ON sp.id = o.owner_salesperson_id
       WHERE ${OPEN} AND o.expected_close_date BETWEEN ${TODAY_SQL} AND ${TODAY_SQL} + 7
       ORDER BY o.estimated_value DESC NULLS LAST LIMIT ${TOP}`
    )
    .all();
  const atRisk = await db
    .prepare(
      `SELECT o.id, o.title, c.name AS company_name, sp.name AS owner_name, o.estimated_value AS value, o.expected_close_date::text AS date,
              (o.expected_close_date < ${TODAY_SQL}) AS is_overdue, ${STUCK_SQL} AS is_stuck, ${DAYS_IN_STAGE_SQL} AS days_in_stage
       FROM opportunity o JOIN company c ON c.id = o.company_id JOIN salesperson sp ON sp.id = o.owner_salesperson_id
       WHERE ${OPEN} AND (o.expected_close_date < ${TODAY_SQL} OR ${STUCK_SQL})
       ORDER BY o.estimated_value DESC NULLS LAST LIMIT ${TOP}`
    )
    .all();
  const tenders = await db
    .prepare(
      `SELECT t.opportunity_id AS id, o.title, t.tender_number, c.name AS company_name, sp.name AS owner_name, t.bid_due_date::text AS date
       FROM tender t JOIN opportunity o ON o.id = t.opportunity_id JOIN company c ON c.id = o.company_id JOIN salesperson sp ON sp.id = o.owner_salesperson_id
       WHERE o.tender AND o.closed_at IS NULL AND t.bid_status = 'preparing' AND t.bid_due_date <= ${TODAY_SQL} + 7
       ORDER BY t.bid_due_date LIMIT 10`
    )
    .all();
  const counts = await db
    .prepare(
      `SELECT (SELECT COUNT(*)::int FROM company WHERE archived_at IS NULL AND approval_status = 'pending') AS companies_pending,
              (SELECT COALESCE(SUM(t.emd_amount), 0)::float FROM tender t JOIN opportunity o ON o.id = t.opportunity_id
               WHERE o.tender AND t.emd_status = 'paid' AND (t.bid_status IN ('won', 'lost', 'cancelled') OR o.closed_at IS NOT NULL)) AS emd_to_recover,
              (SELECT COUNT(*)::int FROM installed_instrument i CROSS JOIN LATERAL (VALUES (i.warranty_end_date), (i.amc_end_date)) AS e(d)
               WHERE i.is_active AND e.d BETWEEN ${TODAY_SQL} AND ${TODAY_SQL} + 30) AS renewals_30_days`
    )
    .get();
  const forecast = await db
    .prepare(
      `SELECT COALESCE(SUM(o.estimated_value) FILTER (WHERE o.probability >= 75), 0)::float AS commit,
              COALESCE(SUM(o.estimated_value) FILTER (WHERE o.probability = 50), 0)::float AS best_case,
              COALESCE(SUM(o.estimated_value) FILTER (WHERE o.probability < 50), 0)::float AS pipeline
       FROM opportunity o
       WHERE ${OPEN} AND o.expected_close_date >= ${TODAY_SQL}
         AND date_trunc('month', o.expected_close_date) = date_trunc('month', ${TODAY_SQL}::timestamp)`
    )
    .get();

  return { totals, previous, salespeople, wins, closing, at_risk: atRisk, tenders, forecast_this_month: forecast, ...counts };
}

// ---------- email ----------

function emailConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.MAIL_FROM);
}

async function sendWithSmtp(message) {
  const port = Number(process.env.SMTP_PORT) || 587;
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  await transport.sendMail({ from: process.env.MAIL_FROM, ...message });
}

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function money(value) {
  const n = Number(value) || 0;
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(1)} L`;
  return `₹${n.toLocaleString('en-IN')}`;
}

const dayMonth = (date) => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });

// Plain tables with inline styles: mail apps ignore most other styling. Everything from the database
// is escaped, because customer and deal names are typed by people.
export function reportEmail(report) {
  const d = report.data;
  const t = d.totals;
  const cell = 'padding:6px 10px;border-bottom:1px solid #E4E8F2;text-align:left;font-size:14px';
  const num = `${cell};text-align:right`;
  const list = (title, rows, line) =>
    rows.length ? `<h3 style="margin:20px 0 6px;font-size:15px">${esc(title)}</h3><ul style="margin:0;padding-left:18px;font-size:14px">${rows.map((r) => `<li style="margin-bottom:4px">${line(r)}</li>`).join('')}</ul>` : '';
  const link = process.env.APP_URL ? `<p style="margin-top:20px"><a href="${esc(process.env.APP_URL)}/reports">Open the full report</a></p>` : '';
  const subject = `Technicon weekly sales report, ${dayMonth(report.week_start)} to ${dayMonth(report.week_end)}`;
  const html = `<div style="font-family:Arial,sans-serif;color:#141B34;max-width:680px">
  <h2 style="margin:0 0 4px;font-size:20px">Weekly sales report</h2>
  <p style="margin:0 0 14px;color:#5B6480;font-size:14px">${esc(dayMonth(report.week_start))} to ${esc(dayMonth(report.week_end))}</p>
  <table style="border-collapse:collapse;width:100%">
    <tr><td style="${cell}">Orders won</td><td style="${num}"><b>${esc(money(t.won_value))}</b> (${t.deals_won})</td></tr>
    <tr><td style="${cell}">Opportunities</td><td style="${num}">${t.visits}</td></tr>
    <tr><td style="${cell}">Opportunities lost / abandoned</td><td style="${num}">${t.deals_lost} / ${t.deals_abandoned}</td></tr>
    <tr><td style="${cell}">Open pipeline</td><td style="${num}">${esc(money(t.pipeline_value))} (${t.open_deals} opportunities), weighted ${esc(money(t.weighted_pipeline))}</td></tr>
    <tr><td style="${cell}">Past closing date / stuck</td><td style="${num}">${t.overdue_deals} / ${t.stuck_deals}</td></tr>
  </table>
  <h3 style="margin:20px 0 6px;font-size:15px">By salesperson</h3>
  <table style="border-collapse:collapse;width:100%">
    <tr><th style="${cell}">Name</th><th style="${num}">Opportunities</th><th style="${num}">Won</th><th style="${num}">Pipeline</th><th style="${num}">Overdue</th><th style="${num}">Stuck</th></tr>
    ${d.salespeople.map((p) => `<tr><td style="${cell}">${esc(p.name)}</td><td style="${num}">${p.visits}</td><td style="${num}">${esc(money(p.won_value))}</td><td style="${num}">${esc(money(p.pipeline_value))}</td><td style="${num}">${p.overdue_deals}</td><td style="${num}">${p.stuck_deals}</td></tr>`).join('')}
  </table>
  ${list('Biggest wins', d.wins, (r) => `${esc(r.title)}, ${esc(r.company_name)}: <b>${esc(money(r.value))}</b> (${esc(r.owner_name)})`)}
  ${list('Closing this week', d.closing, (r) => `${esc(r.title)}, ${esc(r.company_name)}: ${esc(money(r.value))}, ${r.probability}% (${esc(r.owner_name)})`)}
  ${list('Needs attention', d.at_risk, (r) => `${esc(r.title)}, ${esc(r.company_name)}: ${esc(money(r.value))} (${esc(r.owner_name)})`)}
  ${list('Tenders due', d.tenders, (r) => `${esc(r.tender_number)}, ${esc(r.company_name)}: due ${esc(dayMonth(r.date))} (${esc(r.owner_name)})`)}
  ${link}
</div>`;
  const text = `Weekly sales report, ${dayMonth(report.week_start)} to ${dayMonth(report.week_end)}\nOrders won: ${money(t.won_value)} (${t.deals_won})\nVisits: ${t.visits}\nOpen pipeline: ${money(t.pipeline_value)} (${t.open_deals} opportunities)\nPast closing date: ${t.overdue_deals}. Stuck: ${t.stuck_deals}.`;
  return { subject, html, text };
}

// Sends to everyone on the list. A failure is saved on the report, to show on screen and retry from there.
export async function emailReport(report, { sendEmail = sendWithSmtp } = {}) {
  if (sendEmail === sendWithSmtp && !emailConfigured()) return { sent: 0, skipped: 'Email is not set up on the server.' };
  const recipients = await db.prepare(`SELECT email FROM report_recipient WHERE is_active`).all();
  if (recipients.length === 0) return { sent: 0, skipped: 'Nobody is on the email list.' };
  try {
    await sendEmail({ to: recipients.map((r) => r.email).join(', '), ...reportEmail(report) });
    await db.prepare(`UPDATE weekly_report SET emailed_at = NOW(), email_error = NULL WHERE id = ?`).run(report.id);
    return { sent: recipients.length };
  } catch (err) {
    // The reason may help; the message could also quote server details, so it's kept short.
    const reason = String(err.message ?? 'Unknown error').slice(0, 300);
    await db.prepare(`UPDATE weekly_report SET email_error = ? WHERE id = ?`).run(reason, report.id);
    console.error('Weekly report email failed:', reason);
    return { sent: 0, error: reason };
  }
}

// Makes last week's report if it doesn't exist yet, and tells managers once. Safe to run repeatedly.
export async function runWeeklyReport({ push = null, sendEmail } = {}) {
  const week = await lastFinishedWeek();
  const exists = await db.prepare(`SELECT id FROM weekly_report WHERE week_start = ?`).get(week.from_date);
  if (exists) return { created: false, id: exists.id };
  const data = await buildReportData(week);
  const report = await db
    .prepare(`INSERT INTO weekly_report (week_start, week_end, data) VALUES (?, ?, ?) ON CONFLICT (week_start) DO NOTHING RETURNING *`)
    .get(week.from_date, week.to_date, JSON.stringify(data));
  // Another process got there first.
  if (!report) return { created: false };
  await recordAudit({ actorUserId: null, action: 'report.created', entityType: 'weekly_report', entityId: report.id, summary: `Weekly report for ${week.from_date} to ${week.to_date}` });

  const title = 'Weekly report ready';
  const body = `Won ${money(data.totals.won_value)} last week. Open pipeline ${money(data.totals.pipeline_value)}.`;
  const managers = await db.prepare(`SELECT id FROM app_user WHERE is_active AND role IN ('admin', 'managing_director', 'sales_manager')`).all();
  for (const { id } of managers) {
    const row = await db
      .prepare(
        `INSERT INTO notification (user_id, kind, for_date, title, body, url) VALUES (?, 'weekly_report', ?, ?, ?, '/reports')
         ON CONFLICT (user_id, kind, for_date) DO NOTHING RETURNING id`
      )
      .get(id, week.from_date, title, body);
    if (row && push) await push(id, { title, body, url: '/reports' });
  }
  const email = await emailReport(report, sendEmail ? { sendEmail } : {});
  return { created: true, id: report.id, email };
}
