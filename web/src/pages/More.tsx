import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { canRecordQuotations, isAdminRole, isManagingRole } from '../lib/roles';
import { toggleTheme, useIsDark } from '../lib/theme';
import { Button, PageHeader } from '../components/ui';

interface InstallPrompt extends Event {
  prompt: () => Promise<void>;
}

// Android and desktop Chrome can install on request; on an iPhone it's a step in the Share menu.
function InstallCard() {
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  const installed = window.matchMedia('(display-mode: standalone)').matches;
  const iphone = /iphone|ipad|ipod/i.test(navigator.userAgent);
  useEffect(() => {
    const capture = (e: Event) => {
      e.preventDefault();
      setPrompt(e as InstallPrompt);
    };
    window.addEventListener('beforeinstallprompt', capture);
    return () => window.removeEventListener('beforeinstallprompt', capture);
  }, []);
  if (installed || (!prompt && !iphone)) return null;
  return (
    <div className="ts-card ts-white !px-4 !py-3 mb-3 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-sm font-medium">Install the app</div>
        <div className="text-xs text-ink-muted mt-0.5">{iphone ? 'In Safari, tap Share, then Add to Home Screen.' : 'Opens from your home screen and works without signal.'}</div>
      </div>
      {prompt && (
        <Button
          className="shrink-0"
          onClick={() => {
            void prompt.prompt();
            setPrompt(null);
          }}
        >
          Install
        </Button>
      )}
    </div>
  );
}

// The dock has no room for the theme switch on phones. The whole row is the touch target.
function ThemeCard() {
  const dark = useIsDark();
  const button = useRef<HTMLButtonElement>(null);
  return (
    <div onClick={() => toggleTheme(button.current)} className="ts-card ts-white !px-4 !py-3 mb-3 flex items-center justify-between gap-3 cursor-pointer">
      <div className="text-sm font-medium">Dark mode</div>
      <div className="ts-switch">
        <button type="button" ref={button} aria-label="Dark mode" aria-pressed={dark} />
      </div>
    </div>
  );
}

// The dock shows the five main places on phones; everything else lives here.
export default function More() {
  const { user } = useAuth();
  const links = [
    { to: '/notifications', title: 'Reminders', text: 'Your daily reminders, and turning them on for this phone.' },
    { to: '/companies', title: 'Companies', text: 'Search the shared company list and contacts.' },
    { to: '/tenders', title: 'Tenders', text: 'Bid deadlines, and deposits still to come back.' },
    { to: '/renewals', title: 'Renewals and reorders', text: 'Warranties and AMCs ending, and consumables due.' },
    { to: '/products', title: 'Products', text: 'Search the catalogue by part number, name or make.' },
    { to: '/analysis', title: 'Sales analysis', text: 'The sales funnel and the monthly forecast.' },
    { to: '/performance', title: 'Performance', text: 'Opportunities, opportunities won and the pipeline for 7, 30 or 90 days.' },
    ...(user?.role !== 'salesperson' ? [{ to: '/team', title: 'Team', text: 'Every salesperson side by side, trends and opportunities going quiet.' }] : []),
    ...(user?.role !== 'salesperson' ? [{ to: '/reports', title: 'Weekly report', text: 'Last week’s results, made each Monday morning.' }] : []),
    ...(isManagingRole(user?.role) ? [{ to: '/approvals', title: 'Company approvals', text: 'New companies from the field, waiting for a decision.' }] : []),
    ...(isManagingRole(user?.role) ? [{ to: '/team/handover', title: 'Hand over work', text: 'Move a leaver’s open opportunities and follow-ups.' }] : []),
    ...(canRecordQuotations(user?.role) ? [{ to: '/quotation-requests', title: 'Quotation requests', text: 'Customers waiting for a quotation.' }] : []),
    ...(isAdminRole(user?.role)
      ? [
          { to: '/admin/salespeople', title: 'Salespeople', text: 'The people who own opportunities and opportunities.' },
          { to: '/admin/users', title: 'Users', text: 'Logins and roles.' },
          { to: '/admin/erp', title: 'ERP sync', text: 'The connection to the ERP, and customers to match.' },
          { to: '/admin/import', title: 'Import data', text: 'Existing customers, contacts and open opportunities from Excel.' },
          { to: '/admin/catalogue', title: 'OEMs, segments and stuck limits', text: 'The choices on every opportunity, and when an opportunity counts as stuck.' },
          { to: '/admin/audit', title: 'Audit log', text: 'Every account and ownership change.' },
        ]
      : []),
  ];
  return (
    <div>
      <PageHeader title="More" />
      <ThemeCard />
      <InstallCard />
      <ul className="flex flex-col gap-2">
        {links.map((l) => (
          <li key={l.to}>
            <Link to={l.to} className="ts-card ts-white block !px-4 !py-3 hover:shadow-lift transition-shadow">
              <div className="text-sm font-medium">{l.title}</div>
              <div className="text-xs text-ink-muted mt-0.5">{l.text}</div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
