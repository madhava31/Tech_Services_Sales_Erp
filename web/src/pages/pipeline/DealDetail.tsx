import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, DealInput, ErpQuotation, LostReason, OpportunityDetail, QuotationStatus, Stage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { askConfirm } from '../../lib/confirm';
import { useLoad } from '../../lib/useLoad';
import {
  LOST_REASON_LABELS,
  OPEN_STAGES,
  QUOTED_STAGES,
  competitorText,
  OUTCOME_LABELS,
  QUOTATION_STATUS_LABELS,
  STAGE_LABELS,
  TASK_TYPE_LABELS,
  dueLabel,
  formatDate,
  formatDateTime,
  formatIndianDigits,
  formatMoney,
  localDate,
} from '../../lib/labels';
import { canRecordQuotations, canWriteCrm, isManagingRole } from '../../lib/roles';
import DealFields, { DealDraft, dealDraftComplete, dealToDraft, draftToInput } from '../../components/DealFields';
import ContactLogCard from '../../components/ContactLogCard';
import TenderCard from '../../components/TenderCard';
import { Badge, Button, Card, CardHeader, EmptyState, Notice, OverdueBadge, SelectField, StuckBadge, TextField, LoadingCard } from '../../components/ui';

type Panel = 'won' | 'lost' | 'reopen' | 'edit' | 'transfer' | null;

