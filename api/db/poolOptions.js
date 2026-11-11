import { sslConfig } from './ssl.js';

// Connection pool settings. Kept apart from index.js so they can be checked without opening a pool.
export function poolOptions(env = process.env) {
  const max = Number(env.DATABASE_POOL_MAX);
  return {
    connectionString: env.DATABASE_URL,
    ssl: sslConfig(env.DATABASE_URL),
    // Connections this server process keeps open. Supabase's pooler caps the total across every
    // running copy of the app, so on serverless hosting (several copies at once) set this to 1-3.
    max: Number.isInteger(max) && max > 0 ? max : 10,
    // Without this, a request waits forever when the database can't be reached or every connection
    // is busy; with it the request fails after 10 s with an error the person can retry.
    connectionTimeoutMillis: 10_000,
    // Close spare connections after 10 s idle, so a quiet server doesn't hold the pooler's slots.
    idleTimeoutMillis: 10_000,
  };
}
