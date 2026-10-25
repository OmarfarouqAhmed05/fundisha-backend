// Load .env so a TEST_DATABASE_URL line there is picked up, then prefer it over the normal DATABASE_URL.
await import('dotenv/config');
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ||= 'test-secret-test-secret-test-secret-123';
process.env.MPESA_CALLBACK_SECRET = 'test-callback-secret';
process.env.CORS_ORIGIN = 'http://localhost:5173,https://fundisha-frontend.vercel.app,https://fundisha-frontend-*-omarfarouqahmed05.vercel.app';

if (!process.env.DATABASE_URL || !/test/i.test(new URL(process.env.DATABASE_URL).pathname)) {
  throw new Error(
    'Refusing to run: the tests wipe their database, so it must have "test" in its name.\n' +
      'Add a line to .env, for example:\n' +
      '  TEST_DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/fundisha_test\n' +
      'then create it once with: createdb fundisha_test'
  );
}

const { createApp } = await import('../src/app.js');
const { pool } = await import('../src/db/pool.js');
const { runMigrations } = await import('../src/db/migrate.js');
const { seedSkills } = await import('../src/db/seed.js');
const { signToken } = await import('../src/middleware/auth.js');
const { addMinutes, nairobiDayStart, nairobiParts } = await import('../src/utils/time.js');
const { default: request } = await import('supertest');

export { pool, request, signToken };

export async function resetDb() {
  await runMigrations();
  await pool.query('TRUNCATE users, skills RESTART IDENTITY CASCADE');
  await seedSkills();
}

export function makeFakes() {
  const sent = [];
  const mailer = new Proxy(
    {},
    { get: (_t, name) => async (...args) => { sent.push({ name: String(name), args }); return {}; } }
  );
  const mpesa = {
    configured: true,
    pushes: [],
    queryResult: { state: 'pending', description: 'processing' },
    isConfigured() { return this.configured; },
    async initiateSTKPush(args) {
      this.pushes.push(args);
      return { checkoutRequestId: `ws_CO_${this.pushes.length}_${Math.random().toString(36).slice(2, 8)}` };
    },
    async queryStkStatus() { return this.queryResult; },
  };
  return { sent, mailer, mpesa };
}

export function makeApp(fakes) {
  return request(createApp({ mailer: fakes.mailer, mpesa: fakes.mpesa }));
}

let counter = 0;
// Creates a user straight in the database (fast, no bcrypt) and returns a valid token.
export async function makeUser({ role = 'student', name, phone = '254712345678', verified = true } = {}) {
  counter += 1;
  const fullName = name || `${role} ${counter}`;
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, full_name, role, phone, email_verified)
     VALUES ($1, 'x', $2, $3, $4, $5) RETURNING id, email, full_name`,
    [`user${counter}@example.com`, fullName, role, phone, verified]
  );
  if (role !== 'student') await pool.query('INSERT INTO tutor_profiles (user_id) VALUES ($1)', [rows[0].id]);
  return { ...rows[0], token: signToken(rows[0]), auth: { Authorization: `Bearer ${signToken(rows[0])}` } };
}

// A published tutor who teaches skill ids [1, 2] and is free every day 06:00-22:00 Nairobi time.
export async function makeTutor(overrides = {}) {
  const tutor = await makeUser({ role: 'tutor', ...overrides });
  await pool.query(
    `UPDATE tutor_profiles SET headline = 'Test tutor', hourly_rate_kes = $2, experience_years = 3, is_published = true WHERE user_id = $1`,
    [tutor.id, overrides.rate ?? 1200]
  );
  await pool.query('INSERT INTO tutor_skills (tutor_id, skill_id) VALUES ($1, 1), ($1, 2)', [tutor.id]);
  for (let d = 0; d < 7; d++) {
    await pool.query(
      `INSERT INTO availability_slots (tutor_id, day_of_week, start_time, end_time) VALUES ($1, $2, '06:00', '22:00')`,
      [tutor.id, d]
    );
  }
  return tutor;
}

// ISO timestamp for "N days from now at HH:MM Nairobi time".
export function at(daysAhead, hhmm = '10:00') {
  const day = nairobiParts(new Date(Date.now() + daysAhead * 86400000)).dateString;
  const [h, m] = hhmm.split(':').map(Number);
  return addMinutes(nairobiDayStart(day), h * 60 + m).toISOString();
}

export async function book(app, student, tutor, overrides = {}) {
  return app.post('/api/bookings').set(student.auth).send({
    tutorId: tutor.id,
    skillId: 1,
    scheduledAt: at(3, '10:00'),
    durationMinutes: 60,
    ...overrides,
  });
}
