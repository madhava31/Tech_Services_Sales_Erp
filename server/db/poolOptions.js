import { sslConfig } from './ssl.js';

// Connection pool settings. Kept apart from index.js so they can be checked without opening a pool.
export function poolOptions(env = process.env, connectionString = env.DATABASE_URL) {
  const max = Number(env.DATABASE_POOL_MAX);
  // Vercel runs many copies of the app at once, and Supabase's pooler caps the connections across all
  // of them ("max clients reached"). There each copy keeps only a couple, and lets idle ones go quickly.
  const serverless = Boolean(env.VERCEL);
  return {
    connectionString,
    ssl: sslConfig(connectionString),
    // Connections this server process keeps open. DATABASE_POOL_MAX overrides the default.
    max: Number.isInteger(max) && max > 0 ? max : serverless ? 2 : 10,
    // Without this, a request waits forever when the database can't be reached or every connection
    // is busy; with it the request fails after 10 s with an error the person can retry.
    connectionTimeoutMillis: 10_000,
    // Close spare connections when idle, so a quiet copy doesn't hold the pooler's slots.
    idleTimeoutMillis: serverless ? 2_000 : 10_000,
  };
}
