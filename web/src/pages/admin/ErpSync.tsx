import { useEffect, useState } from 'react';
import { ErpCustomer, ErpStatus, api } from '../../lib/api';
import { formatDateTime } from '../../lib/labels';
import CompanyPicker from '../../components/CompanyPicker';
import { Badge, Button, Card, CardHeader, EmptyState, Notice, PageHeader } from '../../components/ui';

const STATUS: Record<string, string> = { ok: 'All good', partial: 'Partly done', failed: 'Failed', running: 'Running' };

// The connection to the Technicon Services ERP, and customers the sync couldn't match by itself.
export default function ErpSync() {
  const [status, setStatus] = useState<ErpStatus | null>(null);
  const [customers, setCustomers] = useState<ErpCustomer[]>([]);
  const [linking, setLinking] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    const [s, c] = await Promise.all([api.erp.status(), api.erp.customers()]);
    setStatus(s);
    setCustomers(c);
  }

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, []);

  async function act(action: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      if (done) setNotice(done);
      setLinking(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That didn’t go through.');
    } finally {
      setBusy(false);
    }
  }

  const last = status?.runs[0];

  return (
    <div className="max-w-3xl flex flex-col gap-5">
      <PageHeader title="ERP sync" description="Customers, products, quotations and orders, read from the Technicon Services ERP every half hour. Nothing is ever written back." />
      {error && <Notice tone="error" onDismiss={() => setError('')}>{error}</Notice>}
      {notice && <Notice tone="success" onDismiss={() => setNotice('')}>{notice}</Notice>}
      {status?.problem && (
        <Card className="p-4">
          <p className="text-sm font-medium">Not connected</p>
          <p className="text-sm text-ink-muted mt-1">{status.problem}</p>
          <p className="text-xs text-subtle mt-2">Until it’s connected, quotations are entered by hand as before.</p>
        </Card>
      )}

      {status && !status.problem && (
        <Card className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">
              {last ? `${STATUS[last.status] ?? last.status}, ${formatDateTime(last.started_at)}` : 'Connected. Not synced yet.'}
            </p>
            {last?.errors.map((e) => (
              <p key={e.part} className="text-sm text-danger mt-1 break-words">
                {e.part}: {e.message}
              </p>
            ))}
            {(last?.counts.unknown_makes?.length ?? 0) > 0 && (
              <p className="text-xs text-ink-muted mt-1 break-words">Products skipped because their make isn’t an OEM here: {last?.counts.unknown_makes?.join(', ')}. Add them under OEMs.</p>
            )}
            {(last?.counts.quotations_mismatched ?? 0) > 0 && (
              <p className="text-xs text-ink-muted mt-1">{last?.counts.quotations_mismatched} recorded quotation(s) have a number that belongs to a different customer in the ERP. Check them on their opportunities.</p>
            )}
          </div>
          <Button className="shrink-0" variant="secondary" disabled={busy} onClick={() => act(api.erp.run, 'Sync finished.')}>
            {busy ? 'Working…' : 'Sync now'}
          </Button>
        </Card>
      )}

      {status && (
        <div className="ts-grid ts-kpis">
          {[
            ['Companies linked', `${status.totals.linked} of ${status.totals.customers}`],
            ['Products', status.totals.products],
            ['Quotations', status.totals.quotations],
            ['Orders', status.totals.orders],
          ].map(([label, value]) => (
            <div key={label} className="ts-card ts-white ts-kpi-sm">
              <div className="ts-val !mt-0">{value}</div>
              <div className="text-xs text-ink-muted mt-0.5">{label}</div>
            </div>
          ))}
        </div>
      )}

      <Card>
        <CardHeader title={`Customers to match (${customers.length})`} description="In the ERP, with no clear match here. Exact names and GSTINs were matched already." />
        {customers.length === 0 && <EmptyState>Nothing waiting.</EmptyState>}
        <ul className="divide-y divide-dashed divide-line overflow-hidden rounded-b-card">
          {customers.map((c) => (
            <li key={c.id} className="px-4 sm:px-5 py-3 flex flex-col gap-2">
              <div>
                <p className="text-sm font-medium break-words">{c.name}</p>
                <p className="text-xs text-ink-muted">{[c.state, c.gstin && `GSTIN ${c.gstin}`, c.phone].filter(Boolean).join(' · ') || 'No details in the ERP'}</p>
              </div>
              {c.suggestions.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="muted">Same as?</Badge>
                  {c.suggestions.map((s) => (
                    <Button key={s.id} size="sm" variant="secondary" disabled={busy} onClick={() => act(() => api.erp.link(c.id, s.id), `${c.name} linked to ${s.name}.`)}>
                      {s.name}
                      {s.city ? `, ${s.city}` : ''}
                    </Button>
                  ))}
                </div>
              )}
              {linking === c.id ? (
                <div className="flex flex-col gap-2">
                  <CompanyPicker allowCreate={false} onSelect={(company) => act(() => api.erp.link(c.id, company.id), `${c.name} linked to ${company.name}.`)} />
                  <div>
                    <Button size="sm" variant="ghost" onClick={() => setLinking(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setLinking(c.id)}>
                    Link to a company…
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => api.erp.add(c.id), `${c.name} added as a company.`)}>
                    Add as new company
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => api.erp.ignore(c.id))}>
                    Set aside
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
