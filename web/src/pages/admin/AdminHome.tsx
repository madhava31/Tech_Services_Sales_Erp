import { Link } from 'react-router-dom';
import { PageHeader } from '../../components/ui';

const SECTIONS = [
  { to: '/admin/salespeople', title: 'Salespeople', text: 'The people who own opportunities, follow-ups and opportunities.' },
  { to: '/admin/users', title: 'Users', text: 'Logins, roles and who reports to whom.' },
  { to: '/admin/erp', title: 'ERP sync', text: 'The connection to the ERP, and customers to match.' },
  { to: '/admin/import', title: 'Import data', text: 'Existing customers, contacts and open opportunities from Excel.' },
  { to: '/admin/catalogue', title: 'OEMs, segments and stuck limits', text: 'The choices on every opportunity, and when an opportunity counts as stuck.' },
  { to: '/products', title: 'Products', text: 'The catalogue, by make.' },
  { to: '/admin/audit', title: 'Audit log', text: 'Every account, ownership and record change.' },
];

export default function AdminHome() {
  return (
    <div>
      <PageHeader title="Admin" />
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
