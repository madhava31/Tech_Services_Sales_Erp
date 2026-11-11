import { useEffect, useState } from 'react';
import { api, Contact, DealInput, NamedOption, OpportunityDetail, Product } from '../lib/api';
import { formatDate, formatMoney, formatIndianDigits } from '../lib/labels';
import { PHONE_TOUCH, SelectField, TextAreaField, TextField } from './ui';

const NEW_CONTACT = 'new';
export const WIN_PROBABILITIES = [25, 50, 75, 100];

// The deal form's values. Text while being typed, so a half-filled draft can be kept on the device.
export interface DealDraft {
  title: string;
  contactId: string; // a contact id, '' for none, or NEW_CONTACT
  newContact: { phone: string; name: string; designation: string; department?: string; email: string };
  oemId: string;
  productIds: number[];
  closeDate: string;
  probability: number;
  probabilityReason: string;
  value: string; // digits only
  tender: boolean;
  segmentIds: number[];
  comments: string;
}

export const EMPTY_DEAL_DRAFT: DealDraft = {
  title: '',
  contactId: '',
  newContact: { phone: '', name: '', designation: '', department: '', email: '' },
  oemId: '',
  productIds: [],
  closeDate: '',
  probability: 25,
  probabilityReason: '',
  value: '',
  tender: false,
  segmentIds: [],
  comments: '',
};

export function dealToDraft(deal: OpportunityDetail): DealDraft {
  return {
    ...EMPTY_DEAL_DRAFT,
    title: deal.title,
    contactId: deal.contact_id ? String(deal.contact_id) : '',
    oemId: deal.oem_id ? String(deal.oem_id) : '',
    productIds: deal.products.map((p) => p.id),
    closeDate: deal.expected_close_date ?? '',
    probability: deal.probability,
    probabilityReason: deal.probability_reason ?? '',
    value: deal.estimated_value != null ? String(Math.round(deal.estimated_value)) : '',
    tender: deal.tender,
    segmentIds: deal.segments.map((s) => s.id),
    comments: deal.notes ?? '',
  };
}

export function draftToInput(d: DealDraft): DealInput {
  const isNew = d.contactId === NEW_CONTACT;
  return {
    title: d.title,
    oem_id: Number(d.oemId),
    product_ids: d.productIds,
    expected_close_date: d.closeDate,
    probability: d.probability,
    probability_reason: d.probabilityReason || null,
    estimated_value: Number(d.value),
    tender: d.tender,
    segment_ids: d.segmentIds,
    notes: d.comments || null,
    contact_id: !isNew && d.contactId ? Number(d.contactId) : null,
    ...(isNew ? { new_contact: d.newContact } : {}),
  };
}

// What still stops the form being saved; the API checks the same rules.
export function dealDraftComplete(d: DealDraft) {
  const contactOk = d.contactId !== NEW_CONTACT || (d.newContact.phone.trim() !== '' && d.newContact.name.trim() !== '');
  return Boolean(d.title.trim() && d.oemId && d.productIds.length > 0 && d.closeDate && Number(d.value) > 0 && contactOk);
}

function CheckList<T extends { id: number }>({
  label,
  hint,
  items,
  selected,
  onChange,
  render,
}: {
  label: string;
  hint?: string;
  items: T[];
  selected: number[];
  onChange: (ids: number[]) => void;
  render: (item: T) => React.ReactNode;
}) {
  return (
    <fieldset className="flex flex-col gap-1.5 min-w-0">
      <legend className="ts-lbl">{label}</legend>
      <div className="rounded-ctl border border-line bg-surface divide-y divide-dashed divide-line max-h-56 overflow-y-auto">
        {items.map((item) => (
          <label key={item.id} className="flex items-start gap-3 px-3 py-2.5 text-sm cursor-pointer hover:bg-tile">
            <input
              type="checkbox"
              className="ts-chk mt-px shrink-0"
              checked={selected.includes(item.id)}
              onChange={(e) => onChange(e.target.checked ? [...selected, item.id] : selected.filter((id) => id !== item.id))}
            />
            <span className="min-w-0">{render(item)}</span>
          </label>
        ))}
        {items.length === 0 && <p className="px-3 py-3 text-sm text-subtle">{hint ?? 'Nothing to choose yet.'}</p>}
      </div>
    </fieldset>
  );
}

