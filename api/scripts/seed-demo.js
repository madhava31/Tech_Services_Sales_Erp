// Load realistic sample data into the LOCAL database so every screen and dashboard has something
// to show: 50 companies with contacts, ~150 visits over the last six months, ~50 deals across every
// stage (with history, quotations, won/lost/abandoned results, OEMs, products and segments),
// requirements, follow-ups, a pending and a rejected company, and overdue deals.
//
//   npm run seed:demo
//
// Fictional data only. Refuses any non-local database and refuses to run twice (demo companies
// are marked "(Demo)" in the category field). To start over, recreate the local database and run
// `npm run db:migrate` first. Deterministic: the same data every time.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// Imported after .env is loaded: crm/pipeline.js pulls in db/index.js, which needs DATABASE_URL.
const { createClient, isLocalDatabaseUrl } = await import('../db/migrate.js');
const { normalizeCompanyName } = await import('../crm/normalize.js');
const { stageOrder } = await import('../crm/pipeline.js');
const { parseProductCsv, upsertProducts } = await import('../crm/products.js');

// ---------- deterministic randomness ----------
let seed = 20261024;
function rand() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (min, max) => min + Math.floor(rand() * (max - min + 1));
const pick = (list) => list[Math.floor(rand() * list.length)];
function weighted(entries) {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [value, w] of entries) if ((r -= w) < 0) return value;
  return entries[entries.length - 1][0];
}

// ---------- India-time dates ----------
const DAY = 86400000;
const IST_OFFSET = 330 * 60000;
function istDate(daysAgo) {
  return new Date(Date.now() + IST_OFFSET - daysAgo * DAY).toISOString().slice(0, 10);
}
function istTimestamp(daysAgo, hour = int(10, 17), minute = pick([0, 15, 30, 45])) {
  const d = istDate(daysAgo);
  return new Date(`${d}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+05:30`);
}
const addHours = (date, h) => new Date(date.getTime() + h * 3600000);
const minDate = (a, b) => (a < b ? a : b);

