import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { validate, bookingSchema, bookingStatusSchema } from '../utils/validation.js';

const router = Router();

// A student requests a session with a tutor.
router.post('/', requireAuth, validate(bookingSchema), async (req, res) => {
  const studentId = req.user.id;
  const { tutorId, skillId, scheduledAt, durationMinutes, studentNote } = req.body;

  if (tutorId === studentId) {
    return res.status(400).json({ error: 'You cannot book a session with yourself' });
  }

  const tutorCheck = await pool.query(
    `SELECT tp.user_id FROM tutor_profiles tp WHERE tp.user_id = $1 AND tp.is_published = true`,
    [tutorId]
  );
  if (tutorCheck.rows.length === 0) {
    return res.status(404).json({ error: 'Tutor not found or not currently accepting bookings' });
  }

  const result = await pool.query(
    `INSERT INTO bookings (student_id, tutor_id, skill_id, scheduled_at, duration_minutes, student_note)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, status, scheduled_at, duration_minutes, created_at`,
    [studentId, tutorId, skillId, scheduledAt, durationMinutes, studentNote]
  );

  res.status(201).json({ booking: result.rows[0] });
});

// Everything the logged-in user is involved in, as either student or tutor.
router.get('/me', requireAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT b.id, b.status, b.scheduled_at, b.duration_minutes, b.student_note, b.created_at,
            s.name AS skill_name,
            student.id AS student_id, student.full_name AS student_name,
            tutor.id AS tutor_id, tutor.full_name AS tutor_name
     FROM bookings b
     JOIN skills s ON s.id = b.skill_id
     JOIN users student ON student.id = b.student_id
     JOIN users tutor ON tutor.id = b.tutor_id
     WHERE b.student_id = $1 OR b.tutor_id = $1
     ORDER BY b.scheduled_at DESC`,
    [req.user.id]
  );
  res.json({ bookings: result.rows });
});

// Only the tutor (confirm/decline/complete) or the student (cancel) on a
// booking may change its status — never an unrelated user.
router.patch('/:id/status', requireAuth, validate(bookingStatusSchema), async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const existing = await pool.query('SELECT student_id, tutor_id, status FROM bookings WHERE id = $1', [id]);
  const booking = existing.rows[0];
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  const isTutor = booking.tutor_id === req.user.id;
  const isStudent = booking.student_id === req.user.id;

  const tutorOnlyStatuses = ['confirmed', 'declined', 'completed'];
  const studentOnlyStatuses = ['cancelled'];

  if (tutorOnlyStatuses.includes(status) && !isTutor) {
    return res.status(403).json({ error: 'Only the tutor can set that status' });
  }
  if (studentOnlyStatuses.includes(status) && !isStudent) {
    return res.status(403).json({ error: 'Only the student can cancel a booking' });
  }
  if (!isTutor && !isStudent) {
    return res.status(403).json({ error: 'You are not part of this booking' });
  }

  const result = await pool.query(
    'UPDATE bookings SET status = $1 WHERE id = $2 RETURNING id, status',
    [status, id]
  );
  res.json({ booking: result.rows[0] });
});

export default router;
