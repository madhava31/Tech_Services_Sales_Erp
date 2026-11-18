import { useEffect, useState } from 'react';
import companyLogo from '../assets/brand/technicon-logo.png';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Button, Notice, PasswordField, TextField } from '../components/ui';

function Shell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="ts-auth min-h-screen grid place-items-center p-4 text-fg antialiased">
      <div className="w-full max-w-[396px] flex flex-col gap-6">
        <span className="ts-brand">
          <img className="ts-brand-logo" src={companyLogo} alt="Technicon Services - Advancing Analytical Science" width={207} height={44} />
        </span>
        <div className="flex flex-col gap-1.5">
          <h1 className="m-0 text-[28px] font-medium tracking-[-.025em]">{title}</h1>
          <p className="ts-muted m-0 text-[14px]">{subtitle}</p>
        </div>
        {children}
      </div>
    </div>
  );
}

// Counts down after a code is sent, so "Send again" isn't pressed in a hurry (the server enforces it too).
function useCooldown(): [number, () => void] {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);
  return [left, () => setLeft(45)];
}

// Shown right after signing in with a temporary password: nothing else opens until a new one is set. The
// registered mobile is the one the admin entered, so it can be seen but not changed here.
export function SetPassword() {
  const { user, logout } = useAuth();
  const [info, setInfo] = useState<{ phone: string | null; can_send: boolean } | null>(null);
  const [sent, setSent] = useState(false);
  const [otp, setOtp] = useState('');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [wait, startWait] = useCooldown();

  useEffect(() => {
    api.auth.otpInfo().then(setInfo).catch((err) => setError(err.message));
  }, []);

  async function send() {
    setBusy(true);
    setError('');
    try {
      await api.auth.firstLoginSend();
      setSent(true);
      startWait();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the code.');
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (next !== again) {
      setError('The two new passwords don’t match.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.auth.firstLoginComplete(info?.can_send ? { new_password: next, otp: otp.trim() } : { new_password: next, current_password: current });
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set the password.');
      setBusy(false);
    }
  }

  const viaCode = Boolean(info?.can_send);
  return (
    <Shell title="Set your own password" subtitle={`Welcome${user ? `, ${user.username}` : ''}. Your administrator gave you a temporary password. Choose your own before you start.`}>
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {error && <Notice tone="error" onDismiss={() => setError('')}>{error}</Notice>}
        {info === null && !error && <p className="ts-muted text-sm">Loading…</p>}
        {info && viaCode && (
          <>
            <TextField label="Your registered mobile" value={info.phone ?? ''} readOnly disabled hint="Added by your administrator. It can’t be changed here." />
            {!sent ? (
              <Button type="button" onClick={() => void send()} disabled={busy} className="w-full !py-3">
                {busy ? 'Sending…' : 'Send code to this number'}
              </Button>
            ) : (
              <>
                <TextField label="Code from the text message" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} required autoFocus />
                <button type="button" className="ts-lnk text-left text-sm disabled:opacity-60" disabled={busy || wait > 0} onClick={() => void send()}>
                  {wait > 0 ? `Send the code again in ${wait}s` : 'Send the code again'}
                </button>
              </>
            )}
          </>
        )}
        {info && !viaCode && (
          <>
            <p className="ts-box text-[13.5px] m-0">
              {info.phone ? 'Text messages are not set up yet, so enter the temporary password instead.' : 'No mobile number is registered for you yet. Enter the temporary password, and ask your administrator to add your number.'}
            </p>
            <PasswordField label="Temporary password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
          </>
        )}
        {info && (!viaCode || sent) && (
          <>
            <PasswordField label="New password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" hint="At least 8 characters." required />
            <PasswordField label="New password again" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" required />
            <Button type="submit" disabled={busy || !next || !again || (viaCode ? otp.length !== 6 : !current)} className="w-full !py-3">
              {busy ? 'Please wait…' : 'Set password'}
            </Button>
          </>
        )}
        <button type="button" className="ts-lnk text-sm text-left" onClick={() => void logout()}>
          Sign out
        </button>
      </form>
    </Shell>
  );
}

// Signed out: the username asks for a code, which goes to the registered mobile.
export function ForgotPassword({ onBack }: { onBack: () => void }) {
  const [username, setUsername] = useState('');
  const [sent, setSent] = useState(false);
  const [done, setDone] = useState(false);
  const [otp, setOtp] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [wait, startWait] = useCooldown();

  async function send() {
    setBusy(true);
    setError('');
    try {
      await api.auth.forgotSend(username.trim());
      setSent(true);
      startWait();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the code.');
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (next !== again) {
      setError('The two new passwords don’t match.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.auth.forgotReset(username.trim(), otp.trim(), next);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reset the password.');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Shell title="Password changed" subtitle="Sign in with your new password.">
        <Button onClick={onBack} className="w-full !py-3">
          Go to sign in
        </Button>
      </Shell>
    );
  }
  return (
    <Shell title="Forgot your password?" subtitle="We’ll text a code to the mobile number your administrator registered for you.">
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {error && <Notice tone="error" onDismiss={() => setError('')}>{error}</Notice>}
        <TextField label="Username" autoComplete="username" autoCapitalize="none" autoCorrect="off" value={username} onChange={(e) => setUsername(e.target.value)} disabled={sent} required />
        {!sent ? (
          <Button type="button" onClick={() => void send()} disabled={busy || !username.trim()} className="w-full !py-3">
            {busy ? 'Sending…' : 'Send code'}
          </Button>
        ) : (
          <>
            <p className="ts-box text-[13.5px] m-0">If that username has a registered mobile number, a code is on its way.</p>
            <TextField label="Code from the text message" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} required autoFocus />
            <button type="button" className="ts-lnk text-left text-sm disabled:opacity-60" disabled={busy || wait > 0} onClick={() => void send()}>
              {wait > 0 ? `Send the code again in ${wait}s` : 'Send the code again'}
            </button>
            <PasswordField label="New password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" hint="At least 8 characters." required />
            <PasswordField label="New password again" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" required />
            <Button type="submit" disabled={busy || otp.length !== 6 || !next || !again} className="w-full !py-3">
              {busy ? 'Please wait…' : 'Set new password'}
            </Button>
          </>
        )}
        <button type="button" className="ts-lnk text-sm text-left" onClick={onBack}>
          Back to sign in
        </button>
      </form>
    </Shell>
  );
}
