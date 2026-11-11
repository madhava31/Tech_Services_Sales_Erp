import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, DealFilters, Opportunity } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { STAGE_LABELS, formatDate, formatMoney } from '../../lib/labels';
import { canWriteCrm } from '../../lib/roles';
import { Badge, DESKTOP_ONLY, EmptyState, Notice, OverdueBadge, PHONE_ONLY, PHONE_TOUCH, PageHeader, SearchBox, SkeletonRows, StuckBadge, rowStagger } from '../../components/ui';

type Status = NonNullable<DealFilters['status']>;
const VIEWS: [Status, string][] = [
  ['open', 'Open'],
  ['won', 'Won'],
  ['lost', 'Lost'],
  ['abandoned', 'Abandoned'],
];

function StageBadge({ deal }: { deal: Opportunity }) {
  return <Badge tone={deal.stage === 'won' ? 'ok' : deal.stage === 'lost' || deal.stage === 'abandoned' ? 'muted' : 'brand'}>{STAGE_LABELS[deal.stage]}</Badge>;
}

const value = (d: Opportunity) => formatMoney(d.won_value ?? d.estimated_value, { compact: true });

// Every opportunity as a list. A row opens the same page as its card on the Pipeline.
export default function Opportunities() {
  const { user } = useAuth();
  const teamView = user?.role !== 'salesperson';
  const [view, setView] = useState<Status>('open');
  const [rows, setRows] = useState<Opportunity[] | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');

  useEffect(() => {
    setRows(null);
    setError('');
    api.opportunities
      .list({ status: view })
      .then(setRows)
      .catch((err) => setError(err.message));
  }, [view]);

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!rows || !term) return rows ?? [];
    return rows.filter((d) => [d.title, d.company_name, d.owner_name, d.oem_name].some((v) => (v ?? '').toLowerCase().includes(term)));
  }, [rows, q]);

  return (
    <div>
      <PageHeader
        title="Opportunities"
        description={teamView ? 'Every opportunity across the team.' : 'Your opportunities.'}
        actions={
          canWriteCrm(user?.role) && (
            <Link to="/opportunities/new" className="ts-btn ts-dark justify-center max-[860px]:min-h-11">
              + New opportunity
            </Link>
          )
        }
      />
      {error && <Notice tone="error">{error}</Notice>}
      <section className="ts-card ts-white ts-tcard ts-tbl !mt-0">
        <div className="ts-tbar">
          <div className="ts-tabs" role="tablist">
            {VIEWS.map(([v, label]) => (
              <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)} className={`ts-tab ${PHONE_TOUCH} ${view === v ? 'ts-on' : ''}`}>
                {label}
              </button>
            ))}
          </div>
          <SearchBox label="Search opportunities" placeholder="Name, company or owner" value={q} onChange={(e) => setQ(e.target.value)} />
          {rows && (
            <span className="ts-showing ts-muted">
              Showing {shown.length} of {rows.length}
            </span>
          )}
        </div>
        {rows === null && !error && <SkeletonRows />}
        {rows && shown.length === 0 && <EmptyState>{rows.length ? 'No opportunities match this search.' : `No ${VIEWS.find(([v]) => v === view)?.[1].toLowerCase()} opportunities.`}</EmptyState>}
        {shown.length > 0 && (
          <>
            <div className={`ts-tblwrap ${DESKTOP_ONLY}`}>
              <table>
                <thead>
                  <tr>
                    <th>Opportunity</th>
                    <th>Company</th>
                    <th>Stage</th>
                    <th className="ts-r">Value</th>
                    <th>{view === 'open' ? 'Closing date' : 'Closed'}</th>
                    {teamView && <th>Owner</th>}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((d, i) => (
                    <tr key={d.id} style={rowStagger(i)}>
                      <td className="ts-wrap">
                        <Link to={`/pipeline/${d.id}`} className="ts-lnk font-medium">
                          {d.title}
                        </Link>
                      </td>
                      <td className="ts-wrap">{d.company_name}</td>
                      <td>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <StageBadge deal={d} />
                          {d.is_overdue && <OverdueBadge />}
                          {d.is_stuck && <StuckBadge days={d.days_in_stage} />}
                        </div>
                      </td>
                      <td className="ts-r">{value(d)}</td>
                      <td className={d.is_overdue ? 'text-danger' : 'ts-muted'}>
                        {view === 'open' ? (d.expected_close_date ? formatDate(d.expected_close_date) : '—') : d.closed_at ? formatDate(d.closed_at) : '—'}
                      </td>
                      {teamView && <td className="ts-muted">{d.owner_name}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className={`ts-list ${PHONE_ONLY}`}>
              {shown.map((d) => (
                <Link key={d.id} to={`/pipeline/${d.id}`} className="ts-li !grid-cols-[minmax(0,1fr)_auto] !items-start">
                  <div className="min-w-0">
                    <div className="ts-nm !whitespace-normal">{d.title}</div>
                    <div className="ts-sub truncate">
                      {d.company_name}
                      {teamView && ` · ${d.owner_name}`}
                      {view === 'open' && d.expected_close_date && ` · ${formatDate(d.expected_close_date)}`}
                    </div>
                  </div>
                  <span className="flex flex-col items-end gap-1 shrink-0">
                    <StageBadge deal={d} />
                    <span className="ts-amt">{value(d)}</span>
                  </span>
                </Link>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
