// Remove all demo data loaded by seed-demo.js.
// Preserves real non-demo companies (like Tata), real users, and linked salespeople.
//
//   node server/scripts/delete-demo.js [--company-ids=12,15] [--dry-run | --confirm=DELETE] [--remote]
//
// Removes the companies whose category ends in "(Demo)" and any companies named by --company-ids (typed-in
// test entries), with everything that hangs off them. Nothing else is touched. --dry-run does it all
// inside a transaction, prints what would go, and rolls it back. A real delete needs --confirm=DELETE.
// --company-ids alone does not remove the seeded demo salespeople or demo products.
//
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const { createClient, isLocalDatabaseUrl } = await import('../db/migrate.js');

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set (.env).');
  const dryRun = process.argv.includes('--dry-run');
  const confirmed = process.argv.includes('--confirm=DELETE');
  const idArg = process.argv.find((a) => a.startsWith('--company-ids='));
  const ids = idArg ? idArg.slice('--company-ids='.length).split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  if (idArg && ids.length === 0) throw new Error('--company-ids needs a comma-separated list of company ids, e.g. --company-ids=12,15');
  const allowRemote = process.argv.includes('--remote') || process.env.ALLOW_REMOTE_DEMO === '1';
  if (!isLocalDatabaseUrl(url) && !allowRemote) {
    throw new Error('Refusing: pass --remote or set ALLOW_REMOTE_DEMO=1 to run against a remote database.');
  }

  console.log(`Database: ${new URL(url).host}${new URL(url).pathname}`);
  const client = createClient(url);
  await client.connect();
  const q = async (sql, params = []) => (await client.query(sql, params)).rows;

  try {
    const selected = await q(`SELECT id, name, city, category FROM company WHERE category LIKE '%(Demo)' OR id = ANY($1::int[]) ORDER BY id`, [ids]);
    const missing = ids.filter((id) => !selected.some((c) => c.id === id));
    if (missing.length) console.log(`Not found, ignored: ${missing.join(', ')}`);
    if (selected.length === 0) {
      console.log('No demo data found to delete.');
      return;
    }
    console.log(`${selected.length} companies selected:`);
    for (const c of selected) console.log(`  #${c.id}  ${c.name}${c.city ? ` (${c.city})` : ''}${c.category ? `  [${c.category}]` : ''}`);
    if (!dryRun && !confirmed) throw new Error('Refusing: add --dry-run to preview, or --confirm=DELETE to delete for real.');
    const seeded = selected.some((c) => /\(Demo\)$/.test(c.category ?? ''));

    await client.query('BEGIN');
    await q(`CREATE TEMP TABLE doomed_company ON COMMIT DROP AS SELECT id FROM company WHERE category LIKE '%(Demo)' OR id = ANY($1::int[])`, [ids]);

    // 1. Installed base & reorder plans
    const delInst = await q(`DELETE FROM installed_instrument WHERE company_id IN (SELECT id FROM doomed_company) RETURNING id`);
    const delReorder = await q(`DELETE FROM reorder_plan WHERE company_id IN (SELECT id FROM doomed_company) RETURNING id`);

    // 2. Contact logs
    const delLog = await q(`DELETE FROM contact_log WHERE company_id IN (SELECT id FROM doomed_company) RETURNING id`);

    // 3. Tenders & quotations linked to demo opportunities
    const delTenders = await q(`
      DELETE FROM tender WHERE opportunity_id IN (
        SELECT id FROM opportunity WHERE company_id IN (SELECT id FROM doomed_company)
      ) RETURNING opportunity_id
    `);
    const delQuotes = await q(`
      DELETE FROM quotation_link WHERE opportunity_id IN (
        SELECT id FROM opportunity WHERE company_id IN (SELECT id FROM doomed_company)
      ) RETURNING id
    `);

    // 4. Opportunity products, segments, and history
    const delOppProd = await q(`
      DELETE FROM opportunity_product WHERE opportunity_id IN (
        SELECT id FROM opportunity WHERE company_id IN (SELECT id FROM doomed_company)
      ) RETURNING opportunity_id
    `);
    await q(`
      DELETE FROM opportunity_custom_product WHERE opportunity_id IN (
        SELECT id FROM opportunity WHERE company_id IN (SELECT id FROM doomed_company)
      )
    `);
    await q(`
      DELETE FROM opportunity_oem WHERE opportunity_id IN (
        SELECT id FROM opportunity WHERE company_id IN (SELECT id FROM doomed_company)
      )
    `);
    const delOppSeg = await q(`
      DELETE FROM opportunity_segment WHERE opportunity_id IN (
        SELECT id FROM opportunity WHERE company_id IN (SELECT id FROM doomed_company)
      ) RETURNING opportunity_id
    `);
    // History is append-only. Its delete guard is lifted for this one transaction and put back at once.
    await q(`ALTER TABLE opportunity_history DISABLE TRIGGER opportunity_history_no_update_delete`);
    const delOppHist = await q(`
      DELETE FROM opportunity_history WHERE opportunity_id IN (
        SELECT id FROM opportunity WHERE company_id IN (SELECT id FROM doomed_company)
      ) RETURNING id
    `);

    await q(`ALTER TABLE opportunity_history ENABLE TRIGGER opportunity_history_no_update_delete`);

    // 5. Tasks & requirements
    // Automatic follow-ups point at their task, and at the instrument or reorder plan they came from.
    await q(
      `DELETE FROM auto_followup
       WHERE task_id IN (SELECT id FROM task WHERE company_id IN (SELECT id FROM doomed_company)
                            OR opportunity_id IN (SELECT id FROM opportunity WHERE company_id IN (SELECT id FROM doomed_company)))
          OR (kind IN ('warranty', 'amc') AND ref_id = ANY($1::int[]))
          OR (kind = 'reorder' AND ref_id = ANY($2::int[]))`,
      [delInst.map((r) => r.id), delReorder.map((r) => r.id)]
    );
    const delTasks = await q(`
      DELETE FROM task WHERE company_id IN (SELECT id FROM doomed_company)
         OR opportunity_id IN (SELECT id FROM opportunity WHERE company_id IN (SELECT id FROM doomed_company))
      RETURNING id
    `);
    const delReq = await q(`DELETE FROM requirement WHERE company_id IN (SELECT id FROM doomed_company) RETURNING id`);

    // 6. Break visit -> opportunity references, then delete opportunities & visits
    await q(`UPDATE visit SET opportunity_id = NULL WHERE company_id IN (SELECT id FROM doomed_company)`);
    const delDeals = await q(`DELETE FROM opportunity WHERE company_id IN (SELECT id FROM doomed_company) RETURNING id`);
    const delVisits = await q(`DELETE FROM visit WHERE company_id IN (SELECT id FROM doomed_company) RETURNING id`);

    // 7. Contacts & companies (break parent/merge self-references first)
    // Approval reminders about demo companies.
    await q(`DELETE FROM notification WHERE ref_type = 'company' AND ref_id IN (SELECT id FROM doomed_company)`);
    const delContacts = await q(`DELETE FROM company_contact WHERE company_id IN (SELECT id FROM doomed_company) RETURNING id`);
    await q(`UPDATE company SET parent_company_id = NULL, merged_into_company_id = NULL WHERE id IN (SELECT id FROM doomed_company)`);
    const delCompanies = await q(`DELETE FROM company WHERE id IN (SELECT id FROM doomed_company) RETURNING id`);

    // 8. Demo salespeople (only delete those without an associated app_user login)
    const delSalespeople = seeded
      ? await q(`
      DELETE FROM salesperson
      WHERE employee_code IN ('SE-001', 'SE-002', 'SE-003', 'SE-004', 'SE-005')
        AND id NOT IN (SELECT salesperson_id FROM app_user WHERE salesperson_id IS NOT NULL)
      RETURNING id, name
    `)
      : [];

    // 9. Demo products
    const delProducts = seeded ? await q(`DELETE FROM product WHERE part_number LIKE 'DEMO-%' RETURNING id`) : [];

    if (dryRun) {
      await client.query('ROLLBACK');
      console.log('DRY RUN: nothing was deleted. This is what would be deleted:');
    } else {
      await client.query('COMMIT');
      console.log('Successfully deleted all demo data:');
    }
    console.log(`  Companies:        ${delCompanies.length}`);
    console.log(`  Contacts:         ${delContacts.length}`);
    console.log(`  Deals:            ${delDeals.length}`);
    console.log(`  Visits:           ${delVisits.length}`);
    console.log(`  Tasks/Follow-ups: ${delTasks.length}`);
    console.log(`  Requirements:     ${delReq.length}`);
    console.log(`  Quotations:       ${delQuotes.length}`);
    console.log(`  Instruments:      ${delInst.length}`);
    console.log(`  Reorder plans:    ${delReorder.length}`);
    console.log(`  Salespeople:      ${delSalespeople.length} (${delSalespeople.map(s => s.name).join(', ') || 'none'})`);
    console.log(`  Demo Products:    ${delProducts.length}`);
    console.log(dryRun ? 'Run again without --dry-run to delete them.' : 'Real data (like Tata and your user accounts) has been preserved intact.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

