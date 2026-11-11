import ExcelJS from 'exceljs';
import db from '../db/index.js';
import { HttpError } from './access.js';
import { phoneTakenMessage, addContactPerson } from './contacts.js';
import { parseCsvRecords } from './csv.js';
import { assertCompanyAcceptsDeals, insertOpportunity, parseDealFields } from './deals.js';
import { normalizeCompanyName, phoneKey } from './normalize.js';
import { OPEN_STAGES } from './pipeline.js';

// Bulk import for going live: companies, then contacts, then open deals. The same validation runs for
// the preview and again for the import, so what was previewed is what happens. Rows with an error are
// skipped and reported; rows already in the system are skipped, so a file can safely be loaded twice.

export const MAX_ROWS = 5000;

// Accepted column headings, compared after lower-casing and dropping punctuation.
export const COLUMNS = {
  companies: {
    name: ['company', 'company name', 'customer', 'customer name', 'name'],
    city: ['city'],
    state: ['state'],
    address: ['address'],
    pincode: ['pin code', 'pincode', 'pin', 'postal code'],
    phone: ['phone', 'company phone', 'telephone'],
    email: ['email', 'company email'],
    contact_person: ['contact person', 'contact'],
    category: ['category', 'industry'],
    gstin: ['gstin', 'gst', 'gst no', 'gst number'],
    parent: ['parent company', 'branch of', 'parent'],
  },
  contacts: {
    company: ['company', 'company name', 'customer', 'customer name'],
    name: ['contact', 'contact name', 'name'],
    designation: ['designation', 'title'],
    department: ['department', 'dept'],
    phone: ['phone', 'mobile', 'contact number', 'customer number', 'phone number'],
    email: ['email'],
  },
  deals: {
    company: ['company', 'company name', 'customer', 'customer name'],
    title: ['opportunity', 'opportunity name', 'deal', 'deal name', 'title'],
    salesperson: ['salesperson', 'sales person', 'owner', 'sales engineer', 'employee code'],
    oem: ['oem', 'make'],
    products: ['products', 'product', 'part number', 'part numbers'],
    closing: ['expected closing date', 'closing date', 'expected close', 'expected close date'],
    value: ['order value inr', 'order value', 'value', 'amount'],
    probability: ['win probability', 'win probability %', 'probability'],
    probability_reason: ['probability reason'],
    tender: ['tender'],
    segments: ['market segment', 'market segments', 'segment', 'segments'],
    stage: ['stage'],
    contact_phone: ['phone', 'contact phone', 'customer number'],
    contact_name: ['contact', 'contact name'],
    comments: ['comments', 'notes'],
    quotation_number: ['quotation number', 'quotation no', 'quotation'],
  },
};

const REQUIRED = {
  companies: ['name'],
  contacts: ['company', 'name'],
  deals: ['company', 'title', 'salesperson', 'oem', 'products', 'closing', 'value'],
};

export const TEMPLATES = {
  companies: {
    headers: ['Company', 'City', 'State', 'Address', 'Pin code', 'Phone', 'Email', 'Contact person', 'Category', 'GSTIN', 'Parent company'],
    example: ['Example Labs Pvt Ltd', 'Hyderabad', 'Telangana', 'Plot 1, Example Road', '04000000000', 'info@example.com', 'Dr. Example', 'Pharma', '', ''],
  },
  contacts: {
    headers: ['Company', 'Contact', 'Designation', 'Department', 'Phone', 'Email'],
    example: ['Example Labs Pvt Ltd', 'Dr. Example', 'QC Head', '9000000000', 'qc@example.com'],
  },
  deals: {
    headers: ['Company', 'Opportunity', 'Salesperson', 'OEM', 'Products', 'Expected closing date', 'Order value (INR)', 'Win probability', 'Probability reason', 'Tender', 'Market segment', 'Stage', 'Phone', 'Contact', 'Comments', 'Quotation number'],
    example: ['Example Labs Pvt Ltd', 'Example instrument', 'SE-001', 'PerkinElmer', 'Part number or product name; separate several with ;', '31/03/2027', '500000', '50', 'Budget confirmed', 'No', 'Pharma', 'Qualified', '9000000000', 'Dr. Example', '', ''],
  },
};

