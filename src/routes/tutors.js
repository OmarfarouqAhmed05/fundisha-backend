import { Router } from 'express';
import { pool, withTransaction } from '../db/pool.js';
import { requireAuth, requireRole, requireVerifiedEmail } from '../middleware/auth.js';
import {
  validate,
  isUuid,
  tutorProfileSchema,
  availabilitySchema,
  tutorSearchSchema,
  slotsQuerySchema,
} from '../utils/validation.js';
import { httpError } from '../utils/http.js';
import { rules } from '../config.js';
import { candidateStarts, addMinutes } from '../utils/time.js';

const router = Router();

const RATING_JOIN = `
  LEFT JOIN LATERAL (
    SELECT ROUND(AVG(rating)::numeric, 1)::float AS avg_rating, COUNT(*)::int AS review_count
    FROM reviews WHERE tutor_id = u.id
  ) r ON true`;

const SKILLS_SELECT = `
  COALESCE((SELECT json_agg(s.name ORDER BY s.name)
            FROM tutor_skills ts JOIN skills s ON s.id = ts.skill_id
            WHERE ts.tutor_id = u.id), '[]'::json) AS skills`;

const SORTS = {
  rating: 'r.avg_rating DESC NULLS LAST, r.review_count DESC, tp.experience_years DESC, u.full_name',
  price_asc: 'tp.hourly_rate_kes ASC, r.avg_rating DESC NULLS LAST, u.full_name',
  price_desc: 'tp.hourly_rate_kes DESC, r.avg_rating DESC NULLS LAST, u.full_name',
  experience: 'tp.experience_years DESC, r.avg_rating DESC NULLS LAST, u.full_name',
};

const escapeLike = (s) => s.replace(/[\\%_]/g, '\\$&');

