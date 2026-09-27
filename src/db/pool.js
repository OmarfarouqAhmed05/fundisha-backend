import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Keep the pool small by default — fine for a dev/small-scale deployment;
  // raise max if you move to a bigger Postgres plan.
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  // A background/idle client failing shouldn't crash the whole process.
  console.error('Unexpected PostgreSQL pool error:', err);
});

export async function query(text, params) {
  return pool.query(text, params);
}
