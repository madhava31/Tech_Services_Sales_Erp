import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useLoad } from '../../lib/useLoad';
import { formatDateTime, formatMoney } from '../../lib/labels';
import { DESKTOP_ONLY, EmptyState, Notice, OverdueBadge, PHONE_ONLY, PageHeader, SkeletonRows, rowStagger } from '../../components/ui';

// The office's queue: deals where the customer asked for a quotation and none is recorded yet.
// Prepare the quotation in the Technicon Services ERP, then record its number on the deal.
export default function QuotationQueue() {
  const queue = useLoad(api.opportunities.quotationRequests, []);
  return (
    <div>
      <PageHeader
        title="Quotation requests"
        description="Customers waiting for a quotation, oldest first. Prepare it in the ERP, then record it on the opportunity."
      />
      {queue.error && <Notice tone="error">{queue.error}</Notice>}
      <section className="ts-card ts-white ts-tcard ts-tbl !mt-0">
        {queue.loading && queue.data.length === 0 && <SkeletonRows />}
        {queue.data.length === 0 && !queue.loading && <EmptyState>No quotations waiting.</EmptyState>}
        {queue.data.length > 0 && (
          <>
            <div className={`ts-tblwrap !mt-0 ${DESKTOP_ONLY}`}>
              <table>
                <thead>
                  <tr>
                    <th>Company</th>
                    <th>Opportunity</th>
                    <th>Owner</th>
                    <th>Updated</th>
                    <th className="ts-r">Value</th>
                    <th className="ts-r">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {queue.data.map((d, i) => (
                    <tr key={d.id} style={rowStagger(i)}>
                      <td>
                        <Link to={`/pipeline/${d.id}`} className="ts-lnk font-medium">
                          {d.company_name}
                        </Link>
                      </td>
                      <td className="ts-wrap">{d.title}</td>
                      <td className="ts-muted">{d.owner_name}</td>
                      <td className="ts-muted">{formatDateTime(d.updated_at)}</td>
                      <td className="ts-r">
                        <div className="flex items-center justify-end gap-2">
                          {d.is_overdue && <OverdueBadge />}
                          {formatMoney(d.estimated_value, { compact: true })}
                        </div>
                      </td>
                      <td className="ts-r">
                        <div className="ts-racts">
                          <Link to={`/pipeline/${d.id}`} className="ts-btn ts-ghost ts-xs">
                            Open opportunity
                          </Link>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className={`ts-list !mt-0 ${PHONE_ONLY}`}>
              {queue.data.map((d) => (
                <Link key={d.id} to={`/pipeline/${d.id}`} className="ts-li !grid-cols-[minmax(0,1fr)_auto]">
                  <div className="min-w-0">
                    <div className="ts-nm">{d.company_name}</div>
                    <div className="ts-sub truncate">
                      {d.title} · {d.owner_name} · updated {formatDateTime(d.updated_at)}
                    </div>
                  </div>
                  <span className="flex flex-col items-end gap-1 shrink-0">
                    {d.is_overdue && <OverdueBadge />}
                    <span className="ts-amt">{formatMoney(d.estimated_value, { compact: true })}</span>
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
