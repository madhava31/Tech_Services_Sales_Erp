import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, DeletionRequest, PendingCompany } from '../../lib/api';
import { useLoad } from '../../lib/useLoad';
import { formatDate } from '../../lib/labels';
import { impactText } from '../../lib/companyImpact';
import { Button, Card, CardHeader, EmptyState, Notice, PageHeader, TextField } from '../../components/ui';

// Companies salespeople added, waiting for a manager (a deal can't be opened on one until it's approved),
// and requests to delete a company, which only a manager or admin can grant.
export default function Approvals() {
  const list = useLoad<PendingCompany[]>(api.companies.approvals, []);
  const deletions = useLoad<DeletionRequest[]>(api.companies.deletionRequests, []);
  const [rejecting, setRejecting] = useState<number | null>(null);
  const [rejectingDeletion, setRejectingDeletion] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  async function act(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      setNotice(done);
      window.dispatchEvent(new Event('notifications-check'));
      setRejecting(null);
      setRejectingDeletion(null);
      setReason('');
      await Promise.all([list.reload(), deletions.reload()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Company approvals" description="New companies from the field, and requests to delete one. Check them before deciding." />
      {list.error && <Notice tone="error">{list.error}</Notice>}
      {deletions.error && <Notice tone="error">{deletions.error}</Notice>}
      {error && <Notice tone="error" onDismiss={() => setError('')}>{error}</Notice>}
      {notice && <Notice tone="success" onDismiss={() => setNotice('')}>{notice}</Notice>}

      <Card>
        <CardHeader title={`New companies${list.data.length ? ` (${list.data.length})` : ''}`} />
        {list.data.length === 0 && !list.loading && <EmptyState>Nothing waiting for approval.</EmptyState>}
        <ul className="divide-y divide-dashed divide-line overflow-hidden rounded-b-card">
          {list.data.map((c) => (
            <li key={c.id} className="px-4 sm:px-5 py-3 flex flex-col gap-3">
              <div>
                <Link to={`/companies/${c.id}`} className="text-sm font-medium hover:text-brand">
                  {c.name}
                </Link>
                <p className="text-xs text-ink-muted mt-0.5">
                  {[c.city, c.state, c.category, c.contact_person, c.phone].filter(Boolean).join(' · ') || 'No details yet'}
                </p>
                <p className="text-xs text-subtle">
                  Added by {c.created_by_username} on {formatDate(c.created_at)}
                </p>
              </div>
              {rejecting === c.id ? (
                <form
                  className="flex flex-col sm:flex-row sm:items-end gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    act(() => api.companies.reject(c.id, reason), `${c.name} rejected.`);
                  }}
                >
                  <div className="flex-1">
                    <TextField label="Why is it being rejected?" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus required />
                  </div>
                  <Button type="submit" variant="danger" disabled={busy || !reason.trim()}>
                    Reject
                  </Button>
                  <Button variant="ghost" onClick={() => setRejecting(null)}>
                    Cancel
                  </Button>
                </form>
              ) : (
                <div className="flex gap-2">
                  <Button disabled={busy} onClick={() => act(() => api.companies.approve(c.id), `${c.name} approved.`)}>
                    Approve
                  </Button>
                  <Button
                    variant="danger"
                    disabled={busy}
                    onClick={() => {
                      setReason('');
                      setRejectingDeletion(null);
                      setRejecting(c.id);
                    }}
                  >
                    Reject
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <CardHeader title={`Requests to delete a company${deletions.data.length ? ` (${deletions.data.length})` : ''}`} />
        {deletions.data.length === 0 && !deletions.loading && <EmptyState>No company is waiting to be deleted.</EmptyState>}
        <ul className="divide-y divide-dashed divide-line overflow-hidden rounded-b-card">
          {deletions.data.map((d) => (
            <li key={d.id} className="px-4 sm:px-5 py-3 flex flex-col gap-3">
              <div>
                <Link to={`/companies/${d.company_id}`} className="text-sm font-medium hover:text-brand">
                  {d.company_name}
                  {d.company_city ? ` (${d.company_city})` : ''}
                </Link>
                <p className="text-sm mt-0.5">“{d.reason}”</p>
                <p className="text-xs text-ink-muted mt-0.5">{impactText(d.impact)} Deleting hides the company, closes its open deals as lost and cancels its open follow-ups. The history is kept.</p>
                <p className="text-xs text-subtle">
                  Asked by {d.requested_by_name} on {formatDate(d.created_at)}
                </p>
              </div>
              {rejectingDeletion === d.id ? (
                <form
                  className="flex flex-col sm:flex-row sm:items-end gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    act(() => api.companies.rejectDeletion(d.id, reason), `${d.company_name} stays.`);
                  }}
                >
                  <div className="flex-1">
                    <TextField label="Why should it stay?" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus required />
                  </div>
                  <Button type="submit" variant="danger" disabled={busy || !reason.trim()}>
                    Keep company
                  </Button>
                  <Button variant="ghost" onClick={() => setRejectingDeletion(null)}>
                    Cancel
                  </Button>
                </form>
              ) : (
                <div className="flex gap-2">
                  <Button variant="danger" disabled={busy} onClick={() => act(() => api.companies.approveDeletion(d.id), `${d.company_name} deleted.`)}>
                    Approve deletion
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => {
                      setReason('');
                      setRejecting(null);
                      setRejectingDeletion(d.id);
                    }}
                  >
                    Keep it
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
