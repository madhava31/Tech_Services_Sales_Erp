import { useState } from 'react';
import { NamedOption, StageSetting, api } from '../../lib/api';
import { STAGE_LABELS } from '../../lib/labels';
import { useLoad } from '../../lib/useLoad';
import { Badge, Button, Card, CardHeader, EmptyState, Notice, PageHeader, TextField } from '../../components/ui';

// OEMs and market segments: short name lists managed by the MD or an administrator. Nothing is
// deleted; a name in use is deactivated so it stops being offered on new deals.
function NameList({ title, description, load, create, update }: {
  title: string;
  description: string;
  load: () => Promise<NamedOption[]>;
  create: (name: string) => Promise<unknown>;
  update: (id: number, data: { name?: string; is_active?: boolean }) => Promise<unknown>;
}) {
  const list = useLoad<NamedOption[]>(load, []);
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await action();
      await list.reload();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader title={title} description={description} />
      {error && (
        <div className="px-4 sm:px-5 pt-3">
          <Notice tone="error" onDismiss={() => setError('')}>{error}</Notice>
        </div>
      )}
      {list.data.length === 0 && !list.loading && <EmptyState>None yet.</EmptyState>}
      <ul className="divide-y divide-dashed divide-line overflow-hidden rounded-b-card">
        {list.data.map((row) => (
          <li key={row.id} className="px-4 sm:px-5 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            {renaming?.id === row.id ? (
              <form
                className="flex items-end gap-2 flex-1"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (await act(() => update(row.id, { name: renaming.name }))) setRenaming(null);
                }}
              >
                <div className="flex-1">
                  <TextField label="Name" value={renaming.name} onChange={(e) => setRenaming({ ...renaming, name: e.target.value })} autoFocus required />
                </div>
                <Button type="submit" size="sm" disabled={busy || !renaming.name.trim()}>
                  Save
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setRenaming(null)}>
                  Cancel
                </Button>
              </form>
            ) : (
              <>
                <span className="text-sm min-w-0">
                  <span className="font-medium">{row.name}</span>
                  {row.in_use > 0 && <span className="text-xs text-subtle"> · in use ({row.in_use})</span>}{' '}
                  {!row.is_active && <Badge tone="muted">Inactive</Badge>}
                </span>
                <span className="flex gap-1 shrink-0">
                  <Button size="sm" variant="ghost" onClick={() => setRenaming({ id: row.id, name: row.name })}>
                    Rename
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => update(row.id, { is_active: !row.is_active }))}>
                    {row.is_active ? 'Deactivate' : 'Reactivate'}
                  </Button>
                </span>
              </>
            )}
          </li>
        ))}
      </ul>
      <form
        className="px-4 sm:px-5 py-3 border-t border-dashed border-line flex items-end gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await act(() => create(name))) setName('');
        }}
      >
        <div className="flex-1">
          <TextField label="Add new" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <Button type="submit" variant="secondary" disabled={busy || !name.trim()}>
          Add
        </Button>
      </form>
    </Card>
  );
}

// How long a deal may sit in each stage before it is flagged as stuck.
function StuckLimits() {
  const list = useLoad<StageSetting[]>(api.analysis.stageSettings, []);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  async function save(row: StageSetting) {
    const value = Number(drafts[row.stage]);
    setError('');
    setSaved('');
    try {
      await api.analysis.updateStageSetting(row.stage, value);
      await list.reload();
      setDrafts((d) => {
        const { [row.stage]: _done, ...rest } = d;
        return rest;
      });
      setSaved(`${STAGE_LABELS[row.stage]} saved.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
    }
  }

  return (
    <Card>
      <CardHeader title="When an opportunity counts as stuck" description="Days an opportunity can stay in a stage before it is flagged. Set these to how long your opportunities really take." />
      {error && (
        <div className="px-4 sm:px-5 pt-3">
          <Notice tone="error" onDismiss={() => setError('')}>{error}</Notice>
        </div>
      )}
      {saved && (
        <div className="px-4 sm:px-5 pt-3">
          <Notice tone="success" onDismiss={() => setSaved('')}>{saved}</Notice>
        </div>
      )}
      <ul className="divide-y divide-dashed divide-line overflow-hidden rounded-b-card">
        {list.data.map((row) => {
          const draft = drafts[row.stage];
          const changed = draft !== undefined && Number(draft) !== row.stuck_after_days;
          return (
            <li key={row.stage} className="px-4 sm:px-5 py-2.5 flex items-center justify-between gap-3">
              <label htmlFor={`stuck-${row.stage}`} className="text-sm font-medium min-w-0">
                {STAGE_LABELS[row.stage]}
              </label>
              <span className="flex items-center gap-2 shrink-0">
                <input
                  id={`stuck-${row.stage}`}
                  inputMode="numeric"
                  className="ts-fi ts-r !w-20"
                  value={draft ?? row.stuck_after_days}
                  onChange={(e) => setDrafts({ ...drafts, [row.stage]: e.target.value.replace(/\D/g, '') })}
                />
                <span className="text-xs text-ink-muted">days</span>
                <Button size="sm" variant="secondary" disabled={!changed || !draft} onClick={() => save(row)}>
                  Save
                </Button>
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

export default function Catalogue() {
  return (
    <div className="max-w-3xl flex flex-col gap-5">
      <PageHeader title="OEMs, segments and stuck limits" description="The choices offered on every opportunity, and when an opportunity is flagged as stuck." />
      <NameList title="OEMs" description="The makes we sell." load={() => api.catalogue.oems(true)} create={api.catalogue.createOem} update={api.catalogue.updateOem} />
      <NameList title="Market segments" description="Who the opportunity is for." load={() => api.catalogue.segments(true)} create={api.catalogue.createSegment} update={api.catalogue.updateSegment} />
      <StuckLimits />
    </div>
  );
}