// Every field of a deal. Controlled, with no <form> of its own, so it fits the new-deal form, the edit
// form and the deal step of completing a visit. `keep` lists a deal's current products and segments,
// shown even if they have since been deactivated.
export default function DealFields({
  companyId,
  value,
  onChange,
  keep,
}: {
  companyId: number;
  value: DealDraft;
  onChange: (patch: Partial<DealDraft>) => void;
  keep?: Pick<OpportunityDetail, 'products' | 'segments' | 'oem_id' | 'oem_name'>;
}) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [oems, setOems] = useState<NamedOption[]>([]);
  const [segments, setSegments] = useState<NamedOption[]>([]);
  const [products, setProducts] = useState<Product[]>([]);

  useEffect(() => {
    api.companies.get(companyId).then((c) => setContacts(c.contacts)).catch(() => setContacts([]));
  }, [companyId]);
  useEffect(() => {
    api.catalogue.oems().then(setOems).catch(() => setOems([]));
    api.catalogue.segments().then(setSegments).catch(() => setSegments([]));
  }, []);
  useEffect(() => {
    if (!value.oemId) {
      setProducts([]);
      return;
    }
    let cancelled = false;
    api.products
      .list({ oem_id: Number(value.oemId), limit: 500 })
      .then((rows) => !cancelled && setProducts(rows))
      .catch(() => !cancelled && setProducts([]));
    return () => {
      cancelled = true;
    };
  }, [value.oemId]);

  const keptProducts = (keep?.products ?? []).filter((p) => String(keep?.oem_id) === value.oemId && !products.some((x) => x.id === p.id));
  const keptSegments = (keep?.segments ?? []).filter((s) => !segments.some((x) => x.id === s.id));
  const keptOem = keep?.oem_id && !oems.some((o) => o.id === keep.oem_id) ? { id: keep.oem_id, name: keep.oem_name ?? '' } : null;
  const productChoices: { id: number; name: string; part_number: string }[] = [...products, ...keptProducts];
  const value_ = Number(value.value);

  return (
    <div className="ts-fgrid ts-g2 !mt-0">
      <div className="ts-span2 min-w-0">
        <TextField label="Opportunity name" value={value.title} onChange={(e) => onChange({ title: e.target.value })} placeholder="e.g. AAS for QC lab" required />
      </div>

      <div className="ts-span2 min-w-0">
        <SelectField label="Contact (by phone)" value={value.contactId} onChange={(e) => onChange({ contactId: e.target.value })}>
          <option value="">Select…</option>
          {contacts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.phone ? ` · ${c.phone}` : ''}
            </option>
          ))}
          <option value={NEW_CONTACT}>+ Add customer number</option>
        </SelectField>
      </div>
      {value.contactId === NEW_CONTACT && (
        <fieldset className="ts-span2 ts-fgrid ts-g2 !mt-0 rounded-lg border border-line p-3">
          <legend className="ts-lbl !mb-0 px-1">New customer number</legend>
          <TextField label="Phone" type="tel" inputMode="tel" value={value.newContact.phone} onChange={(e) => onChange({ newContact: { ...value.newContact, phone: e.target.value } })} required />
          <TextField label="Name" value={value.newContact.name} onChange={(e) => onChange({ newContact: { ...value.newContact, name: e.target.value } })} required />
          <TextField label="Designation" value={value.newContact.designation} onChange={(e) => onChange({ newContact: { ...value.newContact, designation: e.target.value } })} />
          <TextField label="Department" value={value.newContact.department ?? ''} onChange={(e) => onChange({ newContact: { ...value.newContact, department: e.target.value } })} />
          <TextField label="Email" type="email" value={value.newContact.email} onChange={(e) => onChange({ newContact: { ...value.newContact, email: e.target.value } })} />
        </fieldset>
      )}

      <div className="ts-span2 min-w-0">
        <SelectField
          label="OEM"
          value={value.oemId}
          // Changing the OEM clears the products: they belong to the old one.
          onChange={(e) => onChange({ oemId: e.target.value, productIds: [] })}
          required
        >
          <option value="">Select…</option>
          {oems.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
          {keptOem && <option value={keptOem.id}>{keptOem.name} (inactive)</option>}
        </SelectField>
      </div>
      <div className="ts-span2 min-w-0">
        <CheckList
          label="Products"
          hint={value.oemId ? 'No active products for this OEM yet.' : 'Choose the OEM first.'}
          items={productChoices}
          selected={value.productIds}
          onChange={(productIds) => onChange({ productIds })}
          render={(p) => (
            <>
              <span className="block font-medium">{p.name}</span>
              <span className="block text-xs text-ink-muted">{p.part_number}</span>
            </>
          )}
        />
      </div>

      <TextField
        label="Order value (₹)"
        inputMode="numeric"
        value={formatIndianDigits(value.value)}
        onChange={(e) => onChange({ value: e.target.value.replace(/\D/g, '') })}
        hint={value_ > 0 ? formatMoney(value_, { compact: true }) : undefined}
        required
      />
      <TextField
        label="Expected closing date"
        type="date"
        value={value.closeDate}
        onChange={(e) => onChange({ closeDate: e.target.value })}
        hint={value.closeDate ? formatDate(value.closeDate) : undefined}
        required
      />

      <fieldset className="flex flex-col gap-1.5">
        <legend className="ts-lbl">Win probability</legend>
        <div className="ts-tabs !w-full" role="radiogroup" aria-label="Win probability">
          {WIN_PROBABILITIES.map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={value.probability === p}
              onClick={() => onChange({ probability: p })}
              className={`ts-tab flex-1 justify-center ${PHONE_TOUCH} ${value.probability === p ? 'ts-on' : ''}`}
            >
              {p}%
            </button>
          ))}
        </div>
      </fieldset>
      <TextField label="Probability reason" value={value.probabilityReason} onChange={(e) => onChange({ probabilityReason: e.target.value })} placeholder="e.g. Budget confirmed" />

      <fieldset className="flex flex-col gap-1.5">
        <legend className="ts-lbl">Tender</legend>
        <div className="ts-tabs !w-full" role="radiogroup" aria-label="Tender">
          {[false, true].map((t) => (
            <button
              key={String(t)}
              type="button"
              role="radio"
              aria-checked={value.tender === t}
              onClick={() => onChange({ tender: t })}
              className={`ts-tab flex-1 justify-center ${PHONE_TOUCH} ${value.tender === t ? 'ts-on' : ''}`}
            >
              {t ? 'Yes' : 'No'}
            </button>
          ))}
        </div>
      </fieldset>
      <CheckList
        label="Market segment"
        items={[...segments, ...keptSegments]}
        selected={value.segmentIds}
        onChange={(segmentIds) => onChange({ segmentIds })}
        render={(s) => s.name}
      />

      <div className="ts-span2 min-w-0">
        <TextAreaField label="Comments" value={value.comments} onChange={(e) => onChange({ comments: e.target.value })} />
      </div>
    </div>
  );
}
