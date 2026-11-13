import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, PendingCompany } from '../../lib/api';
import { useLoad } from '../../lib/useLoad';
import { formatDate } from '../../lib/labels';
import { Button, Card, EmptyState, Notice, PageHeader, TextField } from '../../components/ui';

// Companies salespeople added, waiting for a manager. A deal can't be opened on one until it's approved.
export default function Approvals() {
  const list = useLoad<PendingCompany[]>(api.companies.approvals, []);
  const [rejecting, setRejecting] = useState<number | null>(null);
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
      setReason('');
      await list.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader title="Company approvals" description="New companies from the field. Check they aren't duplicates before approving." />
      {list.error && <Notice tone="error">{list.error}</Notice>}
      {error && <Notice tone="error" onDismiss={() => setError('')}>{error}</Notice>}
      {notice && <Notice tone="success" onDismiss={() => setNotice('')}>{notice}</Notice>}
      <Card className="mt-3">
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
    </div>
  );
}
