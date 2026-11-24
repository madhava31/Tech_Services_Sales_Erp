import { Link } from 'react-router-dom';
import { api, UserAccount } from '../../lib/api';
import { useLoad } from '../../lib/useLoad';
import { isQuiet, quietDays } from '../../lib/signIn';
import { Card, CardHeader, PageHeader } from '../../components/ui';

const SECTIONS = [
  { to: '/admin/salespeople', title: 'Salespeople', text: 'The people who own opportunities, follow-ups and opportunities.' },
  { to: '/admin/users', title: 'Users', text: 'Logins, roles and who reports to whom.' },
  { to: '/admin/erp', title: 'ERP sync', text: 'The connection to the ERP, and customers to match.' },
  { to: '/admin/import', title: 'Import data', text: 'Existing customers, contacts and open opportunities from Excel.' },
  { to: '/admin/catalogue', title: 'OEMs, segments and stuck limits', text: 'The choices on every opportunity, and when an opportunity counts as stuck.' },
  { to: '/products', title: 'Products', text: 'The catalogue, by make.' },
  { to: '/admin/audit', title: 'Audit log', text: 'Every account, ownership and record change.' },
];

// Salespeople sign in every day. Anyone who hasn't for three days is listed here, longest first.
function QuietSalespeople() {
  const users = useLoad<UserAccount[]>(api.users.list, []);
  const quiet = users.data.filter(isQuiet).sort((a, b) => (b.hours_since_login ?? 0) - (a.hours_since_login ?? 0));
  if (quiet.length === 0) return null;
  return (
    <Card>
      <CardHeader title={`Not signed in for 3 days or more (${quiet.length})`} description="Salespeople sign in every day. They have been sent a reminder." />
      <ul className="divide-y divide-dashed divide-line overflow-hidden rounded-b-card">
        {quiet.map((u) => (
          <li key={u.id} className="px-4 sm:px-5 py-3 flex flex-wrap items-center gap-x-4 gap-y-1">
            <Link to="/admin/users" className="text-sm font-medium hover:text-brand">
              {u.salesperson_name ?? u.username}
            </Link>
            <span className="ts-st ts-tone-warn">{u.last_login_at ? `${quietDays(u)} days` : `Never signed in, ${quietDays(u)} days`}</span>
            <span className="text-xs text-ink-muted">Login: {u.username}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export default function AdminHome() {
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Admin" />
      <QuietSalespeople />
      <div className="ts-grid ts-row3 !mt-0">
        {SECTIONS.map((s) => (
          <Link key={s.to} to={s.to} className="ts-card ts-white block hover:shadow-lift transition-shadow">
            <div className="text-sm font-medium">{s.title}</div>
            <div className="text-xs text-ink-muted mt-1">{s.text}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
