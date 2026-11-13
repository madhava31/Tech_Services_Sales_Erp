import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, DealFilters, NamedOption, Opportunity, Stage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { LOST_REASON_LABELS, OPEN_STAGES, STAGE_LABELS, formatDate, formatMoney } from '../../lib/labels';
import { canWriteCrm, isManagingRole } from '../../lib/roles';
import BulkBar, { bulkMessage } from '../../components/BulkBar';
import ExportPanel from '../../components/ExportPanel';
import { Badge, Button, Card, EmptyState, Notice, OverdueBadge, PHONE_TOUCH, PageHeader, SelectField, SkeletonRows, StuckBadge, TextField, stagger } from '../../components/ui';

type View = 'open' | 'won' | 'lost';

function DealCard({ deal, teamView, selected, onToggle }: { deal: Opportunity; teamView: boolean; selected?: boolean; onToggle?: () => void }) {
  const body = (
    <>
      <div className="text-[11px] text-subtle tabular-nums tracking-wide mb-0.5">{deal.code}</div>
      <h5 className="!mt-0 !mb-1 !whitespace-normal">{deal.title}</h5>
      <div className="text-xs text-subtle truncate">{deal.company_name}</div>
      <div className="ts-kmeta items-center mt-2.5">
        <span className="text-sm font-medium tabular-nums text-fg">{formatMoney(deal.won_value ?? deal.estimated_value, { compact: true })}</span>
        {deal.expected_close_date && !deal.closed_at && <span className={deal.is_overdue ? 'text-danger font-medium' : ''}>{formatDate(deal.expected_close_date)}</span>}
      </div>
      {(deal.is_overdue || deal.is_stuck) && (
        <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
          {deal.is_overdue && <OverdueBadge />}
          {deal.is_stuck && <StuckBadge days={deal.days_in_stage} />}
        </div>
      )}
      <div className="ts-kmeta mt-2.5 pt-2.5 border-t border-dashed border-line2">
        <span>{deal.probability}%</span>
        {teamView && <span className="truncate">{deal.owner_name}</span>}
      </div>
    </>
  );
  if (onToggle) {
    return (
      <label className={`ts-kcard flex items-start gap-2.5 cursor-pointer ${selected ? 'ring-2 ring-brand' : ''}`}>
        <input type="checkbox" className="ts-chk mt-0.5 shrink-0" checked={Boolean(selected)} onChange={onToggle} />
        <span className="min-w-0 flex-1 block">{body}</span>
      </label>
    );
  }
  return (
    <Link to={`/pipeline/${deal.id}`} className="ts-kcard block">
      {body}
    </Link>
  );
}

