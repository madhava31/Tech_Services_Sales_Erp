import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, CompanyDetail, Instrument, ServiceReportInput, ServiceReportPart } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { localDate } from '../../lib/labels';
import CompanyPicker from '../../components/CompanyPicker';
import SignaturePad from '../../components/SignaturePad';
import { Button, Card, CardHeader, LoadingCard, Notice, PageHeader, SelectField, TextAreaField, TextField } from '../../components/ui';

type Form = Omit<ServiceReportInput, 'parts' | 'complete' | 'client_uuid' | 'company_id'>;

const EMPTY: Form = {
  company_name: '',
  company_address: '',
  contact_id: null,
  instrument_id: null,
  user_name: '',
  user_designation: '',
  user_department: '',
  user_phone: '',
  user_email: '',
  instrument_make: '',
  instrument_name: '',
  model_no: '',
  serial_no: '',
  lab: '',
  call_reported_date: localDate(),
  call_attended_date: localDate(),
  call_completed_date: localDate(),
  problem_reported: '',
  work_done: '',
  user_comments: '',
  engineer_name: '',
  engineer_signature: null,
  customer_name: '',
  customer_signature: null,
};

const NO_PART: ServiceReportPart = { part_no: '', description: '', qty: 1 };

const addressOf = (c: CompanyDetail) => [c.address, c.city, c.state, c.pincode].filter(Boolean).join(', ');

