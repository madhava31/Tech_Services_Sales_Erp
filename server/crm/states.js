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
