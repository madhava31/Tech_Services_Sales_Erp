import { useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { EllipsisIcon, HouseIcon, KanbanSquareIcon, ListChecksIcon, MapPinIcon, MoonIcon, PlusIcon, SunIcon } from 'lucide-react';
import { toggleTheme, useIsDark } from '../../lib/theme';

// .ts-dk and .ts-dock set their own display, so hiding them needs the important form.
const DESKTOP_ONLY = 'max-[860px]:!hidden';
const PHONE_ONLY = 'min-[861px]:!hidden';

function DockLink({ to, label, on, className = '', children }: { to: string; label: string; on: boolean; className?: string; children: React.ReactNode }) {
  return (
    <Link to={to} className={`ts-dk ${on ? 'on' : ''} ${className}`} data-label={label} aria-label={label} aria-current={on ? 'page' : undefined}>
      {children}
    </Link>
  );
}

/** Floating quick-tools dock: left edge on desktop. On phones, bottom centre with the five main destinations. */
export function Dock({ canLogVisit }: { canLogVisit: boolean }) {
  const { pathname } = useLocation();
  const dark = useIsDark();
  const themeBtn = useRef<HTMLButtonElement>(null);
  const under = (base: string) => pathname === base || pathname.startsWith(`${base}/`);
  return (
    <aside className="ts-dock print:!hidden" aria-label="Quick tools">
      <DockLink to="/" label="Today" on={pathname === '/'} className={PHONE_ONLY}>
        <HouseIcon />
      </DockLink>
      <DockLink to="/opportunities" label="Opportunities" on={pathname === '/opportunities'} className={PHONE_ONLY}>
        <MapPinIcon />
      </DockLink>
      {canLogVisit && (
        <DockLink to="/opportunities/new" label="New opportunity" on={pathname === '/opportunities/new'} className={DESKTOP_ONLY}>
          <PlusIcon />
        </DockLink>
      )}
      <DockLink to="/pipeline" label="Pipeline" on={under('/pipeline')}>
        <KanbanSquareIcon />
      </DockLink>
      <DockLink to="/tasks" label="Follow-ups" on={under('/tasks')}>
        <ListChecksIcon />
      </DockLink>
      <DockLink to="/more" label="More" on={pathname === '/more'} className={PHONE_ONLY}>
        <EllipsisIcon />
      </DockLink>
      <hr className={DESKTOP_ONLY} />
      <button type="button" ref={themeBtn} className={`ts-dk ${DESKTOP_ONLY}`} data-label={dark ? 'Light mode' : 'Dark mode'} aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'} onClick={() => toggleTheme(themeBtn.current)}>
        {dark ? <SunIcon /> : <MoonIcon />}
      </button>
    </aside>
  );
}
