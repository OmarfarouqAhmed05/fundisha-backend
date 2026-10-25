import pg from 'pg';
import { attachDatabasePool } from '@vercel/functions';
import { config } from '../config.js';

// Every serverless instance keeps its own pool, so on Vercel the per-instance limit is kept small.
// Use your database provider's pooled connection string as well (see the README).
const defaultMax = process.env.VERCEL ? 5 : 10;

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
  max: Number(process.env.DB_POOL_MAX) || defaultMax,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000, // fail with an error instead of hanging if the database is unreachable
});

// Lets Vercel close idle connections before it pauses the function, so they are not leaked.
if (process.env.VERCEL) attachDatabasePool(pool);

pool.on('error', (err) => {
  // An idle client failing should not crash the whole process.
  console.error('Unexpected PostgreSQL pool error:', err);
});

export const query = (text, params) => pool.query(text, params);

// Runs fn inside a transaction. Rolls back and rethrows on any error.
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
