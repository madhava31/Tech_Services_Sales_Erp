// Direct-to-database fixtures, so tests can set up users and salespeople without going through
// the API under test.
import { hashPassword } from '../../server/auth/password.js';
import { query } from './testDb.js';

export const PASSWORD = 'test-password';

export async function createSalesperson(name, { active = true } = {}) {
  const [row] = await query(
    `INSERT INTO salesperson (employee_code, name, is_active) VALUES ($1, $2, $3) RETURNING id`,
    [`EMP-${name}`, name, active]
  );
  return row.id;
}

export async function createUser(username, role, { salespersonId = null, managerUserId = null } = {}) {
  const { salt, hash } = hashPassword(PASSWORD);
  const [row] = await query(
    `INSERT INTO app_user (username, password_hash, password_salt, role, salesperson_id, manager_user_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [username, hash, salt, role, salespersonId, managerUserId]
  );
  return row.id;
}

export async function createCompany(name, { city = null, createdBy, approvalStatus = 'approved' } = {}) {
  const { normalizeCompanyName } = await import('../../server/crm/normalize.js');
  const [row] = await query(
    `INSERT INTO company (name, normalized_name, city, created_by, approval_status) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [name, normalizeCompanyName(name), city, createdBy, approvalStatus]
  );
  return row.id;
}

// A product of the named OEM (seeded by migration).
export async function createProduct(partNumber, oemName = 'PerkinElmer', { active = true, category = 'Spectroscopy' } = {}) {
  const [row] = await query(
    `INSERT INTO product (part_number, name, oem_id, category, is_active)
     SELECT $1, $2, o.id, $3, $4 FROM oem o WHERE o.name = $5 RETURNING id, oem_id`,
    [partNumber, `Product ${partNumber}`, category, active, oemName]
  );
  return row;
}

// The fields every new deal must have, using a product created for the purpose.
export async function dealFieldsFor(partNumber) {
  const product = await createProduct(partNumber);
  return { oem_id: product.oem_id, product_ids: [product.id], estimated_value: 500000, expected_close_date: '2099-03-31' };
}

// A signed-in salesperson: salesperson record + linked login + cookie client.
export async function signedInSalesperson(baseUrl, name, createClient) {
  const salespersonId = await createSalesperson(name);
  const userId = await createUser(name.toLowerCase(), 'salesperson', { salespersonId });
  const client = createClient(baseUrl);
  await login(client, name.toLowerCase());
  return { client, salespersonId, userId };
}

export async function login(client, username, password = PASSWORD) {
  const res = await client.request('POST', '/api/auth/login', { username, password });
  if (res.status !== 200) throw new Error(`login ${username} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.user;
}
