import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { Building2Icon, BriefcaseIcon, SearchIcon, UserIcon, XIcon } from 'lucide-react';
import { api, SearchResults } from '../lib/api';
import { STAGE_LABELS, formatMoney } from '../lib/labels';

type Hit = { key: string; to: string; icon: 'opp' | 'company' | 'contact'; title: string; sub: string; tag?: string };

const ICONS = { opp: BriefcaseIcon, company: Building2Icon, contact: UserIcon };

function toHits(r: SearchResults): { label: string; hits: Hit[] }[] {
  return [
    {
      label: 'Opportunities',
      hits: r.opportunities.map((o) => ({
        key: `o${o.id}`,
        to: `/pipeline/${o.id}`,
        icon: 'opp' as const,
        title: o.title,
        sub: `${o.code} · ${o.company_name} · ${o.owner_name} · ${formatMoney(o.won_value ?? o.estimated_value, { compact: true })}`,
        tag: STAGE_LABELS[o.stage],
      })),
    },
    {
      label: 'Companies',
      hits: r.companies.map((c) => ({
        key: `c${c.id}`,
        to: `/companies/${c.id}`,
        icon: 'company' as const,
        title: c.name,
        sub: [c.city, c.approval_status === 'pending' ? 'Waiting for approval' : null].filter(Boolean).join(' · '),
      })),
    },
    {
      label: 'Contacts',
      hits: r.contacts.map((c) => ({
        key: `p${c.id}`,
        to: `/companies/${c.company_id}`,
        icon: 'contact' as const,
        title: c.name,
        sub: [c.company_name, c.designation, c.department, c.phone].filter(Boolean).join(' · '),
      })),
    },
  ].filter((g) => g.hits.length > 0);
}

// The search button in the top bar: one box for opportunities (by ID such as TS-G-0001, name or
// company), companies and contacts. Ctrl+K or "/" opens it from anywhere.
export default function UniversalSearch() {
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  // Ctrl+K (or Cmd+K) anywhere; "/" unless the person is typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = Boolean(t?.closest('input,textarea,select,[contenteditable="true"]'));
      if ((e.key === 'k' || e.key === 'K') && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setOpen(true);
      } else if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Leaving the page closes it.
  useEffect(() => setOpen(false), [location.pathname]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => input.current?.focus());
    return () => {
      document.body.style.overflow = previous;
      button.current?.focus();
    };
  }, [open]);

  // Search as they type, a moment after they pause.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults(null);
      setError('');
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      api
        .search(term)
        .then((r) => {
          if (cancelled) return;
          setResults(r);
          setError('');
          setActive(0);
        })
        .catch((err) => !cancelled && setError(err instanceof Error ? err.message : 'Search failed.'))
        .finally(() => !cancelled && setLoading(false));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q]);

  const groups = useMemo(() => (results ? toHits(results) : []), [results]);
  const flat = groups.flatMap((g) => g.hits);

  function go(hit: Hit | undefined) {
    if (!hit) return;
    setOpen(false);
    setQ('');
    navigate(hit.to);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(flat.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(flat[active]);
    }
  }

  useEffect(() => {
    document.getElementById(`search-hit-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const term = q.trim();
  let index = -1;

  return (
    <>
      <button ref={button} type="button" className="ts-iconbtn" onClick={() => setOpen(true)} aria-label="Search (Ctrl+K)" title="Search opportunities, companies and contacts (Ctrl+K)">
        <SearchIcon aria-hidden="true" />
      </button>
      {open && createPortal(
        <div className="fixed inset-0 z-[80] bg-black/40 min-[861px]:pt-[10vh] min-[861px]:px-4" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Search"
            onKeyDown={onKeyDown}
            className="ts-card ts-white !p-0 !mt-0 mx-auto flex flex-col w-full h-full min-[861px]:h-auto min-[861px]:max-h-[70vh] min-[861px]:max-w-[620px] max-[860px]:!rounded-none overflow-hidden"
          >
            <div className="flex items-center gap-2 px-4 py-3 border-b border-dashed border-line">
              <SearchIcon className="size-5 shrink-0 text-subtle" aria-hidden="true" />
              <input
                ref={input}
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Opportunity ID (TS-G-0001), name, company, contact…"
                aria-label="Search"
                aria-controls="search-results"
                aria-activedescendant={flat.length ? `search-hit-${active}` : undefined}
                className="flex-1 min-w-0 !border-0 !bg-transparent !shadow-none !px-0 text-[16px] min-h-11"
                autoComplete="off"
              />
              <button type="button" onClick={() => setOpen(false)} className="ts-iconbtn shrink-0" aria-label="Close search">
                <XIcon aria-hidden="true" />
              </button>
            </div>
            <div id="search-results" role="listbox" aria-label="Results" className="flex-1 overflow-y-auto py-2">
              {term.length < 2 && <p className="px-4 py-6 text-sm text-subtle text-center">Type at least 2 letters. Find an opportunity by its ID, such as TS-G-0001, or by name.</p>}
              {term.length >= 2 && error && <p className="px-4 py-6 text-sm text-danger text-center">{error}</p>}
              {term.length >= 2 && !error && results && groups.length === 0 && !loading && <p className="px-4 py-6 text-sm text-subtle text-center">Nothing found for “{term}”.</p>}
              {term.length >= 2 && !results && loading && <p className="px-4 py-6 text-sm text-subtle text-center">Searching…</p>}
              {groups.map((g) => (
                <div key={g.label} className="mb-1">
                  <h6 className="px-4 pt-2 pb-1 text-[11px] font-medium uppercase tracking-[.07em] text-subtle">{g.label}</h6>
                  {g.hits.map((hit) => {
                    index++;
                    const i = index;
                    const Icon = ICONS[hit.icon];
                    return (
                      <button
                        key={hit.key}
                        id={`search-hit-${i}`}
                        type="button"
                        role="option"
                        aria-selected={i === active}
                        onMouseMove={() => i !== active && setActive(i)}
                        onClick={() => go(hit)}
                        className={`w-full flex items-center gap-3 px-4 py-2.5 text-left min-h-11 ${i === active ? 'bg-tile' : ''}`}
                      >
                        <Icon className="size-4 shrink-0 text-subtle" aria-hidden="true" />
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium truncate">{hit.title}</span>
                          {hit.sub && <span className="block text-xs text-ink-muted truncate">{hit.sub}</span>}
                        </span>
                        {hit.tag && <span className="text-[11px] text-subtle shrink-0">{hit.tag}</span>}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
            <div className="max-[860px]:hidden px-4 py-2 border-t border-dashed border-line text-[11px] text-subtle flex gap-4">
              <span>↑ ↓ to move</span>
              <span>Enter to open</span>
              <span>Esc to close</span>
            </div>
          </div>
        </div>,
        // Drawn at the top of the page, so it covers the header and the phone dock.
        document.body
      )}
    </>
  );
}
