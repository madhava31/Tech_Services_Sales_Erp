import { useEffect, useState } from 'react';
import { DownloadIcon } from 'lucide-react';
import { api, DealFilters } from '../lib/api';
import { Button } from './ui';

const STORAGE_KEY = 'export-columns';

function remembered(): string[] | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as string[]) : null;
  } catch {
    return null;
  }
}

// Admin's Excel download: choose which columns go in the file (all by default), then download with the
// Pipeline's current filters. The choice is remembered on this device.
export default function ExportPanel({ filters, onClose }: { filters: DealFilters; onClose: () => void }) {
  const [columns, setColumns] = useState<{ key: string; label: string }[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');

  useEffect(() => {
    api.opportunities
      .exportColumns()
      .then((list) => {
        setColumns(list);
        const saved = remembered()?.filter((k) => list.some((c) => c.key === k));
        setPicked(new Set(saved && saved.length ? saved : list.map((c) => c.key)));
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load the columns.'));
  }, []);

  const toggle = (key: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // In the agreed order, whatever order they were ticked in.
  const chosen = (columns ?? []).filter((c) => picked.has(c.key)).map((c) => c.key);

  function download() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(chosen));
    } catch {
      // Remembering is a convenience; the download still works.
    }
    const a = document.createElement('a');
    a.href = api.opportunities.exportUrl({ ...filters, columns: chosen.join(',') });
    a.download = 'technicon-opportunities.xlsx';
    document.body.appendChild(a);
    a.click();
    a.remove();
    onClose();
  }

  return (
    <section className="ts-card ts-white !mt-0 p-4 sm:p-5 flex flex-col gap-3" aria-label="Download Excel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[15px] font-medium">Choose what goes in the Excel file</h2>
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" onClick={() => setPicked(new Set((columns ?? []).map((c) => c.key)))}>
            Select all
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>
            Clear
          </Button>
        </div>
      </div>
      <p className="text-xs text-subtle">The filters above decide which opportunities are in it. Columns stay in this order.</p>
      {error && <p className="text-sm text-danger">{error}</p>}
      {!columns && !error && <p className="text-sm text-subtle">Loading…</p>}
      {columns && (
        <div className="grid grid-cols-1 min-[480px]:grid-cols-2 min-[861px]:grid-cols-3 gap-x-4 gap-y-1">
          {columns.map((c) => (
            <label key={c.key} className="flex items-center gap-2.5 py-1.5 text-sm cursor-pointer max-[860px]:min-h-11">
              <input type="checkbox" className="ts-chk shrink-0" checked={picked.has(c.key)} onChange={() => toggle(c.key)} />
              {c.label}
            </label>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button onClick={download} disabled={chosen.length === 0}>
          <DownloadIcon aria-hidden="true" /> Download {chosen.length ? `${chosen.length} column${chosen.length === 1 ? '' : 's'}` : ''}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </section>
  );
}
