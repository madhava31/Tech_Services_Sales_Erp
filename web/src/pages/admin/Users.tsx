import { useState } from 'react';
import { api, Salesperson, UserAccount, UserAssignment } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useLoad } from '../../lib/useLoad';
import { MANAGER_ROLES, ROLE_OPTIONS, Role, isAdminRole, roleLabel } from '../../lib/roles';
import { Badge, Button, Card, CardHeader, EmptyState, Notice, PageHeader, PasswordField, SelectField, TextField } from '../../components/ui';

const EMPTY_ASSIGNMENT: UserAssignment = { role: 'salesperson', salesperson_id: null, manager_user_id: null };

function AssignmentFields({
  value,
  onChange,
  salespeople,
  managers,
}: {
  value: UserAssignment;
  onChange: (v: UserAssignment) => void;
  salespeople: Salesperson[];
  managers: UserAccount[];
}) {
  const needsSalesperson = value.role === 'salesperson';
  return (
    <>
      <SelectField label="Role" value={value.role} onChange={(e) => onChange({ ...value, role: e.target.value as Role })}>
        {ROLE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </SelectField>
      <SelectField
        label={needsSalesperson ? 'Salesperson record (required)' : 'Salesperson record'}
        value={value.salesperson_id ?? ''}
        onChange={(e) => onChange({ ...value, salesperson_id: e.target.value ? Number(e.target.value) : null })}
        hint={salespeople.length === 0 ? 'Every active salesperson already has a login. Add new ones on the Salespeople page.' : undefined}
      >
        <option value="">{needsSalesperson ? 'Select…' : 'None'}</option>
        {salespeople.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name} ({s.employee_code}){s.user_id && s.user_is_active === false ? ` — replaces deactivated login ${s.username}` : ''}
          </option>
        ))}
      </SelectField>
      <SelectField
        label="Reports to"
        value={value.manager_user_id ?? ''}
        onChange={(e) => onChange({ ...value, manager_user_id: e.target.value ? Number(e.target.value) : null })}
      >
        <option value="">None</option>
        {managers.map((m) => (
          <option key={m.id} value={m.id}>
            {m.username} — {roleLabel(m.role)}
          </option>
        ))}
      </SelectField>
    </>
  );
}

type Panel = { kind: 'edit'; value: UserAssignment } | { kind: 'deactivate'; reason: string } | { kind: 'password'; password: string };