// ---------- reference data (fictional) ----------
const COMPANIES = [
  ['Sri Venkateswara Pumps', 'Hyderabad', 'Pumps & motors'],
  ['Deccan Hydraulics', 'Hyderabad', 'Hydraulics'],
  ['Godavari Steel Works', 'Vizag', 'Steel'],
  ['Krishna Agro Processing', 'Vijayawada', 'Food processing'],
  ['Nizam Engineering', 'Hyderabad', 'Fabrication'],
  ['Coromandel Valves', 'Chennai', 'Valves'],
  ['Kaveri Textiles', 'Coimbatore', 'Textiles'],
  ['Bharat Precision Tools', 'Bengaluru', 'Machine tools'],
  ['Sahyadri Chemicals', 'Pune', 'Chemicals'],
  ['Tungabhadra Cement', 'Kurnool', 'Cement'],
  ['Annapurna Foods', 'Hyderabad', 'Food processing'],
  ['Lakshmi Polymers', 'Chennai', 'Plastics'],
  ['Vizag Marine Services', 'Vizag', 'Marine'],
  ['Shakti Power Systems', 'Bengaluru', 'Power'],
  ['Medak Pharma Labs', 'Hyderabad', 'Pharmaceuticals'],
  ['Hosur Auto Components', 'Hosur', 'Automotive'],
  ['Rayalaseema Granites', 'Anantapur', 'Mining'],
  ['Pragati Packaging', 'Pune', 'Packaging'],
  ['Srinivasa Cold Storage', 'Guntur', 'Cold chain'],
  ['Konark Paper Mills', 'Vizag', 'Paper'],
  ['Hindustan Boilers', 'Chennai', 'Boilers'],
  ['Telangana Dairy Cooperative', 'Hyderabad', 'Dairy'],
  ['Malnad Coffee Works', 'Bengaluru', 'Food processing'],
  ['Ganga Water Solutions', 'Hyderabad', 'Water treatment'],
  ['Saraswati Electricals', 'Warangal', 'Electrical'],
  ['Andhra Sugars Unit 2', 'Tanuku', 'Sugar'],
  ['Nilgiri Bottling', 'Coimbatore', 'Beverages'],
  ['Pioneer Forgings', 'Pune', 'Forging'],
  ['Kakatiya Cables', 'Warangal', 'Cables'],
  ['Mahindra Nagar Foundry', 'Hyderabad', 'Foundry'],
  ['Sunrise Hospitals Group', 'Hyderabad', 'Healthcare'],
  ['Orchid Glass Works', 'Chennai', 'Glass'],
  ['Vidya Infra Projects', 'Bengaluru', 'Construction'],
  ['Amaravati Rice Mills', 'Guntur', 'Food processing'],
  ['Eastern Ghats Minerals', 'Vizag', 'Mining'],
  ['Pearl City Pharma', 'Hyderabad', 'Pharmaceuticals'],
  ['Kanchi Silk Processors', 'Kanchipuram', 'Textiles'],
  ['Deccan Breweries', 'Hyderabad', 'Beverages'],
  ['Silicon Valley Data Park', 'Bengaluru', 'Data centres'],
  ['Mysore Sandal Works', 'Mysuru', 'FMCG'],
  ['Ratnagiri Fisheries', 'Ratnagiri', 'Fisheries'],
  ['Charminar Paints', 'Hyderabad', 'Paints'],
  ['Simhapuri Energy', 'Nellore', 'Power'],
  ['Palar Leather Exports', 'Vellore', 'Leather'],
  ['Hampi Steel Rolling', 'Ballari', 'Steel'],
  ['Kolar Gold Fields Engineering', 'Kolar', 'Engineering'],
  ['Srisailam Hydro Works', 'Kurnool', 'Power'],
  ['Banjara Hotels', 'Hyderabad', 'Hospitality'],
  ['Pune Fluid Controls', 'Pune', 'Valves'],
  ['Cyberabad Tech Park', 'Hyderabad', 'Real estate'],
];
const FIRST = ['Suresh', 'Ramesh', 'Lakshmi', 'Anil', 'Kavitha', 'Srinivas', 'Padma', 'Rajesh', 'Meena', 'Venkat', 'Divya', 'Prakash', 'Sunitha', 'Karthik', 'Anjali', 'Naveen', 'Swathi', 'Mahesh', 'Revathi', 'Ganesh'];
const LAST = ['Rao', 'Reddy', 'Naidu', 'Sharma', 'Iyer', 'Kumar', 'Varma', 'Menon', 'Patil', 'Chowdary', 'Prasad', 'Nair'];
const DESIGNATIONS = ['Purchase Manager', 'Plant Head', 'Maintenance Engineer', 'General Manager', 'Director', 'Procurement Officer', 'Project Engineer', 'Stores In-charge'];
// What customers ask for: category, requirement, unit, value range.
const PRODUCTS = [
  ['Spectroscopy', 'Atomic absorption spectrometer for metals testing', 'Nos', [1500000, 4500000]],
  ['Spectroscopy', 'UV-Vis spectrophotometer for QC lab', 'Nos', [300000, 1200000]],
  ['Chromatography', 'HPLC system for assay and impurities', 'Nos', [1800000, 6500000]],
  ['Chromatography', 'GC columns and consumables', 'Sets', [50000, 350000]],
  ['Weighing', 'Analytical balance for QC lab', 'Nos', [120000, 600000]],
  ['Weighing', 'Microbalance for R&D lab', 'Nos', [500000, 1800000]],
  ['Titration', 'Automatic Karl Fischer titrator', 'Nos', [300000, 1100000]],
  ['Density', 'Digital density meter', 'Nos', [400000, 1500000]],
  ['Rheology', 'Rotational viscometer', 'Nos', [350000, 1300000]],
  ['Lab consumables', 'Reagents and solvents, annual supply', 'Year', [100000, 800000]],
  ['Service', 'Annual maintenance contract', 'Year', [100000, 500000]],
];
// Used only until technicon_products_seed.csv is in place: fictional part numbers, one set per OEM.
const DEMO_CATALOGUE = [
  ['DEMO-PE-AAS', 'Atomic Absorption Spectrometer', 'PerkinElmer', 'Spectroscopy', 'Flame and furnace | Multi-element'],
  ['DEMO-PE-UV', 'UV-Vis Spectrophotometer', 'PerkinElmer', 'Spectroscopy', 'Double beam'],
  ['DEMO-MT-XPR', 'Analytical Balance', 'Mettler Toledo', 'Weighing', '0.1 mg readability | Auto calibration'],
  ['DEMO-MT-KF', 'Karl Fischer Titrator', 'Mettler Toledo', 'Titration', 'Volumetric | Touch screen'],
  ['DEMO-AP-DMA', 'Digital Density Meter', 'Anton Paar', 'Density', 'Oscillating U-tube'],
  ['DEMO-AP-RHEO', 'Rotational Viscometer', 'Anton Paar', 'Rheology', 'Peltier temperature control'],
  ['DEMO-SH-HPLC', 'HPLC System', 'SHINE', 'Chromatography', 'Quaternary pump | PDA detector'],
  ['DEMO-ME-RGT', 'Analytical Reagents Kit', 'Merck', 'Lab consumables', 'ACS grade'],
  ['DEMO-ME-SOL', 'HPLC Grade Solvents', 'Merck', 'Lab consumables', 'Low UV absorbance'],
  ['DEMO-VC-GC', 'GC Capillary Column', 'Vintage Chrom', 'Chromatography', '30 m | Low bleed'],
];
const STATES = { Hyderabad: 'Telangana', Warangal: 'Telangana', Vizag: 'Andhra Pradesh', Vijayawada: 'Andhra Pradesh', Guntur: 'Andhra Pradesh', Kurnool: 'Andhra Pradesh', Anantapur: 'Andhra Pradesh', Tanuku: 'Andhra Pradesh', Nellore: 'Andhra Pradesh', Chennai: 'Tamil Nadu', Coimbatore: 'Tamil Nadu', Hosur: 'Tamil Nadu', Kanchipuram: 'Tamil Nadu', Vellore: 'Tamil Nadu', Bengaluru: 'Karnataka', Mysuru: 'Karnataka', Ballari: 'Karnataka', Kolar: 'Karnataka', Pune: 'Maharashtra', Ratnagiri: 'Maharashtra' };
const CLOSE_REASONS = {
  won: ['PO received after final negotiation', 'Beat the competitor on service support', 'Repeat customer, ordered after demo'],
  lost: ['Customer chose a cheaper local option', 'Budget moved to next year', 'Went with their existing supplier'],
  abandoned: ['Customer project on hold, no reply for two months', 'Requirement dropped after a management change'],
};
const PROBABILITY_REASONS = ['Budget confirmed', 'Competing with one other vendor', 'Early discussion only', 'Demo went well'];
const TIMELINES = ['This month', 'Within 2 months', 'This quarter', 'Next quarter', 'After budget approval'];
const NEW_SALESPEOPLE = [
  ['SE-004', 'Sneha Reddy'],
  ['SE-005', 'Vikram Singh'],
];