// A field service report, laid out like the paper form: who and where, the call dates, the instrument, the
// problem, the parts, and both signatures. Saved as a draft, or completed once the engineer and the customer
// have signed.
export default function ServiceReportForm() {
  const { id } = useParams();
  const [search] = useSearchParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const editing = id ? Number(id) : null;
  const clientUuid = useRef(crypto.randomUUID());

  const [companyId, setCompanyId] = useState<number | null>(search.get('company') ? Number(search.get('company')) : null);
  const [company, setCompany] = useState<CompanyDetail | null>(null);
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [f, setF] = useState<Form>(EMPTY);
  const [parts, setParts] = useState<ServiceReportPart[]>([{ ...NO_PART }]);
  const [loaded, setLoaded] = useState(!editing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setF((cur) => ({ ...cur, [key]: value }));

  // Editing a draft: load what was saved.
  useEffect(() => {
    if (!editing) return;
    api.serviceReports
      .get(editing)
      .then((r) => {
        if (r.status === 'completed') {
          navigate(`/service-reports/${r.id}`, { replace: true });
          return;
        }
        const { id: _i, code: _c, status: _s, salesperson_name: _n, engineer_signed_at: _e, customer_signed_at: _cu, completed_at: _co, opportunity_id: _o, opportunity_code: _oc, created_at: _ca, parts: rows, company_id, salesperson_id: _sp, ...rest } = r;
        setCompanyId(company_id);
        setF({ ...EMPTY, ...rest });
        setParts(rows.length ? rows : [{ ...NO_PART }]);
        setLoaded(true);
      })
      .catch((err) => {
        setError(err.message);
        setLoaded(true);
      });
  }, [editing, navigate]);

  // The engineer is whoever is signed in, unless a draft already names one.
  useEffect(() => {
    if (editing || !user?.salesperson_id) return;
    api.directory.salespeople().then((rows) => {
      const me = rows.find((s) => s.id === user.salesperson_id);
      if (me) setF((cur) => (cur.engineer_name ? cur : { ...cur, engineer_name: me.name }));
    }).catch(() => undefined);
  }, [editing, user?.salesperson_id]);

  // Once the company is known: its details, contacts and the instruments it owns.
  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    Promise.all([api.companies.get(companyId), api.installed.forCompany(companyId).catch(() => [] as Instrument[])]).then(([c, inst]) => {
      if (cancelled) return;
      setCompany(c);
      setInstruments(inst.filter((i) => i.is_active));
      setF((cur) => ({ ...cur, company_name: cur.company_name || c.name, company_address: cur.company_address || addressOf(c) }));
      const wanted = Number(search.get('instrument'));
      if (!editing && wanted) pickInstrument(wanted, inst);
    }).catch((err) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  function pickContact(value: string) {
    const contact = company?.contacts.find((c) => c.id === Number(value));
    if (!contact) {
      set('contact_id', null);
      return;
    }
    setF((cur) => ({
      ...cur,
      contact_id: contact.id,
      user_name: contact.name,
      user_designation: contact.designation ?? '',
      user_department: contact.department ?? '',
      user_phone: contact.phone ?? '',
      user_email: contact.email ?? '',
      customer_name: cur.customer_name || contact.name,
    }));
  }

  function pickInstrument(value: number | string, list = instruments) {
    const inst = list.find((i) => i.id === Number(value));
    if (!inst) {
      set('instrument_id', null);
      return;
    }
    setF((cur) => ({ ...cur, instrument_id: inst.id, instrument_name: inst.product_name ?? inst.description, serial_no: inst.serial_number ?? '', instrument_make: cur.instrument_make }));
  }

  const setPart = (i: number, patch: Partial<ServiceReportPart>) => setParts((cur) => cur.map((p, n) => (n === i ? { ...p, ...patch } : p)));

  async function save(complete: boolean) {
    if (!companyId || busy) return;
    setBusy(true);
    setError('');
    const clean = (s: string | null | undefined) => (s ?? '').trim() || null;
    const data: ServiceReportInput = {
      ...f,
      company_id: companyId,
      company_address: clean(f.company_address),
      user_name: clean(f.user_name),
      user_designation: clean(f.user_designation),
      user_department: clean(f.user_department),
      user_phone: clean(f.user_phone),
      user_email: clean(f.user_email),
      instrument_make: clean(f.instrument_make),
      model_no: clean(f.model_no),
      serial_no: clean(f.serial_no),
      lab: clean(f.lab),
      work_done: clean(f.work_done),
      user_comments: clean(f.user_comments),
      customer_name: clean(f.customer_name),
      call_completed_date: complete ? f.call_completed_date || null : f.call_completed_date || null,
      parts: parts.filter((p) => p.description.trim() || (p.part_no ?? '').trim()).map((p) => ({ ...p, part_no: clean(p.part_no), description: p.description.trim() || (p.part_no ?? '').trim() })),
      complete,
      ...(editing ? {} : { client_uuid: clientUuid.current }),
    };
    try {
      const saved = editing ? await api.serviceReports.update(editing, data) : await api.serviceReports.create(data);
      navigate(`/service-reports/${saved.id}`, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the report.');
      setBusy(false);
    }
  }

  if (!loaded) return <LoadingCard />;

  if (!companyId) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="New service report" description="Choose the customer first." />
        <Card className="p-4 sm:p-5">
          <CompanyPicker allowCreate={false} onSelect={(c) => setCompanyId(c.id)} />
        </Card>
      </div>
    );
  }

  const ready = f.company_name.trim() && f.instrument_name.trim() && f.problem_reported.trim() && f.engineer_name.trim();
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save(false);
      }}
    >
      <header className="ts-phead !block !mb-1">
        <Link to="/service-reports" className="ts-back">
          ← Service reports
        </Link>
        <h1 className="ts-title">{editing ? 'Edit service report' : 'New service report'}</h1>
      </header>
      {error && <Notice tone="error" onDismiss={() => setError('')}>{error}</Notice>}

      <Card>
        <CardHeader title="Customer" />
        <div className="p-4 sm:p-5 grid gap-4 sm:grid-cols-2">
          <TextField label="Company name" value={f.company_name} onChange={(e) => set('company_name', e.target.value)} required />
          <TextField label="Company address" value={f.company_address ?? ''} onChange={(e) => set('company_address', e.target.value)} />
          <SelectField label="User (from the company’s contacts)" value={f.contact_id ?? ''} onChange={(e) => pickContact(e.target.value)} hint="Pick one to fill the details below, or type them.">
            <option value="">Type the details below</option>
            {company?.contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.designation ? `, ${c.designation}` : ''}
              </option>
            ))}
          </SelectField>
          <TextField label="User name" value={f.user_name ?? ''} onChange={(e) => set('user_name', e.target.value)} />
          <TextField label="Designation" value={f.user_designation ?? ''} onChange={(e) => set('user_designation', e.target.value)} />
          <TextField label="Department" value={f.user_department ?? ''} onChange={(e) => set('user_department', e.target.value)} />
          <TextField label="Contact number" inputMode="tel" value={f.user_phone ?? ''} onChange={(e) => set('user_phone', e.target.value)} />
          <TextField label="Email ID" type="email" value={f.user_email ?? ''} onChange={(e) => set('user_email', e.target.value)} />
        </div>
      </Card>

      <Card>
        <CardHeader title="The call" />
        <div className="p-4 sm:p-5 grid gap-4 sm:grid-cols-3">
          <TextField label="Call reported" type="date" value={f.call_reported_date} onChange={(e) => set('call_reported_date', e.target.value)} required />
          <TextField label="Call attended" type="date" value={f.call_attended_date} onChange={(e) => set('call_attended_date', e.target.value)} min={f.call_reported_date} required />
          <TextField label="Call completed" type="date" value={f.call_completed_date ?? ''} onChange={(e) => set('call_completed_date', e.target.value)} min={f.call_attended_date} />
        </div>
      </Card>

      <Card>
        <CardHeader title="Instrument" />
        <div className="p-4 sm:p-5 grid gap-4 sm:grid-cols-2">
          {instruments.length > 0 && (
            <SelectField label="One of their instruments" value={f.instrument_id ?? ''} onChange={(e) => pickInstrument(e.target.value)} hint="Or type a new one below. It is added to their instruments.">
              <option value="">A different instrument</option>
              {instruments.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.product_name ?? i.description}
                  {i.serial_number ? ` · ${i.serial_number}` : ''}
                </option>
              ))}
            </SelectField>
          )}
          <TextField label="Instrument make" value={f.instrument_make ?? ''} onChange={(e) => set('instrument_make', e.target.value)} />
          <TextField label="Instrument name" value={f.instrument_name} onChange={(e) => set('instrument_name', e.target.value)} required />
          <TextField label="Model no" value={f.model_no ?? ''} onChange={(e) => set('model_no', e.target.value)} />
          <TextField label="Serial no and ID" value={f.serial_no ?? ''} onChange={(e) => set('serial_no', e.target.value)} />
          <TextField label="Lab" value={f.lab ?? ''} onChange={(e) => set('lab', e.target.value)} />
        </div>
      </Card>

      <Card>
        <CardHeader title="Problem and work done" />
        <div className="p-4 sm:p-5 grid gap-4">
          <TextAreaField label="Problem reported" rows={4} value={f.problem_reported} onChange={(e) => set('problem_reported', e.target.value)} required />
          <TextAreaField label="Work done and findings" rows={4} value={f.work_done ?? ''} onChange={(e) => set('work_done', e.target.value)} />
        </div>
      </Card>

      <Card>
        <CardHeader title="Required / replaced parts" description="Leave empty if none." />
        <div className="p-4 sm:p-5 grid gap-3">
          {parts.map((p, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[1fr_2fr_6rem_auto] items-end">
              <TextField label={i === 0 ? 'Part no' : 'Part no '} value={p.part_no ?? ''} onChange={(e) => setPart(i, { part_no: e.target.value })} />
              <TextField label={i === 0 ? 'Description' : 'Description '} value={p.description} onChange={(e) => setPart(i, { description: e.target.value })} />
              <TextField label="Qty" type="number" min={1} step="any" value={p.qty} onChange={(e) => setPart(i, { qty: Number(e.target.value) || 1 })} />
              <Button type="button" variant="ghost" size="sm" onClick={() => setParts((cur) => (cur.length > 1 ? cur.filter((_, n) => n !== i) : [{ ...NO_PART }]))}>
                Remove
              </Button>
            </div>
          ))}
          <div>
            <Button type="button" variant="secondary" size="sm" onClick={() => setParts((cur) => [...cur, { ...NO_PART }])}>
              + Add a part
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="Comments and signatures" />
        <div className="p-4 sm:p-5 grid gap-4">
          <TextAreaField label="User comments" rows={3} value={f.user_comments ?? ''} onChange={(e) => set('user_comments', e.target.value)} />
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-3">
              <TextField label="Engineer name" value={f.engineer_name} onChange={(e) => set('engineer_name', e.target.value)} required />
              <SignaturePad label="Engineer signature" value={f.engineer_signature} onChange={(png) => set('engineer_signature', png)} />
            </div>
            <div className="grid gap-3">
              <TextField label="Customer name" value={f.customer_name ?? ''} onChange={(e) => set('customer_name', e.target.value)} />
              <SignaturePad label="Customer signature" value={f.customer_signature} onChange={(png) => set('customer_signature', png)} />
            </div>
          </div>
        </div>
      </Card>

      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={busy || !ready || !f.engineer_signature || !f.customer_signature || !(f.customer_name ?? '').trim() || !f.call_completed_date} onClick={() => void save(true)}>
          {busy ? 'Saving…' : 'Complete report'}
        </Button>
        <Button type="submit" variant="secondary" disabled={busy || !ready}>
          Save draft
        </Button>
        <p className="ts-muted text-xs self-center m-0">Completing needs the completed date, both signatures and the customer’s name. A completed report is locked.</p>
      </div>
    </form>
  );
}
