// Company-name normalization for duplicate detection. "M/s. ABC Engineering Pvt. Ltd." and
// "ABC Engineering Private Limited" both become "abc engineering".
const LEGAL_WORDS = new Set([
  'ms',
  'pvt',
  'private',
  'ltd',
  'limited',
  'llp',
  'inc',
  'incorporated',
  'corp',
  'corporation',
  'co',
  'company',
  'the',
  'p',
]);

export function normalizeCompanyName(name) {
  const cleaned = String(name ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/m\/s\.?/g, ' ms ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const words = cleaned.split(' ').filter(Boolean);
  const meaningful = words.filter((w) => !LEGAL_WORDS.has(w));
  // A name made only of legal words ("The Company") keeps them rather than becoming empty.
  return (meaningful.length ? meaningful : words).join(' ');
}

// Digits only, last 10 — so "+91 98765 43210" and "098765-43210" compare equal.
export function phoneKey(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  return digits.length >= 6 ? digits.slice(-10) : null;
}
