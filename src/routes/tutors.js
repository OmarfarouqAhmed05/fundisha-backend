import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { validate, tutorProfileSchema, availabilitySchema } from '../utils/validation.js';

const router = Router();

// GET /api/tutors?skill=React&maxRate=2000 — public search, published tutors only
router.get('/', async (req, res) => {
  const { skill, maxRate, q } = req.query;
  const params = [];
  const conditions = ['tp.is_published = true'];

  let joinSkills = '';
  if (skill) {
    joinSkills = 'JOIN tutor_skills ts ON ts.tutor_id = u.id JOIN skills s ON s.id = ts.skill_id';
    params.push(skill);
    conditions.push(`s.name = $${params.length}`);
  }
  if (maxRate) {
    params.push(Number(maxRate));
    conditions.push(`tp.hourly_rate_kes <= $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    conditions.push(`(u.full_name ILIKE $${params.length} OR tp.headline ILIKE $${params.length})`);
  }

  const sql = `
    SELECT DISTINCT u.id, u.full_name, tp.headline, tp.hourly_rate_kes, tp.experience_years
    FROM users u
    JOIN tutor_profiles tp ON tp.user_id = u.id
    ${joinSkills}
    WHERE ${conditions.join(' AND ')}
    ORDER BY tp.experience_years DESC
    LIMIT 50
  `;
  const result = await pool.query(sql, params);
  res.json({ tutors: result.rows });
});

router.get('/:id', async (req, res) => {
  const { id } = req.params;

  const profileResult = await pool.query(
    `SELECT u.id, u.full_name, u.bio, tp.headline, tp.hourly_rate_kes, tp.experience_years, tp.is_published
     FROM users u JOIN tutor_profiles tp ON tp.user_id = u.id
     WHERE u.id = $1`,
    [id]
  );
  const profile = profileResult.rows[0];
  if (!profile || !profile.is_published) {
    return res.status(404).json({ error: 'Tutor not found' });
  }

  const skillsResult = await pool.query(
    `SELECT s.id, s.name, s.category FROM tutor_skills ts
     JOIN skills s ON s.id = ts.skill_id WHERE ts.tutor_id = $1`,
    [id]
  );

  const availabilityResult = await pool.query(
    `SELECT day_of_week AS "dayOfWeek", start_time AS "startTime", end_time AS "endTime"
     FROM availability_slots WHERE tutor_id = $1 ORDER BY day_of_week, start_time`,
    [id]
  );

  res.json({ ...profile, skills: skillsResult.rows, availability: availabilityResult.rows });
});

// --- Self-service: the logged-in tutor manages their own profile ---

router.put(
  '/me/profile',
  requireAuth,
  requireRole('tutor'),
  validate(tutorProfileSchema),
  async (req, res) => {
    const { headline, hourlyRateKes, experienceYears, skillIds, isPublished } = req.body;
    const tutorId = req.user.id;

    await pool.query(
      `INSERT INTO tutor_profiles (user_id, headline, hourly_rate_kes, experience_years, is_published, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (user_id) DO UPDATE
       SET headline = $2, hourly_rate_kes = $3, experience_years = $4, is_published = $5, updated_at = now()`,
      [tutorId, headline, hourlyRateKes, experienceYears, isPublished]
    );

    await pool.query('DELETE FROM tutor_skills WHERE tutor_id = $1', [tutorId]);
    if (skillIds.length > 0) {
      const values = skillIds.map((_, i) => `($1, $${i + 2})`).join(', ');
      await pool.query(
        `INSERT INTO tutor_skills (tutor_id, skill_id) VALUES ${values} ON CONFLICT DO NOTHING`,
        [tutorId, ...skillIds]
      );
    }

    res.json({ ok: true });
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

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM availability_slots WHERE tutor_id = $1', [tutorId]);
      for (const slot of slots) {
        await client.query(
          `INSERT INTO availability_slots (tutor_id, day_of_week, start_time, end_time)
           VALUES ($1, $2, $3, $4)`,
          [tutorId, slot.dayOfWeek, slot.startTime, slot.endTime]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.json({ ok: true });
  }
);

export default router;
