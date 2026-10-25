import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { pool, withTransaction } from '../db/pool.js';
import { signToken, requireAuth } from '../middleware/auth.js';
import {
  validate,
  registerSchema,
  loginSchema,
  updateMeSchema,
  changePasswordSchema,
  verifyEmailSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from '../utils/validation.js';
import { generateToken, hashToken } from '../utils/tokens.js';
import { httpError, background } from '../utils/http.js';
import { config } from '../config.js';

const USER_COLUMNS = 'id, email, full_name, phone, role, bio, email_verified, is_demo, created_at';

// Compared against when an email is unknown, so response time does not reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

// Auth endpoints are brute-force targets, so they get a stricter limit than the rest of the API.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.env === 'test' ? 100000 : 20, // relaxed only under tests, which share one IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in a few minutes.' },
});

const resendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: config.env === 'test' ? 100000 : 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `resend:${req.user?.id}`,
  message: { error: 'You have asked for too many emails. Try again in an hour.' },
});

export function authRoutes({ mailer }) {
  const router = Router();

  async function issueVerificationToken(db, userId) {
    const raw = generateToken();
    await db.query('DELETE FROM email_verification_tokens WHERE user_id = $1', [userId]);
    await db.query(
      `INSERT INTO email_verification_tokens (token, user_id, expires_at)
       VALUES ($1, $2, now() + interval '24 hours')`,
      [hashToken(raw), userId]
    );
    return raw;
  }

  router.post('/register', authLimiter, validate(registerSchema), async (req, res) => {
    const { email, password, fullName, phone, role } = req.body;
    const passwordHash = await bcrypt.hash(password, 12);

    const { user, verifyToken } = await withTransaction(async (db) => {
      const existing = await db.query('SELECT 1 FROM users WHERE lower(email) = $1', [email]);
      if (existing.rowCount > 0) throw httpError(409, 'An account with that email already exists');

      const inserted = await db.query(
        `INSERT INTO users (email, password_hash, full_name, phone, role)
         VALUES ($1, $2, $3, $4, $5) RETURNING ${USER_COLUMNS}`,
        [email, passwordHash, fullName, phone, role]
      );
      const created = inserted.rows[0];
      if (role === 'tutor' || role === 'both') {
        await db.query('INSERT INTO tutor_profiles (user_id) VALUES ($1)', [created.id]);
      }
      return { user: created, verifyToken: await issueVerificationToken(db, created.id) };
    });

    background(mailer.sendVerificationEmail(user.email, verifyToken), 'verification email');
    res.status(201).json({ token: signToken({ id: user.id, token_version: 0 }), user });
  });

  router.post('/login', authLimiter, validate(loginSchema), async (req, res) => {
    const { email, password } = req.body;
    const { rows } = await pool.query(
      `SELECT ${USER_COLUMNS}, password_hash, token_version FROM users WHERE lower(email) = $1`,
      [email]
    );
    const found = rows[0];

    const valid = await bcrypt.compare(password, found ? found.password_hash : DUMMY_HASH);
    if (!found || !valid) throw httpError(401, 'Invalid email or password');

    const { password_hash: _hash, token_version, ...user } = found;
    res.json({ token: signToken({ id: user.id, token_version }), user });
  });

  router.get('/me', requireAuth, async (req, res) => {
    const { rows } = await pool.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [req.user.id]);
    res.json({ user: rows[0] });
  });

  router.put('/me', requireAuth, validate(updateMeSchema), async (req, res) => {
    const { fullName, phone, bio } = req.body;
    const { rows } = await pool.query(
      `UPDATE users SET
         full_name = COALESCE($1, full_name),
         phone     = COALESCE($2, phone),
         bio       = COALESCE($3, bio)
       WHERE id = $4 RETURNING ${USER_COLUMNS}`,
      [fullName ?? null, phone ?? null, bio ?? null, req.user.id]
    );
    res.json({ user: rows[0] });
  });

  router.post('/change-password', authLimiter, requireAuth, validate(changePasswordSchema), async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!(await bcrypt.compare(currentPassword, rows[0].password_hash))) {
      throw httpError(400, 'Your current password is not correct');
    }
    const hash = await bcrypt.hash(newPassword, 12);
    const updated = await pool.query(
      `UPDATE users SET password_hash = $1, password_changed_at = now(), token_version = token_version + 1
       WHERE id = $2 RETURNING id, token_version`,
      [hash, req.user.id]
    );
    // Every older token stops working, so hand back a fresh one.
    res.json({ ok: true, token: signToken(updated.rows[0]) });
  });

  router.post('/verify-email', validate(verifyEmailSchema), async (req, res) => {
    const { rows } = await pool.query(
      'SELECT user_id FROM email_verification_tokens WHERE token = $1 AND expires_at > now()',
      [hashToken(req.body.token)]
    );
    if (rows.length === 0) throw httpError(400, 'That verification link is invalid or has expired');

    await withTransaction(async (db) => {
      await db.query('UPDATE users SET email_verified = true WHERE id = $1', [rows[0].user_id]);
      await db.query('DELETE FROM email_verification_tokens WHERE user_id = $1', [rows[0].user_id]);
    });
    res.json({ ok: true });
  });

  router.post('/resend-verification', requireAuth, resendLimiter, async (req, res) => {
    if (req.user.emailVerified) return res.json({ ok: true, alreadyVerified: true });
    const raw = await issueVerificationToken(pool, req.user.id);
    background(mailer.sendVerificationEmail(req.user.email, raw), 'verification email');
    res.json({ ok: true });
  });

  router.post('/forgot-password', authLimiter, validate(forgotPasswordSchema), async (req, res) => {
    const { rows } = await pool.query('SELECT id, email FROM users WHERE lower(email) = $1', [req.body.email]);
    // Same answer whether or not the email exists, so this cannot be used to look up accounts.
    if (rows.length > 0) {
      const raw = generateToken();
      await pool.query(
        `INSERT INTO password_reset_tokens (token, user_id, expires_at)
         VALUES ($1, $2, now() + interval '1 hour')`,
        [hashToken(raw), rows[0].id]
      );
      background(mailer.sendPasswordResetEmail(rows[0].email, raw), 'reset email');
    }
    res.json({ ok: true, message: 'If that email has an account, a reset link is on its way.' });
  });

  router.post('/reset-password', authLimiter, validate(resetPasswordSchema), async (req, res) => {
    const { token, newPassword } = req.body;
    const hash = await bcrypt.hash(newPassword, 12);

    await withTransaction(async (db) => {
      // Claim the token atomically so it can only ever be used once.
      const claimed = await db.query(
        `UPDATE password_reset_tokens SET used = true
         WHERE token = $1 AND used = false AND expires_at > now() RETURNING user_id`,
        [hashToken(token)]
      );
      if (claimed.rowCount === 0) throw httpError(400, 'That reset link is invalid or has expired');

      await db.query(
        'UPDATE users SET password_hash = $1, password_changed_at = now(), token_version = token_version + 1 WHERE id = $2',
        [hash, claimed.rows[0].user_id]
      );
      await db.query('UPDATE password_reset_tokens SET used = true WHERE user_id = $1', [claimed.rows[0].user_id]);
    });
    res.json({ ok: true });
  });

  return router;
}
