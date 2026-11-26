import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, DealFilters, DeletedOpportunity, Opportunity } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { STAGE_LABELS, formatDate, formatMoney } from '../../lib/labels';
import { canWriteCrm, isManagingRole } from '../../lib/roles';
import { askConfirm } from '../../lib/confirm';
import { Badge, DESKTOP_ONLY, EmptyState, Notice, OverdueBadge, PHONE_ONLY, PHONE_TOUCH, PageHeader, SearchBox, SkeletonRows, StuckBadge, rowStagger } from '../../components/ui';

type Status = NonNullable<DealFilters['status']>;
const VIEWS: [Status, string][] = [
  ['open', 'Open'],
  ['won', 'Won'],
  ['lost', 'Lost'],
];

function StageBadge({ deal }: { deal: Opportunity }) {
  return <Badge tone={deal.stage === 'won' ? 'ok' : deal.stage === 'lost' ? 'muted' : 'brand'}>{STAGE_LABELS[deal.stage]}</Badge>;
}

const value = (d: Opportunity) => formatMoney(d.won_value ?? d.estimated_value, { compact: true });

// Every opportunity as a list. A row opens the same page as its card on the Pipeline.
export default function Opportunities() {
  const { user } = useAuth();
  const teamView = user?.role !== 'salesperson';
  const [rows, setRows] = useState<Opportunity[] | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [notice, setNotice] = useState('');
  const [deleting, setDeleting] = useState<number | null>(null);

  // Managers (admin, MD, sales manager) can pick one salesperson, and see what salespeople have deleted.
  const manager = isManagingRole(user?.role);
  const [tab, setTab] = useState<Status | 'deleted'>('open');
  const [people, setPeople] = useState<{ id: number; name: string }[]>([]);
  const [ownerId, setOwnerId] = useState<number | ''>('');
  const [deletedRows, setDeletedRows] = useState<DeletedOpportunity[] | null>(null);
  useEffect(() => {
    if (teamView) api.directory.salespeople(true).then(setPeople).catch(() => undefined);
  }, [teamView]);

  useEffect(() => {
    if (tab === 'deleted') {
      setDeletedRows(null);
      setError('');
      api.opportunities
        .deleted()
        .then(setDeletedRows)
        .catch((err) => setError(err.message));
      return;
    }
    setRows(null);
    setError('');
    api.opportunities
      .list({ status: tab })
      .then(setRows)
      .catch((err) => setError(err.message));
  }, [tab]);

  async function purge(d: DeletedOpportunity) {
    if (!(await askConfirm(`Remove "${d.title}" (${d.code}) for good? This can’t be undone.`, 'Remove for good'))) return;
    setError('');
    setNotice('');
    try {
      await api.opportunities.purgeDeleted(d.id);
      setDeletedRows((current) => current?.filter((r) => r.id !== d.id) ?? null);
      setNotice(`Removed ${d.code}: “${d.title}” for good.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove it.');
    }
  }

  // The owner or a manager can delete one; a won opportunity stays.
  const canDelete = (d: Opportunity) =>
    canWriteCrm(user?.role) && d.stage !== 'won' && (isManagingRole(user?.role) || (user?.salesperson_id != null && user.salesperson_id === d.owner_salesperson_id));
  async function deleteDeal(d: Opportunity) {
    if (!(await askConfirm(`Delete "${d.title}" (${d.code})? Its history, quotations and follow-ups are removed. This can’t be undone.`, 'Delete opportunity'))) return;
    setError('');
    setNotice('');
    setDeleting(d.id);
    try {
      await api.opportunities.remove(d.id);
      setRows((current) => current?.filter((r) => r.id !== d.id) ?? null);
      setNotice(`Deleted ${d.code}: “${d.title}”.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the opportunity.');
    } finally {
      setDeleting(null);
    }
  }

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    const mine = (rows ?? []).filter((d) => ownerId === '' || d.owner_salesperson_id === ownerId);
    if (!term) return mine;
    // The ID matches with or without its dashes: "tsg12" finds TS-G-0012.
    const compact = term.replace(/[^a-z0-9]/g, '');
    return mine.filter(
      (d) => [d.title, d.company_name, d.owner_name, d.oem_name, d.code].some((v) => (v ?? '').toLowerCase().includes(term)) || (compact.length >= 2 && d.code.toLowerCase().replace(/-/g, '').includes(compact))
    );
  }, [rows, q, ownerId]);

  const shownDeleted = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (deletedRows ?? []).filter(
      (d) =>
        (ownerId === '' || d.owner_salesperson_id === ownerId) &&
        (!term || [d.title, d.company_name, d.owner_name, d.code, d.deleted_by_name].some((v) => (v ?? '').toLowerCase().includes(term)))
    );
  }, [deletedRows, q, ownerId]);
  const view: Status = tab === 'deleted' ? 'open' : tab;

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
      {error && <Notice tone="error" onDismiss={() => setError('')}>{error}</Notice>}
      {notice && <Notice tone="success" onDismiss={() => setNotice('')}>{notice}</Notice>}
      <section className="ts-card ts-white ts-tcard ts-tbl !mt-0">
        <div className="ts-tbar">
          <div className="ts-tabs" role="tablist">
            {VIEWS.map(([v, label]) => (
              <button key={v} type="button" role="tab" aria-selected={tab === v} onClick={() => setTab(v)} className={`ts-tab ${PHONE_TOUCH} ${tab === v ? 'ts-on' : ''}`}>
                {label}
              </button>
            ))}
            {manager && (
              <button type="button" role="tab" aria-selected={tab === 'deleted'} onClick={() => setTab('deleted')} className={`ts-tab ${PHONE_TOUCH} ${tab === 'deleted' ? 'ts-on' : ''}`}>
                Deleted
              </button>
            )}
          </div>
          {teamView && (
            <select aria-label="Salesperson" className="ts-fi ts-sel max-[860px]:!h-11" value={ownerId} onChange={(e) => setOwnerId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">All salespeople</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          <SearchBox label="Search opportunities" placeholder="ID, name, company or owner" value={q} onChange={(e) => setQ(e.target.value)} />
          {tab === 'deleted' ? (
            deletedRows && (
              <span className="ts-showing ts-muted">
                Showing {shownDeleted.length} of {deletedRows.length}
              </span>
            )
          ) : (
            rows && (
              <span className="ts-showing ts-muted">
                Showing {shown.length} of {rows.length}
              </span>
            )
          )}
        </div>
        {tab === 'deleted' && (
          <>
            <p className="ts-muted m-0 px-4 pt-3 text-[13px]">Opportunities a salesperson deleted from their own account. They stay here until you remove them for good.</p>
            {deletedRows === null && !error && <SkeletonRows />}
            {deletedRows && shownDeleted.length === 0 && <EmptyState>{deletedRows.length ? 'Nothing matches this search.' : 'No deleted opportunities.'}</EmptyState>}
            {shownDeleted.length > 0 && (
              <div className="ts-tblwrap">
                <table>
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Opportunity</th>
                      <th>Company</th>
                      <th>Stage</th>
                      <th className="ts-r">Value</th>
                      <th>Owner</th>
                      <th>Deleted by</th>
                      <th>Deleted</th>
                      <th className="ts-r"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {shownDeleted.map((d, i) => (
                      <tr key={d.id} style={rowStagger(i)}>
                        <td className="ts-muted tabular-nums whitespace-nowrap">{d.code}</td>
                        <td className="ts-wrap font-medium">
                          {d.title}
                          {d.reason && <div className="ts-muted text-[12px] font-normal">{d.reason}</div>}
                        </td>
                        <td className="ts-wrap">{d.company_name}</td>
                        <td>
                          <Badge tone="muted">{STAGE_LABELS[d.stage]}</Badge>
                        </td>
                        <td className="ts-r">{formatMoney(d.estimated_value == null ? null : Number(d.estimated_value), { compact: true })}</td>
                        <td className="ts-muted">{d.owner_name ?? '—'}</td>
                        <td className="ts-muted">{d.deleted_by_name ?? '—'}</td>
                        <td className="ts-muted whitespace-nowrap">{formatDate(d.deleted_at)}</td>
                        <td className="ts-r">
                          <button type="button" className="ts-lnk text-danger" onClick={() => void purge(d)}>
                            Remove for good
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
        {tab !== 'deleted' && rows === null && !error && <SkeletonRows />}
        {tab !== 'deleted' && rows && shown.length === 0 && <EmptyState>{rows.length ? 'No opportunities match this search.' : `No ${VIEWS.find(([v]) => v === view)?.[1].toLowerCase()} opportunities.`}</EmptyState>}
        {tab !== 'deleted' && shown.length > 0 && (
          <>
            <div className={`ts-tblwrap ${DESKTOP_ONLY}`}>
              <table>
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Opportunity</th>
                    <th>Company</th>
                    <th>Stage</th>
                    <th className="ts-r">Value</th>
                    <th>{view === 'open' ? 'Closing date' : 'Closed'}</th>
                    {teamView && <th>Owner</th>}
                    <th className="ts-r"></th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((d, i) => (
                    <tr key={d.id} style={rowStagger(i)}>
                      <td className="ts-muted tabular-nums whitespace-nowrap">{d.code}</td>
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
                      <td className="ts-r">
                        {canDelete(d) && (
                          <button type="button" className="ts-lnk text-danger disabled:opacity-60" disabled={deleting !== null} onClick={() => void deleteDeal(d)}>
                            {deleting === d.id ? 'Deleting…' : 'Delete'}
                          </button>
                        )}
                      </td>
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
                      <span className="tabular-nums">{d.code}</span> · {d.company_name}
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
