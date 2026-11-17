import { useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { roleLabel } from '../lib/roles';
import { Button, Card, CardHeader, Notice, PageHeader, PasswordField } from '../components/ui';

// Your own account: change your password. Other phones and browsers you were signed in on are signed out.
export default function Account() {
  const { user } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setNotice('');
    if (next !== again) {
      setError('The two new passwords don’t match.');
      return;
    }
    setBusy(true);
    try {
      await api.auth.changePassword(current, next);
      setCurrent('');
      setNext('');
      setAgain('');
      setNotice('Your password has been changed. Any other phone or browser you were signed in on has been signed out.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the password.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="My account" description={user ? `${user.username} · ${roleLabel(user.role)}` : undefined} />
      {error && <Notice tone="error" onDismiss={() => setError('')}>{error}</Notice>}
      {notice && <Notice tone="success" onDismiss={() => setNotice('')}>{notice}</Notice>}
      <Card>
        <CardHeader title="Change password" />
        <form onSubmit={submit} className="p-4 sm:p-5 grid gap-4 max-w-md">
          <PasswordField label="Current password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
          <PasswordField label="New password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" hint="At least 8 characters." required />
          <PasswordField label="New password again" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" required />
          <div>
            <Button type="submit" disabled={busy || !current || !next || !again}>
              {busy ? 'Changing…' : 'Change password'}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