const STAGE_NAMES = {
  'new prospect': 'new_prospect',
  visited: 'visit_completed',
  'visit completed': 'visit_completed',
  qualified: 'qualified',
  'quote requested': 'quotation_requested',
  'quotation requested': 'quotation_requested',
  'quote sent': 'quotation_sent',
  'quotation sent': 'quotation_sent',
  negotiation: 'negotiation',
};

const headerKey = (h) => String(h ?? '').toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim();
const nameKey = (s) => String(s ?? '').trim().toLowerCase();

function cellText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((r) => r.text).join('').trim();
    if (value.text !== undefined) return cellText(value.text);
    if (value.result !== undefined) return cellText(value.result);
    return '';
  }
  return String(value).trim();
}

// Reads the first sheet of an .xlsx, or a .csv, into { headers, rows: [{ row, values }] }.
export async function readTable(buffer) {
  let records;
  if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(buffer);
    } catch {
      throw new HttpError(400, 'That Excel file could not be read. Save it as .xlsx or .csv and try again.');
    }
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new HttpError(400, 'That Excel file has no sheets.');
    records = [];
    sheet.eachRow({ includeEmpty: true }, (row, number) => {
      const cells = [];
      for (let i = 1; i <= sheet.columnCount; i++) cells.push(cellText(row.getCell(i).value));
      records[number - 1] = cells;
    });
    for (let i = 0; i < records.length; i++) records[i] = records[i] ?? [];
  } else {
    records = parseCsvRecords(buffer.toString('utf-8')).map((r) => r.map((c) => c.trim()));
  }
  const headerIndex = records.findIndex((r) => r.some((c) => c));
  if (headerIndex < 0) throw new HttpError(400, 'The file is empty.');
  const headers = records[headerIndex].map(headerKey);
  const rows = [];
  for (let i = headerIndex + 1; i < records.length; i++) {
    if (records[i].some((c) => c)) rows.push({ row: i + 1, cells: records[i] });
  }
  if (rows.length > MAX_ROWS) throw new HttpError(400, `The file has ${rows.length} rows. Import at most ${MAX_ROWS} at a time.`);
  return { headers, rows };
}

function mapColumns(kind, headers) {
  const map = {};
  for (const [field, aliases] of Object.entries(COLUMNS[kind])) {
    const index = headers.findIndex((h) => aliases.includes(h));
    if (index >= 0) map[field] = index;
  }
  const missing = REQUIRED[kind].filter((f) => map[f] === undefined);
  if (missing.length) {
    const wanted = missing.map((f) => `"${COLUMNS[kind][f][0]}"`).join(', ');
    throw new HttpError(400, `The file has no ${wanted} column. Download the template to see the headings.`);
  }
  return map;
}

