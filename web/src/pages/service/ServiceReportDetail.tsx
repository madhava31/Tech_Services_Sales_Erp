import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ServiceReport } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useLoad } from '../../lib/useLoad';
import { formatDate, formatDateTime } from '../../lib/labels';
import { canWriteCrm, isManagingRole } from '../../lib/roles';
import companyLogo from '../../assets/brand/technicon-logo.png';
import { Badge, Button, LoadingCard, Notice, TextField } from '../../components/ui';

const dash = (v: string | null | undefined) => (v && v.trim() ? v : '—');
const date = (v: string | null | undefined) => (v ? formatDate(v) : '—');

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border border-line2 px-3 py-2 min-w-0">
      <div className="text-[11px] uppercase tracking-wide ts-muted">{label}</div>
      <div className="text-[14px] break-words">{children}</div>
    </div>
  );
}

// The report laid out like the paper form. "Print / save as PDF" prints just this page (the menus are hidden).
export default function ServiceReportDetail() {
  const id = Number(useParams().id);
  const { user } = useAuth();
  const load = useLoad<ServiceReport | null>(() => api.serviceReports.get(id), null);
  const [reopening, setReopening] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const r = load.data;

  if (load.error) return <Notice tone="error">{load.error}</Notice>;
  if (!r) return <LoadingCard />;

  const writer = canWriteCrm(user?.role);
  const parts = r.parts.filter((p) => p.description.trim() && p.description.trim().toUpperCase() !== 'NA');

  async function reopen(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.serviceReports.reopen(id, reason.trim());
      setReopening(false);
      setReason('');
      await load.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reopen the report.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <Link to="/service-reports" className="ts-back !mb-0">
          ← Service reports
        </Link>
        <span className="flex-1" />
        <Badge tone={r.status === 'completed' ? 'ok' : 'muted'}>{r.status === 'completed' ? 'Completed' : 'Draft'}</Badge>
        {r.status === 'draft' && writer && (
          <Link to={`/service-reports/${r.id}/edit`} className="ts-btn ts-dark">
            Continue editing
          </Link>
        )}
        <Button variant="secondary" size="sm" onClick={() => window.print()}>
          Print / save as PDF
        </Button>
        {r.status === 'completed' && isManagingRole(user?.role) && (
          <Button variant="ghost" size="sm" onClick={() => setReopening((v) => !v)}>
            Reopen…
          </Button>
        )}
      </div>
      {error && <Notice tone="error" onDismiss={() => setError('')}>{error}</Notice>}
      {reopening && (
        <form onSubmit={reopen} className="ts-box flex flex-col sm:flex-row sm:items-end gap-2 print:hidden">
          <div className="flex-1">
            <TextField label="Why is it being reopened? The signatures are cleared and taken again." value={reason} onChange={(e) => setReason(e.target.value)} autoFocus required />
          </div>
          <Button type="submit" variant="danger" disabled={busy || !reason.trim()}>
            Reopen report
          </Button>
        </form>
      )}

      <article className="bg-white text-black border border-line2 rounded-card p-4 sm:p-6 max-w-[860px] w-full mx-auto print:border-0 print:p-0 print:max-w-none">
        <header className="grid grid-cols-[auto_1fr] gap-4 items-center border border-line2 p-3">
          <img src={companyLogo} alt="Technicon Services" width={170} height={36} />
          <div className="text-[12px] leading-snug">
            <div>H. No: 6-83/S-202, Divya Sai Residency, Canara Nagar Colony, Near Sivalayam Temple, Peerzadiguda, Hyderabad-500098</div>
            <div>Phone No: 91-9676233304 · E-Mail ID: info@techniconservices.com</div>
          </div>
        </header>

        <div className="flex items-center justify-between mt-4 mb-2">
          <h1 className="m-0 text-[18px] font-semibold tracking-wide">FIELD SERVICE REPORT</h1>
          <div className="text-[14px]">
            FSR NO: <b className="tabular-nums">{r.code}</b>
          </div>
        </div>

        <div className="grid sm:grid-cols-2 gap-0">
          <Cell label="Company name">{r.company_name}</Cell>
          <Cell label="Company address">{dash(r.company_address)}</Cell>
          <Cell label="User name">{dash(r.user_name)}</Cell>
          <Cell label="Department">{dash(r.user_department)}</Cell>
          <Cell label="Designation">{dash(r.user_designation)}</Cell>
          <Cell label="Contact no &amp; email ID">{[r.user_phone, r.user_email].filter(Boolean).join(' · ') || '—'}</Cell>
          <Cell label="Call reported date">{date(r.call_reported_date)}</Cell>
          <Cell label="Call attended date">{date(r.call_attended_date)}</Cell>
          <Cell label="Call completed date">{date(r.call_completed_date)}</Cell>
          <Cell label="Instrument make">{dash(r.instrument_make)}</Cell>
          <Cell label="Instrument name">{r.instrument_name}</Cell>
          <Cell label="Model no">{dash(r.model_no)}</Cell>
          <Cell label="Serial no &amp; ID">{dash(r.serial_no)}</Cell>
          <Cell label="Lab">{dash(r.lab)}</Cell>
        </div>

        <div className="border border-line2 px-3 py-2 mt-3">
          <div className="text-[11px] uppercase tracking-wide ts-muted">Problem reported</div>
          <p className="m-0 whitespace-pre-wrap text-[14px]">{r.problem_reported}</p>
          {r.work_done && (
            <>
              <div className="text-[11px] uppercase tracking-wide ts-muted mt-3">Work done and findings</div>
              <p className="m-0 whitespace-pre-wrap text-[14px]">{r.work_done}</p>
            </>
          )}
        </div>

        <table className="w-full mt-3 border-collapse text-[14px]">
          <caption className="text-left font-semibold py-1">Required / replaced parts</caption>
          <thead>
            <tr className="[&>th]:border [&>th]:border-line2 [&>th]:px-3 [&>th]:py-1.5 [&>th]:text-left">
              <th className="w-[26%]">Part no</th>
              <th>Description</th>
              <th className="w-[10%]">Qty</th>
            </tr>
          </thead>
          <tbody>
            {parts.length === 0 ? (
              <tr className="[&>td]:border [&>td]:border-line2 [&>td]:px-3 [&>td]:py-1.5">
                <td>NA</td>
                <td>NA</td>
                <td>NA</td>
              </tr>
            ) : (
              parts.map((p) => (
                <tr key={p.id} className="[&>td]:border [&>td]:border-line2 [&>td]:px-3 [&>td]:py-1.5">
                  <td>{dash(p.part_no)}</td>
                  <td>{p.description}</td>
                  <td>{p.qty}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        <div className="border border-line2 px-3 py-2 mt-3">
          <div className="text-[11px] uppercase tracking-wide ts-muted">User comments</div>
          <p className="m-0 whitespace-pre-wrap text-[14px] min-h-[1.5em]">{dash(r.user_comments)}</p>
        </div>

        <div className="grid sm:grid-cols-2 gap-0 mt-3">
          <div className="border border-line2 px-3 py-2">
            <div className="text-[11px] uppercase tracking-wide ts-muted">Engineer name &amp; signature</div>
            <div className="text-[14px]">{r.engineer_name}</div>
            {r.engineer_signature ? <img src={r.engineer_signature} alt="Engineer's signature" className="h-16 object-contain" /> : <div className="h-16 ts-muted text-xs pt-5">Not signed</div>}
            {r.engineer_signed_at && <div className="text-xs ts-muted">{formatDateTime(r.engineer_signed_at)}</div>}
          </div>
          <div className="border border-line2 px-3 py-2">
            <div className="text-[11px] uppercase tracking-wide ts-muted">Customer’s name &amp; signature</div>
            <div className="text-[14px]">{dash(r.customer_name)}</div>
            {r.customer_signature ? <img src={r.customer_signature} alt="Customer's signature" className="h-16 object-contain" /> : <div className="h-16 ts-muted text-xs pt-5">Not signed</div>}
            {r.customer_signed_at && <div className="text-xs ts-muted">{formatDateTime(r.customer_signed_at)}</div>}
          </div>
        </div>
      </article>
    </div>
  );
}
