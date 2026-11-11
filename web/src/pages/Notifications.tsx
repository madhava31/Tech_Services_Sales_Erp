import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, NotificationList } from '../lib/api';
import { formatDateTime } from '../lib/labels';
import { currentPushSubscription, disablePush, enablePush, pushSupported } from '../lib/push';
import { useLoad } from '../lib/useLoad';
import { Button, Card, CardHeader, EmptyState, Notice, PageHeader } from '../components/ui';

// Reminders, and the choice to also get them on this phone.
export default function Notifications() {
  const list = useLoad<NotificationList | null>(api.notifications.list, null);
  const [pushOn, setPushOn] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const key = list.data?.push_public_key;

  useEffect(() => {
    currentPushSubscription().then((s) => setPushOn(Boolean(s)));
  }, []);

  useEffect(() => {
    if (list.data?.unread) {
      // Seen now. The badge in the menu updates the next time it checks.
      api.notifications.readAll().then(() => window.dispatchEvent(new Event('notifications-read'))).catch(() => undefined);
    }
  }, [list.data?.unread]);

  async function togglePush() {
    setBusy(true);
    setError('');
    try {
      if (pushOn) await disablePush();
      else await enablePush(key!);
      setPushOn(!pushOn);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change phone reminders.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-3xl flex flex-col gap-4">
      <PageHeader title="Reminders" description="Your follow-ups and overdue opportunities, each working morning." />
      {error && <Notice tone="error" onDismiss={() => setError('')}>{error}</Notice>}
      {list.error && <Notice tone="error">{list.error}</Notice>}
      <Card className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">Reminders on this phone</p>
          <p className="text-xs text-ink-muted mt-0.5">
            {!pushSupported()
              ? 'This browser can’t receive them. On an iPhone, add the app to your Home Screen first.'
              : !key
                ? 'Not set up on the server yet. They still appear here.'
                : pushOn
                  ? 'On. You’ll get one message each working morning.'
                  : 'Off. They still appear here.'}
          </p>
        </div>
        {pushSupported() && key && (
          <Button variant={pushOn ? 'secondary' : 'primary'} className="shrink-0" disabled={busy} onClick={togglePush}>
            {pushOn ? 'Turn off' : 'Turn on'}
          </Button>
        )}
      </Card>
      <Card>
        <CardHeader title="Recent" />
        {list.data?.items.length === 0 && <EmptyState>Nothing yet. Reminders arrive at 9 am when something is due.</EmptyState>}
        <ul className="divide-y divide-dashed divide-line overflow-hidden rounded-b-card">
          {list.data?.items.map((n) => (
            <li key={n.id}>
              <Link to={n.url} className="block px-4 sm:px-5 py-3 hover:bg-surface transition-colors">
                <span className={`block text-sm ${n.read_at ? '' : 'font-medium'}`}>{n.title}</span>
                <span className="block text-sm text-ink-muted">{n.body}</span>
                <span className="block text-xs text-subtle mt-0.5">{formatDateTime(n.created_at)}</span>
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
