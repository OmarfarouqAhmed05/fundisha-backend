import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { pool } from '../db/pool.js';
import { signToken, requireAuth } from '../middleware/auth.js';
import { validate, registerSchema, loginSchema } from '../utils/validation.js';

const router = Router();

// Auth endpoints are brute-force targets — throttle harder than the rest of the API.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in a few minutes.' },
});

router.post('/register', authLimiter, validate(registerSchema), async (req, res) => {
  const { email, password, fullName, role } = req.body;

  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length > 0) {
    return res.status(409).json({ error: 'An account with that email already exists' });
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const result = await pool.query(
    `INSERT INTO users (email, password_hash, full_name, role)
     VALUES ($1, $2, $3, $4)
     RETURNING id, email, full_name, role, created_at`,
    [email, passwordHash, fullName, role]
  );
  const user = result.rows[0];

  if (role === 'tutor' || role === 'both') {
    await pool.query('INSERT INTO tutor_profiles (user_id) VALUES ($1)', [user.id]);
  }

  const token = signToken({ id: user.id, email: user.email, role: user.role });
  res.status(201).json({ token, user });
});

router.post('/login', authLimiter, validate(loginSchema), async (req, res) => {
  const { email, password } = req.body;

  const result = await pool.query(
    'SELECT id, email, password_hash, full_name, role FROM users WHERE email = $1',
    [email]
  );
  const user = result.rows[0];

  // Same generic error whether the email doesn't exist or the password is
  // wrong — don't leak which one it was.
  if (!user) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const token = signToken({ id: user.id, email: user.email, role: user.role });
  delete user.password_hash;
  res.json({ token, user });
});

router.get('/me', requireAuth, async (req, res) => {
  const result = await pool.query(
    'SELECT id, email, full_name, role, bio, created_at FROM users WHERE id = $1',
    [req.user.id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
  res.json({ user: result.rows[0] });
});

export default router;
