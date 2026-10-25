import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { httpError } from '../utils/http.js';

const JWT_EXPIRES_IN = '7d';

// tv = the user's token_version. Changing a password bumps it, which instantly
// invalidates every token issued before.
export function signToken(user) {
  return jwt.sign({ id: user.id, tv: user.token_version ?? 0 }, config.jwtSecret, { expiresIn: JWT_EXPIRES_IN });
}

// Verifies the token, then loads the user so role changes, deleted accounts and
// password resets take effect immediately instead of waiting for the token to expire.
export async function requireAuth(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw httpError(401, 'Please log in to continue');

  let decoded;
  try {
    decoded = jwt.verify(token, config.jwtSecret);
  } catch {
    throw httpError(401, 'Your session has expired. Please log in again.');
  }

  const { rows } = await pool.query(
    'SELECT id, email, role, email_verified, token_version FROM users WHERE id = $1',
    [decoded.id]
  );
  const user = rows[0];
  if (!user) throw httpError(401, 'Your session is no longer valid. Please log in again.');

  if ((decoded.tv ?? 0) !== user.token_version) {
    throw httpError(401, 'Your password was changed. Please log in again.');
  }

  req.user = { id: user.id, email: user.email, role: user.role, emailVerified: user.email_verified };
  next();
}

// A user with role 'both' satisfies a check for either 'student' or 'tutor'.
export function requireRole(...roles) {
  return (req, _res, next) => {
    const role = req.user?.role;
    if (!req.user || !(role === 'both' || roles.includes(role))) {
      throw httpError(403, 'You do not have access to this resource');
    }
    next();
  };
}

// Only enforced when REQUIRE_VERIFIED_EMAIL=true.
export function requireVerifiedEmail(req, _res, next) {
  if (config.requireVerifiedEmail && !req.user?.emailVerified) {
    throw httpError(403, 'Please verify your email address first. Check your inbox for the link.');
  }
  next();
}