const OPEN_STAGE_FLOW = ['new_prospect', 'visit_completed', 'qualified', 'quotation_requested', 'quotation_sent', 'negotiation'];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set (.env).');
  const allowRemote = process.argv.includes('--remote') || process.env.ALLOW_REMOTE_DEMO === '1';
  if (!isLocalDatabaseUrl(url) && !allowRemote) {
    throw new Error('Refusing: demo data is only for a local database, or pass --remote / set ALLOW_REMOTE_DEMO=1.');
  }

  const client = createClient(url);
  await client.connect();
  const q = async (sql, params = []) => (await client.query(sql, params)).rows;
  try {
    const [{ c: existingDemo }] = await q(`SELECT COUNT(*)::int AS c FROM company WHERE category LIKE '%(Demo)'`);
    if (existingDemo > 0) throw new Error('Demo data is already loaded. Recreate the local database to load it again.');

    const admin = (await q(`SELECT id FROM app_user WHERE role IN ('admin', 'managing_director') AND is_active ORDER BY id LIMIT 1`))[0];
    if (!admin) throw new Error('Create the first administrator in the app before loading demo data.');

    await client.query('BEGIN');

    // The real catalogue if the file is in place, otherwise a small fictional one.
    const csvPath = path.resolve(__dirname, '../db/seeds/technicon_products_seed.csv');
    const [{ c: productCount }] = await q(`SELECT COUNT(*)::int AS c FROM product`);
    if (fs.existsSync(csvPath)) await upsertProducts(q, parseProductCsv(fs.readFileSync(csvPath, 'utf-8')));
    else if (productCount === 0) {
      await upsertProducts(q, DEMO_CATALOGUE.map(([part_number, name, make, category, features]) => ({ part_number, name, make, category, key_features: features.split(' | ') })));
    }
    const catalogue = await q(`SELECT p.id, p.oem_id, p.category FROM product p WHERE p.is_active ORDER BY p.id`);
    const segmentRows = await q(`SELECT id FROM market_segment WHERE is_active ORDER BY id`);
    const oemIds = [...new Set(catalogue.map((p) => p.oem_id))];

    // Salespeople: keep any that exist (Ravi, Priya, Arjun from earlier setup), add the rest.
    for (const [code, name] of [['SE-001', 'Ravi Kumar'], ['SE-002', 'Priya Sharma'], ['SE-003', 'Arjun Rao'], ...NEW_SALESPEOPLE]) {
      await q(`INSERT INTO salesperson (employee_code, name) VALUES ($1, $2) ON CONFLICT (employee_code) DO NOTHING`, [code, name]);
    }
    const people = await q(
      `SELECT sp.id, sp.name, u.id AS user_id FROM salesperson sp
       LEFT JOIN app_user u ON u.salesperson_id = sp.id AND u.is_active
       WHERE sp.is_active ORDER BY sp.id`
    );
    // Records are "created by" the salesperson's own login when they have one.
    const creatorOf = (sp) => sp.user_id ?? admin.id;
    const ravi = people.find((p) => p.name === 'Ravi Kumar') ?? people[0];
    // Ravi gets the biggest share so his own dashboard is full.
    const ownerFor = () => (rand() < 0.36 ? ravi : pick(people));

    const counts = { companies: 0, pending: 0, rejected: 0, contacts: 0, visits: 0, drafts: 0, requirements: 0, deals: 0, abandoned: 0, overdue: 0, quotations: 0, tasksOpen: 0, tasksDone: 0 };
    let quotationNo = 4100;
    // Phone numbers are unique across contacts, so hand them out in sequence.
    let contactPhone = 9000100000;

    for (const [index, [name, city, industry]] of COMPANIES.entries()) {
      const owner = ownerFor();
      const creator = creatorOf(owner);
      // Most relationships started in the last 90 days; some go back ~6 months for the trend chart.
      const firstVisitDaysAgo = rand() < 0.7 ? int(3, 88) : int(89, 175);
      // The last few companies show the approval flow: two waiting for a manager, one rejected.
      const approval = index >= COMPANIES.length - 2 ? 'pending' : index === COMPANIES.length - 3 ? 'rejected' : 'approved';
      const [company] = await q(
        `INSERT INTO company (name, normalized_name, city, state, phone, category, approval_status, approved_by, approved_at, rejection_reason, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12) RETURNING id`,
        [
          name,
          normalizeCompanyName(name),
          city,
          STATES[city] ?? null,
          `${pick(['9', '8', '7'])}${String(int(100000000, 999999999))}`,
          `${industry} (Demo)`,
          approval,
          approval === 'pending' ? null : admin.id,
          approval === 'pending' ? null : istTimestamp(firstVisitDaysAgo),
          approval === 'rejected' ? 'Not a lab customer, hotel chain with no testing needs' : null,
          creator,
          istTimestamp(firstVisitDaysAgo + 1),
        ]
      );
      counts.companies++;
      if (approval === 'pending') counts.pending++;
      if (approval === 'rejected') counts.rejected++;

      const contacts = [];
      for (let i = 0; i < int(1, 2); i++) {
        const contactName = `${pick(FIRST)} ${pick(LAST)}`;
        const [contact] = await q(
          `INSERT INTO company_contact (company_id, name, designation, phone, email, created_by, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [
            company.id,
            contactName,
            pick(DESIGNATIONS),
            String(contactPhone++),
            `${contactName.split(' ')[0].toLowerCase()}@example.com`,
            creator,
            istTimestamp(firstVisitDaysAgo + 1),
          ]
        );
        contacts.push(contact.id);
        counts.contacts++;
      }

      // Visits, oldest first, mostly by the company's owner.
      const visitDays = [firstVisitDaysAgo];
      for (let i = 0, n = int(1, 4); i < n; i++) {
        const next = visitDays[visitDays.length - 1] - int(5, 25);
        if (next < 0) break;
        visitDays.push(next);
      }
      const product = pick(PRODUCTS);
      const value = Math.round(int(product[3][0], product[3][1]) / 1000) * 1000;
      const visits = [];
      for (const [vi, daysAgo] of visitDays.entries()) {
        const visitor = rand() < 0.85 ? owner : pick(people);
        // Never later than now, whatever time of day the loader runs.
        const visitedAt = minDate(istTimestamp(daysAgo), new Date(Date.now() - 3 * 3600000));
        // The most recent visit of a few companies is still being written up.
        const draft = vi === visitDays.length - 1 && daysAgo <= 2 && rand() < 0.5;
        const outcome = draft
          ? null
          : vi === 0
            ? weighted([['interested', 5], ['follow_up_needed', 3], ['quotation_requested', 2], ['not_interested', 1], ['no_meeting', 1]])
            : weighted([['interested', 3], ['follow_up_needed', 4], ['quotation_requested', 3], ['not_interested', 1], ['no_meeting', 1]]);
        const [visit] = await q(
          `INSERT INTO visit (company_id, contact_id, salesperson_id, visited_at, status, outcome, notes, completed_at, created_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $4, $4) RETURNING id`,
          [
            company.id,
            pick(contacts),
            visitor.id,
            visitedAt,
            draft ? 'draft' : 'completed',
            outcome,
            draft ? null : pick(['Discussed current setup and pain points.', 'Walked the plant with maintenance team.', 'Customer comparing two vendors.', 'Budget expected next month.', 'Shared catalogue and reference list.']),
            draft ? null : addHours(visitedAt, 1),
            creatorOf(visitor),
          ]
        );
        counts.visits++;
        if (draft) counts.drafts++;
        visits.push({ id: visit.id, visitedAt, outcome, visitor, daysAgo, draft });

        if (outcome && ['interested', 'follow_up_needed', 'quotation_requested'].includes(outcome)) {
          await q(
            `INSERT INTO requirement (company_id, visit_id, salesperson_id, product_category, description, quantity, unit, budget, urgency, purchase_timeline, created_by, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [
              company.id,
              visit.id,
              visitor.id,
              product[0],
              product[1],
              int(1, 20),
              product[2],
              rand() < 0.6 ? value : null,
              weighted([['normal', 6], ['high', 3], ['urgent', 1], ['low', 1]]),
              pick(TIMELINES),
              creatorOf(visitor),
              addHours(visitedAt, 1),
            ]
          );
          counts.requirements++;
        }
      }

      // A deal for most companies whose visits showed a real need; a few companies get two.
      const activeVisit = visits.find((v) => ['interested', 'follow_up_needed', 'quotation_requested'].includes(v.outcome));
      const dealCount = activeVisit && approval === 'approved' ? (index % 9 === 0 ? 2 : 1) : 0;
      for (let di = 0; di < dealCount; di++) {
        const createdAt = addHours(activeVisit.visitedAt, 2 + di * 24 * int(3, 10));
        const ageDays = Math.max(0, (Date.now() - createdAt.getTime()) / DAY);
        // Older deals are more likely to be closed.
        let finalStage =
          ageDays > 45
            ? weighted([['won', 3], ['lost', 2], ['abandoned', 1], ['negotiation', 2], ['quotation_sent', 2], ['qualified', 1]])
            : ageDays > 15
              ? weighted([['won', 2], ['lost', 1], ['negotiation', 2], ['quotation_sent', 3], ['quotation_requested', 2], ['qualified', 2]])
              : weighted([['qualified', 3], ['quotation_requested', 3], ['visit_completed', 2], ['new_prospect', 1], ['quotation_sent', 1]]);
        // Always at least one abandoned deal to look at.
        if (counts.abandoned === 0 && ageDays > 15) finalStage = 'abandoned';
        const dealProduct = di === 0 ? product : pick(PRODUCTS);
        const dealValue = di === 0 ? value : Math.round(int(dealProduct[3][0], dealProduct[3][1]) / 1000) * 1000;
        const closed = ['won', 'lost', 'abandoned'].includes(finalStage);
        const startStage = activeVisit.outcome === 'quotation_requested' ? 'quotation_requested' : activeVisit.outcome === 'interested' ? 'qualified' : 'visit_completed';
        // Path from the starting stage to the final one, one history row per step.
        const path = [startStage];
        const target = closed ? (finalStage === 'won' ? 'negotiation' : finalStage === 'abandoned' ? 'qualified' : pick(['qualified', 'quotation_sent', 'negotiation'])) : finalStage;
        if (stageOrder(target) > stageOrder(startStage)) {
          for (const s of OPEN_STAGE_FLOW) if (stageOrder(s) > stageOrder(startStage) && stageOrder(s) <= stageOrder(target)) path.push(s);
        } else if (stageOrder(target) < stageOrder(startStage)) {
          path[0] = target;
        }
        if (closed) path.push(finalStage);

        // The deal's last activity falls somewhere in its life — closed deals closed weeks ago,
        // and some open deals have gone quiet — so monthly trends and "going quiet" look real.
        const span = Math.max(1, ageDays - 1) * (closed ? 0.3 + rand() * 0.6 : 0.2 + rand() * 0.8);
        const stepTimes = path.map((_, i) => minDate(new Date(createdAt.getTime() + (span * DAY * i) / Math.max(1, path.length - 1)), new Date(Date.now() - 3600000)));
        const lastActivity = stepTimes[stepTimes.length - 1];
        const closedAt = closed ? stepTimes[stepTimes.length - 1] : null;
        const lostReason = finalStage === 'lost' ? weighted([['price', 4], ['competitor', 3], ['timing', 2], ['no_budget', 2], ['no_response', 1]]) : null;
        // Open deals mostly close in the coming weeks; about one in five has slipped past its date.
        const overdue = !closed && (counts.overdue === 0 || rand() < 0.2);
        const expectedClose = closed ? new Date(closedAt.getTime() + IST_OFFSET).toISOString().slice(0, 10) : overdue ? istDate(int(1, 20)) : istDate(-int(5, 60));
        if (overdue) counts.overdue++;
        if (finalStage === 'abandoned') counts.abandoned++;
        const oemId = pick(oemIds);
        const oemProducts = catalogue.filter((p) => p.oem_id === oemId);
        const chosenProducts = oemProducts.length > 1 && rand() < 0.3 ? oemProducts.slice(0, 2) : [pick(oemProducts)];
        const chosenSegments = rand() < 0.3 ? [segmentRows[0], pick(segmentRows.slice(1))] : [pick(segmentRows)];
        const probability = finalStage === 'won' ? 100 : closed ? 0 : weighted([[25, 3], [50, 4], [75, 2], [100, 1]]);

        const [deal] = await q(
          `INSERT INTO opportunity (company_id, title, owner_salesperson_id, original_owner_salesperson_id, stage, estimated_value, probability,
                                    expected_close_date, source_visit_id, won_value, lost_reason, close_reason, closed_at, created_by, created_at, updated_at,
                                    oem_id, contact_id, probability_reason, tender, notes)
           VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20) RETURNING id`,
          [
            company.id,
            dealProduct[1],
            owner.id,
            finalStage,
            dealValue,
            probability,
            expectedClose,
            di === 0 ? activeVisit.id : null,
            finalStage === 'won' ? Math.round((dealValue * int(85, 100)) / 100 / 100) * 100 : null,
            lostReason,
            closed ? pick(CLOSE_REASONS[finalStage]) : null,
            closedAt,
            creatorOf(owner),
            createdAt,
            stepTimes[stepTimes.length - 1],
            oemId,
            pick(contacts),
            pick(PROBABILITY_REASONS),
            rand() < 0.15,
            rand() < 0.4 ? 'Customer wants installation and training included.' : null,
          ]
        );
        counts.deals++;
        for (const p of chosenProducts) await q(`INSERT INTO opportunity_product (opportunity_id, product_id) VALUES ($1, $2)`, [deal.id, p.id]);
        for (const s of chosenSegments) await q(`INSERT INTO opportunity_segment (opportunity_id, segment_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [deal.id, s.id]);

        for (const [i, stage] of path.entries()) {
          await q(
            `INSERT INTO opportunity_history (opportunity_id, change_type, from_value, to_value, changed_by, changed_at)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [deal.id, i === 0 ? 'created' : 'stage', i === 0 ? null : path[i - 1], stage, creatorOf(owner), stepTimes[i]]
          );
        }

        // Quotation recorded when the deal reached "quote sent".
        const sentIndex = path.indexOf('quotation_sent');
        if (sentIndex >= 0 || finalStage === 'won') {
          const at = stepTimes[sentIndex >= 0 ? sentIndex : Math.max(0, path.length - 2)];
          const status = finalStage === 'won' ? 'accepted' : finalStage === 'lost' || finalStage === 'abandoned' ? (lostReason === 'price' || lostReason === 'competitor' ? 'rejected' : 'sent') : 'sent';
          await q(
            `INSERT INTO quotation_link (opportunity_id, quotation_number, quotation_date, amount, status, created_by, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
            [deal.id, `QTN-2026-${quotationNo++}`, new Date(at.getTime() + IST_OFFSET).toISOString().slice(0, 10), Math.round((dealValue * int(95, 105)) / 100 / 100) * 100, status, admin.id, at]
          );
          counts.quotations++;
        }

        // Visits by the owner after the deal opened belong to it.
        // Visits by the owner during the deal's active life belong to it, with their requirements
        // (as completing a visit in the app would do).
        await q(
          `UPDATE visit SET opportunity_id = $1 WHERE company_id = $2 AND salesperson_id = $3 AND visited_at BETWEEN $4 AND $5 AND opportunity_id IS NULL`,
          [deal.id, company.id, owner.id, activeVisit.visitedAt, lastActivity]
        );
        await q(`UPDATE requirement r SET opportunity_id = v.opportunity_id FROM visit v WHERE r.visit_id = v.id AND v.opportunity_id = $1`, [deal.id]);

        // Follow-ups: a done one in the past, and an open next step for open deals (some overdue).
        await q(
          `INSERT INTO task (company_id, opportunity_id, assignee_salesperson_id, task_type, title, due_date, status, outcome_notes, completed_at, completed_by, created_by, created_at)
           VALUES ($1, $2, $3, 'call', $4, $5, 'done', $6, $7, $8, $8, $9)`,
          [company.id, deal.id, owner.id, `Call ${name} about ${dealProduct[0]}`, istDate(Math.max(1, Math.round(ageDays) - 3)), pick(['Spoke to purchase', 'Shared revised specs', 'Customer asked for a demo']), lastActivity > createdAt ? minDate(addHours(createdAt, 72), lastActivity) : addHours(createdAt, 1), creatorOf(owner), createdAt]
        );
        counts.tasksDone++;
        if (!closed) {
          const dueDaysAgo = weighted([[int(1, 6), 3], [0, 1], [-int(1, 10), 6]]);
          const type = finalStage === 'quotation_requested' ? 'send_quotation' : pick(['call', 'visit', 'demo', 'technical_discussion']);
          await q(
            `INSERT INTO task (company_id, opportunity_id, assignee_salesperson_id, task_type, title, due_date, priority, created_by, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              company.id,
              deal.id,
              owner.id,
              type,
              type === 'send_quotation' ? `Send quotation to ${name}` : type === 'demo' ? `Product demo at ${name}` : type === 'visit' ? `Revisit ${name}` : `Follow up with ${name}`,
              istDate(dueDaysAgo),
              dealValue > 800000 ? 'high' : 'normal',
              creatorOf(owner),
              stepTimes[stepTimes.length - 1],
            ]
          );
          counts.tasksOpen++;
        }
      }

      // "Couldn't meet" with no deal: a revisit on someone's list.
      const lastVisit = visits[visits.length - 1];
      if (!dealCount && lastVisit.outcome === 'no_meeting') {
        await q(
          `INSERT INTO task (company_id, visit_id, assignee_salesperson_id, task_type, title, due_date, created_by, created_at)
           VALUES ($1, $2, $3, 'visit', $4, $5, $6, $7)`,
          [company.id, lastVisit.id, lastVisit.visitor.id, `Revisit ${name}`, istDate(lastVisit.daysAgo - 3), creatorOf(lastVisit.visitor), lastVisit.visitedAt]
        );
        counts.tasksOpen++;
      }
    }

    // Tenders on the deals marked as tenders, some due soon, some decided with the deposit still out.
    const tenderDeals = await q(`SELECT id, stage, closed_at FROM opportunity WHERE tender ORDER BY id`);
    let openTenders = 0;
    for (const [i, d] of tenderDeals.entries()) {
      const closed = Boolean(d.closed_at);
      if (!closed) openTenders++;
      await q(
        `INSERT INTO tender (opportunity_id, tender_number, issuing_authority, bid_due_date, emd_amount, emd_status, bid_status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          d.id,
          `GEM/2026/B/${5100 + i}`,
          pick(['State Food Lab', 'Regional Pharma Testing Centre', 'University Science Dept', 'Public Health Lab']),
          // The first open bid is due in days, so there is always one to chase.
          istDate(closed ? int(20, 60) : openTenders === 1 ? -3 : -int(1, 25)),
          int(1, 6) * 25000,
          closed || i % 2 ? 'paid' : 'pending',
          d.stage === 'won' ? 'won' : d.stage === 'lost' ? 'lost' : closed ? 'cancelled' : openTenders % 3 === 0 ? 'submitted' : 'preparing',
          admin.id,
        ]
      );
    }

    // Instruments from won deals, with warranties and AMCs ending across the coming months.
    const wonDeals = await q(
      `SELECT o.id, o.company_id, o.owner_salesperson_id, o.closed_at, p.id AS product_id, p.name AS product_name
       FROM opportunity o JOIN LATERAL (SELECT pr.id, pr.name FROM opportunity_product op JOIN product pr ON pr.id = op.product_id WHERE op.opportunity_id = o.id ORDER BY pr.id LIMIT 1) p ON TRUE
       WHERE o.stage = 'won' ORDER BY o.id`
    );
    for (const [i, d] of wonDeals.entries()) {
      const inMonths = int(5, 200);
      await q(
        `INSERT INTO installed_instrument (company_id, product_id, description, serial_number, opportunity_id, salesperson_id, installed_on, warranty_end_date, amc_end_date, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [d.company_id, d.product_id, d.product_name, `SN${70000 + i * 137}`, d.id, d.owner_salesperson_id, new Date(d.closed_at.getTime() + IST_OFFSET).toISOString().slice(0, 10), istDate(-inMonths), i % 2 ? istDate(-int(10, 120)) : null, admin.id]
      );
    }

    // Repeat consumables for some of the customers who bought from us.
    const reorderProducts = await q(`SELECT p.id, p.name FROM product p WHERE p.is_active AND (p.category ILIKE '%consumable%' OR p.category ILIKE '%chromatograph%') ORDER BY p.id`);
    for (const [i, d] of wonDeals.slice(0, 8).entries()) {
      const product = reorderProducts[i % Math.max(1, reorderProducts.length)];
      const interval = pick([30, 45, 60, 90]);
      const lastOrder = int(5, interval + 10);
      await q(
        `INSERT INTO reorder_plan (company_id, product_id, item, salesperson_id, interval_days, last_order_date, next_due_date, typical_value, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [d.company_id, product?.id ?? null, product?.name ?? 'Reagents and solvents', d.owner_salesperson_id, interval, istDate(lastOrder), istDate(lastOrder - interval), int(2, 12) * 10000, admin.id]
      );
    }

    // One customer with a second plant, to show parent and branch companies.
    await q(`UPDATE company SET parent_company_id = (SELECT id FROM company WHERE name = 'Medak Pharma Labs') WHERE name = 'Pearl City Pharma'`);

    await q(
      `INSERT INTO audit_log (actor_user_id, action, entity_type, summary) VALUES ($1, 'demo.loaded', 'system', $2)`,
      [admin.id, `Loaded demo data: ${counts.companies} companies, ${counts.visits} visits, ${counts.deals} deals`]
    );
    await client.query('COMMIT');
    console.log('Demo data loaded:');
    for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(13)} ${v}`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
