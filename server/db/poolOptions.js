import { sslConfig } from './ssl.js';

// Connection pool settings. Kept apart from index.js so they can be checked without opening a pool.
export function poolOptions(env = process.env, connectionString = env.DATABASE_URL) {
  let connStr = connectionString;
  if (connStr && connStr.includes('pooler.supabase.com:5432')) {
    connStr = connStr.replace('pooler.supabase.com:5432', 'pooler.supabase.com:6543');
  }
  const max = Number(env.DATABASE_POOL_MAX);
  const serverless = Boolean(env.VERCEL);
  return {
    connectionString: connStr,
    ssl: sslConfig(connStr),
    max: Number.isInteger(max) && max > 0 ? max : serverless ? 4 : 10,
    connectionTimeoutMillis: 8_000,
    idleTimeoutMillis: serverless ? 5_000 : 10_000,
    keepAlive: true,
  };
}
