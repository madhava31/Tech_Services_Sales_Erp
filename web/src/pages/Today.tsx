import { Children, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDownIcon } from 'lucide-react';
import { CountUp } from '../components/ds/CountUp';
import { Gauge } from '../components/ds/Gauge';
import { RevenueBars } from '../components/ds/RevenueBars';
import { Spark } from '../components/ds/Spark';
import { api, Performance, Task, TodayData } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useLoad } from '../lib/useLoad';
import { OUTCOME_LABELS, STAGE_LABELS, daysLabel, formatDate, formatDateTime, formatMoney, localDate } from '../lib/labels';
import { canRecordQuotations, canWriteCrm } from '../lib/roles';
import TaskItem from '../components/TaskItem';
import { Badge, Card, CardHeader, Notice, OverdueBadge, Skeleton, StuckBadge, stagger } from '../components/ui';

const whole = (v: number) => Math.round(v).toLocaleString('en-IN');
const RING = 2 * Math.PI * 19;

interface Trends {
  // Oldest first, seven days each, the last ending today.
  weeks: (Performance & { label: string })[];
  month: Performance;
}

// The figures behind the small charts. They're extra: if they can't load (no signal), the page works without them.
function useTrends() {
  const [trends, setTrends] = useState<Trends | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const ranges = [5, 4, 3, 2, 1, 0].map((n) => ({ from: localDate(-7 * n - 6), to: localDate(-7 * n) }));
    Promise.all([...ranges.map((r) => api.performance(r)), api.performance({ days: 30 })])
      .then((rows) => {
        if (cancelled) return;
        const month = rows[rows.length - 1];
        setTrends({ weeks: ranges.map((r, i) => ({ ...rows[i], label: formatDate(r.from) })), month });
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, []);
  return { trends, failed };
}

function Kpi({ i, white, label, value, note, tone, chart, foot, to }: { i: number; white?: boolean; label: string; value: number; note: string; tone?: 'danger'; chart?: React.ReactNode; foot: string; to: string }) {
  return (
    <div className={`ts-card ${white ? 'ts-white' : ''}`} style={stagger(i)}>
      <div className="ts-ch">{label}</div>
      <div className="ts-kbody">
        <div>
          <div className={`ts-val ${tone === 'danger' && value > 0 ? 'text-danger' : ''}`}>
            <CountUp value={value} format={whole} />
          </div>
          <div className="ts-delta">{note}</div>
        </div>
        {chart}
      </div>
      <Link className="ts-kfoot" to={to}>
        {foot}
      </Link>
    </div>
  );
}

// Open follow-ups per day, from six days ago to a week ahead. Anything older counts on the first day.
function followUpsByDay(data: TodayData) {
  const days = Array.from({ length: 14 }, (_, i) => localDate(i - 6));
  const counts = days.map(() => 0);
  for (const task of [...data.overdue, ...data.due_today, ...data.upcoming]) {
    const at = days.indexOf(task.due_date);
    if (at >= 0) counts[at] += 1;
    else if (task.due_date < days[0]) counts[0] += 1;
  }
  return counts;
}

function WinRateCard({ month, i }: { month: Performance | null; i: number }) {
  const rate = month?.win_rate ?? null;
  return (
    <div className="ts-card ts-white ts-gauge-card" style={stagger(i)}>
      <div className="ts-ch">Opportunity win rate</div>
      <div className="ts-gwrap">
        <Gauge value={(rate ?? 0) / 100} />
        <div className="ts-gval">
          <div className="ts-big">
            <span>
              <CountUp value={rate ?? 0} format={(v) => String(Math.round(v))} duration={1700} />
            </span>
            <span style={{ fontSize: '.5em', opacity: 0.7, marginLeft: -8 }}>%</span>
          </div>
          <small>of closed opportunities won</small>
        </div>
      </div>
      <h4>{rate === null ? 'No closed opportunities yet' : rate >= 50 ? 'Winning more than you lose' : 'Room to improve'}</h4>
      <p>
        {!month
          ? 'Loading…'
          : rate === null
            ? 'Mark opportunities won or lost and the last 30 days show here.'
            : `${month.deals_won} won and ${month.deals_lost} lost in the last 30 days.`}
      </p>
      <Link className="ts-kfoot" to="/pipeline">
        See pipeline
      </Link>
    </div>
  );
}

function Row({ to, title, sub, children }: { to: string; title: string; sub: React.ReactNode; children: React.ReactNode }) {
  return (
    <li>
      <Link to={to} className="flex items-center justify-between gap-3 px-4 sm:px-5 py-3 hover:bg-surface transition-colors">
        <span className="min-w-0">
          <span className="block text-sm font-medium truncate">{title}</span>
          <span className="block text-xs text-subtle truncate">{sub}</span>
        </span>
        {children}
      </Link>
    </li>
  );
}

// Shows the top item; "View all" opens the rest, scrolling inside the card so a long list can't stretch the page.
function TopOne({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const items = Children.toArray(children);
  return (
    <>
      <ul className={`divide-y divide-dashed divide-line ${open ? 'max-h-[420px] overflow-y-auto' : 'overflow-hidden'} ${items.length > 1 ? '' : 'rounded-b-card'}`}>{open ? items : items.slice(0, 1)}</ul>
      {items.length > 1 && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex items-center justify-center gap-1.5 w-full px-4 py-2.5 max-[860px]:min-h-11 text-[13.5px] text-brand border-t border-dashed border-line rounded-b-card hover:bg-surface transition-colors"
        >
          {open ? 'Show less' : `View all (${items.length})`}
          <ChevronDownIcon className={`size-4 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
        </button>
      )}
    </>
  );
}

function TaskSection({ title, tasks, data, i, ...rest }: { title: string; tasks: Task[]; data: TodayData; i: number } & Omit<React.ComponentProps<typeof TaskItem>, 'task' | 'today'>) {
  if (tasks.length === 0) return null;
  return (
    <Card style={stagger(i)}>
      <CardHeader title={title} action={<Badge>{tasks.length}</Badge>} />
      <TopOne>
        {tasks.map((t) => (
          <TaskItem key={t.id} task={t} today={data.today} {...rest} />
        ))}
      </TopOne>
    </Card>
  );
}

export default function Today() {
  const { user } = useAuth();
  const today = useLoad<TodayData | null>(api.today, null);
  const [error, setError] = useState('');
  const writer = canWriteCrm(user?.role);
  const teamView = user?.role !== 'salesperson';
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const data = today.data;
  const nothingDue = data && data.overdue.length + data.due_today.length + data.upcoming.length === 0;
  const { trends, failed } = useTrends();
  const quotedPct = trends && trends.month.quotation_requests > 0 ? Math.min(100, Math.round((trends.month.quotations_sent / trends.month.quotation_requests) * 100)) : 0;
  const ticks = data ? followUpsByDay(data) : [];
  const tickMax = Math.max(1, ...ticks);

  return (
    <div>
      <header className="ts-phead">
        <div>
          <div className="ts-crumb">{new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}</div>
          <h1 className="ts-title">
            {greeting}, {user?.username}
          </h1>
          {teamView && <p className="ts-muted mt-1.5">Showing the whole team.</p>}
        </div>
        <span className="ts-grow" />
        {writer && (
          <Link to="/opportunities/new" className="ts-btn ts-dark justify-center max-[860px]:min-h-11 max-sm:w-full">
            + New opportunity
          </Link>
        )}
      </header>

      <div className="flex flex-col gap-3 empty:hidden mb-4">
        {error && <Notice tone="error" onDismiss={() => setError('')}>{error}</Notice>}
        {today.error && <Notice tone="error">{today.error}</Notice>}
        {user?.role === 'salesperson' && !user.salesperson_id && (
          <Notice tone="error">Your login isn't linked to a salesperson record yet. Ask your administrator.</Notice>
        )}
      </div>

      {!data && today.loading && (
        <div className="ts-grid ts-kpis" aria-busy="true" aria-label="Loading">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="ts-card ts-white ts-kpi-sm flex flex-col gap-3">
              <Skeleton width="70%" />
              <Skeleton width="35%" height={24} />
            </div>
          ))}
        </div>
      )}

      {data && (
        <div className="flex flex-col">
          <div className="ts-grid ts-kpis order-1">
            <Kpi
              i={0}
              white
              label="Opportunities"
              value={data.stats.visits_this_week}
              note="This week"
              foot="See opportunities"
              to="/visits"
              chart={
                trends && (
                  <div className="ts-minibars" aria-hidden="true">
                    {trends.weeks.slice(-3).map((w, n, a) => (
                      <i key={w.label} style={{ '--h': `${8 + Math.round((w.visits / Math.max(1, ...a.map((x) => x.visits))) * 36)}px`, '--d': `${n * 80}ms` } as React.CSSProperties} />
                    ))}
                  </div>
                )
              }
            />
            <Kpi
              i={1}
              white
              label="Companies visited"
              value={data.stats.companies_visited_30d}
              note="Last 30 days"
              foot="See companies"
              to="/companies"
              chart={trends && <Spark values={trends.weeks.map((w) => w.companies_visited)} small />}
            />
            <Kpi
              i={2}
              label="Quotation requests"
              value={data.stats.quotation_requests_30d}
              note={trends ? `${trends.month.quotations_sent} quotations sent` : 'Last 30 days'}
              foot={canRecordQuotations(user?.role) ? 'See quotation requests' : 'See pipeline'}
              to={canRecordQuotations(user?.role) ? '/quotation-requests' : '/pipeline'}
              chart={
                trends && (
                  <svg className="ts-ring shrink-0" width="46" height="46" viewBox="0 0 46 46" role="img" aria-label={`${quotedPct}% as many quotations sent as requested`}>
                    <title>{quotedPct}% as many quotations sent as requested</title>
                    <circle className="ts-bg" cx="23" cy="23" r="19" />
                    <circle className="ts-fg" cx="23" cy="23" r="19" transform="rotate(-90 23 23)" strokeDasharray={RING} strokeDashoffset={RING * (1 - quotedPct / 100)} />
                    <text x="23" y="27" textAnchor="middle">
                      {quotedPct}%
                    </text>
                  </svg>
                )
              }
            />
            <Kpi
              i={3}
              label="Overdue follow-ups"
              value={data.stats.overdue_follow_ups}
              tone="danger"
              note={`${data.due_today.length} due today`}
              foot="See follow-ups"
              to="/tasks"
              chart={
                <div className="ts-ticks" aria-hidden="true">
                  {ticks.map((v, n) => (
                    <i key={n} style={{ '--h': `${6 + Math.round((v / tickMax) * 32)}px`, '--d': `${n * 30}ms` } as React.CSSProperties} />
                  ))}
                </div>
              }
            />
          </div>

          {/* Phones: below the lists, so today's work stays near the top. */}
          {!failed && (
            <div className="ts-grid ts-row2 order-3 min-[861px]:order-2">
              <WinRateCard month={trends?.month ?? null} i={4} />
              <div className="ts-card ts-white" style={stagger(5)}>
                <div className="ts-rhead">
                  <div className="ts-ch">
                    <b>Orders won</b> <span>Last 6 weeks</span>
                  </div>
                </div>
                {trends ? (
                  <RevenueBars data={trends.weeks.map((w) => ({ label: w.label, value: w.won_value }))} metric="Orders won" emptyText="No orders won in these weeks" />
                ) : (
                  <div className="ts-skel" style={{ height: 280, marginTop: 12 }} />
                )}
              </div>
            </div>
          )}

          <div className="ts-grid ts-row-half items-start order-2 min-[861px]:order-3">
            {data.draft_visits.length > 0 && (
              <Card style={stagger(4)}>
                <CardHeader title="Opportunities to finish" description="Record the outcome and next step while it's fresh." />
                <TopOne>
                  {data.draft_visits.map((v) => (
                    <Row
                      key={v.id}
                      to={v.local_uuid ? `/visits/local/${v.local_uuid}` : `/visits/${v.id}`}
                      title={v.company_name}
                      sub={
                        <>
                          Started {formatDateTime(v.visited_at)}
                          {teamView && ` · ${v.salesperson_name}`}
                        </>
                      }
                    >
                      <span className="text-sm font-medium text-brand shrink-0">Finish →</span>
                    </Row>
                  ))}
                </TopOne>
              </Card>
            )}

            {data.erp_orders.length > 0 && (
              <Card style={stagger(5)}>
                <CardHeader title="Orders received" description="The customer’s order is in the ERP, but the opportunity is still open. Mark it won." />
                <TopOne>
                  {data.erp_orders.map((o) => (
                    <Row
                      key={o.id}
                      to={`/pipeline/${o.id}`}
                      title={o.title}
                      sub={
                        <>
                          {o.company_name}
                          {teamView && ` · ${o.owner_name}`}
                        </>
                      }
                    >
                      <span className="text-xs font-medium text-ok shrink-0">{o.order_number}</span>
                    </Row>
                  ))}
                </TopOne>
              </Card>
            )}

            {data.tenders_due.length > 0 && (
              <Card style={stagger(6)}>
                <CardHeader title="Tenders due" description="Bids not yet submitted, due within a week." action={<Link to="/tenders" className="text-sm font-medium text-brand shrink-0">All tenders</Link>} />
                <TopOne>
                  {data.tenders_due.map((t) => (
                    <Row
                      key={t.opportunity_id}
                      to={`/pipeline/${t.opportunity_id}`}
                      title={t.title}
                      sub={
                        <>
                          {t.company_name} · {t.tender_number}
                          {teamView && ` · ${t.owner_name}`}
                        </>
                      }
                    >
                      <span className={`shrink-0 ${t.days_left < 3 ? 'ts-st ts-tone-bad' : 'ts-due ts-warn'}`}>{daysLabel(t.days_left)}</span>
                    </Row>
                  ))}
                </TopOne>
              </Card>
            )}

            {data.overdue_deals.length > 0 && (
              <Card style={stagger(7)}>
                <CardHeader title="Overdue opportunities" description="Past their expected closing date. Update the date or close them." action={<Badge>{data.overdue_deals.length}</Badge>} />
                <TopOne>
                  {data.overdue_deals.map((d) => (
                    <Row
                      key={d.id}
                      to={`/pipeline/${d.id}`}
                      title={d.title}
                      sub={
                        <>
                          {d.company_name}
                          {teamView && ` · ${d.owner_name}`} · was due {formatDate(d.expected_close_date)}
                        </>
                      }
                    >
                      <span className="flex flex-col items-end gap-1 shrink-0">
                        <OverdueBadge />
                        <span className="text-xs font-medium tabular-nums">{formatMoney(d.estimated_value, { compact: true })}</span>
                      </span>
                    </Row>
                  ))}
                </TopOne>
              </Card>
            )}

            {data.stuck_deals.length > 0 && (
              <Card style={stagger(8)}>
                <CardHeader title="Stuck opportunities" description="In the same stage for too long. Move them on, or close them." action={<Badge>{data.stuck_deals.length}</Badge>} />
                <TopOne>
                  {data.stuck_deals.map((d) => (
                    <Row
                      key={d.id}
                      to={`/pipeline/${d.id}`}
                      title={d.title}
                      sub={
                        <>
                          {d.company_name}
                          {teamView && ` · ${d.owner_name}`} · {STAGE_LABELS[d.stage]}
                        </>
                      }
                    >
                      <span className="flex flex-col items-end gap-1 shrink-0">
                        <StuckBadge days={d.days_in_stage} />
                        <span className="text-xs font-medium tabular-nums">{formatMoney(d.estimated_value, { compact: true })}</span>
                      </span>
                    </Row>
                  ))}
                </TopOne>
              </Card>
            )}

            <TaskSection i={9} title="Overdue follow-ups" tasks={data.overdue} data={data} showAssignee={teamView} canAct={writer} onChanged={today.reload} onError={setError} />
            <TaskSection i={10} title="Due today" tasks={data.due_today} data={data} showAssignee={teamView} canAct={writer} onChanged={today.reload} onError={setError} />
            <TaskSection i={11} title="Next 7 days" tasks={data.upcoming} data={data} showAssignee={teamView} canAct={writer} onChanged={today.reload} onError={setError} />
            {nothingDue && (
              <Card className="p-5" style={stagger(9)}>
                <p className="text-sm text-subtle">No follow-ups due this week.</p>
              </Card>
            )}

            {data.recent_visits.length > 0 && (
              <Card style={stagger(12)}>
                <CardHeader title="Recent opportunities" action={<Link to="/visits" className="text-sm font-medium text-brand shrink-0">All opportunities</Link>} />
                <TopOne>
                  {data.recent_visits.map((v) => (
                    <Row
                      key={v.id}
                      to={`/visits/${v.id}`}
                      title={v.company_name}
                      sub={
                        <>
                          {formatDateTime(v.visited_at)}
                          {teamView && ` · ${v.salesperson_name}`}
                        </>
                      }
                    >
                      <Badge>{OUTCOME_LABELS[v.outcome]}</Badge>
                    </Row>
                  ))}
                </TopOne>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
