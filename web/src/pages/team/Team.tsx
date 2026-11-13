import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, TeamInsights, TeamPerformance } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { LOST_REASON_LABELS, STAGE_LABELS, formatDate, formatMoney } from '../../lib/labels';
import { isManagingRole } from '../../lib/roles';
import { Badge, Card, CardHeader, DESKTOP_ONLY, EmptyState, LoadingCard, Notice, PHONE_ONLY, PHONE_TOUCH, PageHeader, Tile, rowStagger, stagger } from '../../components/ui';

const RANGES = [7, 30, 90];

function monthLabel(ym: string) {
  return new Date(`${ym}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'short' });
}

export default function Team() {
  const { user } = useAuth();
  const [days, setDays] = useState(30);
  const [perf, setPerf] = useState<TeamPerformance | null>(null);
  const [insights, setInsights] = useState<TeamInsights | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setError('');
    Promise.all([api.team.performance(days), api.team.insights(days)])
      .then(([p, i]) => {
        setPerf(p);
        setInsights(i);
      })
      .catch((err) => setError(err.message));
  }, [days]);

  const t = perf?.totals;
  const maxMonth = Math.max(1, ...(insights?.won_by_month.map((m) => m.won_value) ?? [0]));

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Team"
        description="Every salesperson side by side, adding up to the team total."
        actions={
          isManagingRole(user?.role) && (
            <Link to="/team/handover" className="ts-btn ts-ghost justify-center max-[860px]:min-h-11">
              Hand over work…
            </Link>
          )
        }
      />

      <div className="ts-toolbar !mb-0">
        <div className="ts-tabs" role="tablist" aria-label="Period">
        {RANGES.map((r) => (
          <button
            key={r}
            type="button"
            role="tab"
            aria-selected={days === r}
            onClick={() => setDays(r)}
            className={`ts-tab ${PHONE_TOUCH} ${days === r ? 'ts-on' : ''}`}
          >
            {r} days
          </button>
        ))}
        </div>
        {perf && (
          <span className="ts-muted text-[13.5px] ml-auto">
            {formatDate(perf.from)} – {formatDate(perf.to)}
          </span>
        )}
      </div>

      {error && <Notice tone="error">{error}</Notice>}

      {insights && insights.orphaned.length > 0 && (
        <Notice tone="error">
          {insights.orphaned.map((o) => `${o.name} (${o.open_deals} open ${o.open_deals === 1 ? 'opportunity' : 'opportunities'})`).join(', ')}{' '}
          {insights.orphaned.length === 1 ? 'has' : 'have'} left but still own{insights.orphaned.length === 1 ? 's' : ''} open opportunities.{' '}
          {isManagingRole(user?.role) && (
            <Link to={`/team/handover?from=${insights.orphaned[0].salesperson_id}`} className="underline font-medium">
              Hand them over
            </Link>
          )}
        </Notice>
      )}

      {!perf && !error && <LoadingCard />}

      {t && (
        <div className="ts-grid grid-cols-2 min-[1101px]:grid-cols-6">
          <Tile i={0} label="Won" value={formatMoney(t.won_value, { compact: true })} hint={`${t.deals_won} opportunities · ${t.deals_lost} lost`} tone="ok" />
          <Tile i={1} label="Pipeline" value={formatMoney(t.pipeline_value, { compact: true })} hint={`${t.open_deals} open · weighted ${formatMoney(t.weighted_pipeline, { compact: true })}`} />
          <Tile i={2} label="Opportunities" value={t.visits} hint={`${t.companies_visited} companies · ${t.new_prospects} new`} />
          <Tile i={3} label="Overdue opportunities" value={t.overdue_deals} tone={t.overdue_deals ? 'danger' : undefined} hint="Past expected closing date" />
          <Tile i={4} label="Stuck opportunities" value={t.stuck_deals} tone={t.stuck_deals ? 'warn' : undefined} hint="Too long in one stage" />
          <Tile i={5} label="Overdue follow-ups" value={t.overdue_follow_ups} tone={t.overdue_follow_ups ? 'danger' : undefined} hint="Right now" />
        </div>
      )}

      {perf && (
        <Card>
          <CardHeader title="By salesperson" />
          {/* Phones: one card per person */}
          <ul className={`${PHONE_ONLY} divide-y divide-dashed divide-line overflow-hidden rounded-b-card`}>
            {perf.salespeople.map((p) => (
              <li key={p.id} className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{p.name}</span>
                  {!p.is_active && <Badge tone="muted">Left</Badge>}
                </div>
                <div className="grid grid-cols-3 gap-2 mt-2 text-xs text-ink-muted">
                  <span>
                    <b className="text-ink">{p.metrics.visits}</b> {p.metrics.visits === 1 ? 'opportunity' : 'opportunities'}
                  </span>
                  <span>
                    <b className="text-ink">{p.metrics.deals_won}</b> won · {formatMoney(p.metrics.won_value, { compact: true })}
                  </span>
                  <span>
                    <b className="text-ink">{formatMoney(p.metrics.pipeline_value, { compact: true })}</b> open
                  </span>
                  <span>
                    <b className="text-ink">{p.metrics.quotation_requests}</b> quote req.
                  </span>
                  <span>
                    win <b className="text-ink">{p.metrics.win_rate ?? '—'}%</b>
                  </span>
                  <span>
                    <b className="text-ink">{formatMoney(p.metrics.weighted_pipeline, { compact: true })}</b> weighted
                  </span>
                  <span>
                    <b className="text-ink">{p.metrics.open_deals}</b> open
                  </span>
                  <span>
                    <b className="text-ink">{p.metrics.deals_lost}</b> lost
                  </span>
                  <span className={p.metrics.overdue_deals ? 'text-danger font-medium' : ''}>{p.metrics.overdue_deals} opportunities overdue</span>
                  <span className={p.metrics.stuck_deals ? 'text-warn font-medium' : ''}>{p.metrics.stuck_deals} stuck</span>
                  <span className={p.metrics.overdue_follow_ups ? 'text-danger font-medium' : ''}>{p.metrics.overdue_follow_ups} follow-ups overdue</span>
                </div>
              </li>
            ))}
          </ul>
          {/* Desktop: table */}
          <div className={`ts-tbl ts-tblwrap !mt-0 px-2 pb-2 ${DESKTOP_ONLY}`}>
            <table>
              <thead>
                <tr>
                  <th>Salesperson</th>
                  {['Opportunities', 'Open', 'Pipeline', 'Weighted', 'Overdue opportunities', 'Stuck', 'Won', 'Won value', 'Lost', 'Quote req.', 'Overdue tasks'].map((h) => (
                    <th key={h} className="ts-r">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {perf.salespeople.map((p, i) => (
                  <tr key={p.id} style={rowStagger(i)}>
                    <td className="font-medium">
                      {p.name} {!p.is_active && <Badge tone="muted">Left</Badge>}
                    </td>
                    <td className="ts-r">{p.metrics.visits}</td>
                    <td className="ts-r">{p.metrics.open_deals}</td>
                    <td className="ts-r">{formatMoney(p.metrics.pipeline_value, { compact: true })}</td>
                    <td className="ts-r">{formatMoney(p.metrics.weighted_pipeline, { compact: true })}</td>
                    <td className={`ts-r ${p.metrics.overdue_deals ? 'text-danger font-medium' : ''}`}>{p.metrics.overdue_deals}</td>
                    <td className={`ts-r ${p.metrics.stuck_deals ? 'text-warn font-medium' : ''}`}>{p.metrics.stuck_deals}</td>
                    <td className="ts-r">{p.metrics.deals_won}</td>
                    <td className="ts-r">{formatMoney(p.metrics.won_value, { compact: true })}</td>
                    <td className="ts-r">{p.metrics.deals_lost}</td>
                    <td className="ts-r">{p.metrics.quotation_requests}</td>
                    <td className={`ts-r ${p.metrics.overdue_follow_ups ? 'text-danger font-medium' : ''}`}>{p.metrics.overdue_follow_ups}</td>
                  </tr>
                ))}
              </tbody>
              {t && (
                <tfoot>
                  <tr className="font-medium">
                    <td>Team</td>
                    <td className="ts-r">{t.visits}</td>
                    <td className="ts-r">{t.open_deals}</td>
                    <td className="ts-r">{formatMoney(t.pipeline_value, { compact: true })}</td>
                    <td className="ts-r">{formatMoney(t.weighted_pipeline, { compact: true })}</td>
                    <td className="ts-r">{t.overdue_deals}</td>
                    <td className="ts-r">{t.stuck_deals}</td>
                    <td className="ts-r">{t.deals_won}</td>
                    <td className="ts-r">{formatMoney(t.won_value, { compact: true })}</td>
                    <td className="ts-r">{t.deals_lost}</td>
                    <td className="ts-r">{t.quotation_requests}</td>
                    <td className="ts-r">{t.overdue_follow_ups}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </Card>
      )}

      {insights && (
        <>
          <Card>
            <CardHeader title="Won, last 6 months" />
            <div className="px-4 sm:px-5 py-4 grid grid-cols-6 gap-2 items-end h-56" role="list">
              {insights.won_by_month.map((m, i) => (
                <div key={m.month} className={`ts-col !flex-col !items-center gap-1.5 !cursor-default ${i === insights.won_by_month.length - 1 ? 'ts-on' : ''}`} role="listitem" aria-label={`${monthLabel(m.month)}: ${formatMoney(m.won_value)}, ${m.deals_won} opportunities`}>
                  <span className="text-[11px] text-ink-muted tabular-nums">{m.won_value ? formatMoney(m.won_value, { compact: true }) : ''}</span>
                  <div className="ts-bar" style={{ height: `${Math.max(3, (m.won_value / maxMonth) * 80)}%` }} />
                  <span className="text-xs text-ink-muted">{monthLabel(m.month)}</span>
                </div>
              ))}
            </div>
          </Card>

          <div className="ts-grid ts-row-half !mt-0 items-start">
            {[
              { title: 'By product category', rows: insights.by_category.map((r) => ({ key: r.category, ...r })) },
              { title: 'By city', rows: insights.by_city.map((r) => ({ key: r.city, ...r })) },
              { title: 'By OEM', rows: insights.by_oem.map((r) => ({ key: r.oem, ...r })) },
              { title: 'By market segment', rows: insights.by_segment.map((r) => ({ key: r.segment, ...r })) },
            ].map((section, i) => (
              <Card key={section.title} style={stagger(i)}>
                <CardHeader title={section.title} description={section.title === 'By market segment' ? 'An opportunity in two segments counts in both.' : 'Won in the period · open pipeline now'} />
                {section.rows.length === 0 && <EmptyState>Nothing yet.</EmptyState>}
                <ul className="divide-y divide-dashed divide-line overflow-hidden rounded-b-card">
                  {section.rows.map((r) => (
                    <li key={r.key} className="px-4 sm:px-5 py-2.5 flex items-center justify-between gap-3 text-sm">
                      <span className="min-w-0 truncate">{r.key}</span>
                      <span className="text-right tabular-nums shrink-0">
                        <span className="text-ok font-medium">{formatMoney(r.won_value, { compact: true })}</span>
                        <span className="text-subtle"> · </span>
                        <span>{formatMoney(r.pipeline_value, { compact: true })}</span>
                        <span className="text-subtle text-xs"> ({r.open_deals})</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            ))}
          </div>

          <Card>
            <CardHeader title="Opportunities going quiet" description={`Open opportunities with no activity for ${insights.stale_after_days}+ days, biggest first.`} />
            {insights.stale_deals.length === 0 && <EmptyState>Every open opportunity has had recent activity.</EmptyState>}
            <ul className="divide-y divide-dashed divide-line overflow-hidden rounded-b-card">
              {insights.stale_deals.map((d) => (
                <li key={d.id}>
                  <Link to={`/pipeline/${d.id}`} className="flex items-center justify-between gap-3 px-4 sm:px-5 py-3 hover:bg-surface transition-colors">
                    <span className="min-w-0">
                      <span className="block text-sm font-medium truncate">{d.title}</span>
                      <span className="block text-xs text-ink-muted truncate">
                        {d.company_name} · {d.owner_name} · {STAGE_LABELS[d.stage]}
                      </span>
                    </span>
                    <span className="text-right shrink-0">
                      <span className="block text-sm font-medium tabular-nums">{formatMoney(d.estimated_value, { compact: true })}</span>
                      <span className="block text-xs text-danger">{d.idle_days} days quiet</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>

          {t && t.lost_reasons.length > 0 && (
            <Card>
              <CardHeader title="Why opportunities were lost" />
              <div className="px-4 sm:px-5 py-3">
                {t.lost_reasons.map((r) => (
                  <div key={r.reason} className="ts-hbar">
                    <span>{LOST_REASON_LABELS[r.reason]}</span>
                    <div className="ts-t">
                      <i style={{ width: `${(r.count / Math.max(...t.lost_reasons.map((x) => x.count))) * 100}%` }} />
                    </div>
                    <span className="ts-p">{r.count}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
