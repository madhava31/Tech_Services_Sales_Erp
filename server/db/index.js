import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { poolOptions } from './poolOptions.js';

const { Pool } = pg;

// node-postgres parses DATE columns into JS Date objects by default, which would serialize
// as full ISO datetimes ('2026-08-12T00:00:00.000Z') instead of the plain 'YYYY-MM-DD' strings
// the frontend expects (table display, <input type="date">). Keep DATE columns as raw strings.
pg.types.setTypeParser(1082, (val) => val);

// NUMERIC (quantities, money) arrives as a string; the amounts here fit a JS number exactly.
pg.types.setTypeParser(1700, (val) => Number(val));

let _pool = null;

export function getPool() {
  if (!_pool) {
    const connStr = process.env.DATABASE_URL || process.env.DATABASE_URL1 || process.env.POSTGRES_URL;
    if (!connStr) {
      throw new Error("DATABASE_URL is not set. Copy .env.example to .env and point it at this app's own Postgres database.");
    }
    _pool = new Pool(poolOptions(process.env, connStr));
    // pg-pool emits 'error' when an *idle* pooled connection dies (database restarted, network drop).
    // With no listener Node would crash the whole server; this lets the pool discard it and reconnect.
    _pool.on('error', (err) => {
      console.error('Postgres pool error (idle client):', err.message);
    });
  }
  return _pool;
}

// Holds the active transaction client, if any, so nested helpers (e.g. numbering.js) that call
// db.prepare(...) directly automatically participate in the surrounding transaction without
// needing a `tx` parameter threaded through every function call.
const als = new AsyncLocalStorage();

function executor() {
  return als.getStore() || getPool();
}

// Queries are written with `?` placeholders (shorter, and matching the Technicon Services ERP's
// style); pg needs `$1, $2, ...`. Never put a literal `?` inside SQL text passed to prepare().
function toPgSql(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function prepare(sql) {
  const pgSql = toPgSql(sql);
  async function exec(params) {
    return executor().query(pgSql, params);
  }
  return {
    async get(...params) {
      const result = await exec(params);
      return result.rows[0];
    },
    async all(...params) {
      const result = await exec(params);
      return result.rows;
    },
    async run(...params) {
      const result = await exec(params);
      return {
        changes: result.rowCount,
        // Populated automatically when the query's SQL includes RETURNING id.
        lastInsertRowid: result.rows[0]?.id,
      };
    },
  };
}

async function transaction(fn) {
  const client = await getPool().connect();
  let broken;
  // While this request holds the connection, the pool's own 'error' listener isn't attached to it. If
  // the connection drops mid-transaction the client emits 'error', and with no listener Node would
  // crash the whole server. Record it instead: the query in flight fails and the client is discarded.
  const onError = (err) => {
    broken = err;
  };
  client.on('error', onError);
  try {
    await client.query('BEGIN');
    const result = await als.run(client, fn);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    // If the connection itself broke, ROLLBACK fails too: report the original error, and don't hand
    // the broken connection to the next request.
    if (!broken) {
      await client.query('ROLLBACK').catch((rollbackErr) => {
        broken = rollbackErr;
      });
    }
    throw err;
  } finally {
    client.off('error', onError);
    client.release(broken);
  }
}

const db = {
  prepare,
  transaction,
  get pool() {
    return getPool();
  },
};

export default db;
