import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { TenderRow, api } from '../../lib/api';
import { BID_STATUS_LABELS, EMD_STATUS_LABELS, daysLabel, formatDate, formatMoney } from '../../lib/labels';
import { useAuth } from '../../lib/auth';
import { Badge, DESKTOP_ONLY, EmptyState, Notice, PHONE_ONLY, PageHeader, SkeletonRows, rowStagger } from '../../components/ui';

const VIEWS = [
  ['open', 'To submit'],
  ['submitted', 'Submitted'],
  ['emd', 'EMD to recover'],
  ['all', 'All'],
] as const;

type View = (typeof VIEWS)[number][0];

function BidStatus({ tender: t }: { tender: TenderRow }) {
  return <Badge tone={t.bid_status === 'won' ? 'ok' : t.bid_status === 'lost' || t.bid_status === 'cancelled' ? 'muted' : 'brand'}>{BID_STATUS_LABELS[t.bid_status]}</Badge>;
}

function DaysLeft({ tender: t }: { tender: TenderRow }) {
  if (t.bid_status !== 'preparing') return null;
  return <span className={t.is_late || t.days_left < 3 ? 'ts-st ts-tone-bad' : 'ts-due ts-warn'}>{daysLabel(t.days_left)}</span>;
}

// Bid deadlines, and deposits that should be coming back.
export default function Tenders() {
  const { user } = useAuth();
  const teamView = user?.role !== 'salesperson';
  const [view, setView] = useState<View>('open');
  const [rows, setRows] = useState<TenderRow[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setRows(null);
    setError('');
    api.tenders.list(view).then(setRows).catch((err) => setError(err.message));
  }, [view]);

  const emdTotal = rows?.reduce((sum, t) => sum + (t.emd_amount ?? 0), 0) ?? 0;

  return (
    <div>
      <PageHeader title="Tenders" description="Add tender details from the opportunity page of any opportunity marked as a tender." />
      {error && <Notice tone="error">{error}</Notice>}
      {view === 'emd' && rows && rows.length > 0 && (
        <p className="ts-box text-sm mb-4">
          <b className="font-medium">{formatMoney(emdTotal)}</b> in deposits should be coming back. Mark each one refunded or forfeited when it’s settled.
        </p>
      )}
      <section className="ts-card ts-white ts-tcard ts-tbl !mt-0">
        <div className="ts-tbar">
          <div className="ts-tabs" role="tablist">
            {VIEWS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={view === value}
                onClick={() => setView(value)}
                className={`ts-tab max-[860px]:min-h-11 ${view === value ? 'ts-on' : ''}`}
              >
                {label}
              </button>
            ))}
          </div>
          {rows && <span className="ts-showing ts-muted">Showing {rows.length}</span>}
        </div>
        {rows === null && !error && <SkeletonRows />}
        {rows?.length === 0 && (
          <EmptyState>{view === 'open' ? 'No bids waiting to be submitted.' : view === 'emd' ? 'No deposits waiting to come back.' : 'Nothing here yet.'}</EmptyState>
        )}
        {rows && rows.length > 0 && (
          <>
            <div className={`ts-tblwrap ${DESKTOP_ONLY}`}>
              <table>
                <thead>
                  <tr>
                    <th>Opportunity</th>
                    <th>Company</th>
                    <th>Tender no.</th>
                    <th>Authority</th>
                    {teamView && <th>Owner</th>}
                    <th>Bid due</th>
                    <th>EMD</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((t, i) => (
                    <tr key={t.opportunity_id} style={rowStagger(i)}>
                      <td className="ts-wrap">
                        <Link to={`/pipeline/${t.opportunity_id}`} className="ts-lnk font-medium">
                          {t.deal_title}
                        </Link>
                      </td>
                      <td className="ts-wrap">{t.company_name}</td>
                      <td className="ts-muted">{t.tender_number}</td>
                      <td className="ts-muted ts-wrap">{t.issuing_authority || '—'}</td>
                      {teamView && <td className="ts-muted">{t.owner_name}</td>}
                      <td>
                        <div>{formatDate(t.bid_due_date)}</div>
                        <DaysLeft tender={t} />
                      </td>
                      <td className="ts-muted">
                        {EMD_STATUS_LABELS[t.emd_status]}
                        {t.emd_amount != null && <div>{formatMoney(t.emd_amount, { compact: true })}</div>}
                      </td>
                      <td>
                        <BidStatus tender={t} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className={`ts-list ${PHONE_ONLY}`}>
              {rows.map((t) => (
                <Link key={t.opportunity_id} to={`/pipeline/${t.opportunity_id}`} className="ts-li !grid-cols-[minmax(0,1fr)_auto] !items-start">
                  <div className="min-w-0">
                    <div className="ts-nm !whitespace-normal">{t.deal_title}</div>
                    <div className="ts-sub break-words">
                      {t.company_name} · {t.tender_number}
                      {t.issuing_authority && ` · ${t.issuing_authority}`}
                      {teamView && ` · ${t.owner_name}`}
                    </div>
                    <div className="ts-sub">
                      Due {formatDate(t.bid_due_date)} · EMD {EMD_STATUS_LABELS[t.emd_status].toLowerCase()}
                      {t.emd_amount != null && ` ${formatMoney(t.emd_amount, { compact: true })}`}
                    </div>
                  </div>
                  <span className="flex flex-col items-end gap-1 shrink-0">
                    <BidStatus tender={t} />
                    <DaysLeft tender={t} />
                  </span>
                </Link>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
