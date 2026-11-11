// Main navigation, grouped the way the ERP shows it. The `show` rules decide who sees what.
import { type Role, canRecordQuotations, isAdminRole, isManagingRole } from '../../lib/roles';

type Show = (role: Role | undefined) => boolean;
export interface NavLink { label: string; path: string; desc?: string; exact?: boolean; show?: Show }
export interface NavGroup { key: string; label: string; items: NavLink[] }
export type NavEntry = ({ kind: 'link' } & NavLink) | ({ kind: 'group' } & NavGroup);

const notSalesperson: Show = (role) => role !== undefined && role !== 'salesperson';

export const NAV: NavEntry[] = [
  { kind: 'link', label: 'Today', path: '/', exact: true },
  { kind: 'group', key: 'sales', label: 'Sales', items: [
    { label: 'Opportunities', path: '/opportunities', desc: 'Every opportunity, as a list' },
    { label: 'Pipeline', path: '/pipeline', desc: 'Opportunities by stage' },
    { label: 'Follow-ups', path: '/tasks', desc: 'What needs doing next' },
    { label: 'Quotation requests', path: '/quotation-requests', desc: 'Requests waiting for a quotation', show: canRecordQuotations },
  ] },
  { kind: 'group', key: 'accounts', label: 'Accounts', items: [
    { label: 'Companies', path: '/companies', desc: 'Shared list of customer companies' },
    { label: 'Tenders', path: '/tenders', desc: 'Opportunities marked as tenders' },
    { label: 'Renewals', path: '/renewals', desc: 'Renewals and reorders' },
    { label: 'Products', path: '/products', desc: 'What we sell, by make' },
  ] },
  { kind: 'group', key: 'insights', label: 'Insights', items: [
    { label: 'Performance', path: '/performance', desc: 'Your numbers, or the team’s' },
    { label: 'Sales analysis', path: '/analysis', desc: 'Where opportunities drop out, and what should close when' },
    { label: 'Weekly report', path: '/reports', desc: 'Weekly sales report', show: notSalesperson },
  ] },
  { kind: 'group', key: 'manage', label: 'Manage', items: [
    { label: 'Team', path: '/team', desc: 'Salespeople and their work', show: notSalesperson },
    { label: 'Approvals', path: '/approvals', desc: 'New companies to check and approve', show: isManagingRole },
    { label: 'Admin', path: '/admin', desc: 'Users, catalogue, imports and audit log', show: isAdminRole },
  ] },
];

const under = (path: string, base: string) => path === base || path.startsWith(base + '/');

export function linkActive(l: NavLink, path: string) {
  return l.exact ? path === l.path : under(path, l.path);
}

/** Which top-level entry owns the current path. */
export function activeEntry(path: string): string | null {
  for (const e of NAV) {
    const links: NavLink[] = e.kind === 'link' ? [e] : e.items;
    if (links.some((l) => linkActive(l, path))) return e.kind === 'link' ? e.path : e.key;
  }
  return null;
}
