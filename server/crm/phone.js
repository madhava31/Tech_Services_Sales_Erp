import { HttpError } from './access.js';

// Customer phone numbers are Indian numbers kept as the 10 digits, without the +91. Typing or pasting
// "+91 95026 60090", "091-9502660090" or "9502660090" all become 9502660090. Anything that is not 10
// digits after that is refused, so a number can never run on.
export function tenDigitPhone(value) {
  let digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length === 13 && digits.startsWith('091')) digits = digits.slice(3);
  else if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}

// null/empty stays empty. `keep` is the number already saved: left exactly as it is when it comes back
// unchanged, so an older record with an odd number can still be edited for something else.
export function checkedPhone(value, { keep = null, label = 'Phone number' } = {}) {
  if (value === null || value === undefined || value === '') return null;
  if (keep !== null && keep !== undefined && value === keep) return value;
  const digits = tenDigitPhone(value);
  if (digits.length !== 10) throw new HttpError(400, `${label} must be 10 digits, without +91 (you entered ${digits.length}).`);
  return digits;
}
