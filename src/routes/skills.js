import { Router } from 'express';
import { pool } from '../db/pool.js';

const router = Router();

router.get('/', async (_req, res) => {
  const { rows } = await pool.query('SELECT id, name, category FROM skills ORDER BY category, name');
  res.json({ skills: rows });
});

export default router;
