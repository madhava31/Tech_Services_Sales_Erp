import { HttpError } from './access.js';

// The 28 states and 8 union territories of India: the list a company's state is chosen from.
export const INDIAN_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh',
  'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha',
  'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
  'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Jammu and Kashmir', 'Ladakh',
  'Lakshadweep', 'Puducherry',
];

// A new or changed state must be on the list, spelled as it is there. `keep` is the state already saved.
export function listedState(value, { keep = null } = {}) {
  if (!value) return null;
  if (keep && value === keep) return value;
  const found = INDIAN_STATES.find((s) => s.toLowerCase() === String(value).trim().toLowerCase());
  if (!found) throw new HttpError(400, 'Choose the state from the list.');
  return found;
}

// Other ways the same states get written (the ERP, old spreadsheets): "&" for "and", old names, short forms.
const STATE_ALIASES = {
  orissa: 'Odisha',
  uttaranchal: 'Uttarakhand',
  pondicherry: 'Puducherry',
  telengana: 'Telangana',
  'nct of delhi': 'Delhi',
  'new delhi': 'Delhi',
  'andaman and nicobar': 'Andaman and Nicobar Islands',
  'andaman nicobar islands': 'Andaman and Nicobar Islands',
  'dadra and nagar haveli': 'Dadra and Nagar Haveli and Daman and Diu',
  'daman and diu': 'Dadra and Nagar Haveli and Daman and Diu',
  'dadra nagar haveli daman diu': 'Dadra and Nagar Haveli and Daman and Diu',
  // Abbreviations, with or without full stops ("A.P" becomes "a p").
  ap: 'Andhra Pradesh', 'a p': 'Andhra Pradesh',
  ts: 'Telangana', 't s': 'Telangana', tg: 'Telangana', 't g': 'Telangana',
  tn: 'Tamil Nadu', 't n': 'Tamil Nadu', ka: 'Karnataka', 'k a': 'Karnataka',
  kl: 'Kerala', 'k l': 'Kerala', mh: 'Maharashtra', 'm h': 'Maharashtra',
  gj: 'Gujarat', 'g j': 'Gujarat', dl: 'Delhi', 'd l': 'Delhi',
  up: 'Uttar Pradesh', 'u p': 'Uttar Pradesh', mp: 'Madhya Pradesh', 'm p': 'Madhya Pradesh',
  wb: 'West Bengal', 'w b': 'West Bengal',
};

// The state as the list spells it, from however it was written; null when it is not an Indian state at all.
// Used where text comes from outside (the ERP), so an odd spelling never becomes a state that is not on the list.
export function canonicalState(value) {
  if (!value) return null;
  const key = String(value).replace(/&/g, ' and ').replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!key) return null;
  return INDIAN_STATES.find((s) => s.toLowerCase() === key) ?? STATE_ALIASES[key] ?? null;
}
