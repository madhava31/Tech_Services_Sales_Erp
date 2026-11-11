import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, Opportunity, Outcome, RequirementInput, TaskType, Urgency, VisitDetail as Visit } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { myItems, syncOutbox, syncedVisitId, useOutbox } from '../../lib/outbox';
import {
  OUTCOME_HELP,
  OUTCOME_LABELS,
  OUTCOME_NEEDS_FOLLOW_UP,
  OUTCOME_NEEDS_REQUIREMENT,
  TASK_TYPE_LABELS,
  STAGE_LABELS,
  URGENCY_LABELS,
  dueLabel,
  formatMoney,
  formatDate,
  formatDateTime,
  localDate,
} from '../../lib/labels';
import { canWriteCrm } from '../../lib/roles';
import DealFields, { DealDraft, EMPTY_DEAL_DRAFT, dealDraftComplete, draftToInput } from '../../components/DealFields';
import { Badge, Button, Card, CardHeader, Notice, SelectField, TextAreaField, TextField, LoadingCard } from '../../components/ui';

type RequirementDraft = Omit<RequirementInput, 'quantity' | 'budget'> & { quantity: string; budget: string };
type FollowUpDraft = { task_type: TaskType; title: string; due_date: string; priority: 'normal' | 'high' };
// `fields` is absent in drafts saved before deals had their full set of fields.
type DealChoice = { mode: 'none' | 'existing' | 'new'; id?: number; fields?: DealDraft };
const NO_DEAL: DealChoice = { mode: 'none' };
// Mirrors OUTCOME_STAGE in api/routes/visits.js: outcomes that may open a new deal.
const OUTCOME_CAN_OPEN_DEAL: Outcome[] = ['interested', 'follow_up_needed', 'quotation_requested'];

interface CompletionDraft {
  // Absent in drafts saved before deals existed.
  deal?: DealChoice;
  outcome: Outcome | '';
  notes: string;
  requirements: RequirementDraft[];
  followUp: FollowUpDraft;
  wantsFollowUp: boolean;
}

const EMPTY_REQUIREMENT: RequirementDraft = { description: '', product_category: '', quantity: '', unit: '', budget: '', urgency: 'normal', purchase_timeline: '', decision_maker: '' };

function defaultFollowUp(outcome: Outcome | '', companyName: string): FollowUpDraft {
  if (outcome === 'quotation_requested') return { task_type: 'send_quotation', title: `Send quotation to ${companyName}`, due_date: localDate(2), priority: 'high' };
  if (outcome === 'no_meeting') return { task_type: 'visit', title: `Revisit ${companyName}`, due_date: localDate(3), priority: 'normal' };
  return { task_type: 'call', title: `Follow up with ${companyName}`, due_date: localDate(3), priority: 'normal' };
}

// The half-filled completion form survives a refresh or an accidental back on this device.
const storageKey = (id: number | string) => `visit-completion-${id}`;
function loadDraft(id: number | string): CompletionDraft | null {
  try {
    const raw = localStorage.getItem(storageKey(id));
    return raw ? (JSON.parse(raw) as CompletionDraft) : null;
  } catch {
    return null;
  }
}
function saveDraft(id: number | string, draft: CompletionDraft) {
  try {
    localStorage.setItem(storageKey(id), JSON.stringify(draft));
  } catch {
    // Storage unavailable (private mode); the form still works.
  }
}
function clearDraft(id: number | string) {
  try {
    localStorage.removeItem(storageKey(id));
  } catch {
    // ignore
  }
}

