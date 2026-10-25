import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, withTransaction } from './pool.js';
import { runMigrations } from './migrate.js';
import { addMinutes, nairobiDayStart, nairobiParts } from '../utils/time.js';
import { priceFor } from '../utils/booking-rules.js';

export const DEMO_PASSWORD = 'DemoPass123!';
export const DEMO_LEARNER_EMAIL = 'demo.learner@example.com';
export const DEMO_TUTOR_EMAIL = 'demo.tutor@example.com';

const SKILLS = [
  ['JavaScript', 'coding'], ['Python', 'coding'], ['Java', 'coding'], ['React', 'coding'],
  ['SQL & Databases', 'coding'], ['Web Design', 'coding'],
  ['Spanish', 'language'], ['French', 'language'], ['Swahili', 'language'], ['IELTS/English Prep', 'language'],
  ['Guitar', 'music'], ['Piano', 'music'], ['Vocals', 'music'],
  ['Calculus', 'academic'], ['Statistics', 'academic'],
  ['Public Speaking', 'other'], ['Graphic Design', 'other'],
];

// Sample tutors. They are flagged is_demo so the app can label them as sample profiles.
const TUTORS = [
  {
    email: DEMO_TUTOR_EMAIL, name: 'Kevin Mutiso', rate: 1500, years: 4,
    headline: 'Backend developer who teaches SQL on real, messy datasets',
    bio: 'I write APIs for a living and tutor on the side. Sessions are built around a small project of yours: we design the tables, load some data, then write the queries that answer real questions.',
    skills: ['SQL & Databases', 'Python'],
    slots: [[1, '17:00', '20:00'], [3, '17:00', '20:00'], [6, '09:00', '13:00']],
  },
  {
    email: 'wanjiru.kamau@example.com', name: 'Wanjiru Kamau', rate: 1200, years: 3,
    headline: 'Python and statistics for first-year university students',
    bio: 'Currently finishing a data science degree. I focus on the topics people get stuck on in first and second year: loops, functions, and reading a statistics question properly.',
    skills: ['Python', 'Statistics'],
    slots: [[2, '16:00', '19:00'], [4, '16:00', '19:00'], [0, '14:00', '17:00']],
  },
  {
    email: 'brian.otieno@example.com', name: 'Brian Otieno', rate: 1800, years: 5,
    headline: 'Frontend developer: JavaScript, React and design basics',
    bio: 'Five years building web apps for startups in Nairobi. I teach by code review: bring something you built and we improve it together.',
    skills: ['JavaScript', 'React', 'Web Design'],
    slots: [[1, '18:00', '21:00'], [2, '18:00', '21:00'], [5, '18:00', '21:00']],
  },
  {
    email: 'amina.hassan@example.com', name: 'Amina Hassan', rate: 1000, years: 6,
    headline: 'Swahili and French lessons, conversation first',
    bio: 'Native Swahili speaker who studied French at university. Lessons are mostly speaking, with just enough grammar to keep you moving.',
    skills: ['Swahili', 'French'],
    slots: [[1, '17:30', '19:30'], [3, '17:30', '19:30'], [6, '10:00', '14:00']],
  },
  {
    email: 'david.mwangi@example.com', name: 'David Mwangi', rate: 1300, years: 8,
    headline: 'Guitar and piano for beginners and returning players',
    bio: 'Church band musician and weekend teacher. I start with songs you actually want to play and fit the theory around them.',
    skills: ['Guitar', 'Piano'],
    slots: [[2, '17:00', '20:00'], [4, '17:00', '20:00'], [6, '09:00', '12:00']],
  },
  {
    email: 'faith.achieng@example.com', name: 'Faith Achieng', rate: 900, years: 2,
    headline: 'Calculus and statistics tutoring for exam revision',
    bio: 'Maths and statistics student. I work through past-paper questions step by step so you can see how the marks are earned.',
    skills: ['Calculus', 'Statistics'],
    slots: [[1, '16:00', '19:00'], [3, '16:00', '19:00'], [0, '15:00', '18:00']],
  },
];

const LEARNERS = [
  { email: DEMO_LEARNER_EMAIL, name: 'Demo Learner', loginable: true },
  { email: 'grace.njeri@example.com', name: 'Grace Njeri' },
  { email: 'peter.kiprop@example.com', name: 'Peter Kiprop' },
  { email: 'mercy.wambui@example.com', name: 'Mercy Wambui' },
];

// [tutor index, learner index, skill, days ago, rating, comment]
const PAST_REVIEWED = [
  [0, 1, 'SQL & Databases', 21, 5, 'Joins finally made sense once we used my own project data.'],
  [0, 2, 'Python', 14, 4, 'Good pace and clear examples. Would book again.'],
  [0, 0, 'SQL & Databases', 10, 5, 'Helped me fix my schema before submitting my assignment.'],
  [1, 1, 'Statistics', 18, 5, 'Explained hypothesis testing without the jargon.'],
  [1, 3, 'Python', 9, 4, 'Patient with beginner questions.'],
  [2, 2, 'React', 16, 5, 'Code review style is exactly what I needed.'],
  [2, 3, 'JavaScript', 8, 5, 'Went through closures until I could explain them myself.'],
  [3, 1, 'Swahili', 12, 5, 'Lots of speaking practice, very relaxed lessons.'],
  [3, 3, 'French', 6, 4, 'Great for conversation. Wanted a bit more grammar drills.'],
  [4, 2, 'Guitar', 13, 5, 'Learned my first full song in one session.'],
  [5, 3, 'Calculus', 7, 4, 'Past-paper walkthrough was really useful.'],
];

function pastStart(daysAgo, hour = 18) {
  const day = nairobiParts(new Date(Date.now() - daysAgo * 86400000)).dateString;
  return addMinutes(nairobiDayStart(day), hour * 60);
}

