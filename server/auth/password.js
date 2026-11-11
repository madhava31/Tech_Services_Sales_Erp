import crypto from 'node:crypto';

const KEY_LENGTH = 64;
const MIN_PASSWORD_LENGTH = 8;

export const PASSWORD_RULE = `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;

export function isAcceptablePassword(password) {
  return typeof password === 'string' && password.length >= MIN_PASSWORD_LENGTH;
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, KEY_LENGTH).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, salt, expectedHash) {
  const hash = crypto.scryptSync(password, salt, KEY_LENGTH);
  const expected = Buffer.from(expectedHash, 'hex');
  if (hash.length !== expected.length) return false;
  return crypto.timingSafeEqual(hash, expected);
}
