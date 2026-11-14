import { useEffect, useState } from 'react';
import { PlusIcon, XIcon } from 'lucide-react';
import { api, Competitor, Contact, DealInput, LostReason, NamedOption, OpportunityDetail, Product } from '../lib/api';
import { useAuth } from '../lib/auth';
import { COMPETITOR_LABELS, LOST_REASON_LABELS, OPEN_STAGES, QUOTED_STAGES, STAGE_LABELS, formatDate, formatMoney, formatIndianDigits } from '../lib/labels';
import { canManageProducts } from '../lib/roles';
import { Button, PHONE_TOUCH, SelectField, TextAreaField, TextField } from './ui';

const NEW_CONTACT = 'new';
export const WIN_PROBABILITIES = [25, 50, 75, 100];
const CLOSED = 'closed';

// The deal form's values. Text while being typed, so a half-filled draft can be kept on the device.
export interface DealDraft {
  title: string;
  contactId: string; // a contact id, '' for none, or NEW_CONTACT
  newContact: { phone: string; name: string; designation: string; department?: string; email: string };
  oemIds: string[];
  productIds: number[];
  // Products typed in for this opportunity only, under one of its OEMs.
  customProducts: { oemId: string; name: string }[];
  closeDate: string;
  probability: number;
  probabilityReason: string;
  value: string; // digits only
  tender: boolean;
  segmentIds: number[];
  comments: string;
  competitor: Competitor | '';
  competitorNote: string;
  // Creating only: the stage it starts at ('closed' then asks won or lost) and what that needs.
  stage: string;
  closeResult: 'won' | 'lost' | '';
  wonValue: string; // digits only
  lostReason: LostReason | '';
  closeReason: string;
  quotationNumber: string;
}

export const EMPTY_DEAL_DRAFT: DealDraft = {
  title: '',
  contactId: '',
  newContact: { phone: '', name: '', designation: '', department: '', email: '' },
  oemIds: [],
  productIds: [],
  customProducts: [],
  closeDate: '',
  probability: 25,
  probabilityReason: '',
  value: '',
  tender: false,
  segmentIds: [],
  comments: '',
  competitor: '',
  competitorNote: '',
  stage: 'create',
  closeResult: '',
  wonValue: '',
  lostReason: '',
  closeReason: '',
  quotationNumber: '',
};

export function dealToDraft(deal: OpportunityDetail): DealDraft {
  return {
    ...EMPTY_DEAL_DRAFT,
    title: deal.title,
    contactId: deal.contact_id ? String(deal.contact_id) : '',
    oemIds: deal.oems.map((o) => String(o.id)),
    productIds: deal.products.map((p) => p.id),
    customProducts: (deal.custom_products ?? []).map((p) => ({ oemId: String(p.oem_id), name: p.name })),
    closeDate: deal.expected_close_date ?? '',
    probability: deal.probability,
    probabilityReason: deal.probability_reason ?? '',
    value: deal.estimated_value != null ? String(Math.round(deal.estimated_value)) : '',
    tender: deal.tender,
    segmentIds: deal.segments.map((s) => s.id),
    comments: deal.notes ?? '',
    competitor: deal.competitor ?? '',
    competitorNote: deal.competitor_note ?? '',
    // An existing opportunity changes stage with "Move stage", so the edit form leaves it alone.
    stage: '',
  };
}

const isClosed = (d: DealDraft) => d.stage === CLOSED;

export function draftToInput(d: DealDraft): DealInput {
  const isNew = d.contactId === NEW_CONTACT;
  const input: DealInput = {
    title: d.title,
    oem_ids: d.oemIds.map(Number),
    product_ids: d.productIds,
    custom_products: (d.customProducts ?? []).map((p) => ({ oem_id: Number(p.oemId), name: p.name })),
    expected_close_date: d.closeDate,
    probability: d.probability,
    probability_reason: d.probabilityReason || null,
    estimated_value: Number(d.value),
    tender: d.tender,
    segment_ids: d.segmentIds,
    notes: d.comments || null,
    competitor: d.competitor || null,
    competitor_note: d.competitor === 'other' ? d.competitorNote.trim() || null : null,
    contact_id: !isNew && d.contactId ? Number(d.contactId) : null,
    ...(isNew ? { new_contact: d.newContact } : {}),
  };
  if (d.stage) {
    if (isClosed(d)) {
      input.stage = d.closeResult as 'won' | 'lost';
      input.close_reason = d.closeReason.trim();
      if (d.closeResult === 'won') input.won_value = Number(d.wonValue || d.value);
      if (d.closeResult === 'lost') input.lost_reason = d.lostReason as LostReason;
    } else {
      input.stage = d.stage as DealInput['stage'];
      if (QUOTED_STAGES.includes(input.stage!)) input.quotation_number = d.quotationNumber.trim();
    }
  }
  return input;
}

