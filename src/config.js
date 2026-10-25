import 'dotenv/config';

const env = process.env;
const isProd = env.NODE_ENV === 'production';

function required(name) {
  const value = env[name];
  if (!value) throw new Error(`${name} is required. See .env.example.`);
  return value;
}

const jwtSecret = required('JWT_SECRET');
if (jwtSecret.length < (isProd ? 32 : 16)) {
  throw new Error(
    `JWT_SECRET is too short. Use at least ${isProd ? 32 : 16} random characters.`
  );
}

const mpesaEnv = env.MPESA_ENV === 'production' ? 'production' : 'sandbox';

// Safaricom's published sandbox values. They only work against the sandbox.
const SANDBOX_SHORTCODE = '174379';
const SANDBOX_PASSKEY =
  'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919';

export const config = {
  env: env.NODE_ENV || 'development',
  isProd,
  port: Number(env.PORT) || 4000,
  databaseUrl: required('DATABASE_URL'),
  databaseSsl: env.DATABASE_SSL === 'true',
  jwtSecret,
  corsOrigins: (env.CORS_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  appUrl: (env.APP_URL || 'http://localhost:5173').replace(/\/$/, ''),
  apiUrl: (env.API_URL || 'http://localhost:4000').replace(/\/$/, ''),
  resendApiKey: env.RESEND_API_KEY || '',
  fromEmail: env.FROM_EMAIL || 'Fundisha <onboarding@resend.dev>',
  requireVerifiedEmail: env.REQUIRE_VERIFIED_EMAIL === 'true',
  mpesa: {
    env: mpesaEnv,
    baseUrl:
      mpesaEnv === 'production'
        ? 'https://api.safaricom.co.ke'
        : 'https://sandbox.safaricom.co.ke',
    consumerKey: env.MPESA_CONSUMER_KEY || '',
    consumerSecret: env.MPESA_CONSUMER_SECRET || '',
    shortcode: env.MPESA_SHORTCODE || (mpesaEnv === 'sandbox' ? SANDBOX_SHORTCODE : ''),
    passkey: env.MPESA_PASSKEY || (mpesaEnv === 'sandbox' ? SANDBOX_PASSKEY : ''),
    callbackSecret: env.MPESA_CALLBACK_SECRET || (isProd ? '' : 'dev-callback-secret'),
  },
};

// Business rules shared by routes and tests.
export const rules = {
  timezoneOffsetHours: 3, // Africa/Nairobi is UTC+3 all year (no daylight saving)
  minLeadMinutes: 60,
  maxHorizonDays: 60,
  slotStepMinutes: 30,
  maxPendingPerStudent: 5,
  allowedDurations: [30, 60, 90, 120],
  stkRetryAfterSeconds: 120,
};
