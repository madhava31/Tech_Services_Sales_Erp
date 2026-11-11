import { useEffect, useState } from 'react';
import { api, AuditEntry, UserAccount } from '../../lib/api';
import { Button, Card, EmptyState, Notice, PageHeader, SelectField, TextField } from '../../components/ui';

const RECORD_TYPES = [
  { value: '', label: 'Everything' },
  { value: 'opportunity', label: 'Opportunities' },
  { value: 'company', label: 'Companies' },
  { value: 'company_contact', label: 'Contacts' },
  { value: 'visit', label: 'Opportunities' },
  { value: 'task', label: 'Follow-ups' },
  { value: 'requirement', label: 'Requirements' },
  { value: 'product', label: 'Products' },
  { value: 'oem', label: 'OEMs' },
  { value: 'market_segment', label: 'Market segments' },
  { value: 'app_user', label: 'User accounts' },
  { value: 'salesperson', label: 'Salespeople and handovers' },
];

const NO_FILTERS = { actor_user_id: '', entity_type: '', entity_id: '', from: '', to: '' };

export default function AuditLog() {
  const [users, setUsers] = useState<UserAccount[]>([]);
  const [filters, setFilters] = useState(NO_FILTERS);
  const [rows, setRows] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.users.list().then(setUsers).catch(() => undefined);
  }, []);

  useEffect(() => {
    setError('');
    // Typing a record number shouldn't query on every digit.
    const t = setTimeout(() => {
      api.audit
        .list({ ...filters, limit: 200 })
        .then(setRows)
        .catch((err) => setError(err.message));
    }, 250);
    return () => clearTimeout(t);
  }, [filters]);

  return (
    <div>
      <PageHeader title="Audit log" description="Who did what and when, newest first. Entries can't be edited or deleted." />
      {error && <Notice tone="error">{error}</Notice>}
      <div className="ts-filters !border-0 !pt-0 !pb-0 mb-4 items-end">
        <SelectField label="User" value={filters.actor_user_id} onChange={(e) => setFilters({ ...filters, actor_user_id: e.target.value })}>
          <option value="">Everyone</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.username}
            </option>
          ))}
        </SelectField>
        <SelectField label="Record" value={filters.entity_type} onChange={(e) => setFilters({ ...filters, entity_type: e.target.value })}>
          {RECORD_TYPES.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </SelectField>
        <TextField label="Record no." inputMode="numeric" value={filters.entity_id} onChange={(e) => setFilters({ ...filters, entity_id: e.target.value.replace(/\D/g, '') })} />
        <TextField label="From" type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} />
        <TextField label="To" type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} />
      </div>
      {JSON.stringify(filters) !== JSON.stringify(NO_FILTERS) && (
        <div className="mb-3">
          <Button size="sm" variant="ghost" onClick={() => setFilters(NO_FILTERS)}>
            Clear filters
          </Button>
        </div>
      )}
      <Card>
        {rows?.length === 0 && <EmptyState>Nothing recorded for these filters.</EmptyState>}
        <ol className="divide-y divide-dashed divide-line overflow-hidden rounded-b-card">
          {rows?.map((r) => (
            <li key={r.id} className="px-4 sm:px-5 py-3 flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-4">
              <time className="text-xs text-subtle sm:w-40 shrink-0 tabular-nums" dateTime={r.at}>
                {new Date(r.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
              </time>
              <div className="min-w-0">
                <p className="text-sm break-words">{r.summary ?? r.action}</p>
                <p className="text-xs text-subtle">
                  {r.action} · by {r.actor_username ?? 'system'}
                  {r.entity_id != null && ` · record ${r.entity_id}`}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
