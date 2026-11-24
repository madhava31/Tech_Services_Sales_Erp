// Salespeople sign in every day. Their session ends at 11:50 pm India time, whether or not they were using the
// app; they can sign in again straight away (11:51 pm or the next morning) for the next day. Everyone else keeps
// the long session.
const CUTOFF_HOUR = 23;
const CUTOFF_MINUTE = 50;
const IST_OFFSET_MS = 330 * 60000;

// The next 11:50 pm India time after `now`.
export function nextCutoff(now = new Date()) {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  let cutoff = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), CUTOFF_HOUR, CUTOFF_MINUTE) - IST_OFFSET_MS;
  if (cutoff <= now.getTime()) cutoff += 24 * 60 * 60 * 1000;
  return new Date(cutoff);
}

export const endsDaily = (role) => role === 'salesperson';
