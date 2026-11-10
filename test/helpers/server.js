// Boots the real Express app (api/app.js) on a random port against the test database.
import { resetTestDatabase } from './testDb.js';

export async function startTestServer() {
  const url = await resetTestDatabase();
  // db/index.js reads DATABASE_URL at import time, so it must be set before the app is imported.
  process.env.DATABASE_URL = url;
  process.env.NODE_ENV = 'test';
  const app = (await import('../../server/app.js')).default;
  const db = (await import('../../server/db/index.js')).default;

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  return {
    baseUrl,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await db.pool.end();
    },
  };
}

// Minimal cookie-aware JSON client for exercising session auth.
export function createClient(baseUrl) {
  let cookie = '';
  return {
    cookie: () => cookie,
    // For downloads: the raw bytes rather than parsed JSON.
    async requestRaw(method, path) {
      const res = await fetch(baseUrl + path, { method, headers: cookie ? { Cookie: cookie } : {} });
      return { status: res.status, headers: res.headers, buffer: Buffer.from(await res.arrayBuffer()) };
    },
    async request(method, path, body, headers = {}) {
      const res = await fetch(baseUrl + path, {
        method,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: res.status, headers: res.headers, body: json };
    },
  };
}