export default function Users() {
  const { user: me } = useAuth();
  const users = useLoad(api.users.list, []);
  const salespeople = useLoad(api.salespeople.list, []);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [newUser, setNewUser] = useState({ username: '', password: '', ...EMPTY_ASSIGNMENT });
  const [open, setOpen] = useState<{ id: number; panel: Panel } | null>(null);

  const managers = users.data.filter((u) => u.is_active && MANAGER_ROLES.includes(u.role));
  const activeSalespeople = salespeople.data.filter((s) => s.is_active);
  const activeCount = users.data.filter((u) => u.is_active).length;

  async function run(action: () => Promise<unknown>, success: string) {
    if (busy) return false;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      setNotice(success);
      await Promise.all([users.reload(), salespeople.reload()]);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const { username, password, ...assignment } = newUser;
    if (await run(() => api.users.create({ username: username.trim(), password, ...assignment }), `Account "${username.trim()}" created.`)) {
      setNewUser({ username: '', password: '', ...EMPTY_ASSIGNMENT });
    }
  }

  async function submitPanel(u: UserAccount, panel: Panel) {
    const ok =
      panel.kind === 'edit'
        ? await run(() => api.users.update(u.id, panel.value), `${u.username} updated.`)
        : panel.kind === 'deactivate'
          ? await run(() => api.users.deactivate(u.id, panel.reason), `${u.username} deactivated and signed out. Their records are kept.`)
          : await run(() => api.users.resetPassword(u.id, panel.password), `Password reset for ${u.username}. They have been signed out.`);
    if (ok) setOpen(null);
  }

  return (
    <div>
      <PageHeader title="Users" description="Logins and roles. Accounts are deactivated, never deleted, so history stays attributed." />

      <div className="flex flex-col gap-5">
        {error && <Notice tone="error" onDismiss={() => setError('')}>{error}</Notice>}
        {notice && <Notice tone="success" onDismiss={() => setNotice('')}>{notice}</Notice>}
        {users.error && <Notice tone="error">{users.error}</Notice>}

        <Card>
          <CardHeader title="Add a user" />
          <form onSubmit={create} className="p-4 sm:p-5 ts-fgrid ts-g3 !mt-0">
            <TextField
              label="Username"
              autoCapitalize="none"
              autoCorrect="off"
              value={newUser.username}
              onChange={(e) => setNewUser({ ...newUser, username: e.target.value })}
            />
            <PasswordField
              label="Temporary password"
              autoComplete="new-password"
              hint="At least 8 characters."
              value={newUser.password}
              onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
            />
            <AssignmentFields
              value={newUser}
              onChange={(v) => setNewUser({ ...newUser, ...v })}
              salespeople={activeSalespeople.filter((s) => !s.user_id || s.user_is_active === false)}
              managers={managers}
            />
            <div className="flex items-end">
              <Button
                type="submit"
                className="w-full"
                disabled={busy || !newUser.username.trim() || !newUser.password || (newUser.role === 'salesperson' && !newUser.salesperson_id)}
              >
                Create account
              </Button>
            </div>
          </form>
        </Card>

        <Card>
          <CardHeader title="All users" description={`${activeCount} active · ${users.data.length - activeCount} deactivated`} />
          {users.data.length === 0 && !users.loading && <EmptyState>No users yet.</EmptyState>}
          <ul className="divide-y divide-dashed divide-line overflow-hidden rounded-b-card">
            {users.data.map((u) => {
              const panel = open?.id === u.id ? open.panel : null;
              return (
                <li key={u.id} className={`px-4 sm:px-5 py-4 ${u.is_active ? '' : 'bg-surface'}`}>
                  <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`font-medium ${u.is_active ? '' : 'text-subtle'}`}>{u.username}</span>
                        <Badge tone={isAdminRole(u.role) ? 'brand' : 'neutral'}>{roleLabel(u.role)}</Badge>
                        {u.is_active ? <Badge tone="ok">Active</Badge> : <Badge tone="muted">Deactivated</Badge>}
                        {u.id === me?.id && <Badge tone="muted">You</Badge>}
                      </div>
                      <div className="text-xs text-ink-muted mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
                        {u.salesperson_name && <span>Salesperson: {u.salesperson_name}</span>}
                        {u.manager_username && <span>Reports to: {u.manager_username}</span>}
                        {u.deactivated_at && <span>Deactivated {new Date(u.deactivated_at).toLocaleDateString('en-IN')}</span>}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {u.is_active ? (
                        <>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() =>
                              setOpen({ id: u.id, panel: { kind: 'edit', value: { role: u.role, salesperson_id: u.salesperson_id, manager_user_id: u.manager_user_id } } })
                            }
                          >
                            Edit
                          </Button>
                          <Button size="sm" variant="secondary" onClick={() => setOpen({ id: u.id, panel: { kind: 'password', password: '' } })}>
                            Reset password
                          </Button>
                          {u.id !== me?.id && (
                            <Button size="sm" variant="danger" onClick={() => setOpen({ id: u.id, panel: { kind: 'deactivate', reason: '' } })}>
                              Deactivate
                            </Button>
                          )}
                        </>
                      ) : (
                        <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => api.users.reactivate(u.id), `${u.username} reactivated.`)}>
                          Reactivate
                        </Button>
                      )}
                    </div>
                  </div>

                  {panel && (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        submitPanel(u, panel);
                      }}
                      className="ts-box ts-fgrid ts-g3 !mt-4"
                    >
                      {panel.kind === 'edit' && (
                        <AssignmentFields
                          value={panel.value}
                          onChange={(value) => setOpen({ id: u.id, panel: { kind: 'edit', value } })}
                          salespeople={activeSalespeople.filter((s) => !s.user_id || s.user_id === u.id)}
                          managers={managers.filter((m) => m.id !== u.id)}
                        />
                      )}
                      {panel.kind === 'deactivate' && (
                        <div className="col-span-full">
                          <p className="text-sm text-ink-muted mb-3">
                            {u.username} will be signed out immediately and can't sign in again. Nothing they created is deleted, and you can
                            reactivate the account later.
                          </p>
                          <TextField
                            label="Reason (optional)"
                            placeholder="e.g. Left the company"
                            maxLength={500}
                            value={panel.reason}
                            onChange={(e) => setOpen({ id: u.id, panel: { kind: 'deactivate', reason: e.target.value } })}
                          />
                        </div>
                      )}
                      {panel.kind === 'password' && (
                        <PasswordField
                          label="New password"
                          autoComplete="new-password"
                          hint="At least 8 characters. They will be signed out everywhere."
                          value={panel.password}
                          onChange={(e) => setOpen({ id: u.id, panel: { kind: 'password', password: e.target.value } })}
                        />
                      )}
                      <div className="col-span-full flex gap-2">
                        <Button type="submit" size="sm" variant={panel.kind === 'deactivate' ? 'danger' : 'primary'} disabled={busy}>
                          {panel.kind === 'edit' ? 'Save' : panel.kind === 'deactivate' ? 'Deactivate account' : 'Set password'}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setOpen(null)}>
                          Cancel
                        </Button>
                      </div>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      </div>
    </div>
  );
}
