// Role model (docs/architecture-plan.md §3). Access is enforced here and in every query that
// lists records — never only by hiding things in the web app.

export const ROLES = ['admin', 'managing_director', 'sales_manager', 'salesperson', 'office_staff'];

// May manage users and salespeople and read the audit log.
export const ADMIN_ROLES = ['admin', 'managing_director'];

// May be someone's reporting manager.
export const MANAGER_ROLES = ['admin', 'managing_director', 'sales_manager'];

export function isAdminRole(role) {
  return ADMIN_ROLES.includes(role);
}

// Salesperson ids whose records this user may see, or null for "all". A salesperson login
// without a linked salesperson sees nothing (empty list), never everything.
export function visibleSalespersonIds(user) {
  if (user.role === 'salesperson') return user.salesperson_id ? [user.salesperson_id] : [];
  return null;
}
