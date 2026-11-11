import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, CompanyDetail, CompanySummary } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useOutbox } from '../../lib/outbox';
import { isManagingRole } from '../../lib/roles';
import CompanyPicker from '../../components/CompanyPicker';
import { Button, Card, CardHeader, Notice, PageHeader, SelectField, TextField } from '../../components/ui';

// Step 1: pick (or register) the company. Step 2: who you're meeting. Then the draft visit is
// created and the salesperson finishes it after the meeting on the visit page.
export default function NewVisit() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [company, setCompany] = useState<CompanyDetail | null>(null);
  const [contactChoice, setContactChoice] = useState<string>('');
  const [newContact, setNewContact] = useState({ name: '', designation: '', department: '', phone: '' });
  const [salespeople, setSalespeople] = useState<{ id: number; name: string }[]>([]);
  const [salespersonId, setSalespersonId] = useState<number | ''>(user?.salesperson_id ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // One id per attempt: a double-tap or a retry after a timeout returns the same visit.
  const clientUuid = useMemo(() => crypto.randomUUID(), []);
  const managing = isManagingRole(user?.role);
  const { online } = useOutbox();

  async function selectCompany(c: CompanySummary & { primary_contact_id?: number | null }) {
    setError('');
    try {
      const detail = await api.companies.get(c.id);
      setCompany(detail);
      const preset = c.primary_contact_id ?? (detail.contacts.length === 1 ? detail.contacts[0].id : null);
      setContactChoice(preset ? String(preset) : detail.contacts.length ? '' : 'new');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the company.');
    }
  }

  useEffect(() => {
    const preselected = Number(params.get('company'));
    if (preselected) selectCompany({ id: preselected, name: '', city: null, phone: null, approval_status: 'approved' });
    if (managing) api.directory.salespeople().then(setSalespeople).catch(() => undefined);
    // Runs once on open.
  }, []);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    if (!company) return;
    setBusy(true);
    setError('');
    try {
      const assigned = managing && salespersonId ? Number(salespersonId) : undefined;
      const result = await api.visits.start(
        {
          company_id: company.id,
          client_uuid: clientUuid,
          // The time of arrival, even if this only reaches the server hours later.
          visited_at: new Date().toISOString(),
          salesperson_id: assigned,
          ...(contactChoice === 'new'
            ? newContact.name.trim()
              ? { contact: newContact }
              : {}
            : contactChoice
              ? { contact_id: Number(contactChoice) }
              : {}),
        },
        {
          company_name: company.name,
          company_city: company.city,
          contact_name: contactChoice === 'new' ? newContact.name || null : company.contacts.find((c) => String(c.id) === contactChoice)?.name ?? null,
          salesperson_id: assigned ?? user?.salesperson_id ?? 0,
          salesperson_name: salespeople.find((s) => s.id === assigned)?.name ?? user?.username ?? '',
          company_approval_status: company.approval_status,
        }
      );
      navigate(result.queued ? `/visits/local/${clientUuid}` : `/visits/${result.data.id}`, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the opportunity.');
      setBusy(false);
    }
  }

  return (
    <div className="max-w-3xl">
      <PageHeader title="Log an opportunity" description="Start it when you arrive; finish it with the outcome after the meeting." />
      {error && <div className="mb-4"><Notice tone="error">{error}</Notice></div>}

      {!company ? (
        <Card className="p-4 sm:p-5">
          <CompanyPicker onSelect={selectCompany} allowCreate={online} />
        </Card>
      ) : (
        <Card>
          <CardHeader
            title={company.name}
            description={[company.city, company.phone].filter(Boolean).join(' · ') || undefined}
            action={
              <Button size="sm" variant="ghost" onClick={() => setCompany(null)}>
                Change
              </Button>
            }
          />
          <form onSubmit={start} className="p-4 sm:p-5 flex flex-col gap-4">
            <SelectField label="Meeting with" value={contactChoice} onChange={(e) => setContactChoice(e.target.value)}>
              <option value="">Not decided yet</option>
              {company.contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.designation ? ` — ${c.designation}` : ''}
                </option>
              ))}
              <option value="new">+ Someone new</option>
            </SelectField>

            {contactChoice === 'new' && (
              <div className="ts-fgrid ts-g2 !mt-0">
                <TextField label="Name" value={newContact.name} onChange={(e) => setNewContact({ ...newContact, name: e.target.value })} autoFocus />
                <TextField label="Designation" value={newContact.designation} onChange={(e) => setNewContact({ ...newContact, designation: e.target.value })} />
                <TextField label="Department" value={newContact.department} onChange={(e) => setNewContact({ ...newContact, department: e.target.value })} />
                <TextField label="Phone" type="tel" inputMode="tel" value={newContact.phone} onChange={(e) => setNewContact({ ...newContact, phone: e.target.value })} />
              </div>
            )}

            {managing && (
              <SelectField
                label="Salesperson"
                value={salespersonId}
                onChange={(e) => setSalespersonId(e.target.value ? Number(e.target.value) : '')}
                hint="Whose opportunity is this?"
              >
                <option value="">Select…</option>
                {salespeople.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </SelectField>
            )}

            <Button type="submit" disabled={busy || (managing && !salespersonId) || (contactChoice === 'new' && !newContact.name.trim())} className="h-12">
              {busy ? 'Starting…' : 'Start opportunity'}
            </Button>
          </form>
        </Card>
      )}
    </div>
  );
}
