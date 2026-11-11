import { useEffect, useState } from 'react';
import { api, CompanySummary, DuplicateCandidate, NamedOption } from '../lib/api';
import { Badge, Button, Notice, SelectField, TextField } from './ui';

function useDebounced<T>(value: T, ms = 250) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

// Find an existing company first; only then offer to register a new one, warning about likely
// duplicates as the name is typed. Calls onSelect with the chosen or newly created company.
export default function CompanyPicker({
  onSelect,
  allowCreate,
}: {
  onSelect: (company: CompanySummary & { primary_contact_id?: number | null }) => void;
  allowCreate: boolean;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<CompanySummary[]>([]);
  const [searching, setSearching] = useState(false);
  const [creating, setCreating] = useState(false);
  const debouncedQ = useDebounced(q.trim());

  useEffect(() => {
    if (debouncedQ.length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    api.companies
      .search(debouncedQ)
      .then((rows) => !cancelled && setResults(rows))
      .catch(() => !cancelled && setResults([]))
      .finally(() => !cancelled && setSearching(false));
    return () => {
      cancelled = true;
    };
  }, [debouncedQ]);

  if (creating) {
    return <NewCompanyForm initialName={q} onCancel={() => setCreating(false)} onCreated={onSelect} onUseExisting={onSelect} />;
  }

  return (
    <div className="flex flex-col gap-3">
      <TextField
        label="Company"
        placeholder="Search by name, city or phone"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoFocus
        autoComplete="off"
        type="search"
      />
      {debouncedQ.length >= 2 && (
        <ul className="searchable-select-menu !static !max-h-none">
          {results.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => onSelect(c)} className="searchable-select-option w-full text-left">
                <div className="text-sm font-medium">
                  {c.name} {c.approval_status === 'pending' && <Badge tone="muted">Pending approval</Badge>}
                </div>
                <div className="text-xs text-ink-muted">{[c.parent_name && `Branch of ${c.parent_name}`, c.city, c.phone].filter(Boolean).join(' · ') || '—'}</div>
              </button>
            </li>
          ))}
          {!searching && results.length === 0 && <li className="searchable-select-empty">No matching company.</li>}
        </ul>
      )}
      {allowCreate && (
        <Button variant="secondary" onClick={() => setCreating(true)}>
          Can't find it? Add a new company
        </Button>
      )}
    </div>
  );
}

function NewCompanyForm({
  initialName,
  onCancel,
  onCreated,
  onUseExisting,
}: {
  initialName: string;
  onCancel: () => void;
  onCreated: (c: CompanySummary & { primary_contact_id?: number | null }) => void;
  onUseExisting: (c: CompanySummary) => void;
}) {
  const [form, setForm] = useState({ name: initialName, city: '', state: '', phone: '', email: '', address: '', pincode: '', contact_person: '', category: '' });
  // The contact person's role, saved with them as a contact.
  const [contact, setContact] = useState({ designation: '', department: '' });
  // The category list is the market segment list an admin keeps, in its set order.
  const [categories, setCategories] = useState<NamedOption[]>([]);
  useEffect(() => {
    api.catalogue.segments().then(setCategories).catch(() => setCategories([]));
  }, []);
  // Set when this is a second plant or office of a company already registered.
  const [parent, setParent] = useState<DuplicateCandidate | null>(null);
  const [duplicates, setDuplicates] = useState<DuplicateCandidate[]>([]);
  const [confirmNew, setConfirmNew] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const debounced = useDebounced(form, 400);

  useEffect(() => {
    if (debounced.name.trim().length < 3) {
      setDuplicates([]);
      return;
    }
    let cancelled = false;
    api.companies
      .checkDuplicates(debounced.name, debounced.phone, debounced.city, parent?.id)
      .then((rows) => {
        if (!cancelled) {
          setDuplicates(rows);
          setConfirmNew(false);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [debounced, parent]);

  const exact = duplicates.find((d) => d.exact);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const created = await api.companies.create({
        ...form,
        confirm_new: confirmNew,
        contact: form.contact_person.trim() ? { name: form.contact_person.trim(), designation: contact.designation, department: contact.department } : undefined,
        parent_company_id: parent?.id,
      });
      onCreated(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the company.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {error && <Notice tone="error">{error}</Notice>}
      {parent && (
        <div className="flex items-center justify-between gap-3 rounded-lg bg-brand-soft px-3 py-2 text-sm">
          <span className="min-w-0">
            Registering a branch of <b>{parent.name}</b>. Enter this branch’s city.
          </span>
          <Button size="sm" variant="ghost" onClick={() => setParent(null)}>
            Undo
          </Button>
        </div>
      )}
      <div className="ts-fgrid ts-g2 !mt-0">
        <TextField label="Company name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required autoFocus />
        <SelectField label="Category" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
          <option value="">Select…</option>
          {categories.map((c) => (
            <option key={c.id} value={c.name}>
              {c.name}
            </option>
          ))}
        </SelectField>
        <TextField label="City" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
        <TextField label="State" value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} />
        <TextField label="Address" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
        <TextField label="Pin code" inputMode="numeric" maxLength={6} value={form.pincode} onChange={(e) => setForm({ ...form, pincode: e.target.value.replace(/\D/g, '') })} />
        <TextField label="Contact person" hint="Saved as a contact, so it can be chosen on opportunities." value={form.contact_person} onChange={(e) => setForm({ ...form, contact_person: e.target.value })} />
        <TextField label="Designation" value={contact.designation} onChange={(e) => setContact({ ...contact, designation: e.target.value })} />
        <TextField label="Department" value={contact.department} onChange={(e) => setContact({ ...contact, department: e.target.value })} />
        <TextField label="Company phone" type="tel" inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        <TextField label="Company email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
      </div>

      {duplicates.length > 0 && (
        <div className={`rounded-lg border p-3 ${exact ? 'border-danger/30 bg-danger-soft' : 'border-warn/30 bg-warnbg'}`}>
          <p className="text-sm font-medium">{exact ? 'This company is already registered.' : 'Is it one of these?'}</p>
          <ul className="mt-2 flex flex-col gap-1.5">
            {duplicates.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-2">
                <span className="text-sm min-w-0">
                  {d.name}
                  <span className="text-ink-muted">{d.city ? ` · ${d.city}` : ''}</span>{' '}
                  {d.same_phone && <Badge tone="brand">same phone</Badge>}
                </span>
                <span className="flex gap-1 shrink-0">
                  <Button size="sm" variant="secondary" onClick={() => onUseExisting(d)}>
                    Use this
                  </Button>
                  {!parent && !d.parent_company_id && (
                    <Button size="sm" variant="ghost" onClick={() => setParent(d)}>
                      Add as branch
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {!exact && (
            <label className="mt-3 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={confirmNew} onChange={(e) => setConfirmNew(e.target.checked)} className="ts-chk shrink-0" />
              None of these — it's a different company
            </label>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || !form.name.trim() || !!exact || (duplicates.length > 0 && !confirmNew)}>
          {busy ? 'Saving…' : 'Add company'}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Back to search
        </Button>
      </div>
    </form>
  );
}