const IST_MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// Indian order for typed dates: 31/03/2027, 31-03-2027, 31-Mar-2027, plus 2027-03-31.
export function parseImportDate(text) {
  const value = text.trim();
  let year;
  let month;
  let day;
  let m;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value))) [year, month, day] = [+m[1], +m[2], +m[3]];
  else if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(value))) [day, month, year] = [+m[1], +m[2], +m[3]];
  else if ((m = /^(\d{1,2})[ -]([a-z]{3})[a-z]*[ -](\d{4})$/i.exec(value))) [day, month, year] = [+m[1], IST_MONTHS[m[2].toLowerCase()], +m[3]];
  else return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (!month || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

export function parseImportMoney(text) {
  const n = Number(text.replace(/[₹,\s]/g, '').replace(/^rs\.?/i, ''));
  return Number.isFinite(n) ? n : null;
}

function parseProbability(text) {
  if (!text) return undefined;
  let n = Number(text.replace('%', '').trim());
  // A cell formatted as a percentage arrives as 0.5.
  if (n > 0 && n <= 1) n *= 100;
  return n;
}

function parseYesNo(text) {
  const value = nameKey(text);
  if (!value || ['no', 'n', 'false', '0'].includes(value)) return false;
  if (['yes', 'y', 'true', '1'].includes(value)) return true;
  return null;
}

function splitList(text) {
  return text.split(/[;|\n]/).map((s) => s.trim()).filter(Boolean);
}

// ---------- companies ----------

async function checkCompanies(rows, map) {
  const existing = await db.prepare(`SELECT id, name, normalized_name, parent_company_id, city, phone FROM company WHERE archived_at IS NULL AND approval_status <> 'rejected'`).all();
  const topLevel = new Map(existing.filter((c) => !c.parent_company_id).map((c) => [c.normalized_name, c]));
  const branchKey = (parent, normalized, city) => `${parent}|${normalized}|${nameKey(city)}`;
  const branches = new Set(existing.filter((c) => c.parent_company_id).map((c) => branchKey(c.parent_company_id, c.normalized_name, c.city)));
  const phones = new Map(existing.filter((c) => c.phone).map((c) => [phoneKey(c.phone), c.name]));
  const inFile = new Map();
  const { findDuplicates } = await import('../routes/companies.js');
  // Categories come from the market segment list; anything else is left empty with a warning.
  const segments = await db.prepare(`SELECT name FROM market_segment WHERE is_active ORDER BY sort_order, name`).all();
  const listed = new Map(segments.map((s) => [s.name.toLowerCase(), s.name]));

  const results = [];
  for (const { row, cells } of rows) {
    const get = (f) => (map[f] === undefined ? '' : cells[map[f]] ?? '');
    const result = { row, label: get('name'), status: 'new', errors: [], warnings: [] };
    results.push(result);
    const name = get('name');
    if (!name) {
      result.errors.push('Company name is empty.');
      continue;
    }
    const normalized = normalizeCompanyName(name);
    const email = get('email');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) result.errors.push(`"${email}" is not a valid email.`);
    const parentName = get('parent');
    const pincode = String(get('pincode')).replace(/\s/g, '');
    if (pincode && !/^[0-9]{6}$/.test(pincode)) result.errors.push(`Pin code "${get('pincode')}" must be 6 digits.`);
    const rawCategory = String(get('category')).trim();
    const category = rawCategory ? listed.get(rawCategory.toLowerCase()) ?? null : null;
    if (rawCategory && !category) result.warnings.push(`"${rawCategory}" isn't on the category list (${segments.map((s) => s.name).join(', ')}), so it's left empty.`);
    let parentRef = null;
    if (parentName) {
      const parentKey = normalizeCompanyName(parentName);
      const parent = topLevel.get(parentKey);
      if (parent) parentRef = { id: parent.id };
      else if (inFile.has(parentKey)) parentRef = { key: parentKey };
      else result.errors.push(`The parent company "${parentName}" was not found. Put it earlier in the file or import it first.`);
    }
    result.data = {
      name,
      normalized,
      city: get('city') || null,
      state: get('state') || null,
      address: get('address') || null,
      phone: get('phone') || null,
      email: email || null,
      contact_person: get('contact_person') || null,
      category,
      pincode: pincode || null,
      gstin: get('gstin') ? get('gstin').toUpperCase() : null,
      parentRef,
    };
    const fileKey = parentRef ? `${parentRef.id ?? parentRef.key}|${normalized}|${nameKey(get('city'))}` : normalized;
    if (parentRef ? parentRef.id && branches.has(branchKey(parentRef.id, normalized, get('city'))) : topLevel.has(normalized)) {
      result.status = 'skip';
      result.warnings.push('Already registered, so this row will be skipped.');
      continue;
    }
    if (inFile.has(fileKey)) {
      result.status = 'skip';
      result.warnings.push(`Same company as row ${inFile.get(fileKey)} of this file, so this row will be skipped.`);
      continue;
    }
    if (result.errors.length === 0) {
      inFile.set(fileKey, row);
      if (!parentRef) inFile.set(normalized, row);
    }
    const similar = (await findDuplicates({ name, phone: null })).find((d) => d.score >= 0.6);
    if (similar) result.warnings.push(`Similar to "${similar.name}" already registered. Check it isn't the same company.`);
    const key = phoneKey(get('phone'));
    if (key && phones.has(key)) result.warnings.push(`Same phone number as "${phones.get(key)}".`);
  }
  return results;
}

