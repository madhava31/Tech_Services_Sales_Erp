import type { UserAccount } from './api';

// Salespeople sign in every day. After this many hours without a sign-in they are reminded, and the admin
// sees them flagged. Mirrors INACTIVE_AFTER_HOURS on the server.
export const QUIET_AFTER_HOURS = 72;

// A salesperson whose login is active, with no session open, who hasn't signed in for three days. Someone whose
// session is still open is signed in (an older session from before the daily rule), however long ago it began.
export const isQuiet = (u: UserAccount) => u.is_active && u.role === 'salesperson' && !u.signed_in_now && (u.hours_since_login ?? 0) >= QUIET_AFTER_HOURS;

export const quietDays = (u: UserAccount) => Math.floor((u.hours_since_login ?? 0) / 24);

function signedInText(u: UserAccount) {
  if (!u.last_login_at) return 'Never signed in';
  const hours = u.hours_since_login ?? 0;
  if (hours < 1) return 'Signed in just now';
  if (hours < 24) return `Signed in ${Math.floor(hours)} hour${Math.floor(hours) === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `Signed in ${days} day${days === 1 ? '' : 's'} ago`;
}

// "Signed in 5 hours ago", "Signed in 3 days ago, still signed in", or "Never signed in".
export function lastSignIn(u: UserAccount) {
  const text = signedInText(u);
  return u.signed_in_now && (u.hours_since_login ?? 0) >= 24 ? `${text}, still signed in` : text;
}
