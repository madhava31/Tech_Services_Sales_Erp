import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, CompanySummary } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { canWriteCrm, isManagingRole } from '../../lib/roles';
import CompanyPicker from '../../components/CompanyPicker';
import { Badge, Button, Card, DESKTOP_ONLY, EmptyState, Notice, PHONE_ONLY, PageHeader, SearchBox, SkeletonRows, rowStagger } from '../../components/ui';

export default function Companies() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<CompanySummary[] | null>(null);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      api.companies
        .search(q.trim())
        .then(setRows)
        .catch((err) => setError(err.message));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <div>
      <PageHeader
        title="Companies"
        description="Shared by the whole team — search before adding a new one."
        actions={canWriteCrm(user?.role) && !adding && <Button onClick={() => setAdding(true)}>+ Add</Button>}
      />
      {error && <Notice tone="error">{error}</Notice>}

      {adding ? (
        <Card className="p-4 sm:p-5">
          <CompanyPicker allowCreate onSelect={(c) => navigate(`/companies/${c.id}`)} />
          <Button variant="ghost" className="mt-3" onClick={() => setAdding(false)}>
            Cancel
          </Button>
        </Card>
      ) : (
        <section className="ts-card ts-white ts-tcard ts-tbl">
          <div className="ts-tbar">
            <SearchBox label="Search companies" placeholder="Name, city or phone" value={q} onChange={(e) => setQ(e.target.value)} />
            {rows && <span className="ts-showing ts-muted">Showing {rows.length}</span>}
          </div>
          {rows === null && !error && <SkeletonRows />}
          {rows?.length === 0 && <EmptyState>{q ? 'No matching companies.' : 'No companies yet.'}</EmptyState>}
          {rows && rows.length > 0 && (
            <>
              <div className={`ts-tblwrap ${DESKTOP_ONLY}`}>
                <table>
                  <thead>
                    <tr>
                      <th>Company</th>
                      <th>Branch of</th>
                      <th>City</th>
                      <th>Phone</th>
                      <th>Status</th>
                      <th className="ts-r">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((c, i) => (
                      <tr key={c.id} style={rowStagger(i)}>
                        <td>
                          <Link to={`/companies/${c.id}`} className="ts-lnk font-medium">
                            {c.name}
                          </Link>
                        </td>
                        <td className="ts-muted">{c.parent_name || '—'}</td>
                        <td className="ts-muted">{c.city || '—'}</td>
                        <td className="ts-muted">{c.phone || '—'}</td>
                        <td>{c.approval_status === 'pending' && <Badge tone="muted">Pending approval</Badge>}</td>
                        <td className="ts-r">
                          <div className="ts-racts">
                            <Link to={`/companies/${c.id}`} className="ts-btn ts-ghost ts-xs">
                              View
                            </Link>
                            {isManagingRole(user?.role) && (
                              <Link to={`/companies/${c.id}?edit=1`} className="ts-btn ts-ghost ts-xs">
                                Edit
                              </Link>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className={`ts-list ${PHONE_ONLY}`}>
                {rows.map((c) => (
                  <Link key={c.id} to={`/companies/${c.id}`} className="ts-li !grid-cols-[minmax(0,1fr)_auto]">
                    <div className="min-w-0">
                      <div className="ts-nm">{c.name}</div>
                      <div className="ts-sub truncate">{[c.parent_name && `Branch of ${c.parent_name}`, c.city, c.phone].filter(Boolean).join(' · ') || '—'}</div>
                    </div>
                    {c.approval_status === 'pending' && <Badge tone="muted">Pending approval</Badge>}
                  </Link>
                ))}
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}
