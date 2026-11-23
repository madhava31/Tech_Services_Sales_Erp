import { sslConfig } from './ssl.js';

// Connection pool settings. Kept apart from index.js so they can be checked without opening a pool.
export function poolOptions(env = process.env, connectionString = env.DATABASE_URL) {
  const max = Number(env.DATABASE_POOL_MAX);
  const serverless = Boolean(env.VERCEL);
  return {
    connectionString,
    ssl: sslConfig(connectionString),
    max: Number.isInteger(max) && max > 0 ? max : serverless ? 1 : 10,
    connectionTimeoutMillis: 8_000,
    idleTimeoutMillis: serverless ? 1_000 : 10_000,
    keepAlive: false,
  };
}
