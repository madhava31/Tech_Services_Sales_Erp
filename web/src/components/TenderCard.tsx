import { useState } from 'react';
import { BidStatus, EmdStatus, OpportunityDetail, api } from '../lib/api';
import { BID_STATUS_LABELS, EMD_STATUS_LABELS, daysLabel, formatDate, formatIndianDigits, formatMoney } from '../lib/labels';
import { Badge, Button, Card, CardHeader, EmptyState, Notice, SelectField, TextAreaField, TextField } from './ui';

// The tender side of a deal. Stays editable after the deal closes: the deposit usually comes back later.
export default function TenderCard({ deal, canEdit, onChanged }: { deal: OpportunityDetail; canEdit: boolean; onChanged: () => void }) {
  const t = deal.tender_details;
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    tender_number: t?.tender_number ?? '',
    issuing_authority: t?.issuing_authority ?? '',
    bid_due_date: t?.bid_due_date ?? '',
    pre_bid_date: t?.pre_bid_date ?? '',
    emd_amount: t?.emd_amount != null ? String(Math.round(t.emd_amount)) : '',
    emd_status: (t?.emd_status ?? 'not_required') as EmdStatus,
    bid_status: (t?.bid_status ?? 'preparing') as BidStatus,
    document_url: t?.document_url ?? '',
    notes: t?.notes ?? '',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const needsAmount = form.emd_status !== 'not_required';

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.tenders.save(deal.id, {
        ...form,
        issuing_authority: form.issuing_authority || null,
        pre_bid_date: form.pre_bid_date || null,
        emd_amount: form.emd_amount === '' ? null : Number(form.emd_amount),
        document_url: form.document_url || null,
        notes: form.notes || null,
      });
      setEditing(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the tender.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Tender"
        action={
          canEdit && !editing ? (
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
              {t ? 'Update' : '+ Add details'}
            </Button>
          ) : undefined
        }
      />
      {editing && (
        <form onSubmit={save} className="p-4 sm:p-5 ts-fgrid ts-g2 !mt-0">
          {error && (
            <div className="ts-span2 min-w-0">
              <Notice tone="error">{error}</Notice>
            </div>
          )}
          <TextField label="Tender number" value={form.tender_number} onChange={(e) => setForm({ ...form, tender_number: e.target.value })} required />
          <TextField label="Issuing authority" value={form.issuing_authority} onChange={(e) => setForm({ ...form, issuing_authority: e.target.value })} />
          <TextField label="Bid due date" type="date" value={form.bid_due_date} onChange={(e) => setForm({ ...form, bid_due_date: e.target.value })} required />
          <TextField label="Pre-bid date" type="date" value={form.pre_bid_date} onChange={(e) => setForm({ ...form, pre_bid_date: e.target.value })} />
          <SelectField label="Bid status" value={form.bid_status} onChange={(e) => setForm({ ...form, bid_status: e.target.value as BidStatus })}>
            {(Object.keys(BID_STATUS_LABELS) as BidStatus[]).map((s) => (
              <option key={s} value={s}>
                {BID_STATUS_LABELS[s]}
              </option>
            ))}
          </SelectField>
          <SelectField label="EMD (bid deposit)" value={form.emd_status} onChange={(e) => setForm({ ...form, emd_status: e.target.value as EmdStatus })}>
            {(Object.keys(EMD_STATUS_LABELS) as EmdStatus[]).map((s) => (
              <option key={s} value={s}>
                {EMD_STATUS_LABELS[s]}
              </option>
            ))}
          </SelectField>
          <TextField
            label={needsAmount ? 'EMD amount (₹)' : 'EMD amount (₹, optional)'}
            inputMode="numeric"
            value={formatIndianDigits(form.emd_amount)}
            onChange={(e) => setForm({ ...form, emd_amount: e.target.value.replace(/\D/g, '') })}
            required={needsAmount}
          />
          <TextField label="Link to tender document" type="url" placeholder="https://…" value={form.document_url} onChange={(e) => setForm({ ...form, document_url: e.target.value })} />
          <div className="ts-span2 min-w-0">
            <TextAreaField label="Notes" rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
          {form.bid_status === 'won' && !deal.closed_at && <p className="ts-span2 text-xs text-ink-muted">Bid won? Mark the opportunity won once the order value is confirmed.</p>}
          <div className="ts-span2 flex gap-2">
            <Button type="submit" size="sm" disabled={busy || !form.tender_number.trim() || !form.bid_due_date || (needsAmount && !form.emd_amount)}>
              Save tender
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {!editing && !t && <EmptyState>No tender details yet. Add the bid date so it can be tracked.</EmptyState>}
      {!editing && t && (
        <dl className="px-4 sm:px-5 py-3 grid gap-x-6 gap-y-3 grid-cols-2 text-sm">
          <div className="min-w-0">
            <dt className="ts-lbl !mb-1">Tender number</dt>
            <dd className="mt-0.5 break-words">{t.tender_number}</dd>
          </div>
          <div className="min-w-0">
            <dt className="ts-lbl !mb-1">Authority</dt>
            <dd className="mt-0.5 break-words">{t.issuing_authority || '—'}</dd>
          </div>
          <div>
            <dt className="ts-lbl !mb-1">Bid due</dt>
            <dd className="mt-0.5">
              {formatDate(t.bid_due_date)}
              {t.bid_status === 'preparing' && <span className={`block text-xs font-medium ${t.is_late ? 'text-danger' : 'text-accent-dark'}`}>{daysLabel(t.days_left)}</span>}
            </dd>
          </div>
          <div>
            <dt className="ts-lbl !mb-1">Bid status</dt>
            <dd className="mt-0.5">
              <Badge tone={t.bid_status === 'won' ? 'ok' : t.bid_status === 'lost' || t.bid_status === 'cancelled' ? 'muted' : 'brand'}>{BID_STATUS_LABELS[t.bid_status]}</Badge>
            </dd>
          </div>
          <div>
            <dt className="ts-lbl !mb-1">EMD</dt>
            <dd className="mt-0.5">
              {EMD_STATUS_LABELS[t.emd_status]}
              {t.emd_amount != null && ` · ${formatMoney(t.emd_amount)}`}
            </dd>
          </div>
          <div>
            <dt className="ts-lbl !mb-1">Pre-bid</dt>
            <dd className="mt-0.5">{t.pre_bid_date ? formatDate(t.pre_bid_date) : '—'}</dd>
          </div>
          {t.document_url && (
            <div className="col-span-2">
              <a href={t.document_url} target="_blank" rel="noreferrer noopener" className="ts-lnk text-brand">
                Open tender document
              </a>
            </div>
          )}
          {t.notes && <p className="col-span-2 whitespace-pre-wrap break-words text-ink-muted">{t.notes}</p>}
        </dl>
      )}
    </Card>
  );
}