// GET /api/tutors?skill=React&q=maria&maxRate=2000&sort=rating&page=1&limit=12
router.get('/', validate(tutorSearchSchema, 'query'), async (req, res) => {
  const { skill, q, maxRate, sort, page, limit } = req.query;
  const params = [];
  const where = ['tp.is_published = true'];

  if (skill) {
    params.push(skill);
    where.push(`EXISTS (SELECT 1 FROM tutor_skills ts JOIN skills s ON s.id = ts.skill_id
                        WHERE ts.tutor_id = u.id AND s.name = $${params.length})`);
  }
  if (maxRate !== undefined) {
    params.push(maxRate);
    where.push(`tp.hourly_rate_kes <= $${params.length}`);
  }
  if (q) {
    params.push(`%${escapeLike(q)}%`);
    const p = `$${params.length}`;
    where.push(`(u.full_name ILIKE ${p} OR tp.headline ILIKE ${p} OR EXISTS (
      SELECT 1 FROM tutor_skills ts JOIN skills s ON s.id = ts.skill_id
      WHERE ts.tutor_id = u.id AND s.name ILIKE ${p}))`);
  }

  params.push(limit, (page - 1) * limit);
  const { rows } = await pool.query(
    `SELECT u.id, u.full_name, u.is_demo, tp.headline, tp.hourly_rate_kes, tp.experience_years,
            ${SKILLS_SELECT}, r.avg_rating, COALESCE(r.review_count, 0) AS review_count,
            COUNT(*) OVER()::int AS total
     FROM users u
     JOIN tutor_profiles tp ON tp.user_id = u.id
     ${RATING_JOIN}
     WHERE ${where.join(' AND ')}
     ORDER BY ${SORTS[sort]}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  const total = rows[0]?.total ?? 0;
  res.json({
    tutors: rows.map(({ total: _t, ...tutor }) => tutor),
    total,
    page,
    limit,
    pages: Math.max(1, Math.ceil(total / limit)),
  });
});

// --- The logged-in tutor's own profile (works even while unpublished) ---

async function loadOwnProfile(userId) {
  const profile = await pool.query(
    `SELECT u.bio, tp.headline, tp.hourly_rate_kes, tp.experience_years, tp.is_published
     FROM tutor_profiles tp JOIN users u ON u.id = tp.user_id WHERE tp.user_id = $1`,
    [userId]
  );
  const skills = await pool.query('SELECT skill_id FROM tutor_skills WHERE tutor_id = $1 ORDER BY skill_id', [userId]);
  const slots = await pool.query(
    `SELECT day_of_week AS "dayOfWeek", to_char(start_time, 'HH24:MI') AS "startTime", to_char(end_time, 'HH24:MI') AS "endTime"
     FROM availability_slots WHERE tutor_id = $1 ORDER BY day_of_week, start_time`,
    [userId]
  );
  const p = profile.rows[0];
  if (!p) return null;
  return {
    headline: p.headline,
    bio: p.bio || '',
    hourlyRateKes: p.hourly_rate_kes,
    experienceYears: p.experience_years,
    isPublished: p.is_published,
    skillIds: skills.rows.map((s) => s.skill_id),
    availability: slots.rows,
  };
}

router.get('/me/profile', requireAuth, requireRole('tutor'), async (req, res) => {
  let profile = await loadOwnProfile(req.user.id);
  if (!profile) {
    // Role 'both' accounts created before tutor profiles existed.
    await pool.query('INSERT INTO tutor_profiles (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [req.user.id]);
    profile = await loadOwnProfile(req.user.id);
  }
  res.json({ profile });
});

router.put(
  '/me/profile',
  requireAuth,
  requireRole('tutor'),
  validate(tutorProfileSchema),
  async (req, res) => {
    const { headline, bio, hourlyRateKes, experienceYears, skillIds, isPublished } = req.body;
    const tutorId = req.user.id;

    if (isPublished) requireVerifiedEmail(req, res, () => {}); // throws if REQUIRE_VERIFIED_EMAIL=true

    await withTransaction(async (db) => {
      if (isPublished) {
        const missing = [];
        if (!headline) missing.push('a headline');
        if (hourlyRateKes <= 0) missing.push('an hourly rate above 0');
        if (skillIds.length === 0) missing.push('at least one skill');
        const slots = await db.query('SELECT 1 FROM availability_slots WHERE tutor_id = $1 LIMIT 1', [tutorId]);
        if (slots.rowCount === 0) missing.push('at least one availability slot');
        if (missing.length > 0) {
          throw httpError(400, `To publish your profile, add ${missing.join(', ')}.`, { missing });
        }
      }

      if (skillIds.length > 0) {
        const known = await db.query('SELECT id FROM skills WHERE id = ANY($1::int[])', [skillIds]);
        if (known.rowCount !== skillIds.length) throw httpError(400, 'One of the selected skills does not exist');
      }

      await db.query(
        `INSERT INTO tutor_profiles (user_id, headline, hourly_rate_kes, experience_years, is_published, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (user_id) DO UPDATE
         SET headline = $2, hourly_rate_kes = $3, experience_years = $4, is_published = $5, updated_at = now()`,
        [tutorId, headline, hourlyRateKes, experienceYears, isPublished]
      );
      await db.query('UPDATE users SET bio = $1 WHERE id = $2', [bio, tutorId]);

      await db.query('DELETE FROM tutor_skills WHERE tutor_id = $1', [tutorId]);
      if (skillIds.length > 0) {
        await db.query(
          'INSERT INTO tutor_skills (tutor_id, skill_id) SELECT $1, unnest($2::int[])',
          [tutorId, skillIds]
        );
      }
    });

    res.json({ ok: true, profile: await loadOwnProfile(tutorId) });
  }
);

router.put(
  '/me/availability',
  requireAuth,
  requireRole('tutor'),
  validate(availabilitySchema),
  async (req, res) => {
    const tutorId = req.user.id;
    const { slots } = req.body;

    await withTransaction(async (db) => {
      await db.query('DELETE FROM availability_slots WHERE tutor_id = $1', [tutorId]);
      for (const slot of slots) {
        await db.query(
          `INSERT INTO availability_slots (tutor_id, day_of_week, start_time, end_time)
           VALUES ($1, $2, $3, $4)`,
          [tutorId, slot.dayOfWeek, slot.startTime, slot.endTime]
        );
      }
      // A profile with no availability cannot take bookings, so take it off the search page.
      if (slots.length === 0) {
        await db.query('UPDATE tutor_profiles SET is_published = false WHERE user_id = $1', [tutorId]);
      }
    });

    res.json({ ok: true, availability: (await loadOwnProfile(tutorId)).availability });
  }
);

// --- Public profile ---

router.get('/:id', async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) throw httpError(404, 'Tutor not found');

  const profileResult = await pool.query(
    `SELECT u.id, u.full_name, u.bio, u.is_demo, tp.headline, tp.hourly_rate_kes, tp.experience_years,
            r.avg_rating, COALESCE(r.review_count, 0) AS review_count
     FROM users u
     JOIN tutor_profiles tp ON tp.user_id = u.id
     ${RATING_JOIN}
     WHERE u.id = $1 AND tp.is_published = true`,
    [id]
  );
  const profile = profileResult.rows[0];
  if (!profile) throw httpError(404, 'Tutor not found');

  const skills = await pool.query(
    `SELECT s.id, s.name, s.category FROM tutor_skills ts
     JOIN skills s ON s.id = ts.skill_id WHERE ts.tutor_id = $1 ORDER BY s.name`,
    [id]
  );
  const availability = await pool.query(
    `SELECT day_of_week AS "dayOfWeek", to_char(start_time, 'HH24:MI') AS "startTime", to_char(end_time, 'HH24:MI') AS "endTime"
     FROM availability_slots WHERE tutor_id = $1 ORDER BY day_of_week, start_time`,
    [id]
  );

  res.json({ ...profile, skills: skills.rows, availability: availability.rows });
});

// Bookable start times for one Nairobi calendar date: inside the tutor's weekly slots,
// not in the past, and not overlapping an existing pending or confirmed booking.
router.get('/:id/slots', validate(slotsQuerySchema, 'query'), async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) throw httpError(404, 'Tutor not found');
  const { date, duration } = req.query;

  const tutor = await pool.query(
    'SELECT 1 FROM tutor_profiles WHERE user_id = $1 AND is_published = true',
    [id]
  );
  if (tutor.rowCount === 0) throw httpError(404, 'Tutor not found');

  const slots = (
    await pool.query(
      'SELECT day_of_week, start_time::text AS start_time, end_time::text AS end_time FROM availability_slots WHERE tutor_id = $1',
      [id]
    )
  ).rows;

  const earliest = Date.now() + rules.minLeadMinutes * 60 * 1000;
  const latest = Date.now() + rules.maxHorizonDays * 24 * 60 * 60 * 1000;
  const candidates = candidateStarts(slots, date, duration, rules.slotStepMinutes).filter(
    (c) => c.start.getTime() >= earliest && c.start.getTime() <= latest
  );

  let free = candidates;
  if (candidates.length > 0) {
    const from = candidates[0].start;
    const to = addMinutes(candidates[candidates.length - 1].start, duration);
    const taken = (
      await pool.query(
        `SELECT scheduled_at AS start, scheduled_at + make_interval(mins => duration_minutes) AS "end"
         FROM bookings
         WHERE tutor_id = $1 AND status IN ('pending', 'confirmed')
           AND scheduled_at < $3 AND scheduled_at + make_interval(mins => duration_minutes) > $2`,
        [id, from, to]
      )
    ).rows;
    free = candidates.filter((c) => {
      const end = addMinutes(c.start, duration);
      return !taken.some((t) => c.start < t.end && t.start < end);
    });
  }

  res.json({
    date,
    durationMinutes: duration,
    timezone: 'Africa/Nairobi',
    slots: free.map((c) => ({ start: c.start.toISOString(), label: c.label })),
  });
});

export default router;
