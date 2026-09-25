import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = '7d';

if (!JWT_SECRET || JWT_SECRET.length < 16) {
  // Fail loudly at boot rather than silently signing tokens with a weak
  // or missing secret — a common source of real auth vulnerabilities.
  throw new Error(
    'JWT_SECRET is missing or too short. Set a strong random value (32+ chars) in .env.'
  );
}

export function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // { id, email, role }
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    const userRole = req.user?.role;
    // A user with role 'both' satisfies a check for either 'student' or 'tutor'.
    const allowed = userRole === 'both' || roles.includes(userRole);
    if (!req.user || !allowed) {
      return res.status(403).json({ error: 'You do not have access to this resource' });
    }
    next();
  };
}
