// Loads the Vercel entry point (api/index.js) as Vercel would and sends it requests, using the local test database.
import http from 'node:http';
import { resetTestDatabase } from '../test/helpers/testDb.js';
process.env.DATABASE_URL = await resetTestDatabase();
const { default: handler } = await import('../api/index.js');
const server = http.createServer(handler).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
for (const p of ['/api/health', '/api/auth/me', '/api/opportunities', '/api/nope']) {
  const r = await fetch(base + p);
  console.log(p, r.status, (await r.text()).slice(0, 90));
}
server.close();
process.exit(0);
