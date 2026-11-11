import db from '../db/index.js';
import { recordAudit } from '../audit/log.js';
import { HttpError } from './access.js';
import { recordHistory } from './pipeline.js';

// The company a record should attach to now: follows a merge, so a change queued on a phone before
// the merge still lands. Null if the company is gone for any other reason.
export async function liveCompany(id) {
  let current = id;
  for (let hops = 0; hops < 10; hops++) {
    const company = await db.prepare(`SELECT id, name, approval_status, archived_at, merged_into_company_id FROM company WHERE id = ?`).get(current);
    if (!company) return null;
    if (!company.archived_at) return company;
    if (!company.merged_into_company_id) return null;
    current = company.merged_into_company_id;
  }
  return null;
}

// A parent must be live, not rejected, and not itself a branch: the structure is one level deep.
export async function assertValidParent(parentId, { companyId = null } = {}) {
  if (companyId && parentId === companyId) throw new HttpError(400, 'A company cannot be a branch of itself.');
  const parent = await db.prepare(`SELECT id, name, parent_company_id, approval_status FROM company WHERE id = ? AND archived_at IS NULL`).get(parentId);
  if (!parent) throw new HttpError(400, 'The parent company was not found.');
  if (parent.approval_status === 'rejected') throw new HttpError(400, `${parent.name} was rejected, so it cannot be a parent company.`);
  if (parent.parent_company_id) throw new HttpError(400, `${parent.name} is itself a branch. Choose its parent company.`);
  if (companyId) {
    const [{ count }] = await db.prepare(`SELECT COUNT(*)::int AS count FROM company WHERE parent_company_id = ? AND archived_at IS NULL`).all(companyId);
    if (count > 0) throw new HttpError(409, 'This company has branches of its own, so it cannot become a branch.');
  }
  return parent;
}

const FILLABLE = ['city', 'state', 'address', 'pincode', 'phone', 'email', 'contact_person', 'gstin', 'category'];

// Moves everything from a duplicate onto the company being kept, inside one transaction, then
// archives the duplicate. Nothing is deleted, and the audit entry lists every record moved.
export async function mergeCompanies({ sourceId, targetId, reason, userId }) {
  if (sourceId === targetId) throw new HttpError(400, 'Choose a different company to merge into.');
  return db.transaction(async () => {
    // Locked in id order so two opposite merges can't deadlock.
    const rows = await db.prepare(`SELECT * FROM company WHERE id = ANY(?::int[]) AND archived_at IS NULL ORDER BY id FOR UPDATE`).all([sourceId, targetId]);
    const source = rows.find((c) => c.id === sourceId);
    const target = rows.find((c) => c.id === targetId);
    if (!source) throw new HttpError(404, 'Company not found');
    if (!target) throw new HttpError(400, 'The company to merge into was not found.');
    if (target.approval_status !== 'approved') throw new HttpError(409, `${target.name} must be approved before companies can be merged into it.`);

    const move = async (table) =>
      (await db.prepare(`UPDATE ${table} SET company_id = ?, updated_at = NOW() WHERE company_id = ? RETURNING id`).all(targetId, sourceId)).map((r) => r.id);
    const moveNoTimestamp = async (table) => (await db.prepare(`UPDATE ${table} SET company_id = ? WHERE company_id = ? RETURNING id`).all(targetId, sourceId)).map((r) => r.id);
    const moved = {
      contacts: await move('company_contact'),
      visits: await move('visit'),
      follow_ups: await move('task'),
      requirements: await moveNoTimestamp('requirement'),
      deals: await move('opportunity'),
      instruments: await move('installed_instrument'),
      reorders: await move('reorder_plan'),
      contact_log: await moveNoTimestamp('contact_log'),
    };
    for (const dealId of moved.deals) {
      await recordHistory({ opportunityId: dealId, changeType: 'field', field: 'Company', from: source.name, to: target.name, note: reason, userId });
    }

    // The duplicate is archived first: it frees its name for a branch moving up to the top level.
    const erpCompanyId = target.erp_company_id ?? source.erp_company_id;
    await db.prepare(`UPDATE company SET archived_at = NOW(), merged_into_company_id = ?, erp_company_id = NULL, updated_at = NOW() WHERE id = ?`).run(targetId, sourceId);

    // Branches of the duplicate become branches of the kept company's top level.
    const root = target.parent_company_id === sourceId ? targetId : target.parent_company_id ?? targetId;
    await db.prepare(`UPDATE company SET parent_company_id = NULL WHERE id = ? AND parent_company_id = ?`).run(targetId, sourceId);
    await db.prepare(`UPDATE company SET parent_company_id = ? WHERE parent_company_id = ? AND archived_at IS NULL`).run(root, sourceId);

    // Keep any detail the kept company doesn't have yet.
    const filled = {};
    for (const key of FILLABLE) if (!target[key] && source[key]) filled[key] = source[key];
    const merged = { ...target, ...filled };
    await db
      .prepare(`UPDATE company SET city = ?, state = ?, address = ?, pincode = ?, phone = ?, email = ?, contact_person = ?, gstin = ?, category = ?, erp_company_id = ?, updated_at = NOW() WHERE id = ?`)
      .run(merged.city, merged.state, merged.address, merged.pincode, merged.phone, merged.email, merged.contact_person, merged.gstin, merged.category, erpCompanyId, targetId);

    await recordAudit({
      actorUserId: userId,
      action: 'company.merged',
      entityType: 'company',
      entityId: sourceId,
      summary: `Merged ${source.name} into ${target.name}: ${reason}`,
      before: { name: source.name, city: source.city, approval_status: source.approval_status },
      after: { merged_into_company_id: targetId, moved, filled },
    });
    return { into_company_id: targetId, into_company_name: target.name, moved: Object.fromEntries(Object.entries(moved).map(([k, ids]) => [k, ids.length])) };
  });
}
