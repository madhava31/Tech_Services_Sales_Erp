import { useState } from 'react';
import { ImportKind, ImportResult, api } from '../../lib/api';
import { Badge, Button, Card, CardHeader, Notice, PageHeader } from '../../components/ui';

const STEPS: { kind: ImportKind; title: string; text: string }[] = [
  { kind: 'companies', title: '1. Companies', text: 'Customers and prospects. Imported as approved.' },
  { kind: 'contacts', title: '2. Contacts', text: 'People at those companies. Phone numbers must be unique.' },
  { kind: 'deals', title: '3. Open opportunities', text: 'Needs the companies, salespeople and products in place first.' },
];

// Excel or CSV, in three steps. Nothing changes until the preview has been read and confirmed.
export default function Import() {
  const [kind, setKind] = useState<ImportKind>('companies');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [done, setDone] = useState<(ImportResult & { imported: number }) | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function choose(next: ImportKind) {
    setKind(next);
    setFile(null);
    setPreview(null);
    setDone(null);
    setError('');
  }

  async function check(selected: File) {
    setFile(selected);
    setPreview(null);
    setDone(null);
    setError('');
    setBusy(true);
    try {
      setPreview(await api.imports.preview(kind, selected));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the file.');
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      setDone(await api.imports.commit(kind, file));
      setPreview(null);
      setFile(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The import did not go through. Nothing was changed.');
    } finally {
      setBusy(false);
    }
  }

  const shown = done ?? preview;

  return (
    <div className="max-w-3xl flex flex-col gap-5">
      <PageHeader title="Import data" description="Bring in existing customers, contacts and open opportunities from Excel or CSV. Do them in this order." />

      <div className="ts-grid ts-row3 !mt-0" role="tablist" aria-label="What to import">
        {STEPS.map((s) => (
          <button
            key={s.kind}
            type="button"
            role="tab"
            aria-selected={kind === s.kind}
            onClick={() => choose(s.kind)}
            className={`text-left rounded-lg border p-3.5 ${kind === s.kind ? 'border-brand bg-brand-soft ring-1 ring-brand' : 'border-line bg-surface2 hover:bg-surface transition-colors'}`}
          >
            <span className="block text-sm font-medium">{s.title}</span>
            <span className="block text-xs text-ink-muted mt-0.5">{s.text}</span>
          </button>
        ))}
      </div>

      {error && <Notice tone="error" onDismiss={() => setError('')}>{error}</Notice>}
      {done && (
        <Notice tone="success" onDismiss={() => setDone(null)}>
          Imported {done.imported}. {done.summary.skip} skipped, {done.summary.error} with errors. Recorded in the audit log.
        </Notice>
      )}

      <Card className="p-4 sm:p-5 flex flex-col gap-3">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <label className="ts-btn ts-dark justify-center max-[860px]:min-h-11 cursor-pointer">
            {busy ? 'Checking…' : 'Choose a file'}
            <input
              type="file"
              accept=".xlsx,.csv"
              className="sr-only"
              disabled={busy}
              onChange={(e) => {
                const selected = e.target.files?.[0];
                e.target.value = '';
                if (selected) check(selected);
              }}
            />
          </label>
          <a href={`/api/admin/import/${kind}/template`} download className="text-sm font-medium text-brand">
            Download the template
          </a>
        </div>
        <p className="text-xs text-ink-muted break-words">{file ? file.name : 'Excel (.xlsx, first sheet) or CSV, up to 5,000 rows. Dates as day/month/year. The file is checked first; nothing changes yet.'}</p>
      </Card>

      {shown && (
        <Card>
          <CardHeader title={done ? 'What happened' : 'Check before importing'} />
          <div className="px-4 sm:px-5 py-3 grid grid-cols-3 gap-3 text-center border-b border-dashed border-line">
            {[
              [done ? 'Imported' : 'Will import', done ? done.imported : shown.summary.new, 'text-ok'],
              ['Skipped', shown.summary.skip, 'text-ink-muted'],
              ['With errors', shown.summary.error, shown.summary.error ? 'text-danger' : 'text-ink-muted'],
            ].map(([label, value, tone]) => (
              <div key={label as string}>
                <div className={`ts-val !mt-0 ${tone}`}>{value}</div>
                <div className="text-xs text-ink-muted">{label}</div>
              </div>
            ))}
          </div>
          <ul className="divide-y divide-dashed divide-line overflow-hidden rounded-b-card max-h-96 overflow-y-auto">
            {shown.rows.map((r) => (
              <li key={r.row} className="px-4 sm:px-5 py-2.5 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <span className="min-w-0 font-medium break-words">
                    Row {r.row}
                    {r.label && <span className="font-normal text-ink-muted"> · {r.label}</span>}
                  </span>
                  <Badge tone={r.status === 'error' ? 'neutral' : 'muted'}>{r.status === 'error' ? 'Error' : r.status === 'skip' ? 'Skipped' : 'Check'}</Badge>
                </div>
                {r.errors.map((m) => (
                  <p key={m} className="text-xs text-danger mt-0.5 break-words">
                    {m}
                  </p>
                ))}
                {r.warnings.map((m) => (
                  <p key={m} className="text-xs text-ink-muted mt-0.5 break-words">
                    {m}
                  </p>
                ))}
              </li>
            ))}
          </ul>
          {shown.rows_hidden > 0 && <p className="px-4 sm:px-5 py-2 text-xs text-subtle">And {shown.rows_hidden} more. Fix these and check the file again to see them.</p>}
          {preview && (
            <div className="px-4 sm:px-5 py-3 border-t border-dashed border-line flex flex-col sm:flex-row sm:items-center gap-3">
              <Button disabled={busy || preview.summary.new === 0} onClick={commit}>
                {preview.summary.new === 0 ? 'Nothing to import' : `Import ${preview.summary.new} ${kind}`}
              </Button>
              {preview.summary.error > 0 && <span className="text-xs text-ink-muted">Rows with errors won’t be imported. Fix the file and load it again to add them.</span>}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