async function importCompanies(results, userId) {
  const created = new Map();
  const ids = [];
  for (const r of results) {
    const d = r.data;
    const parentId = d.parentRef ? d.parentRef.id ?? created.get(d.parentRef.key) : null;
    const info = await db
      .prepare(
        `INSERT INTO company (name, normalized_name, city, state, address, pincode, phone, email, contact_person, gstin, category, parent_company_id, approval_status, approved_by, approved_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, NOW(), ?) RETURNING id`
      )
      .run(d.name, d.normalized, d.city, d.state, d.address, d.pincode, d.phone, d.email, d.contact_person, d.gstin, d.category, parentId, userId, userId);
    await addContactPerson({ companyId: info.lastInsertRowid, name: d.contact_person, userId });
    if (!parentId) created.set(d.normalized, info.lastInsertRowid);
    ids.push(info.lastInsertRowid);
  }
  return ids;
}

// ---------- contacts ----------

async function companyLookup() {
  const rows = await db.prepare(`SELECT id, name, normalized_name, parent_company_id, approval_status FROM company WHERE archived_at IS NULL AND approval_status <> 'rejected'`).all();
  const map = new Map();
  // A top-level company wins; a branch is reachable by name only when that name is unambiguous.
  for (const c of rows.filter((x) => x.parent_company_id)) map.set(c.normalized_name, map.has(c.normalized_name) ? null : c);
  for (const c of rows.filter((x) => !x.parent_company_id)) map.set(c.normalized_name, c);
  return (name) => map.get(normalizeCompanyName(name));
}

async function checkContacts(rows, map) {
  const findCompany = await companyLookup();
  const existing = await db
    .prepare(`SELECT cc.id, cc.name, cc.phone, cc.company_id, c.name AS company_name FROM company_contact cc JOIN company c ON c.id = cc.company_id WHERE cc.archived_at IS NULL`)
    .all();
  const byPhone = new Map(existing.filter((c) => phoneKey(c.phone)).map((c) => [phoneKey(c.phone), c]));
  const byName = new Set(existing.map((c) => `${c.company_id}|${nameKey(c.name)}`));

  return rows.map(({ row, cells }) => {
    const get = (f) => (map[f] === undefined ? '' : cells[map[f]] ?? '');
    const result = { row, label: `${get('name')} (${get('company')})`, status: 'new', errors: [], warnings: [] };
    if (!get('name')) result.errors.push('Contact name is empty.');
    if (!get('company')) result.errors.push('Company is empty.');
    if (result.errors.length) return result;
    const company = findCompany(get('company'));
    if (!company) {
      result.errors.push(`The company "${get('company')}" was not found. Import companies first.`);
      return result;
    }
    const email = get('email');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) result.errors.push(`"${email}" is not a valid email.`);
    const phone = get('phone');
    const key = phoneKey(phone);
    const owner = key ? byPhone.get(key) : null;
    if (owner) {
      if (owner.company_id === company.id) {
        result.status = 'skip';
        result.warnings.push(`${phone} is already ${owner.name} at this company, so this row will be skipped.`);
      } else result.errors.push(phoneTakenMessage(owner, phone));
      return result;
    }
    if (byName.has(`${company.id}|${nameKey(get('name'))}`) && !key) {
      result.status = 'skip';
      result.warnings.push('This contact is already on this company, so this row will be skipped.');
      return result;
    }
    if (result.errors.length) return result;
    result.data = { company_id: company.id, name: get('name'), designation: get('designation') || null, department: get('department') || null, phone: phone || null, email: email || null };
    if (key) byPhone.set(key, { name: get('name'), company_id: company.id, company_name: company.name });
    byName.add(`${company.id}|${nameKey(get('name'))}`);
    return result;
  });
}

