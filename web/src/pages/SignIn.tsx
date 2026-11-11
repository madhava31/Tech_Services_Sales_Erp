import { useState } from 'react';
import companyLogo from '../assets/brand/technicon-logo.png';
import { useAuth } from '../lib/auth';
import { Button, Notice, TextField } from '../components/ui';

function Brand() {
  return (
    <span className="ts-brand">
      <img className="ts-brand-logo" src={companyLogo} alt="Technicon Services - Advancing Analytical Science" width={207} height={44} />
    </span>
  );
}

// Sign-in, or first-run setup of the initial administrator when the database has no users.
export default function SignIn({ mode }: { mode: 'login' | 'setup' }) {
  const { login, setup } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const isSetup = mode === 'setup';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      await (isSetup ? setup : login)(username.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ts-auth min-h-screen grid grid-cols-1 tablet-lg:grid-cols-[1.05fr_1fr] gap-3 p-3 text-fg antialiased">
      {/* Brand panel */}
      <aside className="ts-card ts-white hidden tablet-lg:flex relative overflow-hidden !p-10 flex-col justify-between gap-10 select-none">
        <Brand />

        <div className="flex flex-col gap-5 max-w-[460px]">
          <p className="m-0 text-[40px] font-medium tracking-[-.025em] leading-[1.1] text-pretty">Opportunities, opportunities and follow-ups, in one view.</p>
          <p className="m-0 text-[14.5px] leading-[1.6] opacity-65 text-pretty">Log an opportunity from the customer’s site, keep the pipeline moving, and see what needs doing next.</p>
        </div>

        {/* Decorative trend curve in the brand chart colours */}
        <svg viewBox="0 0 560 180" aria-hidden="true" className="w-full max-w-[560px] h-auto">
          <defs>
            <linearGradient id="loginArea" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgb(var(--chart-fill))" stopOpacity="0.22" />
              <stop offset="100%" stopColor="rgb(var(--chart-fill))" stopOpacity="0" />
            </linearGradient>
          </defs>
          <line x1="0" x2="560" y1="150" y2="150" stroke="currentColor" strokeOpacity=".14" />
          <line x1="0" x2="560" y1="100" y2="100" stroke="currentColor" strokeOpacity=".08" strokeDasharray="3 5" />
          <line x1="0" x2="560" y1="50" y2="50" stroke="currentColor" strokeOpacity=".08" strokeDasharray="3 5" />
          <path
            d="M 0 132 C 62 128, 78 108, 140 112 C 202 116, 218 72, 280 66 C 342 60, 358 92, 420 74 C 482 56, 498 28, 560 22 L 560 160 L 0 160 Z"
            fill="url(#loginArea)"
          />
          <path
            className="ts-auth-line"
            d="M 0 132 C 62 128, 78 108, 140 112 C 202 116, 218 72, 280 66 C 342 60, 358 92, 420 74 C 482 56, 498 28, 560 22"
            fill="none"
            stroke="rgb(var(--chart-line))"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </aside>

      {/* Sign-in form */}
      <main className="grid place-items-center px-4 py-10">
        <div className="w-full max-w-[396px] flex flex-col gap-6">
          <div className="tablet-lg:hidden">
            <Brand />
          </div>

          <div className="flex flex-col gap-1.5">
            <h1 className="m-0 text-[30px] font-medium tracking-[-.025em]">{isSetup ? 'Create the first administrator' : 'Sign in'}</h1>
            <p className="ts-muted m-0 text-[14px]">
              {isSetup ? 'No accounts exist yet. This account can add everyone else.' : 'Use the account your administrator gave you.'}
            </p>
          </div>

          <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
            {error && <Notice tone="error">{error}</Notice>}
            <TextField
              label="Username"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
            <TextField
              label="Password"
              type="password"
              autoComplete={isSetup ? 'new-password' : 'current-password'}
              hint={isSetup ? 'At least 8 characters.' : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <Button type="submit" disabled={busy || !username.trim() || !password} className="w-full !py-3">
              {busy ? 'Please wait…' : isSetup ? 'Create administrator' : 'Sign in'}
            </Button>
          </form>
        </div>
      </main>
    </div>
  );
}
