// One-time codes: a six-digit code, valid for ten minutes, five tries, a few sends per hour.
import crypto from 'node:crypto';
import db from '../db/index.js';
import { HttpError } from '../crm/access.js';
import { sendOtp } from './sms.js';

const CODE_MINUTES = 10;
const MAX_TRIES = 5;
const MIN_SECONDS_BETWEEN = 45;
const MAX_PER_HOUR = 5;
const MAX_PER_IP_PER_HOUR = 20;

// The ten digits of an Indian mobile number, or null when the stored value isn't one.
export function mobileDigits(value) {
  const digits = String(value ?? '').replace(/\D/g, '').slice(-10);
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

export const showPhone = (digits) => `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;

// The registered mobile of a login: the number on its salesperson record, which the admin entered.
export async function registeredMobile(userId) {
  const row = await db.prepare(`SELECT sp.phone FROM app_user u JOIN salesperson sp ON sp.id = u.salesperson_id WHERE u.id = ?`).get(userId);
  return mobileDigits(row?.phone);
}

const hash = (salt, code) => crypto.createHash('sha256').update(`${salt}:${code}`).digest('hex');

// Makes a new code for this login, texts it to the registered number, and retires any earlier one.
export async function sendCode({ userId, purpose, phone, ip }) {
  const recent = await db
    .prepare(
      `SELECT COUNT(*) FILTER (WHERE user_id = ?)::int AS by_user,
              COUNT(*) FILTER (WHERE ip = ?)::int AS by_ip,
              COALESCE(EXTRACT(EPOCH FROM NOW() - MAX(created_at) FILTER (WHERE user_id = ?)), 9999)::int AS since_last
         FROM otp_challenge WHERE created_at > NOW() - INTERVAL '1 hour'`
    )
    .get(userId, ip ?? '', userId);
  if (recent.since_last < MIN_SECONDS_BETWEEN) throw new HttpError(429, `Wait ${MIN_SECONDS_BETWEEN - recent.since_last} seconds before asking for another code.`);
  if (recent.by_user >= MAX_PER_HOUR || recent.by_ip >= MAX_PER_IP_PER_HOUR) throw new HttpError(429, 'Too many codes asked for. Try again in an hour.');

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const salt = crypto.randomBytes(16).toString('hex');
  await db.prepare(`UPDATE otp_challenge SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL`).run(userId);
  await db
    .prepare(`INSERT INTO otp_challenge (user_id, purpose, phone, salt, code_hash, expires_at, ip) VALUES (?, ?, ?, ?, ?, NOW() + make_interval(mins => ?), ?)`)
    .run(userId, purpose, phone, salt, hash(salt, code), CODE_MINUTES, ip ?? null);
  try {
    await sendOtp(phone, code);
  } catch (err) {
    await db.prepare(`UPDATE otp_challenge SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL`).run(userId);
    throw new HttpError(503, err.message);
  }
}

// True when the code is right. A wrong guess counts; after five the code is dead and a new one is needed.
export async function checkCode({ userId, purpose, code }) {
  const row = await db
    .prepare(`SELECT id, salt, code_hash, attempts FROM otp_challenge WHERE user_id = ? AND purpose = ? AND used_at IS NULL AND expires_at > NOW() ORDER BY id DESC LIMIT 1`)
    .get(userId, purpose);
  if (!row) return false;
  if (row.attempts >= MAX_TRIES) return false;
  await db.prepare(`UPDATE otp_challenge SET attempts = attempts + 1 WHERE id = ?`).run(row.id);
  const given = Buffer.from(hash(row.salt, String(code ?? '').trim()));
  const real = Buffer.from(row.code_hash);
  if (given.length !== real.length || !crypto.timingSafeEqual(given, real)) return false;
  await db.prepare(`UPDATE otp_challenge SET used_at = NOW() WHERE id = ?`).run(row.id);
  return true;
}
