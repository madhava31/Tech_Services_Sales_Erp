import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, CompanyDetail as Company, CompanySummary } from '../../lib/api';
import CompanyPicker from '../../components/CompanyPicker';
import InstalledBaseCard, { ReordersCard } from '../../components/InstalledBase';
import { useAuth } from '../../lib/auth';
import { useLoad } from '../../lib/useLoad';
import { OUTCOME_LABELS, STAGE_LABELS, TASK_TYPE_LABELS, URGENCY_LABELS, dueLabel, formatDate, formatDateTime, formatMoney, whatsappLink } from '../../lib/labels';
import ContactLogCard from '../../components/ContactLogCard';
import DealFields, { DealDraft, EMPTY_DEAL_DRAFT, dealDraftComplete, draftToInput } from '../../components/DealFields';
import { canWriteCrm, isManagingRole } from '../../lib/roles';
import { Badge, Button, Card, CardHeader, EmptyState, Notice, OverdueBadge, TextField, LoadingCard } from '../../components/ui';

function CompanyChooser({
  title,
  description,
  exclude,
  reasonLabel,
  actionLabel,
  onCancel,
  onConfirm,
}: {
  title: string;
  description?: string;
  exclude: number;
  reasonLabel: string | null;
  actionLabel: (other: CompanySummary) => string;
  onCancel: () => void;
  onConfirm: (other: CompanySummary, reason: string) => Promise<void>;
}) {
  const [other, setOther] = useState<CompanySummary | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Card>
      <CardHeader title={title} description={description} />
      <div className="p-4 sm:p-5 flex flex-col gap-3">
        {error && <Notice tone="error">{error}</Notice>}
        {other ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError('');
              try {
                await onConfirm(other, reason);
              } catch (err) {
                setError(err instanceof Error ? err.message : 'That did not go through.');
                setBusy(false);
              }
            }}
          >
            <p className="text-sm font-medium">{other.name}{other.city ? ` · ${other.city}` : ''}</p>
            {reasonLabel && <TextField label={reasonLabel} value={reason} onChange={(e) => setReason(e.target.value)} required autoFocus />}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant={reasonLabel ? 'danger' : 'primary'} disabled={busy || (reasonLabel !== null && !reason.trim())}>
                {actionLabel(other)}
              </Button>
              <Button variant="ghost" onClick={() => setOther(null)}>
                Choose another
              </Button>
            </div>
          </form>
        ) : (
          <>
            <CompanyPicker allowCreate={false} onSelect={(c) => (c.id === exclude ? setError('Choose a different company.') : setOther(c))} />
            <div>
              <Button variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

// Keyed by id: moving between a parent and its branch, or to the company kept after a merge, is the
// same route, and the page must load the new company rather than keep showing the old one.
export default function CompanyDetail() {
  const { id } = useParams();
  return <CompanyPage key={id} id={Number(id)} />;
}

function CompanyPage({ id }: { id: number }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const company = useLoad<Company | null>(
    () =>
      api.companies.get(id).catch((err) => {
        // An old link to a company that was merged goes to the one kept.
        const movedTo = err instanceof ApiError ? (err.data as { merged_into_company_id?: number } | undefined)?.merged_into_company_id : null;
        if (movedTo) navigate(`/companies/${movedTo}`, { replace: true });
        throw err;
      }),
    null
  );
  const managing = isManagingRole(user?.role);
  const [panel, setPanel] = useState<'merge' | 'parent' | null>(null);
  const writer = canWriteCrm(user?.role);
  const [addingContact, setAddingContact] = useState(false);
  const [contact, setContact] = useState({ name: '', designation: '', department: '', phone: '', email: '' });
  const [creatingDeal, setCreatingDeal] = useState(false);
  const [dealForm, setDealForm] = useState<DealDraft>(EMPTY_DEAL_DRAFT);
  const [dealError, setDealError] = useState('');
  const [dealBusy, setDealBusy] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const c = company.data;

  async function saveDeal(e: React.FormEvent) {
    e.preventDefault();
    if (!c) return;
    setDealBusy(true);
    setDealError('');
    try {
      await api.opportunities.create({
        company_id: c.id,
        ...draftToInput(dealForm),
      });
      setCreatingDeal(false);
      setDealForm(EMPTY_DEAL_DRAFT);
      await company.reload();
    } catch (err) {
      setDealError(err instanceof Error ? err.message : 'Could not create the deal.');
    } finally {
      setDealBusy(false);
    }
  }

  async function addContact(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.companies.addContact(id, contact);
      setContact({ name: '', designation: '', department: '', phone: '', email: '' });
      setAddingContact(false);
      await company.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the contact.');
    } finally {
      setBusy(false);
    }
  }

  if (company.error) return <Notice tone="error">{company.error}</Notice>;
  if (!c) return <LoadingCard />;

  return (
    <div className="flex flex-col gap-4">
      <header className="ts-phead !mb-1">
        <div>
          <Link to="/companies" className="ts-back">
            ← Companies
          </Link>
          <h1 className="ts-title">{c.name}</h1>
          <p className="ts-muted mt-1.5">
            {[c.city, c.state, c.category, c.contact_person, c.gstin && `GSTIN ${c.gstin}`].filter(Boolean).join(' · ') || 'No details yet'}
          </p>
          {c.parent && (
            <p className="text-sm text-ink-muted">
              Branch of{' '}
              <Link to={`/companies/${c.parent.id}`} className="font-medium text-brand">
                {c.parent.name}
              </Link>
            </p>
          )}
          {(c.address || c.pincode) && <p className="text-sm text-ink-muted">{[c.address, c.pincode && `PIN ${c.pincode}`].filter(Boolean).join(' · ')}</p>}
          <div className="flex flex-wrap gap-x-4 mt-1">
            {c.phone && (
              <a href={`tel:${c.phone}`} className="text-sm font-medium text-brand">
                {c.phone}
              </a>
            )}
            {c.email && (
              <a href={`mailto:${c.email}`} className="text-sm font-medium text-brand">
                {c.email}
              </a>
            )}
          </div>
        </div>
        <span className="ts-grow" />
        {writer && c.approval_status !== 'rejected' && (
          <Link to={`/opportunities/new?company=${c.id}`} className="shrink-0 ts-btn ts-dark justify-center max-[860px]:min-h-11">
            + New opportunity
          </Link>
        )}
      </header>

      {error && <Notice tone="error" onDismiss={() => setError('')}>{error}</Notice>}
      {c.approval_status === 'pending' && (
        <div className="ts-box !bg-warnbg text-warn text-[13.5px]">
          <b>Pending approval.</b> Opportunities can be logged now; an opportunity can be opened once a manager approves this company.{' '}
          {isManagingRole(user?.role) && (
            <Link to="/approvals" className="font-medium underline">
              Review it
            </Link>
          )}
        </div>
      )}
      {c.approval_status === 'rejected' && (
        <div className="ts-warnbox !mb-0 block">
          <b>Rejected{c.approved_by_username ? ` by ${c.approved_by_username}` : ''}.</b> {c.rejection_reason}
        </div>
      )}

      {c.branches.length > 0 && (
        <Card>
          <CardHeader title={`Branches (${c.branches.length})`} />
          <ul className="divide-y divide-dashed divide-line overflow-hidden rounded-b-card">
            {c.branches.map((b) => (
              <li key={b.id}>
                <Link to={`/companies/${b.id}`} className="flex items-center justify-between gap-3 px-4 sm:px-5 py-3 hover:bg-surface transition-colors">
                  <span className="min-w-0">
                    <span className="block text-sm font-medium truncate">{b.name}</span>
                    <span className="block text-xs text-ink-muted">{b.city ?? 'No city'}</span>
                  </span>
                  <span className="text-right text-xs text-ink-muted shrink-0">
                    {b.open_deals} open · {formatMoney(b.pipeline_value, { compact: true })}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {managing && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" onClick={() => setPanel(panel === 'parent' ? null : 'parent')}>
            {c.parent ? 'Change parent company' : 'Make this a branch'}
          </Button>
          {c.parent && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError('');
                try {
                  await api.companies.update(c.id, { parent_company_id: null });
                  await company.reload();
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'Could not change the parent.');
                } finally {
                  setBusy(false);
                }
              }}
            >
              Remove parent
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setPanel(panel === 'merge' ? null : 'merge')}>
            Merge duplicate…
          </Button>
        </div>
      )}
      {panel === 'parent' && (
        <CompanyChooser
          title="Whose branch is this?"
          exclude={c.id}
          reasonLabel={null}
          actionLabel={(other) => `Make it a branch of ${other.name}`}
          onCancel={() => setPanel(null)}
          onConfirm={async (other) => {
            await api.companies.update(c.id, { parent_company_id: other.id });
            setPanel(null);
            await company.reload();
          }}
        />
      )}
      {panel === 'merge' && (
        <CompanyChooser
          title={`Merge ${c.name} into which company?`}
          description="All its contacts, opportunities, follow-ups, requirements and opportunities move to the company you choose. This one is then closed. It can’t be undone from the app."
          exclude={c.id}
          reasonLabel="Why are they the same?"
          actionLabel={(other) => `Merge into ${other.name}`}
          onCancel={() => setPanel(null)}
          onConfirm={async (other, reason) => {
            const result = await api.companies.merge(c.id, other.id, reason);
            navigate(`/companies/${result.into_company_id}`, { replace: true });
          }}
        />
      )}

      <Card>
        <CardHeader
          title="Contacts"
          action={
            writer && !addingContact ? (
              <Button size="sm" variant="secondary" onClick={() => setAddingContact(true)}>
                + Add
              </Button>
            ) : undefined
          }
        />
        {addingContact && (
          <form onSubmit={addContact} className="p-4 sm:p-5 ts-fgrid ts-g2 !mt-0 border-b border-dashed border-line">
            <TextField label="Name" value={contact.name} onChange={(e) => setContact({ ...contact, name: e.target.value })} autoFocus required />
            <TextField label="Designation" value={contact.designation} onChange={(e) => setContact({ ...contact, designation: e.target.value })} />
            <TextField label="Department" value={contact.department} onChange={(e) => setContact({ ...contact, department: e.target.value })} />
            <TextField label="Phone" type="tel" inputMode="tel" value={contact.phone} onChange={(e) => setContact({ ...contact, phone: e.target.value })} />
            <TextField label="Email" type="email" value={contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} />
            <div className="ts-span2 flex gap-2">
              <Button type="submit" size="sm" disabled={busy || !contact.name.trim()}>
                Save contact
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setAddingContact(false)}>
                Cancel
              </Button>
            </div>
          </form>
        )}
        {c.contacts.length === 0 && !addingContact && <EmptyState>No contacts yet.</EmptyState>}
        <ul className="divide-y divide-dashed divide-line overflow-hidden rounded-b-card">
          {c.contacts.map((p) => (
            <li key={p.id} className="px-4 sm:px-5 py-3 flex items-center justify-between gap-3">
              <span className="min-w-0">
                <span className="block text-sm font-medium">{p.name}</span>
                <span className="block text-xs text-ink-muted">{[p.designation, p.department, p.email].filter(Boolean).join(' · ')}</span>
              </span>
              {p.phone && (
                <span className="flex flex-col items-end gap-0.5 shrink-0">
                  <a href={`tel:${p.phone}`} className="text-sm font-medium text-brand">
                    {p.phone}
                  </a>
                  <a href={whatsappLink(p.phone, `Hello ${p.name}, this is ${user?.username ?? ''} from Technicon Services.`)} target="_blank" rel="noreferrer noopener" className="text-xs font-medium text-ink-muted hover:text-brand">
                    WhatsApp
                  </a>
                </span>
              )}
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <CardHeader
          title="Opportunities"
          action={
            writer ? (
              <div className="flex items-center gap-2">
                {!creatingDeal && (
                  <Button size="sm" variant="secondary" onClick={() => setCreatingDeal(true)}>
                    + New opportunity
                  </Button>
                )}
                <Link to="/pipeline" className="text-sm font-medium text-brand">
                  Pipeline
                </Link>
              </div>
            ) : undefined
          }
        />
        {creatingDeal && (
          <form onSubmit={saveDeal} className="p-4 sm:p-5 border-b border-dashed border-line flex flex-col gap-4">
            <h4 className="text-base font-medium">New opportunity for {c.name}</h4>
            {dealError && <Notice tone="error">{dealError}</Notice>}
            <DealFields companyId={c.id} value={dealForm} onChange={(patch) => setDealForm({ ...dealForm, ...patch })} />
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={dealBusy || !dealDraftComplete(dealForm)}>
                Open opportunity
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setCreatingDeal(false);
                  setDealForm(EMPTY_DEAL_DRAFT);
                  setDealError('');
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
        {c.opportunities.length === 0 && !creatingDeal && (
          <EmptyState>No opportunities yet. Open one with “+ New opportunity”.</EmptyState>
        )}
        <ul className="divide-y divide-dashed divide-line overflow-hidden rounded-b-card">
          {c.opportunities.map((o) => (
            <li key={o.id}>
              <Link to={`/pipeline/${o.id}`} className="flex items-center justify-between gap-3 px-4 sm:px-5 py-3 hover:bg-surface transition-colors">
                <span className="min-w-0">
                  <span className="block text-sm font-medium truncate">{o.title}</span>
                  <span className="block text-xs text-ink-muted">
                    {o.owner_name} · {formatMoney(o.won_value ?? o.estimated_value, { compact: true })}
                  </span>
                </span>
                <span className="flex flex-col items-end gap-1 shrink-0">
                  <Badge tone={o.stage === 'won' ? 'ok' : o.stage === 'lost' || o.stage === 'abandoned' ? 'muted' : 'brand'}>{STAGE_LABELS[o.stage]}</Badge>
                  {o.is_overdue && <OverdueBadge />}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </Card>

      <ContactLogCard entries={c.contact_log} />
      <InstalledBaseCard companyId={c.id} contacts={c.contacts} />
      <ReordersCard companyId={c.id} contacts={c.contacts} />

      {c.tasks.length > 0 && (
        <Card>
          <CardHeader title="Open follow-ups" />
          <ul className="divide-y divide-dashed divide-line overflow-hidden rounded-b-card">
            {c.tasks.map((t) => (
              <li key={t.id} className="px-4 sm:px-5 py-3 flex items-center justify-between gap-3">
                <span className="text-sm min-w-0">
                  {t.title}
                  <span className="block text-xs text-ink-muted">
                    {TASK_TYPE_LABELS[t.task_type]} · {t.assignee_name}
                  </span>
                </span>
                <span className="text-xs font-medium text-ink-muted whitespace-nowrap">{dueLabel(t.due_date)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {c.requirements.length > 0 && (
        <Card>
          <CardHeader title="Requirements" />
          <ul className="divide-y divide-dashed divide-line overflow-hidden rounded-b-card">
            {c.requirements.map((r) => (
              <li key={r.id} className="px-4 sm:px-5 py-3">
                <p className="text-sm font-medium">{r.description}</p>
                <p className="text-xs text-ink-muted mt-0.5">
                  {[
                    r.product_category,
                    r.quantity != null && `${r.quantity} ${r.unit ?? ''}`.trim(),
                    r.budget != null && `₹${r.budget.toLocaleString('en-IN')}`,
                    r.urgency !== 'normal' && URGENCY_LABELS[r.urgency],
                    formatDate(r.created_at),
                    r.salesperson_name,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <CardHeader title="Opportunity history" />
        {c.visits.length === 0 && <EmptyState>No opportunities recorded{user?.role === 'salesperson' ? ' by you' : ''} yet.</EmptyState>}
        <ul className="divide-y divide-dashed divide-line overflow-hidden rounded-b-card">
          {c.visits.map((v) => (
            <li key={v.id}>
              <Link to={`/visits/${v.id}`} className="flex items-center justify-between gap-3 px-4 sm:px-5 py-3 hover:bg-surface transition-colors">
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{formatDateTime(v.visited_at)}</span>
                  <span className="block text-xs text-ink-muted truncate">
                    {v.salesperson_name}
                    {v.contact_name && ` · ${v.contact_name}`}
                    {v.notes && ` · ${v.notes}`}
                  </span>
                </span>
                {v.status === 'draft' ? <Badge tone="muted">To finish</Badge> : v.outcome && <Badge>{OUTCOME_LABELS[v.outcome]}</Badge>}
              </Link>
            </li>
          ))}
        </ul>
      </Card>

      <p className="text-xs text-subtle">
        Added by {c.created_by_username} on {formatDate(c.created_at)}
      </p>
    </div>
  );
}
