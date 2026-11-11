import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, HandoverPreview } from '../../lib/api';
import { STAGE_LABELS, formatDate, formatMoney } from '../../lib/labels';
import { Button, Card, CardHeader, EmptyState, Notice, OverdueBadge, PageHeader, SelectField, StuckBadge, TextField } from '../../components/ui';

// Move a salesperson's open deals and follow-ups to someone else — when they leave, change
// territory, or go on long leave. Closed deals, visits and history stay with them.
export default function Handover() {
  const [params] = useSearchParams();
  const [people, setPeople] = useState<{ id: number; name: string; is_active: boolean }[]>([]);
  const [fromId, setFromId] = useState<number | ''>(Number(params.get('from')) || '');
  const [toId, setToId] = useState<number | ''>('');
  const [preview, setPreview] = useState<HandoverPreview | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [includeLoose, setIncludeLoose] = useState(true);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ from: string; to: string; deals_moved: number; follow_ups_moved: number; instruments_moved: number; reorders_moved: number } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.directory.salespeople(true).then(setPeople).catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    setPreview(null);
    setError('');
    if (!fromId) return;
    api.handover
      .preview(Number(fromId))
      .then((p) => {
        setPreview(p);
        setSelected(new Set(p.deals.map((d) => d.id)));
      })
      .catch((err) => setError(err.message));
  }, [fromId, done]);

  const total = preview?.deals.filter((d) => selected.has(d.id)).reduce((s, d) => s + (d.estimated_value ?? 0), 0) ?? 0;
  const followUps = (preview?.deals.filter((d) => selected.has(d.id)).reduce((s, d) => s + d.open_tasks, 0) ?? 0) + (includeLoose ? preview?.loose_tasks ?? 0 : 0);
  const nothing = selected.size === 0 && followUps === 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!fromId || !toId) return;
    setBusy(true);
    setError('');
    try {
      const result = await api.handover.run({
        from_salesperson_id: Number(fromId),
        to_salesperson_id: Number(toId),
        reason,
        opportunity_ids: [...selected],
        include_loose_tasks: includeLoose,
      });
      setDone(result);
      setReason('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The handover did not go through.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-3xl flex flex-col gap-4">
      <PageHeader title="Hand over work" description="Move open opportunities and follow-ups to another salesperson. Closed opportunities, opportunities and history stay with the original salesperson." />
      {error && <Notice tone="error" onDismiss={() => setError('')}>{error}</Notice>}
      {done && (
        <Notice tone="success" onDismiss={() => setDone(null)}>
          Moved {done.deals_moved} opportunities, {done.follow_ups_moved} follow-up(s), {done.instruments_moved} instrument(s) and {done.reorders_moved} reorder(s) from {done.from} to {done.to}. Recorded in each opportunity’s history and the audit log.
        </Notice>
      )}

      <Card className="p-4 sm:p-5">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="ts-fgrid ts-g2 !mt-0">
            <SelectField label="From" value={fromId} onChange={(e) => setFromId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">Select…</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.is_active ? '' : ' (left)'}
                </option>
              ))}
            </SelectField>
            <SelectField label="To" value={toId} onChange={(e) => setToId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">Select…</option>
              {people
                .filter((p) => p.is_active && p.id !== fromId)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </SelectField>
          </div>

          {preview && (
            <>
              {preview.salesperson.user_is_active && (
                <p className="text-xs text-ink-muted">
                  {preview.salesperson.name} can still sign in as “{preview.salesperson.username}”. If they are leaving, deactivate the login in Admin → Users too.
                </p>
              )}
              {preview.draft_visits > 0 && (
                <p className="text-xs text-ink-muted">
                  {preview.draft_visits} unfinished opportunities stay with {preview.salesperson.name}; a manager can complete them from Opportunities.
                </p>
              )}
              <Card>
                <CardHeader
                  title={`Open opportunities (${preview.deals.length})`}
                  action={
                    preview.deals.length > 0 ? (
                      <Button size="sm" variant="ghost" onClick={() => setSelected(selected.size === preview.deals.length ? new Set() : new Set(preview.deals.map((d) => d.id)))}>
                        {selected.size === preview.deals.length ? 'Select none' : 'Select all'}
                      </Button>
                    ) : undefined
                  }
                />
                {preview.deals.length === 0 && <EmptyState>No open opportunities.</EmptyState>}
                <ul className="divide-y divide-dashed divide-line overflow-hidden rounded-b-card max-h-96 overflow-y-auto">
                  {preview.deals.map((d) => (
                    <li key={d.id} className="px-4 py-2.5">
                      <label className="flex items-start gap-3 text-sm cursor-pointer">
                        <input
                          type="checkbox"
                          className="ts-chk shrink-0 mt-0.5"
                          checked={selected.has(d.id)}
                          onChange={(e) => {
                            const next = new Set(selected);
                            if (e.target.checked) next.add(d.id);
                            else next.delete(d.id);
                            setSelected(next);
                          }}
                        />
                        <span className="flex-1 min-w-0">
                          <span className="flex items-center gap-2 min-w-0">
                            <span className="font-medium truncate">{d.title}</span>
                            {d.is_overdue && <OverdueBadge />}
                            {d.is_stuck && <StuckBadge />}
                          </span>
                          <span className="block text-xs text-ink-muted truncate">
                            {d.company_name} · {STAGE_LABELS[d.stage]}
                            {d.expected_close_date && ` · closes ${formatDate(d.expected_close_date)}`}
                            {d.open_tasks > 0 && ` · ${d.open_tasks} follow-up${d.open_tasks === 1 ? '' : 's'}`}
                          </span>
                        </span>
                        <span className="text-sm font-medium tabular-nums shrink-0">{formatMoney(d.estimated_value, { compact: true })}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </Card>
              {preview.loose_tasks + preview.instruments + preview.reorders > 0 && (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" className="ts-chk shrink-0" checked={includeLoose} onChange={(e) => setIncludeLoose(e.target.checked)} />
                  Also move {preview.loose_tasks} follow-up(s) not attached to an opportunity, {preview.instruments} instrument(s) and {preview.reorders} reorder(s)
                </label>
              )}
              <TextField label="Reason" placeholder="e.g. Resigned — handing over Hyderabad accounts" value={reason} onChange={(e) => setReason(e.target.value)} required />
              <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                <Button type="submit" disabled={busy || !toId || !reason.trim() || nothing}>
                  {busy ? 'Moving…' : `Move ${selected.size} ${selected.size === 1 ? 'opportunity' : 'opportunities'} and ${followUps} follow-up${followUps === 1 ? '' : 's'}`}
                </Button>
                <span className="text-sm text-ink-muted">{formatMoney(total, { compact: true })} of pipeline</span>
              </div>
            </>
          )}
        </form>
      </Card>

      <p className="text-xs text-subtle">
        To move a single opportunity, open it in the <Link to="/pipeline" className="underline">pipeline</Link> and use “Transfer”.
      </p>
    </div>
  );
}
