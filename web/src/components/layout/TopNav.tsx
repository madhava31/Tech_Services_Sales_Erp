import { useLayoutEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ChevronDownIcon } from 'lucide-react';
import type { Role } from '../../lib/roles';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './dropdown-menu';
import { NAV, activeEntry, linkActive } from './nav';

/**
 * Centred pill navigation. An accent pill slides between items. When moving right, the right edge leads and the
 * left edge follows (and the reverse), which gives the stretch effect. On narrow screens it has its own row and
 * scrolls sideways, as in the ERP.
 */
export function TopNav({ role }: { role: Role | undefined }) {
  const { pathname } = useLocation();
  const navRef = useRef<HTMLElement>(null);
  const indRef = useRef<HTMLSpanElement>(null);
  const prevLeft = useRef<number | null>(null);
  const current = activeEntry(pathname);

  const place = (instant: boolean) => {
    const nav = navRef.current, ind = indRef.current;
    if (!nav || !ind) return;
    const on = nav.querySelector<HTMLElement>(':scope > [data-on="true"]');
    ind.style.opacity = on ? '1' : '0';
    if (!on) return;
    const L = on.offsetLeft, R = nav.offsetWidth - (L + on.offsetWidth);
    const right = prevLeft.current == null || L >= prevLeft.current;
    ind.style.transition = instant ? 'none' : '';
    ind.style.transitionDelay = instant ? '' : right ? '110ms, 0ms' : '0ms, 110ms';
    ind.style.left = `${L}px`; ind.style.right = `${R}px`;
    prevLeft.current = L;
    if (instant) { void ind.offsetWidth; ind.style.transition = ''; }
    const wrap = nav.parentElement;
    if (wrap && wrap.scrollWidth > wrap.clientWidth) wrap.scrollTo({ left: L - wrap.clientWidth / 2 + on.offsetWidth / 2, behavior: instant ? 'auto' : 'smooth' });
  };

  useLayoutEffect(() => { place(prevLeft.current == null); }, [current]);
  useLayoutEffect(() => {
    const ro = new ResizeObserver(() => place(true));
    if (navRef.current) ro.observe(navRef.current);
    document.fonts?.ready.then(() => place(true));
    return () => ro.disconnect();
  }, []);

  return (
    <div className="ts-navwrap">
      <nav className="ts-nav" ref={navRef} aria-label="Main">
        <span className="ts-nav-ind" ref={indRef} aria-hidden="true" />
        {NAV.map((e) => {
          if (e.kind === 'link') {
            const on = current === e.path;
            return (
              <Link key={e.path} to={e.path} data-on={on} aria-current={on ? 'page' : undefined}>{e.label}</Link>
            );
          }
          const items = e.items.filter((i) => !i.show || i.show(role));
          if (items.length === 0) return null;
          const on = current === e.key;
          return (
            <DropdownMenu key={e.key} modal={false}>
              <DropdownMenuTrigger data-on={on} className="ts-nav-trigger">
                {e.label}
                <ChevronDownIcon className="ts-chev" aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="center" sideOffset={10} className="ts-menu">
                <h6>{e.label}</h6>
                {items.map((i) => (
                  <DropdownMenuItem key={i.path} asChild className="ts-mi" data-active={linkActive(i, pathname)}>
                    <Link to={i.path}>
                      <span><b>{i.label}</b>{i.desc && <small>{i.desc}</small>}</span>
                    </Link>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          );
        })}
      </nav>
    </div>
  );
}
