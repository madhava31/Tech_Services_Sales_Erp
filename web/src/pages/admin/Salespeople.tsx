import { useState } from 'react';
import { api, Salesperson, SalespersonInput } from '../../lib/api';
import { useLoad } from '../../lib/useLoad';
import { Badge, Button, Card, CardHeader, EmptyState, Notice, PageHeader, TextField } from '../../components/ui';

const EMPTY: SalespersonInput = { employee_code: '', name: '', phone: '', email: '', erp_sales_engineer_id: null, id_prefix: '' };

function toInput(s: Salesperson): SalespersonInput {
  return { employee_code: s.employee_code, name: s.name, phone: s.phone ?? '', email: s.email ?? '', erp_sales_engineer_id: s.erp_sales_engineer_id, id_prefix: s.id_prefix };
}

function SalespersonFields({ value, onChange }: { value: SalespersonInput; onChange: (v: SalespersonInput) => void }) {
  return (
    <>
      <TextField label="Name" value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} />
      <TextField label="Employee code" value={value.employee_code} onChange={(e) => onChange({ ...value, employee_code: e.target.value })} />
      <TextField
        label="ID letters"
        value={value.id_prefix ?? ''}
        onChange={(e) => onChange({ ...value, id_prefix: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) })}
        placeholder="From the name"
        hint={`Their opportunity IDs: TS-${value.id_prefix || (value.name.trim()[0] ?? 'G').toUpperCase()}-0001. Left empty, it comes from the name. A change applies to new opportunities only.`}
      />
      <TextField label="Phone" type="tel" inputMode="tel" value={value.phone ?? ''} onChange={(e) => onChange({ ...value, phone: e.target.value })} />
      <TextField label="Email" type="email" inputMode="email" value={value.email ?? ''} onChange={(e) => onChange({ ...value, email: e.target.value })} />
      <TextField
        label="ERP sales engineer ID"
        inputMode="numeric"
        hint="Optional. Their ID in Technicon Services ERP, for quotation attribution."
        value={value.erp_sales_engineer_id ?? ''}
        onChange={(e) => onChange({ ...value, erp_sales_engineer_id: e.target.value === '' ? null : Number(e.target.value) })}
      />
    </>
  );
}

export default function Salespeople() {
  const list = useLoad(api.salespeople.list, []);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<SalespersonInput>(EMPTY);
  const [editing, setEditing] = useState<{ id: number; value: SalespersonInput } | null>(null);

  async function run(action: () => Promise<unknown>, success: string) {
    if (busy) return false;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      setNotice(success);
      await list.reload();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  const activeCount = list.data.filter((s) => s.is_active).length;

  return (
    <div>
      <PageHeader title="Salespeople" description="The people who own opportunities, follow-ups and opportunities. Link each one to a login on the Users page." />

      <div className="flex flex-col gap-5">
        {error && <Notice tone="error" onDismiss={() => setError('')}>{error}</Notice>}
        {notice && <Notice tone="success" onDismiss={() => setNotice('')}>{notice}</Notice>}
        {list.error && <Notice tone="error">{list.error}</Notice>}

        <Card>
          <CardHeader title="Add a salesperson" />
          <form
            className="p-4 sm:p-5 ts-fgrid ts-g3 !mt-0"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await run(() => api.salespeople.create(draft), `${draft.name.trim()} added.`)) setDraft(EMPTY);
            }}
          >
            <SalespersonFields value={draft} onChange={setDraft} />
            <div className="flex items-end">
              <Button type="submit" className="w-full" disabled={busy || !draft.name.trim() || !draft.employee_code.trim()}>
                Add salesperson
              </Button>
            </div>
          </form>
        </Card>

        <Card>
          <CardHeader title="All salespeople" description={`${activeCount} active · ${list.data.length - activeCount} inactive`} />
          {list.data.length === 0 && !list.loading && <EmptyState>No salespeople yet.</EmptyState>}
          <ul className="divide-y divide-dashed divide-line overflow-hidden rounded-b-card">
            {list.data.map((s) => (
              <li key={s.id} className={`px-4 sm:px-5 py-4 ${s.is_active ? '' : 'bg-surface'}`}>
                <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`font-medium ${s.is_active ? '' : 'text-subtle'}`}>{s.name}</span>
                      <Badge>{s.employee_code}</Badge>
                      <Badge tone="brand">TS-{s.id_prefix}</Badge>
                      {s.is_active ? <Badge tone="ok">Active</Badge> : <Badge tone="muted">Inactive</Badge>}
                    </div>
                    <div className="text-xs text-ink-muted mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
                      <span>{s.username ? `Login: ${s.username}${s.user_is_active ? '' : ' (deactivated)'}` : 'No login yet'}</span>
                      {s.phone && <a href={`tel:${s.phone}`} className="hover:text-brand">{s.phone}</a>}
                      {s.email && <span>{s.email}</span>}
                      {s.erp_sales_engineer_id && <span>ERP engineer #{s.erp_sales_engineer_id}</span>}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {s.is_active && (
                      <Button size="sm" variant="secondary" onClick={() => setEditing({ id: s.id, value: toInput(s) })}>
                        Edit
                      </Button>
                    )}
                    {s.is_active ? (
                      <Button size="sm" variant="danger" disabled={busy} onClick={() => run(() => api.salespeople.deactivate(s.id), `${s.name} deactivated.`)}>
                        Deactivate
                      </Button>
                    ) : (
                      <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => api.salespeople.reactivate(s.id), `${s.name} reactivated.`)}>
                        Reactivate
                      </Button>
                    )}
                  </div>
                </div>

                {editing?.id === s.id && (
                  <form
                    className="ts-box ts-fgrid ts-g3 !mt-4"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      if (await run(() => api.salespeople.update(s.id, editing.value), `${editing.value.name.trim()} updated.`)) setEditing(null);
                    }}
                  >
                    <SalespersonFields value={editing.value} onChange={(value) => setEditing({ id: s.id, value })} />
                    <div className="flex items-end gap-2">
                      <Button type="submit" size="sm" disabled={busy}>
                        Save
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                        Cancel
                      </Button>
                    </div>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
