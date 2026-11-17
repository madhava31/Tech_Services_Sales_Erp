import db from '../db/index.js';
import { recordAudit } from '../audit/log.js';
import { HttpError } from './access.js';
import { recordHistory } from './pipeline.js';

// What is attached to a company, so whoever decides on deleting it knows what goes with it.
export async function companyImpact(companyId) {
  return db
    .prepare(
      `SELECT
         (SELECT COUNT(*)::int FROM opportunity WHERE company_id = ? AND stage NOT IN ('won', 'lost')) AS open_deals,
         (SELECT COUNT(*)::int FROM opportunity WHERE company_id = ? AND stage IN ('won', 'lost')) AS closed_deals,
         (SELECT COUNT(*)::int FROM visit WHERE company_id = ?) AS visits,
         (SELECT COUNT(*)::int FROM company_contact WHERE company_id = ? AND archived_at IS NULL) AS contacts,
         (SELECT COUNT(*)::int FROM task WHERE company_id = ? AND status = 'open') AS open_tasks,
         (SELECT COUNT(*)::int FROM company WHERE parent_company_id = ? AND archived_at IS NULL) AS branches`
    )
    .get(companyId, companyId, companyId, companyId, companyId, companyId);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function impactText(impact) {
  const parts = [
    impact.open_deals && plural(impact.open_deals, 'open deal'),
    impact.closed_deals && plural(impact.closed_deals, 'closed deal'),
    impact.visits && plural(impact.visits, 'visit'),
    impact.contacts && plural(impact.contacts, 'contact'),
    impact.open_tasks && plural(impact.open_tasks, 'open follow-up'),
  ].filter(Boolean);
  return parts.length ? `It has ${parts.join(', ')}.` : 'It has no deals, visits or contacts.';
}

export function branchesMessage(company, branches) {
  return `${company.name} has ${plural(branches, 'branch')}. Delete or move ${branches === 1 ? 'it' : 'them'} first.`;
}

// Removes a company from view without losing anything: it is archived (hidden from lists and search, and
// its deals and visits stay in the history). Its open deals are closed as lost and its open follow-ups
// cancelled, so nothing of it is left waiting on anyone. Runs in the caller's transaction.
export async function archiveCompany({ company, userId, reason }) {
  const impact = await companyImpact(company.id);
  if (impact.branches > 0) throw new HttpError(409, branchesMessage(company, impact.branches));
  const note = `Company deleted on approval: ${reason}`;
  const openDeals = await db.prepare(`SELECT id, stage FROM opportunity WHERE company_id = ? AND stage NOT IN ('won', 'lost')`).all(company.id);
  for (const deal of openDeals) {
    await db
      .prepare(`UPDATE opportunity SET stage = 'lost', probability = 0, lost_reason = 'other', close_reason = ?, won_value = NULL, closed_at = NOW(), updated_at = NOW() WHERE id = ?`)
      .run(note, deal.id);
    await recordHistory({ opportunityId: deal.id, changeType: 'stage', from: deal.stage, to: 'lost', note, userId });
  }
  await db
    .prepare(`UPDATE task SET status = 'cancelled', completed_at = NOW(), completed_by = ?, outcome_notes = ?, updated_at = NOW() WHERE company_id = ? AND status = 'open'`)
    .run(userId, note, company.id);
  await db.prepare(`UPDATE company SET archived_at = NOW(), updated_at = NOW() WHERE id = ?`).run(company.id);
  await recordAudit({
    actorUserId: userId,
    action: 'company.archived',
    entityType: 'company',
    entityId: company.id,
    summary: `Deleted company ${company.name}${company.city ? ` (${company.city})` : ''}: ${reason}. ${impactText(impact)}`,
    before: { archived: false },
    after: { archived: true, ...impact },
  });
  return impact;
}