export default function Pipeline() {
  const { user } = useAuth();
  const [view, setView] = useState<View>('open');
  const [deals, setDeals] = useState<Opportunity[] | null>(null);
  const [error, setError] = useState('');
  const [stageFilter, setStageFilter] = useState<Stage | ''>('');
  const teamView = user?.role !== 'salesperson';
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [stuckOnly, setStuckOnly] = useState(false);
  const [oemId, setOemId] = useState<number | ''>('');
  const [segmentId, setSegmentId] = useState<number | ''>('');
  const [ownerId, setOwnerId] = useState<number | ''>('');
  const [oems, setOems] = useState<NamedOption[]>([]);
  const [segments, setSegments] = useState<NamedOption[]>([]);
  const [people, setPeople] = useState<{ id: number; name: string }[]>([]);
  const [notice, setNotice] = useState('');
  const [selecting, setSelecting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [newDate, setNewDate] = useState('');
  const [newStage, setNewStage] = useState<Stage | ''>('');
  const [newOwner, setNewOwner] = useState<number | ''>('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const managing = isManagingRole(user?.role);
  const filters: DealFilters = { status: view, overdue: view === 'open' && overdueOnly ? 1 : '', stuck: view === 'open' && stuckOnly ? 1 : '', oem_id: oemId, segment_id: segmentId, owner_id: ownerId };

  useEffect(() => {
    api.catalogue.oems().then(setOems).catch(() => undefined);
    api.catalogue.segments().then(setSegments).catch(() => undefined);
    if (teamView) api.directory.salespeople(true).then(setPeople).catch(() => undefined);
  }, [teamView]);

  function loadDeals() {
    return api.opportunities
      .list(filters)
      .then(setDeals)
      .catch((err) => setError(err.message));
  }

  useEffect(() => {
    setDeals(null);
    setSelecting(false);
    setSelected(new Set());
    void loadDeals();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, overdueOnly, stuckOnly, oemId, segmentId, ownerId]);

  function toggle(id: number) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  async function applyBulk(change: { expected_close_date?: string; stage?: Stage; to_salesperson_id?: number; reason?: string }) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api.opportunities.bulk({ ids: [...selected], ...change });
      setNotice(bulkMessage(result));
      setNewDate('');
      setNewStage('');
      setNewOwner('');
      setReason('');
      setSelected(new Set());
      await loadDeals();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That didn’t go through.');
    } finally {
      setBusy(false);
    }
  }

  const cardProps = (d: Opportunity) => (selecting ? { selected: selected.has(d.id), onToggle: () => toggle(d.id) } : {});

  const byStage = (stage: Stage) => (deals ?? []).filter((d) => d.stage === stage);
  const total = (list: Opportunity[]) => list.reduce((sum, d) => sum + (d.estimated_value ?? 0), 0);
  const openTotal = total(deals ?? []);
  const weighted = (deals ?? []).reduce((sum, d) => sum + ((d.estimated_value ?? 0) * d.probability) / 100, 0);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Pipeline"
        description={teamView ? 'Every open opportunity across the team.' : 'Your opportunities.'}
        actions={
          canWriteCrm(user?.role) && (
            <Link to="/opportunities/new" className="ts-btn ts-dark justify-center max-[860px]:min-h-11">
              + New opportunity
            </Link>
          )
        }
      />
      {error && <Notice tone="error" onDismiss={() => setError('')}>{error}</Notice>}
      {notice && <Notice tone="success" onDismiss={() => setNotice('')}>{notice}</Notice>}

      <div className="ts-toolbar !mb-0">
        <div className="ts-tabs" role="tablist">
        {(['open', 'won', 'lost'] as View[]).map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={view === v}
            onClick={() => setView(v)}
            className={`ts-tab ${PHONE_TOUCH} ${view === v ? 'ts-on' : ''}`}
          >
            {v === 'open' ? 'Open' : v === 'won' ? 'Won' : 'Lost'}
          </button>
        ))}
        </div>
        {view === 'open' && (
          <button
            type="button"
            aria-pressed={overdueOnly}
            onClick={() => setOverdueOnly(!overdueOnly)}
            className={`ts-btn ts-xs justify-center ${PHONE_TOUCH} ${overdueOnly ? 'ts-dark' : 'ts-ghost'}`}
          >
            Overdue
          </button>
        )}
        {view === 'open' && (
          <button
            type="button"
            aria-pressed={stuckOnly}
            onClick={() => setStuckOnly(!stuckOnly)}
            className={`ts-btn ts-xs justify-center ${PHONE_TOUCH} ${stuckOnly ? 'ts-dark' : 'ts-ghost'}`}
          >
            Stuck
          </button>
        )}
        {view === 'open' && deals && (
          <span className="ts-muted text-[13.5px] ml-auto">
            {deals.length} opportunities · {formatMoney(openTotal, { compact: true })} · weighted {formatMoney(weighted, { compact: true })}
          </span>
        )}
      </div>

      <div className="ts-toolbar !mb-0 !gap-2.5">
        <select aria-label="OEM" className="ts-fi ts-sel max-[860px]:!h-11" value={oemId} onChange={(e) => setOemId(e.target.value ? Number(e.target.value) : '')}>
          <option value="">All OEMs</option>
          {oems.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
        <select aria-label="Market segment" className="ts-fi ts-sel max-[860px]:!h-11" value={segmentId} onChange={(e) => setSegmentId(e.target.value ? Number(e.target.value) : '')}>
          <option value="">All segments</option>
          {segments.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        {teamView && (
          <select aria-label="Salesperson" className="ts-fi ts-sel max-[860px]:!h-11" value={ownerId} onChange={(e) => setOwnerId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">Everyone</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <span className="flex-1" />
        {user?.role === 'admin' && (
          <Button variant="ghost" onClick={() => setExporting((x) => !x)} aria-expanded={exporting}>
            Download Excel
          </Button>
        )}
        {canWriteCrm(user?.role) && view === 'open' && !selecting && (deals?.length ?? 0) > 1 && (
          <Button variant="secondary" onClick={() => setSelecting(true)}>
            Select several
          </Button>
        )}
      </div>

      {exporting && <ExportPanel filters={filters} onClose={() => setExporting(false)} />}

      {deals === null && !error && (
        <Card>
          <SkeletonRows />
        </Card>
      )}

      {view === 'open' && deals && (
        <>
          {/* Phones: one stage at a time */}
          <div className="min-[861px]:hidden flex flex-col gap-3">
            <select
              aria-label="Stage"
              value={stageFilter}
              onChange={(e) => setStageFilter(e.target.value as Stage | '')}
              className="ts-fi"
            >
              <option value="">All stages ({deals.length})</option>
              {OPEN_STAGES.map((s) => (
                <option key={s} value={s}>
                  {STAGE_LABELS[s]} ({byStage(s).length})
                </option>
              ))}
            </select>
            {(stageFilter ? byStage(stageFilter) : deals).map((d) => (
              <div key={d.id}>
                {!stageFilter && <div className="ts-lbl !mb-1.5">{STAGE_LABELS[d.stage]}</div>}
                <DealCard deal={d} teamView={teamView} {...cardProps(d)} />
              </div>
            ))}
            {deals.length === 0 && (
              <Card>
                <EmptyState>No open opportunities. Open one from an opportunity or with “New opportunity”.</EmptyState>
              </Card>
            )}
          </div>

          {/* Desktop: board */}
          <div className="ts-kboard max-[860px]:!hidden">
            {OPEN_STAGES.map((s, i) => {
              const list = byStage(s);
              return (
                <section key={s} className="ts-kcol" style={stagger(i)}>
                  <header>
                    <i aria-hidden="true" />
                    {STAGE_LABELS[s]} <span>{list.length}</span>
                    <b>{formatMoney(total(list), { compact: true })}</b>
                  </header>
                  <div className="ts-kcards">
                    {list.length === 0 && <div className="ts-kempty">No opportunities</div>}
                    {list.map((d) => (
                      <DealCard key={d.id} deal={d} teamView={teamView} {...cardProps(d)} />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        </>
      )}

      {selecting && view === 'open' && deals && (
        <BulkBar
          count={selected.size}
          total={deals.length}
          onSelectAll={() => setSelected(new Set(deals.map((d) => d.id)))}
          onClear={() => {
            setSelecting(false);
            setSelected(new Set());
          }}
        >
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex items-end gap-2">
              <TextField label="New closing date" type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} />
              <Button variant="secondary" disabled={busy || !newDate} onClick={() => applyBulk({ expected_close_date: newDate })}>
                Change
              </Button>
            </div>
            <div className="flex items-end gap-2">
              <SelectField label="Move to stage" value={newStage} onChange={(e) => setNewStage(e.target.value as Stage | '')}>
                <option value="">Select…</option>
                {OPEN_STAGES.map((s) => (
                  <option key={s} value={s}>
                    {STAGE_LABELS[s]}
                  </option>
                ))}
              </SelectField>
              <Button variant="secondary" disabled={busy || !newStage} onClick={() => newStage && applyBulk({ stage: newStage })}>
                Move
              </Button>
            </div>
            {managing && (
              <div className="flex flex-wrap items-end gap-2">
                <SelectField label="Transfer to" value={newOwner} onChange={(e) => setNewOwner(e.target.value ? Number(e.target.value) : '')}>
                  <option value="">Select…</option>
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </SelectField>
                <TextField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
                <Button variant="secondary" disabled={busy || !newOwner || !reason.trim()} onClick={() => applyBulk({ to_salesperson_id: Number(newOwner), reason })}>
                  Transfer
                </Button>
              </div>
            )}
          </div>
        </BulkBar>
      )}

      {view !== 'open' && deals && (
        <Card>
          {deals.length === 0 && <EmptyState>Nothing {view} yet.</EmptyState>}
          <ul className="divide-y divide-dashed divide-line overflow-hidden rounded-b-card">
            {deals.map((d) => (
              <li key={d.id}>
                <Link to={`/pipeline/${d.id}`} className="flex items-center justify-between gap-3 px-4 sm:px-5 py-3 hover:bg-surface transition-colors">
                  <span className="min-w-0">
                    <span className="block text-sm font-medium truncate">{d.title}</span>
                    <span className="block text-xs text-ink-muted truncate">
                      {d.company_name}
                      {teamView && ` · ${d.owner_name}`}
                      {d.closed_at && ` · ${formatDate(d.closed_at)}`}
                      {d.lost_reason && ` · ${LOST_REASON_LABELS[d.lost_reason]}`}
                      {d.close_reason && ` · ${d.close_reason}`}
                    </span>
                  </span>
                  {d.stage === 'won' ? <Badge tone="ok">{formatMoney(d.won_value, { compact: true })}</Badge> : <Badge tone="muted">{STAGE_LABELS[d.stage]}</Badge>}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
