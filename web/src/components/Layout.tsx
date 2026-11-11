import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { BellIcon, LogOutIcon, PlusIcon } from 'lucide-react';
import companyLogo from '../assets/brand/technicon-logo.png';
import { api } from '../lib/api';
import { syncOutbox, useOutbox } from '../lib/outbox';
import { useAuth } from '../lib/auth';
import { canWriteCrm, roleLabel } from '../lib/roles';
import { watchSystemTheme } from '../lib/theme';
import ConfirmHost from './ConfirmHost';
import { Dock } from './layout/Dock';
import { TopNav } from './layout/TopNav';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './layout/dropdown-menu';

// The company logo exactly as supplied, as the ERP shows it.
function Brand() {
  return (
    <Link to="/" className="ts-brand" aria-label="Technicon Services, Today">
      <img className="ts-brand-logo" src={companyLogo} alt="Technicon Services - Advancing Analytical Science" width={207} height={44} />
    </Link>
  );
}

function SyncBanner() {
  const { online, waiting, conflicts } = useOutbox();
  if (online && waiting === 0 && conflicts === 0) return null;
  const parts = [
    !online && 'Offline, showing what’s saved on this phone',
    waiting > 0 && `${waiting} change${waiting === 1 ? '' : 's'} waiting to send`,
    conflicts > 0 && `${conflicts} need${conflicts === 1 ? 's' : ''} a decision`,
  ].filter(Boolean);
  return (
    <Link to="/sync" className={`block mt-3 mx-4 tablet-lg:mx-6 rounded-lg px-4 py-2 text-xs font-medium text-center ${conflicts ? 'bg-danger-soft text-danger' : 'bg-accent-soft text-accent-dark'}`}>
      {parts.join(' · ')}
    </Link>
  );
}

function ReminderBell({ unread }: { unread: number }) {
  return (
    <Link to="/notifications" aria-label={unread ? `Reminders, ${unread} new` : 'Reminders'} className="ts-iconbtn">
      <BellIcon aria-hidden="true" />
      {unread > 0 && <span className="absolute -top-0.5 -right-0.5 grid place-items-center min-w-[18px] h-[18px] px-1 rounded-full bg-cta text-oncta text-[10px] font-medium">{unread}</span>}
    </Link>
  );
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export default function Layout() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [unread, setUnread] = useState(0);
  const canLogVisit = canWriteCrm(user?.role);

  useEffect(() => watchSystemTheme(), []);

  // Sends anything waiting when the app comes back into view, and every few minutes while it's open.
  useEffect(() => {
    const send = () => {
      if (document.visibilityState === 'visible') void syncOutbox();
    };
    document.addEventListener('visibilitychange', send);
    const timer = setInterval(send, 3 * 60 * 1000);
    return () => {
      document.removeEventListener('visibilitychange', send);
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const check = () => api.notifications.list().then((n) => setUnread(n.unread)).catch(() => undefined);
    void check();
    const cleared = () => setUnread(0);
    window.addEventListener('notifications-read', cleared);
    return () => window.removeEventListener('notifications-read', cleared);
  }, [location.pathname]);

  // "N" starts a new opportunity from anywhere, unless the person is typing.
  useEffect(() => {
    if (!canLogVisit) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== 'n' && e.key !== 'N') || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input,textarea,select,[contenteditable="true"],[role="dialog"]')) return;
      const openOverlay = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"],[role="menu"]')].some((el) => el.getClientRects().length > 0);
      if (openOverlay) return;
      e.preventDefault();
      navigate('/opportunities/new');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canLogVisit, navigate]);

  return (
    <div className="ts-shell text-fg font-sans antialiased print:!p-0 print:!max-w-none">
      <header className="ts-top print:!hidden">
        <Brand />
        <TopNav role={user?.role} />
        <div className="ts-acts">
          {canLogVisit && (
            <Link to="/opportunities/new" className="ts-newq" title="New opportunity (press N)" aria-label="New opportunity">
              <PlusIcon aria-hidden="true" />
              <span>New opportunity</span>
              <kbd>N</kbd>
            </Link>
          )}
          <ReminderBell unread={unread} />
          {user && (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger className="ts-iconbtn ts-avatar" aria-label={`Account: ${user.username}`}>
                {initials(user.username)}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={10} className="ts-menu !w-[230px]">
                <div className="px-3 pt-2 pb-2.5 mb-1 border-b border-dashed border-line2">
                  <p className="text-[14px] font-medium text-fg truncate">{user.username}</p>
                  <p className="text-[12px] text-subtle">{roleLabel(user.role)}</p>
                </div>
                <DropdownMenuItem className="ts-mi !flex !gap-2 text-bad" onSelect={() => void logout()}>
                  <LogOutIcon className="size-4" aria-hidden="true" /> Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </header>

      <SyncBanner />

      {/* Keyed by path so each page plays the entrance animation. */}
      <main className="ts-main min-w-0 w-full">
        <div key={location.pathname} className="ts-page ts-page-pad min-w-0 flex flex-col">
          <Outlet />
        </div>
      </main>

      <Dock canLogVisit={canLogVisit} />
      <ConfirmHost />
    </div>
  );
}