export default function VisitDetail() {
  const { id } = useParams();
  const visitId = Number(id);
  const { user } = useAuth();
  const navigate = useNavigate();
  const [visit, setVisit] = useState<Visit | null>(null);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    api.visits.get(visitId).then(setVisit).catch((err) => setLoadError(err.message));
  }, [visitId]);

  if (loadError) return <Notice tone="error">{loadError}</Notice>;
  if (!visit) return <LoadingCard />;

  return (
    <div className="max-w-3xl flex flex-col gap-4">
      <header className="ts-phead !block !mb-1">
        <Link to="/visits" className="ts-back">
          ← Opportunities
        </Link>
        <Link to={`/companies/${visit.company_id}`} className="ts-title block hover:text-brand">
          {visit.company_name}
        </Link>
        <p className="ts-muted mt-1.5">
          {formatDateTime(visit.visited_at)} · {visit.salesperson_name}
          {visit.contact_name && ` · with ${visit.contact_name}${visit.contact_designation ? ` (${visit.contact_designation})` : ''}`}
        </p>
        {visit.contact_phone && (
          <a href={`tel:${visit.contact_phone}`} className="text-sm font-medium text-brand">
            Call {visit.contact_phone}
          </a>
        )}
      </header>

      {visit.status === 'draft' && canWriteCrm(user?.role) ? (
        <CompleteVisitForm visit={visit} onCompleted={setVisit} onQueued={() => navigate('/', { replace: true })} />
      ) : (
        <CompletedVisit visit={visit} />
      )}
    </div>
  );
}

// A visit started without signal: it exists only on this phone until the connection returns, but can
// still be finished, and the two are sent together.
export function LocalVisitDetail() {
  const uuid = useParams().uuid ?? '';
  const navigate = useNavigate();
  const [visit, setVisit] = useState<Visit | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    (async () => {
      const item = (await myItems()).find((i) => i.meta.kind === 'visit.create' && i.meta.uuid === uuid);
      if (item && item.meta.kind === 'visit.create') {
        setVisit({ ...item.meta.visit, id: 0, contact_id: null, contact_designation: null, contact_phone: null, status: 'draft', outcome: null, completed_at: null, opportunity_id: null, opportunity_title: null, opportunity_stage: null, requirements: [], tasks: [] });
        return;
      }
      // Already sent since this page was opened.
      const id = await syncedVisitId(uuid);
      if (id) navigate(`/visits/${id}`, { replace: true });
      else setMissing(true);
    })();
  }, [uuid, navigate]);

  if (missing) return <Notice tone="error">This opportunity isn’t on this phone any more.</Notice>;
  if (!visit) return <LoadingCard />;
  return (
    <div className="max-w-3xl flex flex-col gap-4">
      <header className="ts-phead !block !mb-1">
        <h1 className="ts-title">{visit.company_name}</h1>
        <p className="ts-muted mt-1.5">
          {formatDateTime(visit.visited_at)}
          {visit.contact_name && ` · with ${visit.contact_name}`}
        </p>
        <p className="ts-due ts-warn mt-2">Saved on this phone, waiting to send</p>
      </header>
      <CompleteVisitForm visit={visit} localUuid={uuid} onCompleted={() => navigate('/', { replace: true })} onQueued={() => navigate('/', { replace: true })} />
    </div>
  );
}

