import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Forecast, ForecastBucket, Funnel, NamedOption, api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { STAGE_LABELS, formatDate, formatMoney } from '../lib/labels';
import { Card, CardHeader, EmptyState, Notice, OverdueBadge, PHONE_TOUCH, PageHeader, SkeletonRows, stagger } from '../components/ui';

const FUNNEL_PERIODS = [
  [30, '30 days'],
  [90, '3 months'],
  [180, '6 months'],
  [365, '1 year'],
] as const;

// Confidence is ordered, so one hue from dark (most likely) to light (least likely).
const CONFIDENCE = [
  { key: 'commit', label: 'Commit', hint: '75–100%', className: 'bg-brand' },
  { key: 'best_case', label: 'Best case', hint: '50%', className: 'bg-[rgb(var(--brand-blue)/0.6)]' },
  { key: 'pipeline', label: 'Pipeline', hint: '25%', className: 'bg-[rgb(var(--brand-blue)/0.28)]' },
] as const;

function monthLabel(ym: string) {
  return new Date(`${ym}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
}

function FunnelChart({ funnel }: { funnel: Funnel }) {
  const top = Math.max(1, funnel.stages[0].reached);
  const won = funnel.stages[funnel.stages.length - 1];
  // The biggest step down is where the most deals are leaving.
  const steps = funnel.stages.filter((s) => s.to_next_pct !== null && s.reached >= 3);
  const weakest = steps.length ? steps.reduce((a, b) => ((b.to_next_pct ?? 100) < (a.to_next_pct ?? 100) ? b : a)) : null;

  if (funnel.total === 0) return <EmptyState>No opportunities opened in this period.</EmptyState>;
  return (
    <div className="px-4 sm:px-5 py-4 flex flex-col gap-4">
      <p className="text-sm">
        Of <b>{funnel.total}</b> opportunities opened, <b>{won.reached}</b> {won.reached === 1 ? 'was' : 'were'} won ({Math.round((won.reached / top) * 100)}%), {funnel.lost} lost, and {funnel.total - won.reached - funnel.lost} still open.
        {weakest && weakest.to_next_pct! < 100 && (
          <>
            {' '}
            Biggest drop: after <b>{STAGE_LABELS[weakest.stage]}</b>.
          </>
        )}
      </p>
      <ol className="flex flex-col gap-3">
        {funnel.stages.map((s, i) => (
          <li key={s.stage}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="font-medium">{STAGE_LABELS[s.stage]}</span>
              <span className="tabular-nums shrink-0">
                <b>{s.reached}</b>
                <span className="text-ink-muted"> · {formatMoney(s.reached_value, { compact: true })}</span>
              </span>
            </div>
            <div className="mt-1.5 h-2.5 rounded-full bg-tile overflow-hidden" title={`${STAGE_LABELS[s.stage]}: ${s.reached} opportunities, ${formatMoney(s.reached_value)}`}>
              <div className={`h-full rounded-full ${s.stage === 'won' ? 'bg-cta' : 'bg-brand'}`} style={{ width: `${s.reached ? Math.max(1.5, (s.reached / top) * 100) : 0}%` }} />
            </div>
            <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-ink-muted">
              {s.open_now > 0 && <span>{s.open_now} open here</span>}
              {s.dropped > 0 && <span>{s.dropped} lost here</span>}
              {s.avg_days !== null && <span>about {Math.round(s.avg_days)} days here</span>}
            </div>
            {i < funnel.stages.length - 1 && s.to_next_pct !== null && (
              <div className={`mt-1 text-xs font-medium ${weakest?.stage === s.stage && s.to_next_pct < 100 ? 'text-warn' : 'text-subtle'}`}>↓ {s.to_next_pct}% went on</div>
            )}
          </li>
        ))}
      </ol>
      <p className="text-xs text-subtle">An opportunity that skipped a stage counts as having passed it. Opportunities opened recently may still move on, so later stages read low over short periods.</p>
    </div>
  );
}

function ForecastBar({ bucket, max }: { bucket: ForecastBucket; max: number }) {
  return (
    <div className="h-2.5 rounded-full bg-tile flex gap-0.5 overflow-hidden">
      {CONFIDENCE.map((c) =>
        bucket[c.key] > 0 ? (
          <div
            key={c.key}
            className={`h-full first:rounded-l-full last:rounded-r-full ${c.className}`}
            style={{ width: `${Math.max(1, (bucket[c.key] / max) * 100)}%` }}
            title={`${c.label}: ${formatMoney(bucket[c.key])}`}
          />
        ) : null
      )}
    </div>
  );
}

function BucketDeals({ bucket, teamView, overdue }: { bucket: ForecastBucket; teamView: boolean; overdue?: boolean }) {
  return (
    <ul className="mt-2 ts-box !p-0 divide-y divide-dashed divide-line overflow-hidden">
      {bucket.deals.map((d) => (
        <li key={d.id}>
          <Link to={`/pipeline/${d.id}`} className="flex items-center justify-between gap-3 px-3 py-2 hover:bg-surface transition-colors">
            <span className="min-w-0">
              <span className="block text-sm font-medium truncate">{d.title}</span>
              <span className="block text-xs text-ink-muted truncate">
                {d.company_name}
                {teamView && ` · ${d.owner_name}`}
                {d.expected_close_date && ` · ${formatDate(d.expected_close_date)}`} · {d.probability}%
              </span>
            </span>
            <span className="flex flex-col items-end gap-1 shrink-0">
              {overdue && <OverdueBadge />}
              <span className="text-sm font-medium tabular-nums">{formatMoney(d.estimated_value, { compact: true })}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function ForecastRow({ label, bucket, max, won, teamView, overdue }: { label: string; bucket: ForecastBucket; max: number; won?: { value: number; deals: number }; teamView: boolean; overdue?: boolean }) {
  return (
    <li className="px-4 sm:px-5 py-3">
      <details>
        <summary className="cursor-pointer list-none">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="font-medium">{label}</span>
            <span className="tabular-nums shrink-0">
              <b>{formatMoney(bucket.total, { compact: true })}</b>
              <span className="text-ink-muted"> · weighted {formatMoney(bucket.weighted, { compact: true })}</span>
            </span>
          </div>
          <div className="mt-1.5">
            <ForecastBar bucket={bucket} max={max} />
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-ink-muted">
            {bucket.count > 0 ? <span>{bucket.count} {bucket.count === 1 ? 'opportunity' : 'opportunities'} · tap to see them</span> : <span>Nothing expected</span>}
            {bucket.commit > 0 && <span>Commit {formatMoney(bucket.commit, { compact: true })}</span>}
            {bucket.best_case > 0 && <span>Best case {formatMoney(bucket.best_case, { compact: true })}</span>}
            {bucket.pipeline > 0 && <span>Pipeline {formatMoney(bucket.pipeline, { compact: true })}</span>}
            {won && won.deals > 0 && (
              <span className="text-ok font-medium">
                Already won {formatMoney(won.value, { compact: true })} ({won.deals})
              </span>
            )}
          </div>
        </summary>
        {bucket.count > 0 && <BucketDeals bucket={bucket} teamView={teamView} overdue={overdue} />}
      </details>
    </li>
  );
}

function ForecastChart({ forecast, teamView }: { forecast: Forecast; teamView: boolean }) {
  const buckets = [...forecast.months, forecast.overdue, forecast.later, forecast.no_date];
  const max = Math.max(1, ...buckets.map((b) => b.total));
  return (
    <>
      <div className="px-4 sm:px-5 pt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted" aria-label="Legend">
        {CONFIDENCE.map((c) => (
          <span key={c.key} className="inline-flex items-center gap-1.5">
            <span className={`h-2.5 w-2.5 rounded-sm ${c.className}`} aria-hidden />
            {c.label} ({c.hint})
          </span>
        ))}
      </div>
      <ul className="divide-y divide-dashed divide-line overflow-hidden rounded-b-card">
        {forecast.overdue.count > 0 && <ForecastRow label="Past their closing date" bucket={forecast.overdue} max={max} teamView={teamView} overdue />}
        {forecast.months.map((m) => (
          <ForecastRow key={m.month} label={monthLabel(m.month)} bucket={m} max={max} won={{ value: m.won_value, deals: m.won_deals }} teamView={teamView} />
        ))}
        {forecast.later.count > 0 && <ForecastRow label="Later" bucket={forecast.later} max={max} teamView={teamView} />}
        {forecast.no_date.count > 0 && <ForecastRow label="No closing date" bucket={forecast.no_date} max={max} teamView={teamView} />}
      </ul>
      <p className="px-4 sm:px-5 pb-3 text-xs text-subtle">From each open opportunity’s expected closing date and win probability. Weighted = order value × win probability.</p>
    </>
  );
}

// Where deals drop out, and what should close when.
export default function Analysis() {
  const { user } = useAuth();
  const teamView = user?.role !== 'salesperson';
  const [days, setDays] = useState(90);
  const [salespersonId, setSalespersonId] = useState<number | ''>('');
  const [oemId, setOemId] = useState<number | ''>('');
  const [people, setPeople] = useState<{ id: number; name: string }[]>([]);
  const [oems, setOems] = useState<NamedOption[]>([]);
  const [funnel, setFunnel] = useState<Funnel | null>(null);
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.catalogue.oems().then(setOems).catch(() => undefined);
    if (teamView) api.directory.salespeople(true).then(setPeople).catch(() => undefined);
  }, [teamView]);

  useEffect(() => {
    setError('');
    api.analysis.funnel({ days, salesperson_id: salespersonId, oem_id: oemId }).then(setFunnel).catch((err) => setError(err.message));
  }, [days, salespersonId, oemId]);

  useEffect(() => {
    api.analysis.forecast({ salesperson_id: salespersonId, oem_id: oemId }).then(setForecast).catch((err) => setError(err.message));
  }, [salespersonId, oemId]);

  return (
    <div>
      <PageHeader title="Sales analysis" description={teamView ? 'Where opportunities drop out, and what should close when.' : 'Your funnel and what you expect to close.'} />
      {error && <Notice tone="error">{error}</Notice>}

      <div className="ts-toolbar !mb-0">
        {teamView && (
          <select aria-label="Salesperson" className="ts-fi ts-sel max-[860px]:!h-11" value={salespersonId} onChange={(e) => setSalespersonId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">Whole team</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <select aria-label="OEM" className="ts-fi ts-sel max-[860px]:!h-11" value={oemId} onChange={(e) => setOemId(e.target.value ? Number(e.target.value) : '')}>
          <option value="">All OEMs</option>
          {oems.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      </div>

      <div className="ts-grid ts-row-half items-start">
      <Card style={stagger(0)}>
        <CardHeader title="Monthly forecast" description="Expected orders by closing month." />
        {forecast ? <ForecastChart forecast={forecast} teamView={teamView} /> : !error && <SkeletonRows />}
      </Card>

      <Card style={stagger(1)}>
        <CardHeader title="Sales funnel" description="How far the opportunities opened in this period have got." />
        <div className="px-4 sm:px-5 pt-3">
          <div className="ts-tabs" role="tablist" aria-label="Period">
            {FUNNEL_PERIODS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={days === value}
                onClick={() => setDays(value)}
                className={`ts-tab ${PHONE_TOUCH} ${days === value ? 'ts-on' : ''}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {funnel ? <FunnelChart funnel={funnel} /> : !error && <SkeletonRows />}
      </Card>

      {teamView && forecast && forecast.by_salesperson.length > 0 && !salespersonId && (
        <Card style={stagger(2)}>
          <CardHeader title="Next three months, by salesperson" />
          <ul className="divide-y divide-dashed divide-line overflow-hidden rounded-b-card">
            {forecast.by_salesperson.map((p) => (
              <li key={p.salesperson_id} className="px-4 sm:px-5 py-3">
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="font-medium truncate">{p.name}</span>
                  <span className="tabular-nums shrink-0">
                    <b>{formatMoney(p.total, { compact: true })}</b>
                    <span className="text-ink-muted"> · weighted {formatMoney(p.weighted, { compact: true })}</span>
                  </span>
                </div>
                <div className="mt-1 text-xs text-ink-muted">
                  Commit {formatMoney(p.commit, { compact: true })} · Best case {formatMoney(p.best_case, { compact: true })} · Pipeline {formatMoney(p.pipeline, { compact: true })}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {funnel && (
        <Card style={stagger(3)}>
          <CardHeader title="Open pipeline right now" description="Every open opportunity, whenever it was opened." />
          <ul className="divide-y divide-dashed divide-line overflow-hidden rounded-b-card">
            {funnel.open_by_stage.map((s) => (
              <li key={s.stage} className="px-4 sm:px-5 py-2.5 flex items-center justify-between gap-3 text-sm">
                <span>{STAGE_LABELS[s.stage]}</span>
                <span className="tabular-nums">
                  <b>{s.deals}</b>
                  <span className="text-ink-muted"> · {formatMoney(s.value, { compact: true })}</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      </div>
    </div>
  );
}
