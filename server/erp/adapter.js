import { getProduct, listProducts } from '../crm/products.js';

// Where read-only data from the Technicon Services ERP comes from. This app's own tables answer product
// questions either way, because the sync keeps them current. The ERP's database is never connected to:
// only its read-only API, with a key that opens nothing else (docs/erp-integration/README.md).
const PAGE_SIZE = 200;
const TIMEOUT_MS = 20000;

function isLocalAddress(url) {
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

// Set up, or the reason it isn't. The key travels in a header, so anything but https is refused.
function erpConnection() {
  const address = process.env.ERP_API_URL;
  const key = process.env.ERP_API_KEY;
  if (!address || !key) return { problem: 'Not set up yet: the server needs ERP_API_URL and ERP_API_KEY.' };
  let url;
  try {
    url = new URL(address);
  } catch {
    return { problem: 'ERP_API_URL is not a valid address.' };
  }
  if (url.protocol !== 'https:' && !isLocalAddress(url)) return { problem: 'ERP_API_URL must start with https://, so the key stays private.' };
  return { base: `${url.origin}/api/integration/v1`, key };
}

// Pages through one list, one request at a time. The ERP's database has few connections, so this must
// never send requests in parallel. Errors say what happened but never repeat the key or the response.
async function fetchAll(path) {
  const { base, key, problem } = erpConnection();
  if (problem) throw new Error(problem);
  const rows = [];
  let afterId = 0;
  for (;;) {
    let res;
    try {
      res = await fetch(`${base}${path}?after_id=${afterId}&limit=${PAGE_SIZE}`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(err.name === 'TimeoutError' ? 'The ERP took too long to answer.' : 'Could not reach the ERP.');
    }
    if (res.status === 401) throw new Error('The ERP refused the key. Check ERP_API_KEY.');
    if (res.status === 404) throw new Error('The ERP has no read-only API yet, or its key isn’t set.');
    if (!res.ok) throw new Error(`The ERP answered with an error (${res.status}).`);
    const page = await res.json();
    if (!Array.isArray(page)) throw new Error('The ERP sent something unexpected.');
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
    afterId = page[page.length - 1].id;
  }
}

const liveAdapter = {
  listProducts,
  getProduct,
  name: 'erp',
  customers: () => fetchAll('/customers'),
  products: () => fetchAll('/products'),
  quotations: () => fetchAll('/quotations'),
  orders: () => fetchAll('/orders'),
};

const localAdapter = { name: 'local', listProducts, getProduct };

export function erpProblem() {
  return erpConnection().problem ?? null;
}

export function erpAdapter() {
  return erpProblem() ? localAdapter : liveAdapter;
}
