import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, Visit } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { OUTCOME_LABELS, formatDateTime } from '../../lib/labels';
import { canWriteCrm } from '../../lib/roles';
import { Badge, DESKTOP_ONLY, EmptyState, Notice, PHONE_ONLY, PageHeader, SkeletonRows, rowStagger } from '../../components/ui';

const FILTERS = [
  { value: '', label: 'All' },
  { value: 'draft', label: 'To finish' },
  { value: 'completed', label: 'Completed' },
];

function Status({ visit }: { visit: Visit }) {
  if (visit.status === 'draft') return <Badge tone="muted">To finish</Badge>;
  return visit.outcome ? <Badge>{OUTCOME_LABELS[visit.outcome]}</Badge> : null;
}

export default function Visits() {
  const { user } = useAuth();
  const [status, setStatus] = useState('');
  const [visits, setVisits] = useState<Visit[] | null>(null);
  const [error, setError] = useState('');
  const teamView = user?.role !== 'salesperson';

  useEffect(() => {
    setVisits(null);
    api.visits
      .list({ status, limit: 100 })
      .then(setVisits)
      .catch((err) => setError(err.message));
  }, [status]);

  return (
    <div>
      <PageHeader
        title="Opportunities"
        description={teamView ? 'Every salesperson’s opportunities, newest first.' : 'Your opportunities, newest first.'}
        actions={
          canWriteCrm(user?.role) && (
            <Link to="/visits/new" className="ts-btn ts-dark justify-center max-[860px]:min-h-11">
              + New opportunity
            </Link>
          )
        }
      />
      {error && <Notice tone="error">{error}</Notice>}
      <section className="ts-card ts-white ts-tcard ts-tbl">
        <div className="ts-tbar">
          <div className="ts-tabs" role="tablist">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                role="tab"
                aria-selected={status === f.value}
                onClick={() => setStatus(f.value)}
                className={`ts-tab max-[860px]:min-h-11 ${status === f.value ? 'ts-on' : ''}`}
              >
                {f.label}
              </button>
            ))}
          </div>
          {visits && <span className="ts-showing ts-muted">Showing {visits.length}</span>}
        </div>
        {visits === null && !error && <SkeletonRows />}
        {visits?.length === 0 && <EmptyState>No opportunities yet.</EmptyState>}
        {visits && visits.length > 0 && (
          <>
            <div className={`ts-tblwrap ${DESKTOP_ONLY}`}>
              <table>
                <thead>
                  <tr>
                    <th>Company</th>
                    <th>Date</th>
                    <th>Met</th>
                    {teamView && <th>Salesperson</th>}
                    <th>Status</th>
                    <th className="ts-r">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visits.map((v, i) => (
                    <tr key={v.id} style={rowStagger(i)}>
                      <td>
                        <Link to={`/visits/${v.id}`} className="ts-lnk font-medium">
                          {v.company_name}
                        </Link>
                      </td>
                      <td className="ts-muted">{formatDateTime(v.visited_at)}</td>
                      <td>{v.contact_name || <span className="ts-muted">—</span>}</td>
                      {teamView && <td className="ts-muted">{v.salesperson_name}</td>}
                      <td>
                        <Status visit={v} />
                      </td>
                      <td className="ts-r">
                        <div className="ts-racts">
                          <Link to={`/visits/${v.id}`} className="ts-btn ts-ghost ts-xs">
                            {v.status === 'draft' ? 'Finish' : 'View'}
                          </Link>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className={`ts-list ${PHONE_ONLY}`}>
              {visits.map((v) => (
                <Link key={v.id} to={`/visits/${v.id}`} className="ts-li !grid-cols-[minmax(0,1fr)_auto]">
                  <div className="min-w-0">
                    <div className="ts-nm">{v.company_name}</div>
                    <div className="ts-sub truncate">
                      {formatDateTime(v.visited_at)}
                      {v.contact_name && ` · ${v.contact_name}`}
                      {teamView && ` · ${v.salesperson_name}`}
                    </div>
                  </div>
                  <Status visit={v} />
                </Link>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
