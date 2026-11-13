import { useEffect, useState } from 'react';
import { api, Performance as Metrics } from '../lib/api';
import { useAuth } from '../lib/auth';
import { LOST_REASON_LABELS, formatDate, formatMoney } from '../lib/labels';
import { Card, CardHeader, LoadingCard, Notice, PHONE_TOUCH, PageHeader, Tile, stagger } from '../components/ui';

const RANGES = [7, 30, 90];

export default function Performance() {
  const { user } = useAuth();
  const teamView = user?.role !== 'salesperson';
  const [days, setDays] = useState(30);
  const [salespersonId, setSalespersonId] = useState<number | ''>('');
  const [salespeople, setSalespeople] = useState<{ id: number; name: string }[]>([]);
  const [m, setM] = useState<Metrics | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (teamView) api.directory.salespeople().then(setSalespeople).catch(() => undefined);
  }, [teamView]);

  useEffect(() => {
    setError('');
    api
      .performance({ days, salesperson_id: salespersonId })
      .then(setM)
      .catch((err) => setError(err.message));
  }, [days, salespersonId]);

  const topReason = Math.max(1, ...(m?.lost_reasons.map((r) => r.count) ?? []));

  return (
    <div>
      <PageHeader title="Performance" description={teamView ? (salespersonId ? 'One salesperson.' : 'The whole team.') : 'Your numbers.'} />

      <div className="ts-toolbar">
        <div className="ts-tabs" role="tablist" aria-label="Period">
          {RANGES.map((r) => (
            <button key={r} type="button" role="tab" aria-selected={days === r} onClick={() => setDays(r)} className={`ts-tab ${PHONE_TOUCH} ${days === r ? 'ts-on' : ''}`}>
              {r} days
            </button>
          ))}
        </div>
        {teamView && (
          <select aria-label="Salesperson" className="ts-fi ts-sel max-[860px]:!h-11" value={salespersonId} onChange={(e) => setSalespersonId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">Whole team</option>
            {salespeople.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
        {m && (
          <span className="ts-muted text-[13.5px] ml-auto">
            {formatDate(m.from)} – {formatDate(m.to)}
          </span>
        )}
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      {!m && !error && <LoadingCard />}
      {m && (
        <div className="flex flex-col gap-5">
          <section>
            <h2 className="ts-lbl">Field activity</h2>
            <div className="ts-grid ts-kpis">
              <Tile i={0} label="Opportunities" value={m.visits} />
              <Tile i={1} label="Companies visited" value={m.companies_visited} />
              <Tile i={2} label="New prospects" value={m.new_prospects} hint="First-ever opportunity to the company" />
              <Tile i={3} label="Overdue follow-ups" value={m.overdue_follow_ups} tone={m.overdue_follow_ups ? 'danger' : undefined} hint="Right now" />
            </div>
          </section>
          <section>
            <h2 className="ts-lbl">Opportunities</h2>
            <div className="ts-grid ts-kpis">
              <Tile i={4} label="Opportunities opened" value={m.deals_opened} />
              <Tile i={5} label="Quotation requests" value={m.quotation_requests} />
              <Tile i={6} label="Quotations sent" value={m.quotations_sent} />
              <Tile i={7} label="Opportunities won" value={m.deals_won} tone="ok" hint={formatMoney(m.won_value)} />
              <Tile i={8} label="Opportunities lost" value={m.deals_lost} />
              <Tile i={10} label="Win rate" value={m.win_rate === null ? '—' : `${m.win_rate}%`} hint="Of opportunities closed in the period" />
              <Tile i={11} label="Days to win" value={m.avg_days_to_win ?? '—'} hint="Average, opened → won" />
            </div>
          </section>
          <section>
            <h2 className="ts-lbl">Pipeline now</h2>
            <div className="ts-grid ts-kpis">
              <Tile i={12} label="Open opportunities" value={m.open_deals} />
              <Tile i={13} label="Pipeline value" value={formatMoney(m.pipeline_value, { compact: true })} />
              <Tile i={14} label="Weighted pipeline" value={formatMoney(m.weighted_pipeline, { compact: true })} hint="Order value × win probability" />
              <Tile i={15} label="Overdue opportunities" value={m.overdue_deals} tone={m.overdue_deals ? 'danger' : undefined} hint="Past expected closing date" />
              <Tile i={16} label="Stuck opportunities" value={m.stuck_deals} tone={m.stuck_deals ? 'warn' : undefined} hint="Too long in one stage" />
            </div>
          </section>
          {m.lost_reasons.length > 0 && (
            <Card style={stagger(17)}>
              <CardHeader title="Why opportunities were lost" />
              <div className="px-4 sm:px-5 py-3">
                {m.lost_reasons.map((r) => (
                  <div key={r.reason} className="ts-hbar">
                    <span>{LOST_REASON_LABELS[r.reason]}</span>
                    <div className="ts-t">
                      <i style={{ width: `${(r.count / topReason) * 100}%` }} />
                    </div>
                    <span className="ts-p">{r.count}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}
          <p className="text-xs text-subtle">
            Won value counts the order amount entered when an opportunity is marked won — never the quotation total. Quotation requests, sent
            quotations, won and lost opportunities count toward the opportunity’s current owner; opportunities opened toward whoever opened them.
          </p>
        </div>
      )}
    </div>
  );
}