function CompletedVisit({ visit }: { visit: Visit }) {
  return (
    <>
      <Card className="p-4 sm:p-5">
        <div className="flex items-center gap-2">
          {visit.outcome ? <Badge tone="brand">{OUTCOME_LABELS[visit.outcome]}</Badge> : <Badge tone="muted">Not finished</Badge>}
          {visit.completed_at && <span className="text-xs text-subtle">Completed {formatDateTime(visit.completed_at)}</span>}
        </div>
        {visit.opportunity_id && (
          <Link to={`/pipeline/${visit.opportunity_id}`} className="mt-2 inline-block text-sm font-medium text-brand">
            Opportunity: {visit.opportunity_title}
            {visit.opportunity_stage && ` · ${STAGE_LABELS[visit.opportunity_stage]}`}
          </Link>
        )}
        {visit.notes && <p className="text-sm mt-3 whitespace-pre-wrap">{visit.notes}</p>}
      </Card>
      {visit.requirements.length > 0 && (
        <Card>
          <CardHeader title="Requirements" />
          <ul className="divide-y divide-dashed divide-line overflow-hidden rounded-b-card">
            {visit.requirements.map((r) => (
              <li key={r.id} className="px-4 sm:px-5 py-3">
                <p className="text-sm font-medium">{r.description}</p>
                <p className="text-xs text-ink-muted mt-0.5">
                  {[
                    r.product_category,
                    r.quantity != null && `${r.quantity} ${r.unit ?? ''}`.trim(),
                    r.budget != null && `Budget ₹${r.budget.toLocaleString('en-IN')}`,
                    r.purchase_timeline && `Buying: ${r.purchase_timeline}`,
                    r.decision_maker && `Decides: ${r.decision_maker}`,
                    r.urgency !== 'normal' && URGENCY_LABELS[r.urgency],
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
                {r.specification && <p className="text-xs text-ink-muted mt-1 whitespace-pre-wrap">{r.specification}</p>}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {visit.tasks.length > 0 && (
        <Card>
          <CardHeader title="Next steps" />
          <ul className="divide-y divide-dashed divide-line overflow-hidden rounded-b-card">
            {visit.tasks.map((t) => (
              <li key={t.id} className="px-4 sm:px-5 py-3 flex items-center justify-between gap-3">
                <span className="text-sm">
                  {t.title} <span className="text-ink-muted">· {TASK_TYPE_LABELS[t.task_type]}</span>
                </span>
                <span className="text-xs text-ink-muted whitespace-nowrap">{t.status === 'open' ? dueLabel(t.due_date) : t.status}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

function CompleteVisitForm({ visit, localUuid, onCompleted, onQueued }: { visit: Visit; localUuid?: string; onCompleted: (v: Visit) => void; onQueued: () => void }) {
  // A visit started offline has no server id yet, so its half-filled form is kept under its local id.
  const draftKey = localUuid ?? visit.id;
  const { online } = useOutbox();
  const [draft, setDraft] = useState<CompletionDraft>(
    () =>
      loadDraft(draftKey) ?? {
        outcome: '',
        notes: visit.notes ?? '',
        requirements: [{ ...EMPTY_REQUIREMENT }],
        followUp: defaultFollowUp('', visit.company_name),
        wantsFollowUp: false,
      }
  );
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [openDeals, setOpenDeals] = useState<Opportunity[]>([]);
  const deal = draft.deal ?? NO_DEAL;
  const dealFields = deal.fields ?? EMPTY_DEAL_DRAFT;

  useEffect(() => saveDraft(draftKey, draft), [draftKey, draft]);
  useEffect(() => {
    if (localUuid) return;
    api.opportunities
      .list({ company_id: visit.company_id, status: 'open' })
      .then(setOpenDeals)
      .catch(() => setOpenDeals([]));
  }, [visit.company_id, localUuid]);

  const needsRequirement = draft.outcome !== '' && OUTCOME_NEEDS_REQUIREMENT.includes(draft.outcome);
  const needsFollowUp = draft.outcome !== '' && OUTCOME_NEEDS_FOLLOW_UP.includes(draft.outcome);
  const showFollowUp = needsFollowUp || draft.wantsFollowUp;
  const companyApproved = visit.company_approval_status === 'approved';
  // A new deal needs the live product list, so it waits for a connection; the visit doesn't.
  const canOpenDeal = companyApproved && online && !localUuid && draft.outcome !== '' && OUTCOME_CAN_OPEN_DEAL.includes(draft.outcome);

  function chooseOutcome(outcome: Outcome) {
    setDraft((d) => {
      const current = d.deal ?? NO_DEAL;
      // Suggest a deal: the company's open one, or a new one when the customer has a real need.
      const fields = current.fields ?? EMPTY_DEAL_DRAFT;
      const suggested: DealChoice =
        current.mode !== 'none'
          ? current
          : openDeals.length
            ? { ...current, mode: 'existing', id: openDeals[0].id }
            : companyApproved && OUTCOME_CAN_OPEN_DEAL.includes(outcome)
              ? { ...current, mode: 'new', fields: { ...fields, title: fields.title || d.requirements[0]?.description || '' } }
              : current;
      const deal = suggested.mode === 'new' && !OUTCOME_CAN_OPEN_DEAL.includes(outcome) ? { ...suggested, mode: 'none' as const } : suggested;
      return { ...d, outcome, followUp: defaultFollowUp(outcome, visit.company_name), deal };
    });
  }
  function setDeal(patch: Partial<DealChoice>) {
    setDraft((d) => ({ ...d, deal: { ...(d.deal ?? NO_DEAL), ...patch } }));
  }
  function setDealFields(patch: Partial<DealDraft>) {
    setDraft((d) => {
      const current = d.deal ?? NO_DEAL;
      return { ...d, deal: { ...current, fields: { ...(current.fields ?? EMPTY_DEAL_DRAFT), ...patch } } };
    });
  }
  function setRequirement(i: number, patch: Partial<RequirementDraft>) {
    setDraft((d) => ({ ...d, requirements: d.requirements.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  }

  async function saveNotes() {
    setError('');
    setNotice('');
    try {
      // Always kept on this phone; a visit that has reached the server also saves them there.
      if (!localUuid && online) await api.visits.update(visit.id, { notes: draft.notes });
      setNotice(localUuid || !online ? 'Notes saved on this phone.' : 'Notes saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
    }
  }

  async function complete(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.outcome) return;
    setBusy(true);
    setError('');
    const requirements: RequirementInput[] = draft.requirements
      .filter((r) => r.description.trim())
      .map((r) => ({
        ...r,
        quantity: r.quantity === '' ? null : Number(r.quantity),
        budget: r.budget === '' ? null : Number(r.budget),
        urgency: r.urgency as Urgency,
      }));
    try {
      const result = await api.visits.finish(localUuid ? { uuid: localUuid } : { id: visit.id }, visit.company_name, {
        outcome: draft.outcome,
        notes: draft.notes,
        requirements: needsRequirement || requirements.length ? requirements : [],
        follow_up: showFollowUp ? draft.followUp : null,
        opportunity:
          deal.mode === 'existing' && deal.id
            ? { id: deal.id }
            : deal.mode === 'new' && canOpenDeal
              ? draftToInput(dealFields)
              : null,
      });
      clearDraft(draftKey);
      window.scrollTo({ top: 0 });
      if (result.queued) {
        void syncOutbox();
        onQueued();
      } else onCompleted(result.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not complete the opportunity.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={complete} className="flex flex-col gap-4">
      {error && <Notice tone="error" onDismiss={() => setError('')}>{error}</Notice>}
      {notice && <Notice tone="success" onDismiss={() => setNotice('')}>{notice}</Notice>}

      <Card className="p-4 sm:p-5 flex flex-col gap-3">
        <TextAreaField label="Meeting notes" rows={4} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} placeholder="What was discussed?" />
        <div>
          <Button size="sm" variant="secondary" onClick={saveNotes}>
            Save notes for later
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader title="How did it go?" />
        <div className="p-4 sm:p-5 grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Opportunity outcome">
          {(Object.keys(OUTCOME_LABELS) as Outcome[]).map((o) => (
            <button
              key={o}
              type="button"
              role="radio"
              aria-checked={draft.outcome === o}
              aria-label={`${OUTCOME_LABELS[o]}: ${OUTCOME_HELP[o]}`}
              onClick={() => chooseOutcome(o)}
              className={`text-left rounded-ctl border px-3.5 py-3 transition-colors ${
                draft.outcome === o ? 'border-brand bg-brand-soft ring-1 ring-brand' : 'border-line bg-surface hover:bg-tile'
              }`}
            >
              <div className="text-sm font-medium">{OUTCOME_LABELS[o]}</div>
              <div className="text-xs text-ink-muted">{OUTCOME_HELP[o]}</div>
            </button>
          ))}
        </div>
      </Card>

      {draft.outcome !== '' && draft.outcome !== 'no_meeting' && (
        <Card>
          <CardHeader title={needsRequirement ? 'What does the customer need?' : 'Requirements (optional)'} />
          <div className="p-4 sm:p-5 flex flex-col gap-5">
            {draft.requirements.map((r, i) => (
              <div key={i} className={`flex flex-col gap-3 ${i > 0 ? 'pt-5 border-t border-dashed border-line' : ''}`}>
                <TextAreaField
                  label={`Requirement${draft.requirements.length > 1 ? ` ${i + 1}` : ''}`}
                  rows={2}
                  placeholder="e.g. HPLC system for the new QC lab"
                  value={r.description}
                  onChange={(e) => setRequirement(i, { description: e.target.value })}
                />
                <div className="ts-fgrid ts-g4 !mt-0">
                  <TextField label="Product category" value={r.product_category ?? ''} onChange={(e) => setRequirement(i, { product_category: e.target.value })} />
                  <TextField label="Quantity" inputMode="decimal" value={r.quantity} onChange={(e) => setRequirement(i, { quantity: e.target.value })} />
                  <TextField label="Unit" placeholder="Nos" value={r.unit ?? ''} onChange={(e) => setRequirement(i, { unit: e.target.value })} />
                  <SelectField label="Urgency" value={r.urgency} onChange={(e) => setRequirement(i, { urgency: e.target.value as Urgency })}>
                    {(Object.keys(URGENCY_LABELS) as Urgency[]).map((u) => (
                      <option key={u} value={u}>
                        {URGENCY_LABELS[u]}
                      </option>
                    ))}
                  </SelectField>
                  <TextField label="Budget (₹)" inputMode="decimal" value={r.budget} onChange={(e) => setRequirement(i, { budget: e.target.value })} />
                  <TextField label="Buying when" placeholder="e.g. this quarter" value={r.purchase_timeline ?? ''} onChange={(e) => setRequirement(i, { purchase_timeline: e.target.value })} />
                  <TextField label="Decision maker" value={r.decision_maker ?? ''} onChange={(e) => setRequirement(i, { decision_maker: e.target.value })} />
                  <TextField label="Specification" value={r.specification ?? ''} onChange={(e) => setRequirement(i, { specification: e.target.value })} />
                </div>
                {draft.requirements.length > 1 && (
                  <div>
                    <Button size="sm" variant="ghost" onClick={() => setDraft((d) => ({ ...d, requirements: d.requirements.filter((_, j) => j !== i) }))}>
                      Remove
                    </Button>
                  </div>
                )}
              </div>
            ))}
            <div>
              <Button size="sm" variant="secondary" onClick={() => setDraft((d) => ({ ...d, requirements: [...d.requirements, { ...EMPTY_REQUIREMENT }] }))}>
                + Another requirement
              </Button>
            </div>
          </div>
        </Card>
      )}

      {draft.outcome !== '' && (
        <Card>
          <CardHeader title={needsFollowUp ? 'Next follow-up' : 'Next follow-up (optional)'} />
          <div className="p-4 sm:p-5 flex flex-col gap-3">
            {!needsFollowUp && (
              <label className="flex items-center gap-2 text-sm max-[860px]:min-h-11">
                <input type="checkbox" className="ts-chk shrink-0" checked={draft.wantsFollowUp} onChange={(e) => setDraft({ ...draft, wantsFollowUp: e.target.checked })} />
                Schedule a follow-up anyway
              </label>
            )}
            {showFollowUp && (
              <div className="ts-fgrid ts-g2 !mt-0">
                <TextField label="What" value={draft.followUp.title} onChange={(e) => setDraft({ ...draft, followUp: { ...draft.followUp, title: e.target.value } })} />
                <SelectField label="Type" value={draft.followUp.task_type} onChange={(e) => setDraft({ ...draft, followUp: { ...draft.followUp, task_type: e.target.value as TaskType } })}>
                  {(Object.keys(TASK_TYPE_LABELS) as TaskType[]).map((t) => (
                    <option key={t} value={t}>
                      {TASK_TYPE_LABELS[t]}
                    </option>
                  ))}
                </SelectField>
                <TextField
                  label="When"
                  type="date"
                  min={localDate()}
                  value={draft.followUp.due_date}
                  onChange={(e) => setDraft({ ...draft, followUp: { ...draft.followUp, due_date: e.target.value } })}
                  hint={draft.followUp.due_date ? formatDate(draft.followUp.due_date) : undefined}
                />
                <SelectField label="Priority" value={draft.followUp.priority} onChange={(e) => setDraft({ ...draft, followUp: { ...draft.followUp, priority: e.target.value as 'normal' | 'high' } })}>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                </SelectField>
              </div>
            )}
          </div>
        </Card>
      )}

      {draft.outcome !== '' && companyApproved && (!online || localUuid) && OUTCOME_CAN_OPEN_DEAL.includes(draft.outcome) && (
        <p className="text-sm text-ink-muted">Opening a new opportunity needs a connection. Finish the opportunity now and open the opportunity once you’re back online.</p>
      )}

      {draft.outcome !== '' && !companyApproved && OUTCOME_CAN_OPEN_DEAL.includes(draft.outcome) && (
        <Notice tone="error">
          {visit.company_name} is waiting for a manager’s approval. You can complete this opportunity now and open an opportunity once it is approved.
        </Notice>
      )}

      {draft.outcome !== '' && (openDeals.length > 0 || canOpenDeal) && (
        <Card>
          <CardHeader
            title="Opportunity"
            description={
              draft.outcome === 'quotation_requested'
                ? 'Link the quotation request to an opportunity so the office sees it in their queue.'
                : 'Track this as part of an opportunity in the pipeline.'
            }
          />
          <div className="p-4 sm:p-5 flex flex-col gap-3" role="radiogroup" aria-label="Opportunity">
            {openDeals.map((o) => (
              <label key={o.id} className="flex items-start gap-2 text-sm max-[860px]:min-h-11 max-[860px]:items-center">
                <input
                  type="radio"
                  name="deal"
                  className="ts-chk shrink-0 mt-0.5"
                  checked={deal.mode === 'existing' && deal.id === o.id}
                  onChange={() => setDeal({ mode: 'existing', id: o.id })}
                />
                <span>
                  <span className="font-medium">{o.title}</span>
                  <span className="text-ink-muted">
                    {' '}
                    · {STAGE_LABELS[o.stage]} · {formatMoney(o.estimated_value, { compact: true })}
                  </span>
                </span>
              </label>
            ))}
            {canOpenDeal && (
              <label className="flex items-center gap-2 text-sm max-[860px]:min-h-11">
                <input type="radio" name="deal" className="ts-chk shrink-0" checked={deal.mode === 'new'} onChange={() => setDeal({ mode: 'new' })} />
                <span className="font-medium">Open a new opportunity</span>
              </label>
            )}
            <label className="flex items-center gap-2 text-sm max-[860px]:min-h-11">
              <input type="radio" name="deal" className="ts-chk shrink-0" checked={deal.mode === 'none'} onChange={() => setDeal({ mode: 'none' })} />
              Not part of an opportunity
            </label>
            {deal.mode === 'new' && canOpenDeal && (
              <div className="mt-1">
                <DealFields companyId={visit.company_id} value={dealFields} onChange={setDealFields} />
              </div>
            )}
          </div>
        </Card>
      )}

      <div className="sticky bottom-20 lg:bottom-4 z-10">
        <Button type="submit" className="w-full h-12 shadow-lg" disabled={busy || !draft.outcome || (deal.mode === 'new' && canOpenDeal && !dealDraftComplete(dealFields))}>
          {busy ? 'Saving…' : draft.outcome ? 'Complete opportunity' : 'Choose how it went to complete'}
        </Button>
      </div>
    </form>
  );
}
