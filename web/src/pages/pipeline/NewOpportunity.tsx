import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { PlusIcon } from 'lucide-react';
import { api, CompanySummary } from '../../lib/api';
import CompanyPicker from '../../components/CompanyPicker';
import DealFields, { DealDraft, EMPTY_DEAL_DRAFT, dealDraftComplete, draftToInput } from '../../components/DealFields';
import OwnerField, { useOwnerChoice } from '../../components/OwnerField';
import { Button, Card, CardHeader, Notice, PageHeader } from '../../components/ui';

// Each opportunity on the form, with a key so React keeps its fields apart when one is removed.
interface Entry {
  key: number;
  draft: DealDraft;
}

let nextKey = 1;
const newEntry = (): Entry => ({ key: nextKey++, draft: EMPTY_DEAL_DRAFT });

// Its own page, so "New opportunity" opens just the form. ?company= starts with that company chosen.
// One company, one or more opportunities: there is always at least one.
export default function NewOpportunity() {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const companyId = Number(params.get('company')) || null;
  const [company, setCompany] = useState<CompanySummary | null>(null);
  const [entries, setEntries] = useState<Entry[]>(() => [newEntry()]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const owner = useOwnerChoice();

  useEffect(() => {
    if (companyId) api.companies.get(companyId).then(setCompany).catch(() => undefined);
  }, [companyId]);

  // Back to wherever the person came from; straight to the pipeline if they opened this page directly.
  const cancel = () => (location.key !== 'default' ? navigate(-1) : navigate('/pipeline'));

  const update = (key: number, patch: Partial<DealDraft>) =>
    setEntries((list) => list.map((e) => (e.key === key ? { ...e, draft: { ...e.draft, ...patch } } : e)));
  const remove = (key: number) => setEntries((list) => (list.length > 1 ? list.filter((e) => e.key !== key) : list));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!company) return;
    setBusy(true);
    setError('');
    const created: number[] = [];
    // One at a time, so a failure leaves the ones already saved saved, and only the rest on the form.
    for (const entry of entries) {
      try {
        const deal = await api.opportunities.create({
          company_id: company.id,
          ...draftToInput(entry.draft),
          ...(owner.chooses && owner.ownerId ? { owner_salesperson_id: Number(owner.ownerId) } : {}),
        });
        created.push(deal.id);
        setEntries((list) => (list.length > 1 ? list.filter((x) => x.key !== entry.key) : list));
      } catch (err) {
        const name = entry.draft.title.trim() || 'An opportunity';
        setError(`${created.length ? `${created.length} saved. ` : ''}${name}: ${err instanceof Error ? err.message : 'could not be saved.'}`);
        setBusy(false);
        return;
      }
    }
    if (created.length === 1) navigate(`/pipeline/${created[0]}`, { replace: true });
    else navigate(`/companies/${company.id}`, { replace: true });
  }

  const allComplete = entries.every((e) => dealDraftComplete(e.draft));
  const approved = company?.approval_status === 'approved';

  return (
    <div className="max-w-3xl">
      <PageHeader title="New opportunity" description="Choose the company, then add one or more opportunities for it." />
      <Card>
        <CardHeader title={company ? company.name : 'Company'} />
        <div className="p-4 sm:p-5 flex flex-col gap-4">
          {error && <Notice tone="error" onDismiss={() => setError('')}>{error}</Notice>}
          {!company ? (
            <CompanyPicker onSelect={setCompany} allowCreate />
          ) : (
            <form onSubmit={submit} className="flex flex-col gap-4">
              <div className="ts-box !py-2 flex items-center justify-between">
                <span className="text-sm font-medium">{company.name}</span>
                <Button size="sm" variant="ghost" onClick={() => setCompany(null)}>
                  Change
                </Button>
              </div>
              {!approved ? (
                <Notice tone="error">
                  {company.name} is waiting for a manager’s approval. You can log opportunities against it now; an opportunity can be opened once it is approved.
                </Notice>
              ) : (
                <>
                  {owner.chooses && <OwnerField value={owner.ownerId} onChange={owner.setOwnerId} />}
                  {entries.map((entry, i) => (
                    <section key={entry.key} className={i > 0 ? 'pt-4 border-t border-dashed border-line' : ''} aria-label={`Opportunity ${i + 1}`}>
                      <div className="flex items-center justify-between gap-3 mb-3">
                        <h3 className="text-[15px] font-medium">{entries.length > 1 ? `Opportunity ${i + 1}` : 'Opportunity'}</h3>
                        {entries.length > 1 && (
                          <Button size="sm" variant="danger" onClick={() => remove(entry.key)} disabled={busy}>
                            Remove
                          </Button>
                        )}
                      </div>
                      <DealFields companyId={company.id} value={entry.draft} onChange={(patch) => update(entry.key, patch)} withStage />
                    </section>
                  ))}
                  <div>
                    <Button variant="secondary" onClick={() => setEntries((list) => [...list, newEntry()])} disabled={busy}>
                      <PlusIcon aria-hidden="true" /> Add another opportunity
                    </Button>
                  </div>
                </>
              )}
              <div className="flex flex-wrap gap-2 pt-1">
                <Button type="submit" disabled={busy || !approved || !allComplete || !owner.ready}>
                  {busy ? 'Saving…' : entries.length > 1 ? `Save ${entries.length} opportunities` : entries[0].draft.stage === 'closed' ? 'Save opportunity' : 'Open opportunity'}
                </Button>
                <Button variant="ghost" onClick={cancel}>
                  Cancel
                </Button>
              </div>
              {approved && !owner.ready && <p className="text-xs text-subtle">Choose the salesperson these opportunities belong to.</p>}
              {approved && !allComplete && <p className="text-xs text-subtle">Fill in the name, OEM, products, value and closing date of each opportunity, and what its stage and competitor need, to save.</p>}
            </form>
          )}
          {!company && (
            <div>
              <Button variant="ghost" onClick={cancel}>
                Cancel
              </Button>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