export default function DealDetail() {
  const id = Number(useParams().id);
  const { user } = useAuth();
  const deal = useLoad<OpportunityDetail | null>(() => api.opportunities.get(id), null);
  const [panel, setPanel] = useState<Panel>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const d = deal.data;

  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      setNotice(success);
      setPanel(null);
      await deal.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  if (deal.error) return <Notice tone="error">{deal.error}</Notice>;
  if (!d) return <LoadingCard />;

  const open = !d.closed_at;
  const writer = canWriteCrm(user?.role);
  const stageIndex = OPEN_STAGES.indexOf(d.stage);
  // The step after the current one on the stepper. Negotiation's next step is Mark won or Mark lost.
  const nextStage = stageIndex >= 0 && stageIndex < OPEN_STAGES.length - 1 ? OPEN_STAGES[stageIndex + 1] : null;

  async function moveToNext() {
    if (!d || !nextStage) return;
    if (QUOTED_STAGES.includes(nextStage) && d.quotation_count === 0) {
      setError(`${STAGE_LABELS[nextStage]} needs the quotation first: the office or a manager records it on this opportunity.`);
      return;
    }
    if (!(await askConfirm(`Move "${d.title}" from ${STAGE_LABELS[d.stage]} to ${STAGE_LABELS[nextStage]}?`, `Move to ${STAGE_LABELS[nextStage]}`))) return;
    await run(() => api.opportunities.moveStage(d.id, { stage: nextStage }), `Moved to ${STAGE_LABELS[nextStage]}.`);
  }
  const stepInset = 100 / (2 * OPEN_STAGES.length);
  const stepFill = (100 - 2 * stepInset) * (d.stage === 'won' ? 1 : open ? stageIndex / (OPEN_STAGES.length - 1) : 0);

  return (
    <div className="flex flex-col gap-4">
      <header className="ts-phead !block !mb-1">
        <Link to={`/companies/${d.company_id}`} className="ts-back">
          ← {d.company_name}
        </Link>
        {/* ID and status first, then the name, then the facts that matter in labelled boxes. */}
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <span className="inline-flex items-center rounded-full bg-tile px-3 py-1 text-[13px] font-medium tabular-nums tracking-wide select-all" title="Opportunity ID">
            {d.code}
          </span>
          <Badge tone={d.stage === 'won' ? 'ok' : d.stage === 'lost' ? 'muted' : 'brand'}>{STAGE_LABELS[d.stage]}</Badge>
          {d.is_overdue && <OverdueBadge />}
          {d.is_stuck && <StuckBadge days={d.days_in_stage} />}
        </div>
        <h1 className="ts-title">{d.title}</h1>

        <dl className="ts-dw-meta ts-deal-facts mt-4">
          <div>
            <dt>{d.stage === 'won' ? 'Won value' : 'Order value'}</dt>
            <dd className="text-[19px] font-medium tabular-nums">{formatMoney(d.stage === 'won' ? d.won_value : d.estimated_value)}</dd>
          </div>
          {open ? (
            <div>
              <dt>Win chance</dt>
              <dd className="text-[19px] font-medium tabular-nums">{d.probability}%</dd>
            </div>
          ) : (
            <div>
              <dt>Result</dt>
              <dd className={`text-[19px] font-medium ${d.stage === 'won' ? 'text-ok' : 'text-danger'}`}>{STAGE_LABELS[d.stage]}</dd>
            </div>
          )}
          <div>
            <dt>{open ? 'Closes' : 'Closed'}</dt>
            <dd className={d.is_overdue ? 'text-danger font-medium' : ''}>
              {open ? (d.expected_close_date ? formatDate(d.expected_close_date) : '—') : d.closed_at ? formatDate(d.closed_at) : '—'}
              {d.is_overdue && ' · overdue'}
            </dd>
          </div>
          {open && (
            <div>
              <dt>In this stage</dt>
              <dd className={d.is_stuck ? 'text-warn font-medium' : ''}>
                {d.days_in_stage === null ? '—' : d.days_in_stage === 0 ? 'Since today' : `${d.days_in_stage} day${d.days_in_stage === 1 ? '' : 's'}`}
              </dd>
            </div>
          )}
          <div>
            <dt>Owner</dt>
            <dd>
              {d.owner_name}
              {d.original_owner_salesperson_id !== d.owner_salesperson_id && <small className="block text-xs ts-muted">opened by {d.original_owner_name}</small>}
            </dd>
          </div>
          <div>
            <dt>Contact person</dt>
            <dd>
              {d.contact_name ?? '—'}
              {d.contact_phone && (
                <a href={`tel:${d.contact_phone}`} className="block text-brand font-medium tabular-nums">
                  {d.contact_phone}
                </a>
              )}
            </dd>
          </div>
        </dl>
        {d.is_stuck && (
          <p className="text-[13px] text-warn mt-3">
            In {STAGE_LABELS[d.stage]} longer than the {d.stuck_after_days} days expected. What’s the next step?
          </p>
        )}
        {d.closed_at && (d.lost_reason || d.close_reason) && (
          <p className="text-sm mt-3">
            {d.lost_reason && <b className="font-medium">{LOST_REASON_LABELS[d.lost_reason]}. </b>}
            {d.close_reason}
          </p>
        )}
      </header>

      {error && <Notice tone="error" onDismiss={() => setError('')}>{error}</Notice>}
      {notice && <Notice tone="success" onDismiss={() => setNotice('')}>{notice}</Notice>}
      {open && d.erp_orders.length > 0 && (
        <div className="ts-okbox block">
          <b className="font-medium">Order in the ERP:</b> {d.erp_orders.map((o) => `${o.number}${o.client_po_ref ? ` (customer PO ${o.client_po_ref})` : ''}`).join(', ')}. Mark the opportunity won once you’ve confirmed the value.
        </div>
      )}

      {/* Stage stepper */}
      <Card className="p-5">
        <div className="ts-steps" style={{ gridTemplateColumns: `repeat(${OPEN_STAGES.length},1fr)` }} role="group" aria-label="Pipeline stage">
          <span className="ts-rail" style={{ left: `${stepInset}%`, right: `${stepInset}%` }} />
          <span className="ts-fill" style={{ left: `${stepInset}%`, width: `${stepFill}%` }} />
          {OPEN_STAGES.map((s, i) => {
            const done = d.stage === 'won' || (open && i <= stageIndex);
            return (
              <div key={s} className={`ts-step ${done ? 'ts-done' : ''} ${s === d.stage ? 'ts-cur' : ''}`} aria-current={s === d.stage ? 'step' : undefined}>
                <b />
                {STAGE_LABELS[s]}
              </div>
            );
          })}
        </div>
      </Card>

      {writer && (
        <div className="flex flex-wrap gap-2">
          {open ? (
            <>
              {nextStage && (
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => void moveToNext()} title={`Move to ${STAGE_LABELS[nextStage]}`}>
                  Move to next stage
                </Button>
              )}
              {stageIndex < OPEN_STAGES.indexOf('develop') && (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => run(() => api.opportunities.moveStage(d.id, { stage: 'develop' }), 'Moved to Develop: quotation requested. The office has it in their queue.')}
                >
                  Request quotation
                </Button>
              )}
              <Button size="sm" variant="secondary" onClick={() => setPanel('won')}>
                Mark won
              </Button>
              <Button size="sm" variant="danger" onClick={() => setPanel('lost')}>
                Mark lost
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPanel('edit')}>
                Edit details
              </Button>
              {isManagingRole(user?.role) && (
                <Button size="sm" variant="ghost" onClick={() => setPanel('transfer')}>
                  Transfer
                </Button>
              )}
            </>
          ) : (
            isManagingRole(user?.role) && (
              <Button size="sm" variant="secondary" onClick={() => setPanel('reopen')}>
                Reopen opportunity
              </Button>
            )
          )}
        </div>
      )}

      {panel && (
        <Card className="p-4 sm:p-5">
          {panel === 'reopen' && (
            <MoveForm
              current={d.stage}
              reopen
              hasQuotation={d.quotation_count > 0}
              busy={busy}
              onCancel={() => setPanel(null)}
              onSubmit={(stage, note) => run(() => api.opportunities.moveStage(d.id, { stage, note }), `Moved to ${STAGE_LABELS[stage]}.`)}
            />
          )}
          {panel === 'won' && (
            <WonForm
              suggested={d.quotations.find((q) => q.status === 'accepted')?.amount ?? d.estimated_value}
              busy={busy}
              onCancel={() => setPanel(null)}
              onSubmit={(won_value, close_reason) => run(() => api.opportunities.moveStage(d.id, { stage: 'won', won_value, close_reason }), 'Opportunity won.')}
            />
          )}
          {panel === 'lost' && (
            <LostForm
              busy={busy}
              onCancel={() => setPanel(null)}
              onSubmit={(lost_reason, close_reason) => run(() => api.opportunities.moveStage(d.id, { stage: 'lost', lost_reason, close_reason }), 'Opportunity marked lost.')}
            />
          )}
          {panel === 'edit' && (
            <EditForm deal={d} busy={busy} onCancel={() => setPanel(null)} onSubmit={(data) => run(() => api.opportunities.update(d.id, data), 'Opportunity updated.')} />
          )}
          {panel === 'transfer' && (
            <TransferForm
              ownerId={d.owner_salesperson_id}
              busy={busy}
              onCancel={() => setPanel(null)}
              onSubmit={(toId, toName, reason) =>
                run(() => api.handover.transferDeal(d.id, toId, reason), `Transferred to ${toName}, with its open follow-ups.`)
              }
            />
          )}
        </Card>
      )}

      <Card>
        <CardHeader title="Opportunity details" />
        <div className="ts-dw-meta !bg-transparent !rounded-none px-4 sm:px-5 text-sm">
          {(
            [
              ['Created', formatDate(d.created_at)],
              [d.oems.length > 1 ? 'OEMs' : 'OEM', d.oem_name],
              ['Products', [...d.products, ...(d.custom_products ?? [])].map((p) => p.name).join(', ')],
              ['Win probability', `${d.probability}%${d.probability_reason ? ` · ${d.probability_reason}` : ''}`],
              ['Competitor', competitorText(d.competitor, d.competitor_note)],
              ['Tender', d.tender ? 'Yes' : 'No'],
              ['Market segment', d.segments.map((s) => s.name).join(', ')],
              ['Comments', d.notes],
            ] as [string, string | null][]
          ).map(([label, value]) => (
            <div key={label} className="min-w-0">
              <span>{label}</span>
              <b className="font-normal break-words whitespace-pre-wrap">{value || '—'}</b>
            </div>
          ))}
        </div>
      </Card>

      {d.tender && <TenderCard deal={d} canEdit={writer} onChanged={deal.reload} />}
      {d.stage === 'won' && writer && (
        <Card className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <p className="text-sm">Installed at the customer? Record it to get warranty and AMC reminders.</p>
          <Link to={`/companies/${d.company_id}?install_deal=${d.id}`} className="shrink-0 ts-btn ts-ghost justify-center max-[860px]:min-h-11">
            Record as installed
          </Link>
        </Card>
      )}

      <Quotations deal={d} canRecord={canRecordQuotations(user?.role)} onChanged={deal.reload} onError={setError} />

      {d.requirements.length > 0 && (
        <Card>
          <CardHeader title="Requirements" />
          <ul className="divide-y divide-dashed divide-line overflow-hidden rounded-b-card">
            {d.requirements.map((r) => (
              <li key={r.id} className="px-4 sm:px-5 py-3">
                <p className="text-sm font-medium">{r.description}</p>
                <p className="text-xs text-ink-muted">
                  {[r.product_category, r.quantity != null && `${r.quantity} ${r.unit ?? ''}`.trim(), r.budget != null && `Budget ${formatMoney(r.budget)}`]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {d.tasks.length > 0 && (
        <Card>
          <CardHeader title="Follow-ups" />
          <ul className="divide-y divide-dashed divide-line overflow-hidden rounded-b-card">
            {d.tasks.map((t) => (
              <li key={t.id} className="px-4 sm:px-5 py-3 flex items-center justify-between gap-3">
                <span className={`text-sm ${t.status !== 'open' ? 'text-subtle line-through' : ''}`}>
                  {t.title} <span className="text-ink-muted no-underline">· {TASK_TYPE_LABELS[t.task_type]}</span>
                </span>
                <span className="text-xs text-ink-muted whitespace-nowrap">{t.status === 'open' ? dueLabel(t.due_date) : t.status}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <ContactLogCard entries={d.contact_log} />

      {d.visits.length > 0 && (
        <Card>
          <CardHeader title="Opportunities" />
          <ul className="divide-y divide-dashed divide-line overflow-hidden rounded-b-card">
            {d.visits.map((v) => (
              <li key={v.id}>
                <Link to={`/visits/${v.id}`} className="flex items-center justify-between gap-3 px-4 sm:px-5 py-3 hover:bg-surface transition-colors">
                  <span className="text-sm">
                    {formatDateTime(v.visited_at)} <span className="text-ink-muted">· {v.salesperson_name}</span>
                  </span>
                  {v.outcome && <Badge>{OUTCOME_LABELS[v.outcome]}</Badge>}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <CardHeader title="History" />
        <ol className="px-4 sm:px-5 py-3 flex flex-col gap-3">
          {d.history.map((h) => (
            <li key={h.id} className="text-sm">
              <span className="font-medium">
                {h.change_type === 'created'
                  ? `Opened at ${STAGE_LABELS[h.to_value as Stage] ?? h.to_value}`
                  : h.change_type === 'owner'
                    ? `Transferred to ${h.to_value}`
                    : h.change_type === 'field'
                      ? `${h.field}: ${h.from_value ?? '—'} → ${h.to_value}`
                      : `${STAGE_LABELS[h.from_value as Stage] ?? h.from_value} → ${STAGE_LABELS[h.to_value as Stage] ?? h.to_value}`}
              </span>
              <span className="block text-xs text-ink-muted">
                {formatDateTime(h.changed_at)} · {h.changed_by_username}
                {h.note && ` · ${h.note}`}
              </span>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}

function TransferForm({
  ownerId,
  busy,
  onCancel,
  onSubmit,
}: {
  ownerId: number;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (toId: number, toName: string, reason: string) => void;
}) {
  const [people, setPeople] = useState<{ id: number; name: string }[]>([]);
  const [toId, setToId] = useState<number | ''>('');
  const [reason, setReason] = useState('');
  useEffect(() => {
    api.directory.salespeople().then((list) => setPeople(list.filter((p) => p.id !== ownerId))).catch(() => undefined);
  }, [ownerId]);
  return (
    <form
      className="ts-fgrid ts-g2 !mt-0"
      onSubmit={(e) => {
        e.preventDefault();
        if (toId) onSubmit(toId, people.find((p) => p.id === toId)?.name ?? '', reason);
      }}
    >
      <SelectField label="Transfer to" value={toId} onChange={(e) => setToId(e.target.value ? Number(e.target.value) : '')}>
        <option value="">Select…</option>
        {people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </SelectField>
      <TextField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Customer is in their territory" required />
      <div className="ts-span2 flex gap-2">
        <Button type="submit" size="sm" disabled={busy || !toId || !reason.trim()}>
          Transfer opportunity
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function MoveForm({
  current,
  reopen,
  hasQuotation,
  busy,
  onCancel,
  onSubmit,
}: {
  current: Stage;
  reopen: boolean;
  hasQuotation: boolean;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (stage: Stage, note: string) => void;
}) {
  const options = OPEN_STAGES.filter((s) => s !== current);
  const [stage, setStage] = useState<Stage>(options[0]);
  const [note, setNote] = useState('');
  const needsQuote = QUOTED_STAGES.includes(stage) && !hasQuotation;
  return (
    <form
      className="ts-fgrid ts-g2 !mt-0"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(stage, note);
      }}
    >
      <SelectField label={reopen ? 'Reopen at' : 'Move to'} value={stage} onChange={(e) => setStage(e.target.value as Stage)} hint={needsQuote ? 'Needs a recorded quotation first.' : undefined}>
        {options.map((s) => (
          <option key={s} value={s}>
            {STAGE_LABELS[s]}
          </option>
        ))}
      </SelectField>
      <TextField label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="ts-span2 flex gap-2">
        <Button type="submit" size="sm" disabled={busy || needsQuote}>
          {reopen ? 'Reopen' : 'Move'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function WonForm({ suggested, busy, onCancel, onSubmit }: { suggested: number | null; busy: boolean; onCancel: () => void; onSubmit: (value: number, reason: string) => void }) {
  const [value, setValue] = useState(suggested ? String(Math.round(suggested)) : '');
  const [note, setNote] = useState('');
  const amount = Number(value);
  return (
    <form
      className="ts-fgrid ts-g2 !mt-0"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(amount, note);
      }}
    >
      <TextField
        label="Order value (₹)"
        inputMode="numeric"
        value={formatIndianDigits(value)}
        onChange={(e) => setValue(e.target.value.replace(/\D/g, ''))}
        hint={amount > 0 ? formatMoney(amount, { compact: true }) : 'The amount the customer ordered'}
        required
      />
      <TextField label="Why we won" placeholder="e.g. PO received after the demo" value={note} onChange={(e) => setNote(e.target.value)} required />
      <div className="ts-span2 flex gap-2">
        <Button type="submit" size="sm" disabled={busy || !(amount > 0) || !note.trim()}>
          Mark won
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function LostForm({ busy, onCancel, onSubmit }: { busy: boolean; onCancel: () => void; onSubmit: (reason: LostReason, notes: string) => void }) {
  const [reason, setReason] = useState<LostReason | ''>('');
  const [notes, setNotes] = useState('');
  return (
    <form
      className="ts-fgrid ts-g2 !mt-0"
      onSubmit={(e) => {
        e.preventDefault();
        if (reason) onSubmit(reason, notes);
      }}
    >
      <SelectField label="Why was it lost?" value={reason} onChange={(e) => setReason(e.target.value as LostReason)} required>
        <option value="">Select…</option>
        {(Object.keys(LOST_REASON_LABELS) as LostReason[]).map((r) => (
          <option key={r} value={r}>
            {LOST_REASON_LABELS[r]}
          </option>
        ))}
      </SelectField>
      <TextField label="What happened" placeholder="e.g. competitor name, price gap" value={notes} onChange={(e) => setNotes(e.target.value)} required />
      <div className="ts-span2 flex gap-2">
        <Button type="submit" size="sm" variant="danger" disabled={busy || !reason || !notes.trim()}>
          Mark lost
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function EditForm({ deal, busy, onCancel, onSubmit }: { deal: OpportunityDetail; busy: boolean; onCancel: () => void; onSubmit: (data: DealInput) => void }) {
  const [form, setForm] = useState<DealDraft>(() => dealToDraft(deal));
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(draftToInput(form));
      }}
    >
      <DealFields companyId={deal.company_id} value={form} onChange={(patch) => setForm({ ...form, ...patch })} keep={deal} />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy || !dealDraftComplete(form)}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Quotations({ deal, canRecord, onChanged, onError }: { deal: OpportunityDetail; canRecord: boolean; onChanged: () => void; onError: (m: string) => void }) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ quotation_number: '', quotation_date: localDate(), amount: '', status: 'sent' as QuotationStatus, document_url: '' });
  const [busy, setBusy] = useState(false);
  const open = !deal.closed_at;
  const [fromErp, setFromErp] = useState<ErpQuotation[]>([]);

  useEffect(() => {
    if (!canRecord || !open) return;
    api.opportunities.erpQuotations(deal.id).then(setFromErp).catch(() => setFromErp([]));
  }, [canRecord, open, deal.id, deal.quotations.length]);

  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      onChanged();
      return true;
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Something went wrong.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Quotations"
        description={deal.stage === 'develop' && deal.quotations.length === 0 ? 'Waiting for the office to prepare the quotation in the ERP.' : undefined}
        action={
          canRecord && open && !adding ? (
            <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
              + Record
            </Button>
          ) : undefined
        }
      />
      {fromErp.length > 0 && (
        <div className="px-4 sm:px-5 py-3 border-b border-dashed border-line">
          <p className="ts-lbl">In the ERP for this customer</p>
          <ul className="flex flex-col gap-2">
            {fromErp.map((q) => (
              <li key={q.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0">
                  <span className="font-medium">{q.number}</span>
                  <span className="text-ink-muted">
                    {q.quote_date && ` · ${formatDate(q.quote_date)}`} · {formatMoney(q.total)}
                  </span>
                </span>
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => act(() => api.opportunities.addQuotation(deal.id, { quotation_number: q.number, erp_quotation_id: q.id }))}>
                  Add to this opportunity
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {adding && (
        <form
          className="p-4 sm:p-5 ts-fgrid ts-g4 !mt-0 border-b border-dashed border-line"
          onSubmit={async (e) => {
            e.preventDefault();
            const ok = await act(() =>
              api.opportunities.addQuotation(deal.id, {
                quotation_number: form.quotation_number,
                quotation_date: form.quotation_date || null,
                amount: form.amount === '' ? null : Number(form.amount),
                status: form.status,
                document_url: form.document_url || null,
              })
            );
            if (ok) {
              setAdding(false);
              setForm({ quotation_number: '', quotation_date: localDate(), amount: '', status: 'sent', document_url: '' });
            }
          }}
        >
          <TextField label="ERP quotation no." placeholder="QTN-…" value={form.quotation_number} onChange={(e) => setForm({ ...form, quotation_number: e.target.value })} required />
          <TextField label="Date" type="date" value={form.quotation_date} onChange={(e) => setForm({ ...form, quotation_date: e.target.value })} />
          <TextField label="Amount (₹)" inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          <SelectField label="Status" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as QuotationStatus })}>
            {(Object.keys(QUOTATION_STATUS_LABELS) as QuotationStatus[]).map((s) => (
              <option key={s} value={s}>
                {QUOTATION_STATUS_LABELS[s]}
              </option>
            ))}
          </SelectField>
          <div className="col-span-full">
            <TextField label="Link to the document (optional)" type="url" placeholder="https://…" value={form.document_url} onChange={(e) => setForm({ ...form, document_url: e.target.value })} />
          </div>
          <div className="col-span-full flex gap-2">
            <Button type="submit" size="sm" disabled={busy || !form.quotation_number.trim()}>
              Save quotation
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {deal.quotations.length === 0 && !adding && <EmptyState>No quotation recorded yet.</EmptyState>}
      <ul className="divide-y divide-dashed divide-line overflow-hidden rounded-b-card">
        {deal.quotations.map((q) => (
          <li key={q.id} className="px-4 sm:px-5 py-3 flex flex-col sm:flex-row sm:items-center gap-2 justify-between">
            <span className="text-sm">
              <span className="font-medium">{q.quotation_number}</span>
              <span className="text-ink-muted">
                {q.quotation_date && ` · ${formatDate(q.quotation_date)}`} · {formatMoney(q.amount)}
              </span>
              {q.document_url && (
                <>
                  {' · '}
                  <a href={q.document_url} target="_blank" rel="noreferrer noopener" className="ts-lnk text-brand">
                    Open document
                  </a>
                </>
              )}
            </span>
            {q.source === 'erp' ? (
              <span className="flex items-center gap-2">
                <Badge>{QUOTATION_STATUS_LABELS[q.status]}</Badge>
                <Badge tone="muted">From the ERP</Badge>
              </span>
            ) : canRecord ? (
              <select
                aria-label={`Status of ${q.quotation_number}`}
                value={q.status}
                disabled={busy}
                onChange={(e) => act(() => api.opportunities.updateQuotation(q.id, { status: e.target.value as QuotationStatus }))}
                className="ts-fi ts-sel max-[860px]:!h-11"
              >
                {(Object.keys(QUOTATION_STATUS_LABELS) as QuotationStatus[]).map((s) => (
                  <option key={s} value={s}>
                    {QUOTATION_STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            ) : (
              <Badge>{QUOTATION_STATUS_LABELS[q.status]}</Badge>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
