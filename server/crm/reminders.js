import webpush from 'web-push';
import db from '../db/index.js';
import { TODAY_SQL } from './fields.js';
import { createRepeatFollowups } from './repeat.js';
import { runWeeklyReport } from './weeklyReport.js';
import { STUCK_SQL } from './stuck.js';

// Reminders: one digest a day per person, kept in the app and also sent to any phone that agreed to
// push. WhatsApp would plug in beside sendPush once a provider is chosen (decision D12).

// Sent once the working morning starts, India time, Monday to Saturday.
const REMINDER_HOUR_IST = 9;
const CHECK_EVERY_MS = 10 * 60 * 1000;
const IDEMPOTENCY_KEEP_DAYS = 30;

// Only these services receive push, because the address comes from the browser: otherwise a request
// could make this server call anywhere.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/, /(^|\.)push\.services\.mozilla\.com$/];

export function isAllowedPushEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && PUSH_HOSTS.some((host) => host.test(url.hostname));
  } catch {
    return false;
  }
}

export function pushPublicKey() {
  return process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY ? process.env.VAPID_PUBLIC_KEY : null;
}

let vapidReady = false;
function configurePush() {
  if (vapidReady) return true;
  if (!pushPublicKey()) return false;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  vapidReady = true;
  return true;
}

