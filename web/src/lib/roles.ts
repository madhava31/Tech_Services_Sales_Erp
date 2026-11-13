// Mirrors api/auth/roles.js. The API enforces access; this only decides what to show.
export type Role = 'admin' | 'managing_director' | 'sales_manager' | 'salesperson' | 'office_staff';

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Administrator',
  managing_director: 'Managing Director',
  sales_manager: 'Sales Manager',
  salesperson: 'Salesperson',
  office_staff: 'Office Staff',
};

export const ROLE_OPTIONS = (Object.keys(ROLE_LABELS) as Role[]).map((value) => ({ value, label: ROLE_LABELS[value] }));

export const MANAGER_ROLES: Role[] = ['admin', 'managing_director', 'sales_manager'];

export function isAdminRole(role: Role | undefined) {
  return role === 'admin' || role === 'managing_director';
}

// Mirrors api/crm/access.js: who records field activity, and who acts for other salespeople.
export function canWriteCrm(role: Role | undefined) {
  return role !== undefined && role !== 'office_staff';
}

export function isManagingRole(role: Role | undefined) {
  return role === 'admin' || role === 'managing_director' || role === 'sales_manager';
}

// Mirrors QUOTATION_ROLES in api/crm/access.js.
export function canRecordQuotations(role: Role | undefined) {
  return role === 'admin' || role === 'managing_director' || role === 'sales_manager' || role === 'office_staff';
}

// Mirrors api/routes/catalogue.js. Managing OEMs and market segments is isAdminRole.
// Only Admin adds and edits products.
export function canManageProducts(role: Role | undefined) {
  return role === 'admin';
}

// Salespeople keep their own; managers and the office keep anyone's. Mirrors api/routes/repeat.js.
export function canKeepInstruments(role: Role | undefined) {
  return role !== undefined;
}

export function roleLabel(role: string | undefined) {
  return (role && ROLE_LABELS[role as Role]) || role || '';
}
