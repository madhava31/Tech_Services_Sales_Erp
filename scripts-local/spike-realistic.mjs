// 400 requests to heavy screens, as 13 browsers would send them: at most 6 at a time each (78 in flight).
import { startTestServer, createClient } from '../test/helpers/server.js';
import { signedInSalesperson } from '../test/helpers/fixtures.js';
const server = await startTestServer();
const people = [];
for (let i = 0; i < 13; i++) people.push((await signedInSalesperson(server.baseUrl, `Seller${i}`, createClient)).client);
const paths = ['/api/today', '/api/opportunities?status=open', '/api/companies', '/api/analysis/forecast', '/api/offline/bootstrap', '/api/performance'];
const times = [], fails = {};
await Promise.all(people.map(async (c, pi) => {
  let next = 0; const total = Math.ceil(400 / 13);
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < total) { const i = next++; const t = performance.now();
      try { const r = await c.request('GET', paths[(pi + i) % paths.length]); if (r.status >= 400) fails[r.status] = (fails[r.status] ?? 0) + 1; }
      catch (e) { const k = e.cause?.code ?? e.message; fails[k] = (fails[k] ?? 0) + 1; }
      times.push(performance.now() - t); }
  }));
}));
times.sort((a, b) => a - b);
console.log(`${times.length} requests, failures: ${JSON.stringify(fails)}, p50 ${Math.round(times[times.length >> 1])}ms, p95 ${Math.round(times[Math.floor(times.length * 0.95)])}ms, max ${Math.round(times.at(-1))}ms`);
await server.close();
