import { sslConfig } from './ssl.js';

// Connection pool settings. Kept apart from index.js so they can be checked without opening a pool.
export function poolOptions(env = process.env, connectionString = env.DATABASE_URL) {
  const max = Number(env.DATABASE_POOL_MAX);
  return {
    connectionString,
    ssl: sslConfig(connectionString),
    max: Number.isInteger(max) && max > 0 ? max : 4,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 5_000,
    keepAlive: true,
  };
}