async function importContacts(results, userId) {
  const ids = [];
  for (const { data: d } of results) {
    const info = await db
      .prepare(`INSERT INTO company_contact (company_id, name, designation, department, phone, email, created_by) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`)
      .run(d.company_id, d.name, d.designation, d.department, d.phone, d.email, userId);
    ids.push(info.lastInsertRowid);
  }
  return ids;
}

// ---------- deals ----------

async function checkDeals(rows, map) {
  const findCompany = await companyLookup();
  const people = await db.prepare(`SELECT id, name, employee_code, is_active FROM salesperson`).all();
  const personByKey = new Map();
  for (const p of people) {
    personByKey.set(nameKey(p.employee_code), p);
    personByKey.set(nameKey(p.name), p);
  }
  const oems = new Map((await db.prepare(`SELECT id, name FROM oem WHERE is_active`).all()).map((o) => [nameKey(o.name), o]));
  const segments = new Map((await db.prepare(`SELECT id, name FROM market_segment WHERE is_active`).all()).map((s) => [nameKey(s.name), s]));
  // Files made before the list was renamed still use the old names.
  for (const [old, current] of [['R&A', 'Research & Analytics'], ['Applied (non-pharma)', 'Non-pharma'], ['Food (R&A, not R&D)', 'Food']]) {
    if (!segments.has(nameKey(old)) && segments.has(nameKey(current))) segments.set(nameKey(old), segments.get(nameKey(current)));
  }
  const products = await db.prepare(`SELECT id, part_number, name, oem_id FROM product WHERE is_active`).all();
  const contacts = await db
    .prepare(`SELECT cc.id, cc.name, cc.phone, cc.company_id, c.name AS company_name FROM company_contact cc JOIN company c ON c.id = cc.company_id WHERE cc.archived_at IS NULL AND cc.phone IS NOT NULL`)
    .all();
  const contactByPhone = new Map(contacts.filter((c) => phoneKey(c.phone)).map((c) => [phoneKey(c.phone), c]));
  const openDeals = await db.prepare(`SELECT company_id, title FROM opportunity WHERE stage NOT IN ('won', 'lost', 'abandoned')`).all();
  const dealKeys = new Set(openDeals.map((d) => `${d.company_id}|${nameKey(d.title)}`));

  const results = [];
  for (const { row, cells } of rows) {
    const get = (f) => (map[f] === undefined ? '' : cells[map[f]] ?? '');
    const result = { row, label: `${get('title')} (${get('company')})`, status: 'new', errors: [], warnings: [] };
    results.push(result);

    const company = get('company') ? findCompany(get('company')) : null;
    if (!company) result.errors.push(get('company') ? `The company "${get('company')}" was not found. Import companies first.` : 'Company is empty.');
    else if (company.approval_status !== 'approved') result.errors.push(`${company.name} is not approved yet.`);

    if (company && dealKeys.has(`${company.id}|${nameKey(get('title'))}`)) {
      result.status = 'skip';
      result.warnings.push('This open opportunity already exists on this company, so this row will be skipped.');
      continue;
    }

    const person = personByKey.get(nameKey(get('salesperson')));
    if (!person) result.errors.push(`The salesperson "${get('salesperson')}" was not found. Use their employee code or full name.`);
    else if (!person.is_active) result.errors.push(`${person.name} has left. Choose an active salesperson.`);

    const oem = oems.get(nameKey(get('oem')));
    if (!oem) result.errors.push(`The OEM "${get('oem')}" was not found.`);

    const productIds = [];
    if (oem) {
      for (const item of splitList(get('products'))) {
        const match = products.find((p) => p.oem_id === oem.id && (nameKey(p.part_number) === nameKey(item) || nameKey(p.name) === nameKey(item)));
        if (match) productIds.push(match.id);
        else result.errors.push(`"${item}" is not an active ${oem.name} product. Use its part number or exact name.`);
      }
      if (splitList(get('products')).length === 0) result.errors.push('Products is empty.');
    }

    const segmentIds = [];
    for (const item of splitList(get('segments'))) {
      const match = segments.get(nameKey(item));
      if (match) segmentIds.push(match.id);
      else result.errors.push(`The market segment "${item}" was not found.`);
    }

    const closeDate = parseImportDate(get('closing'));
    if (!closeDate) result.errors.push(`"${get('closing')}" is not a date. Use day/month/year, such as 31/03/2027.`);
    const value = parseImportMoney(get('value'));
    if (!value || value <= 0) result.errors.push(`"${get('value')}" is not an order value.`);
    const tender = parseYesNo(get('tender'));
    if (tender === null) result.errors.push(`Tender must be Yes or No, not "${get('tender')}".`);

    let stage = 'new_prospect';
    if (get('stage')) {
      stage = STAGE_NAMES[nameKey(get('stage'))] ?? get('stage');
      if (!OPEN_STAGES.includes(stage)) result.errors.push(`"${get('stage')}" is not an open stage. Import only open opportunities.`);
    }
    const quotation = get('quotation_number');
    if (['quotation_sent', 'negotiation'].includes(stage) && !quotation) result.errors.push('An opportunity at this stage needs its quotation number.');

    let contactId = null;
    let newContact;
    const phone = get('contact_phone');
    const key = phoneKey(phone);
    if (key && company) {
      const owner = contactByPhone.get(key);
      if (owner && owner.company_id !== company.id) result.errors.push(phoneTakenMessage(owner, phone));
      else if (owner) contactId = owner.id;
      else if (get('contact_name')) newContact = { phone, name: get('contact_name') };
      else result.warnings.push(`No contact has the number ${phone} and the row has no contact name, so no contact will be linked.`);
    }

    if (company && oem && productIds.length && closeDate && value > 0 && result.errors.length === 0) {
      try {
        const fields = await parseDealFields(
          {
            title: get('title'),
            estimated_value: value,
            expected_close_date: closeDate,
            probability: parseProbability(get('probability')),
            probability_reason: get('probability_reason'),
            tender,
            notes: get('comments'),
            oem_id: oem.id,
            product_ids: productIds,
            segment_ids: segmentIds,
            contact_id: contactId,
            new_contact: newContact,
          },
          { companyId: company.id }
        );
        result.data = { company_id: company.id, company_name: company.name, owner_id: person.id, stage, fields, quotation };
        dealKeys.add(`${company.id}|${nameKey(get('title'))}`);
        if (newContact) contactByPhone.set(key, { id: null, name: newContact.name, company_id: company.id, company_name: company.name });
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        result.errors.push(err.message);
      }
    }
  }
  return results;
}

