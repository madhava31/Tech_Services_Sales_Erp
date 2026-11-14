// Remove all demo data loaded by seed-demo.js.
// Preserves real non-demo companies (like Tata), real users, and linked salespeople.
//
//   node api/scripts/delete-demo.js [--remote]
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
  const allowRemote = process.argv.includes('--remote') || process.env.ALLOW_REMOTE_DEMO === '1';
  if (!isLocalDatabaseUrl(url) && !allowRemote) {
    throw new Error('Refusing: pass --remote or set ALLOW_REMOTE_DEMO=1 to run against a remote database.');
  }

  const client = createClient(url);
  await client.connect();
  const q = async (sql, params = []) => (await client.query(sql, params)).rows;

  try {
    const demoCompanies = await q(`SELECT id, name FROM company WHERE category LIKE '%(Demo)'`);
    if (demoCompanies.length === 0) {
      console.log('No demo data found to delete.');
      return;
    }

    console.log(`Found ${demoCompanies.length} demo companies. Deleting demo data...`);
    await client.query('BEGIN');

    // 1. Installed base & reorder plans
    const delInst = await q(`DELETE FROM installed_instrument WHERE company_id IN (SELECT id FROM company WHERE category LIKE '%(Demo)') RETURNING id`);
    const delReorder = await q(`DELETE FROM reorder_plan WHERE company_id IN (SELECT id FROM company WHERE category LIKE '%(Demo)') RETURNING id`);

    // 2. Contact logs
    const delLog = await q(`DELETE FROM contact_log WHERE company_id IN (SELECT id FROM company WHERE category LIKE '%(Demo)') RETURNING id`);

    // 3. Tenders & quotations linked to demo opportunities
    const delTenders = await q(`
      DELETE FROM tender WHERE opportunity_id IN (
        SELECT id FROM opportunity WHERE company_id IN (SELECT id FROM company WHERE category LIKE '%(Demo)')
      ) RETURNING id
    `);
    const delQuotes = await q(`
      DELETE FROM quotation_link WHERE opportunity_id IN (
        SELECT id FROM opportunity WHERE company_id IN (SELECT id FROM company WHERE category LIKE '%(Demo)')
      ) RETURNING id
    `);

    // 4. Opportunity products, segments, and history
    const delOppProd = await q(`
      DELETE FROM opportunity_product WHERE opportunity_id IN (
        SELECT id FROM opportunity WHERE company_id IN (SELECT id FROM company WHERE category LIKE '%(Demo)')
      ) RETURNING opportunity_id
    `);
    const delOppSeg = await q(`
      DELETE FROM opportunity_segment WHERE opportunity_id IN (
        SELECT id FROM opportunity WHERE company_id IN (SELECT id FROM company WHERE category LIKE '%(Demo)')
      ) RETURNING opportunity_id
    `);
    const delOppHist = await q(`
      DELETE FROM opportunity_history WHERE opportunity_id IN (
        SELECT id FROM opportunity WHERE company_id IN (SELECT id FROM company WHERE category LIKE '%(Demo)')
      ) RETURNING id
    `);

    // 5. Tasks & requirements
    const delTasks = await q(`
      DELETE FROM task WHERE company_id IN (SELECT id FROM company WHERE category LIKE '%(Demo)')
         OR opportunity_id IN (SELECT id FROM opportunity WHERE company_id IN (SELECT id FROM company WHERE category LIKE '%(Demo)'))
      RETURNING id
    `);
    const delReq = await q(`DELETE FROM requirement WHERE company_id IN (SELECT id FROM company WHERE category LIKE '%(Demo)') RETURNING id`);

    // 6. Break visit -> opportunity references, then delete opportunities & visits
    await q(`UPDATE visit SET opportunity_id = NULL WHERE company_id IN (SELECT id FROM company WHERE category LIKE '%(Demo)')`);
    const delDeals = await q(`DELETE FROM opportunity WHERE company_id IN (SELECT id FROM company WHERE category LIKE '%(Demo)') RETURNING id`);
    const delVisits = await q(`DELETE FROM visit WHERE company_id IN (SELECT id FROM company WHERE category LIKE '%(Demo)') RETURNING id`);

    // 7. Contacts & companies (break parent/merge self-references first)
    const delContacts = await q(`DELETE FROM company_contact WHERE company_id IN (SELECT id FROM company WHERE category LIKE '%(Demo)') RETURNING id`);
    await q(`UPDATE company SET parent_company_id = NULL, merged_into_company_id = NULL WHERE category LIKE '%(Demo)'`);
    const delCompanies = await q(`DELETE FROM company WHERE category LIKE '%(Demo)' RETURNING id`);

    // 8. Demo salespeople (only delete those without an associated app_user login)
    const delSalespeople = await q(`
      DELETE FROM salesperson
      WHERE employee_code IN ('SE-001', 'SE-002', 'SE-003', 'SE-004', 'SE-005')
        AND id NOT IN (SELECT salesperson_id FROM app_user WHERE salesperson_id IS NOT NULL)
      RETURNING id, name
    `);

    // 9. Demo products
    const delProducts = await q(`DELETE FROM product WHERE part_number LIKE 'DEMO-%' RETURNING id`);

    await client.query('COMMIT');

    console.log('Successfully deleted all demo data:');
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
    console.log('Real data (like Tata and your user accounts) has been preserved intact.');
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

