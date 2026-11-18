import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ServiceReportSummary } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatDate } from '../../lib/labels';
import { canWriteCrm } from '../../lib/roles';
import { Badge, DESKTOP_ONLY, EmptyState, Notice, PHONE_ONLY, PHONE_TOUCH, PageHeader, SearchBox, SkeletonRows, rowStagger } from '../../components/ui';

const VIEWS: ['all' | 'draft' | 'completed', string][] = [
  ['all', 'All'],
  ['draft', 'Drafts'],
  ['completed', 'Completed'],
];

// Every field service report you can see: yours, or everyone's for a manager.
export default function ServiceReports() {
  const { user } = useAuth();
  const [view, setView] = useState<'all' | 'draft' | 'completed'>('all');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<ServiceReportSummary[] | null>(null);
  const [error, setError] = useState('');
  const teamView = user?.role !== 'salesperson';

  useEffect(() => {
    setRows(null);
    setError('');
    const t = setTimeout(() => {
      api.serviceReports
        .list({ status: view === 'all' ? undefined : view, q: q.trim() || undefined })
        .then(setRows)
        .catch((err) => setError(err.message));
    }, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [view, q]);

  return (
    <div>
      <PageHeader
        title="Service reports"
        description={teamView ? 'Every field service report across the team.' : 'Your field service reports.'}
        actions={
          canWriteCrm(user?.role) && (
            <Link to="/service-reports/new" className="ts-btn ts-dark justify-center max-[860px]:min-h-11">
              + New service report
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
          <SearchBox label="Search service reports" placeholder="Number, company, instrument or serial no" value={q} onChange={(e) => setQ(e.target.value)} />
          {rows && <span className="ts-showing ts-muted">{rows.length} shown</span>}
        </div>
        {rows === null && !error && <SkeletonRows />}
        {rows && rows.length === 0 && <EmptyState>No service reports{q ? ' match this search' : ' yet'}.</EmptyState>}
        {rows && rows.length > 0 && (
          <>
            <div className={`ts-tblwrap ${DESKTOP_ONLY}`}>
              <table>
                <thead>
                  <tr>
                    <th>Number</th>
                    <th>Company</th>
                    <th>Instrument</th>
                    <th>Attended</th>
                    <th>Engineer</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.id} style={rowStagger(i)}>
                      <td className="ts-muted tabular-nums whitespace-nowrap">{r.code}</td>
                      <td className="ts-wrap">
                        <Link to={`/service-reports/${r.id}`} className="ts-lnk font-medium">
                          {r.company_name}
                        </Link>
                      </td>
                      <td className="ts-wrap">
                        {[r.instrument_make, r.instrument_name].filter(Boolean).join(' ')}
                        {r.serial_no ? <small className="block ts-muted">{r.serial_no}</small> : null}
                      </td>
                      <td className="ts-muted">{formatDate(r.call_attended_date)}</td>
                      <td className="ts-muted">{r.engineer_name}</td>
                      <td>
                        <Badge tone={r.status === 'completed' ? 'ok' : 'muted'}>{r.status === 'completed' ? 'Completed' : 'Draft'}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className={`ts-list ${PHONE_ONLY}`}>
              {rows.map((r) => (
                <Link key={r.id} to={`/service-reports/${r.id}`} className="ts-li !grid-cols-[minmax(0,1fr)_auto] !items-start">
                  <div className="min-w-0">
                    <div className="ts-nm !whitespace-normal">{r.company_name}</div>
                    <div className="ts-sub truncate">
                      {r.code} · {[r.instrument_make, r.instrument_name].filter(Boolean).join(' ')}
                    </div>
                    <div className="ts-sub">{formatDate(r.call_attended_date)} · {r.engineer_name}</div>
                  </div>
                  <Badge tone={r.status === 'completed' ? 'ok' : 'muted'}>{r.status === 'completed' ? 'Completed' : 'Draft'}</Badge>
                </Link>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