// What still stops the form being saved; the API checks the same rules.
export function dealDraftComplete(d: DealDraft) {
  const contactOk = d.contactId !== NEW_CONTACT || (d.newContact.phone.trim() !== '' && d.newContact.name.trim() !== '');
  const competitorOk = d.competitor !== 'other' || d.competitorNote.trim() !== '';
  let stageOk = true;
  if (isClosed(d)) {
    stageOk =
      (d.closeResult === 'won' && Number(d.wonValue || d.value) > 0 && d.closeReason.trim() !== '') ||
      (d.closeResult === 'lost' && d.lostReason !== '' && d.closeReason.trim() !== '');
  } else if (QUOTED_STAGES.includes(d.stage as never)) {
    stageOk = d.quotationNumber.trim() !== '';
  }
  return Boolean(d.title.trim() && d.oemIds.length > 0 && d.productIds.length + (d.customProducts ?? []).length > 0 && d.closeDate && Number(d.value) > 0 && contactOk && competitorOk && stageOk);
}

function CheckList<T extends { id: number }>({
  label,
  hint,
  items,
  selected,
  onChange,
  render,
  filter,
}: {
  label: string;
  hint?: string;
  items: T[];
  selected: number[];
  onChange: (ids: number[]) => void;
  render: (item: T) => React.ReactNode;
  // A search box above long lists, matching on this text.
  filter?: (item: T) => string;
}) {
  const [q, setQ] = useState('');
  const term = q.trim().toLowerCase();
  const shown = filter && term ? items.filter((item) => filter(item).toLowerCase().includes(term) || selected.includes(item.id)) : items;
  return (
    <fieldset className="flex flex-col gap-1.5 min-w-0">
      <legend className="ts-lbl">{label}</legend>
      {filter && items.length > 8 && (
        <input type="search" className="ts-fi" placeholder="Search by name or part number" value={q} onChange={(e) => setQ(e.target.value)} aria-label={`Search ${label}`} />
      )}
      <div className="rounded-ctl border border-line bg-surface divide-y divide-dashed divide-line max-h-56 overflow-y-auto">
        {shown.map((item) => (
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
        {shown.length === 0 && <p className="px-3 py-3 text-sm text-subtle">{items.length ? 'Nothing matches.' : hint ?? 'Nothing to choose yet.'}</p>}
      </div>
    </fieldset>
  );
}

function Segmented<T extends string | number | boolean>({ label, options, value, onChange }: { label: string; options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="ts-lbl">{label}</legend>
      <div className="ts-tabs !w-full" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            onClick={() => onChange(o.value)}
            className={`ts-tab flex-1 justify-center ${PHONE_TOUCH} ${value === o.value ? 'ts-on' : ''}`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

type ProductChoice = { id: number; name: string; part_number: string; oem_id: number };

// "Other product": a name typed in for this opportunity only. It is saved with the opportunity and never
// reaches the product catalogue. Shown under each chosen OEM, with the products already added.
function OtherProducts({ oem, items, onAdd, onRemove }: { oem: NamedOption; items: string[]; onAdd: (name: string) => void; onRemove: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const trimmed = name.trim().replace(/s+/g, ' ');
  const taken = items.some((n) => n.toLowerCase() === trimmed.toLowerCase());
  const add = () => {
    if (!trimmed || taken) return;
    onAdd(trimmed);
    setName('');
  };
  return (
    <div className="flex flex-col gap-2 min-w-0">
      {items.length > 0 && (
        <div className="flex flex-col gap-1.5" aria-label={`Other ${oem.name} products on this opportunity`}>
          <span className="ts-lbl">Other {oem.name} products (this opportunity only)</span>
          <div className="flex flex-wrap gap-2">
            {items.map((n) => (
              <span key={n} className="inline-flex items-center gap-1 rounded-full bg-tile pl-3 pr-1 py-1 text-sm font-medium max-w-full">
                <span className="truncate">{n}</span>
                <button type="button" onClick={() => onRemove(n)} className={`inline-flex items-center justify-center rounded-full size-7 hover:bg-surface ${PHONE_TOUCH} max-[860px]:min-w-11`} aria-label={`Remove ${n}`}>
                  <XIcon className="size-3.5" aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}
      {!open ? (
        <div>
          <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(true)}>
            <PlusIcon className="size-4" aria-hidden="true" /> Add other {oem.name} product
          </Button>
        </div>
      ) : (
        <div className="p-3 border border-line rounded-lg bg-surface flex flex-col gap-2.5">
          <TextField
            label={`Other ${oem.name} product`}
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
            placeholder="Type the product name"
            hint="Saved on this opportunity only. It is not added to the product list."
            autoFocus
          />
          {taken && <p className="text-xs text-danger">Already added.</p>}
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={!trimmed || taken} onClick={add}>
              Add
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => { setOpen(false); setName(''); }}>
              Done
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// Adds a product to one OEM's list, for those who manage the catalogue.
function AddProduct({ oem, onAdded }: { oem: NamedOption; onAdded: (p: Product) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [partNumber, setPartNumber] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (!open) {
    return (
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(true)}>
        + Add {oem.name} product to catalogue
      </Button>
    );
  }
  return (
    <div className="p-3 border border-line rounded-lg bg-surface flex flex-col gap-2.5">
      <span className="text-xs font-semibold text-fg">Add product for {oem.name}</span>
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <TextField label="Product name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Atomic Absorption Spec" required />
        <TextField label="Part number / Model" value={partNumber} onChange={(e) => setPartNumber(e.target.value)} placeholder="e.g. TS-PE-AAS-01" required />
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          disabled={busy || !name.trim() || !partNumber.trim()}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              onAdded(await api.products.create({ oem_id: oem.id, name: name.trim(), part_number: partNumber.trim(), category: null, key_features: [] }));
              setOpen(false);
              setName('');
              setPartNumber('');
            } catch (err) {
              setError(err instanceof Error ? err.message : 'Could not add product.');
            } finally {
              setBusy(false);
            }
          }}
        >
          Add & Select
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => { setOpen(false); setError(''); }}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// Every field of a deal. Controlled, with no <form> of its own, so it fits the new-deal form, the edit
// form and the deal step of completing a visit. `keep` lists a deal's current OEMs, products and
// segments, shown even if they have since been deactivated. `withStage` adds the Stage section, for
// forms that create an opportunity: an existing one changes stage with "Move stage".
export default function DealFields({
  companyId,
  value,
  onChange,
  keep,
  withStage = false,
}: {
  companyId: number;
  value: DealDraft;
  onChange: (patch: Partial<DealDraft>) => void;
  keep?: Pick<OpportunityDetail, 'products' | 'segments' | 'oems'>;
  withStage?: boolean;
}) {
  const { user } = useAuth();
  const canManage = canManageProducts(user?.role);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [oems, setOems] = useState<NamedOption[]>([]);
  const [segments, setSegments] = useState<NamedOption[]>([]);
  const [productsByOem, setProductsByOem] = useState<Record<string, Product[]>>({});

  useEffect(() => {
    api.companies.get(companyId).then((c) => setContacts(c.contacts)).catch(() => setContacts([]));
  }, [companyId]);
  useEffect(() => {
    api.catalogue.oems().then(setOems).catch(() => setOems([]));
    api.catalogue.segments().then(setSegments).catch(() => setSegments([]));
  }, []);
  // Each chosen OEM's products, loaded once.
  useEffect(() => {
    for (const oemId of value.oemIds) {
      if (productsByOem[oemId]) continue;
      api.products
        .list({ oem_id: Number(oemId), limit: 500 })
        .then((rows) => setProductsByOem((all) => ({ ...all, [oemId]: rows })))
        .catch(() => setProductsByOem((all) => ({ ...all, [oemId]: [] })));
    }
  }, [value.oemIds, productsByOem]);

  const keptOems = (keep?.oems ?? []).filter((o) => !oems.some((x) => x.id === o.id)).map((o) => ({ ...o, in_use: 0 }));
  const allOems: NamedOption[] = [...oems, ...keptOems];
  const oemById = (id: string) => allOems.find((o) => String(o.id) === id);
  const choicesFor = (oemId: string): ProductChoice[] => {
    const loaded = productsByOem[oemId] ?? [];
    const kept = (keep?.products ?? []).filter((p) => String(p.oem_id) === oemId && !loaded.some((x) => x.id === p.id));
    return [...loaded, ...kept];
  };
  const keptSegments = (keep?.segments ?? []).filter((s) => !segments.some((x) => x.id === s.id));
  const value_ = Number(value.value);
  const closed = value.stage === CLOSED;

  const customProducts = value.customProducts ?? [];
  const addOem = (id: string) => id && !value.oemIds.includes(id) && onChange({ oemIds: [...value.oemIds, id] });
  // Taking an OEM off also takes off its products.
  const removeOem = (id: string) => {
    const theirs = new Set(choicesFor(id).map((p) => p.id));
    onChange({
      oemIds: value.oemIds.filter((x) => x !== id),
      productIds: value.productIds.filter((p) => !theirs.has(p)),
      customProducts: customProducts.filter((p) => p.oemId !== id),
    });
  };

  return (
    <div className="ts-fgrid ts-g2 !mt-0">
      <div className="ts-span2 min-w-0">
        <SelectField label="Contact person" value={value.contactId} onChange={(e) => onChange({ contactId: e.target.value })}>
          <option value="">Select…</option>
          {contacts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.designation ? ` · ${c.designation}` : ''}
              {c.phone ? ` · ${c.phone}` : ''}
            </option>
          ))}
          <option value={NEW_CONTACT}>+ Add contact person</option>
        </SelectField>
      </div>
      {value.contactId === NEW_CONTACT && (
        <fieldset className="ts-span2 ts-fgrid ts-g2 !mt-0 rounded-lg border border-line p-3">
          <legend className="ts-lbl !mb-0 px-1">New contact person</legend>
          <TextField label="Name" value={value.newContact.name} onChange={(e) => onChange({ newContact: { ...value.newContact, name: e.target.value } })} required />
          <TextField label="Phone" type="tel" inputMode="tel" value={value.newContact.phone} onChange={(e) => onChange({ newContact: { ...value.newContact, phone: e.target.value } })} required />
          <TextField label="Designation" value={value.newContact.designation} onChange={(e) => onChange({ newContact: { ...value.newContact, designation: e.target.value } })} />
          <TextField label="Department" value={value.newContact.department ?? ''} onChange={(e) => onChange({ newContact: { ...value.newContact, department: e.target.value } })} />
          <TextField label="Email" type="email" value={value.newContact.email} onChange={(e) => onChange({ newContact: { ...value.newContact, email: e.target.value } })} />
        </fieldset>
      )}

      <div className="ts-span2 min-w-0">
        <TextField label="Opportunity name" value={value.title} onChange={(e) => onChange({ title: e.target.value })} placeholder="e.g. AAS for QC lab" required />
      </div>

      <div className="ts-span2 min-w-0 flex flex-col gap-2">
        <SelectField
          label={value.oemIds.length ? 'OEMs (add another if this opportunity has more)' : 'OEM'}
          value=""
          onChange={(e) => addOem(e.target.value)}
          required={value.oemIds.length === 0}
        >
          <option value="">{value.oemIds.length ? '+ Add another OEM…' : 'Select…'}</option>
          {allOems
            .filter((o) => !value.oemIds.includes(String(o.id)))
            .map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
                {o.is_active ? '' : ' (inactive)'}
              </option>
            ))}
        </SelectField>
        {value.oemIds.length > 0 && (
          <div className="flex flex-wrap gap-2" aria-label="Chosen OEMs">
            {value.oemIds.map((id) => (
              <span key={id} className="inline-flex items-center gap-1 rounded-full bg-tile pl-3 pr-1 py-1 text-sm font-medium">
                {oemById(id)?.name ?? 'OEM'}
                <button type="button" onClick={() => removeOem(id)} className={`inline-flex items-center justify-center rounded-full size-7 hover:bg-surface ${PHONE_TOUCH} max-[860px]:min-w-11`} aria-label={`Remove ${oemById(id)?.name ?? 'OEM'}`}>
                  <XIcon className="size-3.5" aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {value.oemIds.length === 0 ? (
        <p className="ts-span2 text-sm text-subtle">Choose an OEM to see its products.</p>
      ) : (
        value.oemIds.map((oemId) => {
          const oem = oemById(oemId);
          const choices = choicesFor(oemId);
          const others = customProducts.filter((p) => p.oemId === oemId).map((p) => p.name);
          const picked = choices.filter((p) => value.productIds.includes(p.id)).length + others.length;
          return (
            <div key={oemId} className="ts-span2 min-w-0 flex flex-col gap-2">
              <CheckList
                label={`${oem?.name ?? 'OEM'} products${picked ? ` (${picked} chosen)` : ''}`}
                hint={productsByOem[oemId] ? `No active ${oem?.name ?? ''} products yet.` : 'Loading…'}
                items={choices}
                selected={value.productIds}
                onChange={(productIds) => onChange({ productIds })}
                filter={(p) => `${p.name} ${p.part_number}`}
                render={(p) => (
                  <>
                    <span className="block font-medium">{p.name}</span>
                    <span className="block text-xs text-ink-muted">{p.part_number}</span>
                  </>
                )}
              />
              {value.oemIds.length > 1 && productsByOem[oemId] && picked === 0 && <p className="text-xs text-danger">Choose at least one {oem?.name} product, or remove {oem?.name}.</p>}
              {oem && (
                <OtherProducts
                  oem={oem}
                  items={others}
                  onAdd={(name) => onChange({ customProducts: [...customProducts, { oemId, name }] })}
                  onRemove={(name) => onChange({ customProducts: customProducts.filter((p) => !(p.oemId === oemId && p.name === name)) })}
                />
              )}
              {canManage && oem && (
                <div>
                  <AddProduct
                    oem={oem}
                    onAdded={(created) => {
                      setProductsByOem((all) => ({ ...all, [oemId]: [...(all[oemId] ?? []), created] }));
                      onChange({ productIds: [...value.productIds, created.id] });
                    }}
                  />
                </div>
              )}
            </div>
          );
        })
      )}

      <TextField
        label="Order value (₹)"
        inputMode="numeric"
        value={formatIndianDigits(value.value)}
        onChange={(e) => onChange({ value: e.target.value.replace(/\D/g, '') })}
        hint={value_ > 0 ? formatMoney(value_, { compact: true }) : undefined}
        required
      />

      <div className="flex flex-col gap-1.5 min-w-0">
        <TextField
          label="Expected closing date"
          type="date"
          value={value.closeDate}
          onChange={(e) => onChange({ closeDate: e.target.value })}
          hint={value.closeDate ? formatDate(value.closeDate) : undefined}
          required
        />
        <div className="flex flex-wrap items-center gap-1.5 mt-0.5" aria-label="Quick closing date options">
          <span className="text-[11px] text-subtle mr-0.5 font-medium">Quick date:</span>
          {[
            { label: '+15d', days: 15 },
            { label: '+30d', days: 30 },
            { label: '+60d', days: 60 },
            { label: '+90d', days: 90 },
            { label: 'End of month', endOfMonth: true },
          ].map((preset) => (
            <button
              key={preset.label}
              type="button"
              onClick={() => {
                const now = new Date();
                const target = preset.endOfMonth ? new Date(now.getFullYear(), now.getMonth() + 1, 0) : new Date(now.getTime() + (preset.days ?? 0) * 86400000);
                const yyyy = target.getFullYear();
                const mm = String(target.getMonth() + 1).padStart(2, '0');
                const dd = String(target.getDate()).padStart(2, '0');
                onChange({ closeDate: `${yyyy}-${mm}-${dd}` });
              }}
              className="px-2 py-0.5 text-xs rounded border border-line bg-surface hover:bg-tile text-fg transition-colors"
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      {withStage && (
        <>
          <div className="ts-span2 min-w-0">
            <SelectField label="Stage" value={value.stage} onChange={(e) => onChange({ stage: e.target.value })} required>
              {OPEN_STAGES.map((s, i) => (
                <option key={s} value={s}>
                  {i + 1}. {STAGE_LABELS[s]}
                </option>
              ))}
              <option value={CLOSED}>{OPEN_STAGES.length + 1}. Closed</option>
            </SelectField>
          </div>
          {QUOTED_STAGES.includes(value.stage as never) && (
            <div className="ts-span2 min-w-0">
              <TextField label="Quotation number" value={value.quotationNumber} onChange={(e) => onChange({ quotationNumber: e.target.value })} placeholder="e.g. TS/QTN/2026/0412" hint="The quotation already sent to the customer." required />
            </div>
          )}
          {closed && (
            <div className="ts-span2 ts-fgrid ts-g2 !mt-0 rounded-lg border border-line p-3">
              <div className="ts-span2">
                <Segmented
                  label="Closed as"
                  options={[
                    { value: 'won', label: 'Won' },
                    { value: 'lost', label: 'Lost' },
                  ]}
                  value={value.closeResult}
                  onChange={(closeResult) => onChange({ closeResult })}
                />
              </div>
              {value.closeResult === 'won' && (
                <>
                  <TextField
                    label="Order value won (₹)"
                    inputMode="numeric"
                    value={formatIndianDigits(value.wonValue || value.value)}
                    onChange={(e) => onChange({ wonValue: e.target.value.replace(/\D/g, '') })}
                    required
                  />
                  <div className="ts-span2 min-w-0">
                    <TextAreaField label="Why we won" value={value.closeReason} onChange={(e) => onChange({ closeReason: e.target.value })} placeholder="e.g. Better service support, demo convinced the lab head" required />
                  </div>
                </>
              )}
              {value.closeResult === 'lost' && (
                <>
                  <SelectField label="Reason" value={value.lostReason} onChange={(e) => onChange({ lostReason: e.target.value as LostReason })} required>
                    <option value="">Select…</option>
                    {(Object.keys(LOST_REASON_LABELS) as LostReason[]).map((r) => (
                      <option key={r} value={r}>
                        {LOST_REASON_LABELS[r]}
                      </option>
                    ))}
                  </SelectField>
                  <div className="ts-span2 min-w-0">
                    <TextAreaField label="What happened" value={value.closeReason} onChange={(e) => onChange({ closeReason: e.target.value })} placeholder="e.g. Customer chose a cheaper local option" required />
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}

      {!closed && (
        <>
          <Segmented label="Win probability" options={WIN_PROBABILITIES.map((p) => ({ value: p, label: `${p}%` }))} value={value.probability} onChange={(probability) => onChange({ probability })} />
          <TextField
            label={`Probability reason (${value.probability}%)`}
            value={value.probabilityReason}
            onChange={(e) => onChange({ probabilityReason: e.target.value })}
            placeholder={
              value.probability === 25
                ? 'e.g. Initial inquiry, competitor engaged'
                : value.probability === 50
                  ? 'e.g. Budget discussed, evaluation in progress'
                  : value.probability === 75
                    ? 'e.g. Specs finalized, quotation accepted'
                    : 'e.g. PO expected, budget approved'
            }
          />
        </>
      )}

      <SelectField label="Competitor" value={value.competitor} onChange={(e) => onChange({ competitor: e.target.value as Competitor | '' })}>
        <option value="">Select…</option>
        {(Object.keys(COMPETITOR_LABELS) as Competitor[]).map((c) => (
          <option key={c} value={c}>
            {COMPETITOR_LABELS[c]}
          </option>
        ))}
      </SelectField>
      {value.competitor === 'other' ? (
        <TextField label="Competitor name / comment" value={value.competitorNote} onChange={(e) => onChange({ competitorNote: e.target.value })} placeholder="e.g. Shimadzu, quoting 10% lower" required />
      ) : (
        <span className="max-[860px]:hidden" aria-hidden="true" />
      )}

      <Segmented
        label="Tender"
        options={[
          { value: false, label: 'No' },
          { value: true, label: 'Yes' },
        ]}
        value={value.tender}
        onChange={(tender) => onChange({ tender })}
      />
      <CheckList label="Market segment" items={[...segments, ...keptSegments]} selected={value.segmentIds} onChange={(segmentIds) => onChange({ segmentIds })} render={(s) => s.name} />

      <div className="ts-span2 min-w-0">
        <TextAreaField label="Comments" value={value.comments} onChange={(e) => onChange({ comments: e.target.value })} />
      </div>
    </div>
  );
}
