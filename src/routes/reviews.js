import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { validate, reviewSchema, tutorIdParam } from '../utils/validation.js';
import { httpError } from '../utils/http.js';

const router = Router();

// Only the student on a completed session can review it, once.
router.post('/', requireAuth, validate(reviewSchema), async (req, res) => {
  const { bookingId, rating, comment } = req.body;

  const found = await pool.query('SELECT student_id, tutor_id, status FROM bookings WHERE id = $1', [bookingId]);
  const booking = found.rows[0];
  if (!booking) throw httpError(404, 'Booking not found');
  if (booking.student_id !== req.user.id) {
    throw httpError(403, 'Only the student who booked this session can review it');
  }
  if (booking.status !== 'completed') throw httpError(409, 'You can only review a completed session');

  try {
    const { rows } = await pool.query(
      `INSERT INTO reviews (booking_id, student_id, tutor_id, rating, comment)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, rating, comment, created_at`,
      [bookingId, req.user.id, booking.tutor_id, rating, comment]
    );
    res.status(201).json({ review: rows[0] });
  } catch (err) {
    if (err.code === '23505') throw httpError(409, 'You already reviewed this session');
    throw err;
  }
});

router.get('/:tutorId', validate(tutorIdParam, 'params'), async (req, res) => {
  const { tutorId } = req.params;
  const reviews = await pool.query(
    `SELECT r.id, r.rating, r.comment, r.created_at, u.full_name AS student_name
     FROM reviews r JOIN users u ON u.id = r.student_id
     WHERE r.tutor_id = $1 ORDER BY r.created_at DESC LIMIT 50`,
    [tutorId]
  );
  const stats = await pool.query(
    `SELECT ROUND(AVG(rating)::numeric, 1)::float AS avg_rating, COUNT(*)::int AS count
     FROM reviews WHERE tutor_id = $1`,
    [tutorId]
  );
  res.json({ reviews: reviews.rows, ...stats.rows[0] });
});

export default router;