async function sendPush(subscription, payload) {
  await webpush.sendNotification({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, JSON.stringify(payload));
}

// One message to each of a person's phones, for anything other than the daily digest.
export async function pushToUser(userId, payload) {
  if (!configurePush()) return;
  for (const subscription of await db.prepare(`SELECT * FROM push_subscription WHERE user_id = ?`).all(userId)) {
    await sendPush(subscription, payload).catch(async (err) => {
      if (err.statusCode === 404 || err.statusCode === 410) await db.prepare(`DELETE FROM push_subscription WHERE id = ?`).run(subscription.id);
      else console.error('Push failed:', err.statusCode ?? err.message);
    });
  }
}

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

function digestText({ dueToday, overdueTasks, overdueDeals, stuckDeals, tendersDue }) {
  const parts = [];
  if (dueToday) parts.push(`${plural(dueToday, 'follow-up')} due today`);
  if (overdueTasks) parts.push(`${plural(overdueTasks, 'follow-up')} overdue`);
  if (overdueDeals) parts.push(`${plural(overdueDeals, 'opportunity', 'opportunities')} past closing date`);
  if (stuckDeals) parts.push(`${plural(stuckDeals, 'opportunity', 'opportunities')} stuck`);
  if (tendersDue) parts.push(`${plural(tendersDue, 'tender')} due soon`);
  return parts.join(', ');
}

// What each person hears: salespeople about their own work, managers about the team's overdue work.
// Office staff don't own follow-ups or deals, so they get no digest.
async function digestsForToday() {
  const rows = await db
    .prepare(
      `SELECT u.id AS user_id, u.role,
              (SELECT COUNT(*)::int FROM task t WHERE t.status = 'open' AND t.due_date = ${TODAY_SQL} AND t.assignee_salesperson_id = u.salesperson_id) AS due_today,
              (SELECT COUNT(*)::int FROM task t WHERE t.status = 'open' AND t.due_date < ${TODAY_SQL} AND t.assignee_salesperson_id = u.salesperson_id) AS overdue_tasks,
              (SELECT COUNT(*)::int FROM opportunity o WHERE o.stage NOT IN ('won', 'lost') AND o.expected_close_date < ${TODAY_SQL} AND o.owner_salesperson_id = u.salesperson_id) AS overdue_deals,
              (SELECT COUNT(*)::int FROM opportunity o WHERE ${STUCK_SQL} AND o.owner_salesperson_id = u.salesperson_id) AS stuck_deals,
              (SELECT COUNT(*)::int FROM opportunity o WHERE ${STUCK_SQL}) AS team_stuck_deals,
              (SELECT COUNT(*)::int FROM tender tn JOIN opportunity o ON o.id = tn.opportunity_id WHERE o.tender AND o.closed_at IS NULL AND tn.bid_status = 'preparing' AND tn.bid_due_date <= ${TODAY_SQL} + 3 AND o.owner_salesperson_id = u.salesperson_id) AS tenders_due,
              (SELECT COUNT(*)::int FROM tender tn JOIN opportunity o ON o.id = tn.opportunity_id WHERE o.tender AND o.closed_at IS NULL AND tn.bid_status = 'preparing' AND tn.bid_due_date <= ${TODAY_SQL} + 3) AS team_tenders_due,
              (SELECT COUNT(*)::int FROM task t WHERE t.status = 'open' AND t.due_date < ${TODAY_SQL}) AS team_overdue_tasks,
              (SELECT COUNT(*)::int FROM opportunity o WHERE o.stage NOT IN ('won', 'lost') AND o.expected_close_date < ${TODAY_SQL}) AS team_overdue_deals
       FROM app_user u WHERE u.is_active AND u.role <> 'office_staff'`
    )
    .all();
  const digests = [];
  for (const r of rows) {
    if (r.role === 'salesperson') {
      const body = digestText({ dueToday: r.due_today, overdueTasks: r.overdue_tasks, overdueDeals: r.overdue_deals, stuckDeals: r.stuck_deals, tendersDue: r.tenders_due });
      if (body) digests.push({ userId: r.user_id, title: 'Your day', body, url: '/' });
    } else {
      const body = digestText({ dueToday: 0, overdueTasks: r.team_overdue_tasks, overdueDeals: r.team_overdue_deals, stuckDeals: r.team_stuck_deals, tendersDue: r.team_tenders_due });
      if (body) digests.push({ userId: r.user_id, title: 'Team today', body, url: '/team' });
    }
  }
  return digests;
}

// Safe to run any number of times a day: the unique key means each person's digest is created, and
// so pushed, only once. `send` is replaceable for tests.
export async function runDailyReminders({ send = sendPush } = {}) {
  const { d: today } = await db.prepare(`SELECT ${TODAY_SQL}::text AS d`).get();
  const canPush = send !== sendPush || configurePush();
  const result = { created: 0, pushed: 0, removed: 0 };
  // First, so the digest counts any follow-ups this creates.
  await createRepeatFollowups();
  for (const digest of await digestsForToday()) {
    const row = await db
      .prepare(
        `INSERT INTO notification (user_id, kind, for_date, title, body, url) VALUES (?, 'daily_digest', ?, ?, ?, ?)
         ON CONFLICT (user_id, kind, for_date) WHERE kind IN ('daily_digest', 'weekly_report') DO NOTHING RETURNING id`
      )
      .get(digest.userId, today, digest.title, digest.body, digest.url);
    if (!row) continue;
    result.created++;
    if (!canPush) continue;
    const subscriptions = await db.prepare(`SELECT * FROM push_subscription WHERE user_id = ?`).all(digest.userId);
    for (const subscription of subscriptions) {
      try {
        await send(subscription, { title: digest.title, body: digest.body, url: digest.url });
        result.pushed++;
      } catch (err) {
        // 404 and 410 mean the browser ended this subscription; anything else may be temporary.
        if (err.statusCode === 404 || err.statusCode === 410) {
          await db.prepare(`DELETE FROM push_subscription WHERE id = ?`).run(subscription.id);
          result.removed++;
        } else console.error('Push failed:', err.statusCode ?? err.message);
      }
    }
  }
  await db.prepare(`DELETE FROM request_idempotency WHERE created_at < NOW() - make_interval(days => ?)`).run(IDEMPOTENCY_KEEP_DAYS);
  return result;
}

// What one scheduled run does: from the working morning on (not Sundays), the daily digest and, once a
// week, the weekly report. Awaited, so a serverless run finishes its work before it ends.
export async function runReminderJob({ now = new Date() } = {}) {
  if (!isReminderTime(now)) return { skipped: true };
  const digest = await runDailyReminders();
  const report = await runWeeklyReport({ push: pushToUser });
  return { digest, report: { created: Boolean(report?.created) } };
}

function isReminderTime(now = new Date()) {
  const ist = new Date(now.getTime() + 330 * 60000);
  return ist.getUTCDay() !== 0 && ist.getUTCHours() >= REMINDER_HOUR_IST;
}

// Needs one long-running process, which is how production is planned (docs/architecture-plan.md §2).
export function startReminderSchedule() {
  const tick = () => {
    runReminderJob().catch((err) => console.error('Reminders failed:', err));
  };
  tick();
  return setInterval(tick, CHECK_EVERY_MS);
}
