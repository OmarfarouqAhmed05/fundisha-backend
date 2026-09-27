import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { pool } from '../db/pool.js';
import { signToken, requireAuth } from '../middleware/auth.js';
import {
  validate,
  registerSchema,
  loginSchema,
  verifyEmailSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from '../utils/validation.js';
import { generateToken } from '../utils/tokens.js';
import { sendVerificationEmail, sendPasswordResetEmail } from '../utils/email.js';

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
  const { email, password, fullName, phone, role } = req.body;

  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length > 0) {
    return res.status(409).json({ error: 'An account with that email already exists' });
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const result = await pool.query(
    `INSERT INTO users (email, password_hash, full_name, phone, role)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, email, full_name, phone, role, email_verified, created_at`,
    [email, passwordHash, fullName, phone, role]
  );
  const user = result.rows[0];

  if (role === 'tutor' || role === 'both') {
    await pool.query('INSERT INTO tutor_profiles (user_id) VALUES ($1)', [user.id]);
  }

  const verifyToken = generateToken();
  await pool.query(
    `INSERT INTO email_verification_tokens (token, user_id, expires_at)
     VALUES ($1, $2, now() + interval '24 hours')`,
    [verifyToken, user.id]
  );
  await sendVerificationEmail(user.email, verifyToken);

  const token = signToken({ id: user.id, email: user.email, role: user.role });
  res.status(201).json({ token, user });
});

router.post('/verify-email', validate(verifyEmailSchema), async (req, res) => {
  const { token } = req.body;

  const result = await pool.query(
    `SELECT user_id FROM email_verification_tokens WHERE token = $1 AND expires_at > now()`,
    [token]
  );
  if (result.rows.length === 0) {
    return res.status(400).json({ error: 'That verification link is invalid or has expired' });
  }

  const userId = result.rows[0].user_id;
  await pool.query('UPDATE users SET email_verified = true WHERE id = $1', [userId]);
  await pool.query('DELETE FROM email_verification_tokens WHERE user_id = $1', [userId]);

  res.json({ ok: true });
});

router.post(
  '/forgot-password',
  authLimiter,
  validate(forgotPasswordSchema),
  async (req, res) => {
    const { email } = req.body;

    const result = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    // Always return success, whether or not the email exists — this prevents
    // using this endpoint to check which emails are registered.
    if (result.rows.length > 0) {
      const userId = result.rows[0].id;
      const token = generateToken();
      await pool.query(
        `INSERT INTO password_reset_tokens (token, user_id, expires_at)
         VALUES ($1, $2, now() + interval '1 hour')`,
        [token, userId]
      );
      await sendPasswordResetEmail(email, token);
    }

    res.json({ ok: true, message: 'If that email exists, a reset link has been sent.' });
  }
);

router.post('/reset-password', authLimiter, validate(resetPasswordSchema), async (req, res) => {
  const { token, newPassword } = req.body;

  const result = await pool.query(
    `SELECT user_id FROM password_reset_tokens
     WHERE token = $1 AND expires_at > now() AND used = false`,
    [token]
  );
  if (result.rows.length === 0) {
    return res.status(400).json({ error: 'That reset link is invalid or has expired' });
  }

  const userId = result.rows[0].user_id;
  const passwordHash = await bcrypt.hash(newPassword, 12);

  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, userId]);
  await pool.query('UPDATE password_reset_tokens SET used = true WHERE token = $1', [token]);

  res.json({ ok: true });
});

router.post('/login', authLimiter, validate(loginSchema), async (req, res) => {
  const { email, password } = req.body;

  const result = await pool.query(
    'SELECT id, email, password_hash, full_name, role, email_verified FROM users WHERE email = $1',
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
    'SELECT id, email, full_name, phone, role, bio, email_verified, created_at FROM users WHERE id = $1',
    [req.user.id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
  res.json({ user: result.rows[0] });
});

export default router;