// The next Monday-Friday that is at least minDays away, at the given Nairobi hour.
function nextWeekday(minDays, hour = 18) {
  for (let d = minDays; d < minDays + 7; d++) {
    const parts = nairobiParts(new Date(Date.now() + d * 86400000));
    if (parts.dayOfWeek >= 1 && parts.dayOfWeek <= 5) {
      return addMinutes(nairobiDayStart(parts.dateString), hour * 60);
    }
  }
}

export async function seedSkills() {
  for (const [name, category] of SKILLS) {
    await pool.query('INSERT INTO skills (name, category) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING', [
      name,
      category,
    ]);
  }
}

export async function resetDemo() {
  const { rowCount } = await pool.query('DELETE FROM users WHERE is_demo = true');
  return rowCount;
}

export async function seedDemo() {
  const exists = await pool.query('SELECT 1 FROM users WHERE email = $1', [DEMO_LEARNER_EMAIL]);
  if (exists.rowCount > 0) return false;

  const skillRows = (await pool.query('SELECT id, name FROM skills')).rows;
  const skillId = (name) => skillRows.find((s) => s.name === name).id;
  const demoHash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const lockedHash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10); // nobody can log in as these

  await withTransaction(async (db) => {
    const tutorIds = [];
    for (const t of TUTORS) {
      const u = await db.query(
        `INSERT INTO users (email, password_hash, full_name, role, bio, email_verified, is_demo)
         VALUES ($1, $2, $3, 'tutor', $4, true, true) RETURNING id`,
        [t.email, t.email === DEMO_TUTOR_EMAIL ? demoHash : lockedHash, t.name, t.bio]
      );
      const id = u.rows[0].id;
      tutorIds.push(id);
      await db.query(
        `INSERT INTO tutor_profiles (user_id, headline, hourly_rate_kes, experience_years, is_published)
         VALUES ($1, $2, $3, $4, true)`,
        [id, t.headline, t.rate, t.years]
      );
      for (const s of t.skills) {
        await db.query('INSERT INTO tutor_skills (tutor_id, skill_id) VALUES ($1, $2)', [id, skillId(s)]);
      }
      for (const [dow, from, to] of t.slots) {
        await db.query(
          'INSERT INTO availability_slots (tutor_id, day_of_week, start_time, end_time) VALUES ($1, $2, $3, $4)',
          [id, dow, from, to]
        );
      }
    }

    const learnerIds = [];
    for (const l of LEARNERS) {
      const u = await db.query(
        `INSERT INTO users (email, password_hash, full_name, role, phone, email_verified, is_demo)
         VALUES ($1, $2, $3, 'student', $4, true, true) RETURNING id`,
        [l.email, l.loginable ? demoHash : lockedHash, l.name, l.loginable ? '254712345678' : '']
      );
      learnerIds.push(u.rows[0].id);
    }

    async function addBooking({ tutor, learner, skill, start, status, payment = 'unpaid', review }) {
      const t = TUTORS[tutor];
      const b = await db.query(
        `INSERT INTO bookings (student_id, tutor_id, skill_id, scheduled_at, duration_minutes, status,
                               student_note, price_kes, payment_status, paid_at, mpesa_receipt)
         VALUES ($1, $2, $3, $4, 60, $5, '', $6, $7, $8, $9) RETURNING id`,
        [
          learnerIds[learner], tutorIds[tutor], skillId(skill), start, status, priceFor(t.rate, 60),
          payment, payment === 'paid' ? start : null, payment === 'paid' ? `SANDBOX${Math.floor(Math.random() * 1e6)}` : null,
        ]
      );
      if (review) {
        await db.query(
          'INSERT INTO reviews (booking_id, student_id, tutor_id, rating, comment, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
          [b.rows[0].id, learnerIds[learner], tutorIds[tutor], review.rating, review.comment, addMinutes(start, 180)]
        );
      }
    }

    for (const [tutor, learner, skill, daysAgo, rating, comment] of PAST_REVIEWED) {
      await addBooking({
        tutor, learner, skill, start: pastStart(daysAgo), status: 'completed', payment: 'paid',
        review: { rating, comment },
      });
    }
    // Demo learner: a finished session still waiting for a review, a confirmed session to pay for,
    // and a pending request. The demo tutor also has a pending request from another learner to confirm.
    await addBooking({ tutor: 2, learner: 0, skill: 'JavaScript', start: pastStart(4, 17), status: 'completed', payment: 'paid' });
    await addBooking({ tutor: 0, learner: 0, skill: 'SQL & Databases', start: nextWeekday(2, 18), status: 'confirmed' });
    await addBooking({ tutor: 1, learner: 0, skill: 'Statistics', start: nextWeekday(5, 16), status: 'pending' });
    await addBooking({ tutor: 0, learner: 1, skill: 'Python', start: nextWeekday(4, 18), status: 'pending' });
  });
  return true;
}

// Run directly: `npm run db:seed`, `npm run db:seed:demo`, `npm run db:reset-demo`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flags = new Set(process.argv.slice(2));
  try {
    await runMigrations();
    await seedSkills();
    console.log(`Skills ready (${SKILLS.length}).`);
    if (flags.has('--reset-demo')) {
      console.log(`Removed ${await resetDemo()} demo accounts.`);
    }
    if (flags.has('--demo') || flags.has('--reset-demo')) {
      const created = await seedDemo();
      console.log(
        created
          ? `Demo data created. Log in as ${DEMO_LEARNER_EMAIL} or ${DEMO_TUTOR_EMAIL} with password ${DEMO_PASSWORD}`
          : 'Demo data already present (use npm run db:reset-demo to rebuild it).'
      );
    }
  } catch (err) {
    console.error('Seeding failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