async function importDeals(results, userId) {
  const ids = [];
  for (const { data: d } of results) {
    await assertCompanyAcceptsDeals(d.company_id);
    const id = await insertOpportunity({ companyId: d.company_id, companyName: d.company_name, ownerId: d.owner_id, stage: d.stage, fields: d.fields, userId });
    if (d.quotation) {
      await db.prepare(`INSERT INTO quotation_link (opportunity_id, quotation_number, status, created_by) VALUES (?, ?, 'sent', ?)`).run(id, d.quotation, userId);
    }
    ids.push(id);
  }
  return ids;
}

const KINDS = {
  companies: { check: checkCompanies, run: importCompanies },
  contacts: { check: checkContacts, run: importContacts },
  deals: { check: checkDeals, run: importDeals },
};

export function isImportKind(kind) {
  return Object.hasOwn(KINDS, kind);
}

// Checks every row. Rows with errors become status 'error', so they are never imported.
export async function checkFile(kind, buffer) {
  const { headers, rows } = await readTable(buffer);
  const map = mapColumns(kind, headers);
  const results = await KINDS[kind].check(rows, map);
  for (const r of results) if (r.errors.length) r.status = 'error';
  return results;
}

export function summarize(results) {
  const count = (status) => results.filter((r) => r.status === status).length;
  return { total: results.length, new: count('new'), skip: count('skip'), error: count('error'), warnings: results.filter((r) => r.status === 'new' && r.warnings.length).length };
}

export function runImport(kind, results, userId) {
  return KINDS[kind].run(results.filter((r) => r.status === 'new'), userId);
}
