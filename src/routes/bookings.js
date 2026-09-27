import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import {
  validate,
  bookingSchema,
  bookingStatusSchema,
  reviewSchema,
  mpesaInitiateSchema,
} from '../utils/validation.js';
import { initiateSTKPush } from '../utils/mpesa.js';
import { sendBookingConfirmedEmail } from '../utils/email.js';

const router = Router();

// A student requests a session with a tutor.
router.post('/', requireAuth, validate(bookingSchema), async (req, res) => {
  const studentId = req.user.id;
  const { tutorId, skillId, scheduledAt, durationMinutes, studentNote } = req.body;

  if (tutorId === studentId) {
    return res.status(400).json({ error: 'You cannot book a session with yourself' });
  }

  const tutorCheck = await pool.query(
    `SELECT tp.user_id, tp.hourly_rate_kes FROM tutor_profiles tp
     WHERE tp.user_id = $1 AND tp.is_published = true`,
    [tutorId]
  );
  if (tutorCheck.rows.length === 0) {
    return res.status(404).json({ error: 'Tutor not found or not currently accepting bookings' });
  }

  // Double-booking protection: reject if this tutor already has a
  // pending/confirmed booking whose time range overlaps the requested one.
  // Two ranges [a_start, a_end) and [b_start, b_end) overlap iff
  // a_start < b_end AND b_start < a_end.
  const overlap = await pool.query(
    `SELECT id FROM bookings
     WHERE tutor_id = $1
       AND status IN ('pending', 'confirmed')
       AND scheduled_at < ($2::timestamptz + ($3::int || ' minutes')::interval)
       AND $2::timestamptz < (scheduled_at + (duration_minutes || ' minutes')::interval)`,
    [tutorId, scheduledAt, durationMinutes]
  );
  if (overlap.rows.length > 0) {
    return res.status(409).json({ error: 'That time slot is no longer available for this tutor' });
  }

  const result = await pool.query(
    `INSERT INTO bookings (student_id, tutor_id, skill_id, scheduled_at, duration_minutes, student_note)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, status, scheduled_at, duration_minutes, payment_status, created_at`,
    [studentId, tutorId, skillId, scheduledAt, durationMinutes, studentNote]
  );

  res.status(201).json({ booking: result.rows[0], hourlyRateKes: tutorCheck.rows[0].hourly_rate_kes });
});

// Everything the logged-in user is involved in, as either student or tutor.
// Contact info (email/phone) for the other party is only included once the
// booking is confirmed — not while it's still pending, to avoid leaking
// contact details before a session is actually agreed on.
router.get('/me', requireAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT b.id, b.status, b.scheduled_at, b.duration_minutes, b.student_note, b.payment_status, b.created_at,
            s.name AS skill_name, s.id AS skill_id,
            student.id AS student_id, student.full_name AS student_name,
            tutor.id AS tutor_id, tutor.full_name AS tutor_name,
            CASE WHEN b.status = 'confirmed' THEN student.email END AS student_email,
            CASE WHEN b.status = 'confirmed' THEN student.phone END AS student_phone,
            CASE WHEN b.status = 'confirmed' THEN tutor.email END AS tutor_email,
            CASE WHEN b.status = 'confirmed' THEN tutor.phone END AS tutor_phone,
            EXISTS(SELECT 1 FROM reviews r WHERE r.booking_id = b.id) AS has_review
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

  const existing = await pool.query(
    `SELECT b.student_id, b.tutor_id, b.status, b.scheduled_at,
            student.email AS student_email, student.full_name AS student_name, student.phone AS student_phone,
            tutor.email AS tutor_email, tutor.full_name AS tutor_name, tutor.phone AS tutor_phone
     FROM bookings b
     JOIN users student ON student.id = b.student_id
     JOIN users tutor ON tutor.id = b.tutor_id
     WHERE b.id = $1`,
    [id]
  );
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

  if (status === 'confirmed') {
    const contact = `Student: ${booking.student_email}${booking.student_phone ? ', ' + booking.student_phone : ''} | Tutor: ${booking.tutor_email}${booking.tutor_phone ? ', ' + booking.tutor_phone : ''}`;
    // Email failures shouldn't block the status change itself.
    sendBookingConfirmedEmail(
      booking.student_email,
      booking.tutor_name,
      booking.student_name,
      booking.scheduled_at,
      contact
    ).catch(() => {});
    sendBookingConfirmedEmail(
      booking.tutor_email,
      booking.tutor_name,
      booking.student_name,
      booking.scheduled_at,
      contact
    ).catch(() => {});
  }

  res.json({ booking: result.rows[0] });
});

// --- M-Pesa payment (STK push) ---

router.post('/mpesa/initiate', requireAuth, validate(mpesaInitiateSchema), async (req, res) => {
  const { bookingId, phone } = req.body;

  const result = await pool.query(
    `SELECT b.id, b.student_id, b.duration_minutes, tp.hourly_rate_kes
     FROM bookings b
     JOIN tutor_profiles tp ON tp.user_id = b.tutor_id
     WHERE b.id = $1`,
    [bookingId]
  );
  const booking = result.rows[0];
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.student_id !== req.user.id) {
    return res.status(403).json({ error: 'Only the student on this booking can pay for it' });
  }

  const amount = Math.max(1, Math.round((booking.hourly_rate_kes * booking.duration_minutes) / 60));

  try {
    const { checkoutRequestId } = await initiateSTKPush({
      phone,
      amount,
      accountReference: `Fundisha-${bookingId.slice(0, 8)}`,
      description: 'Fundisha session',
    });

    await pool.query(
      `UPDATE bookings SET payment_status = 'pending', mpesa_checkout_request_id = $1 WHERE id = $2`,
      [checkoutRequestId, bookingId]
    );

    res.json({ ok: true, message: 'Check your phone to complete the M-Pesa payment.' });
  } catch (err) {
    console.error('M-Pesa STK push failed:', err.message);
    res.status(502).json({ error: 'Could not initiate M-Pesa payment. Please try again.' });
  }
});

// Safaricom calls this URL directly (no auth header — verified by the
// unguessable checkout request ID instead) once the payment completes.
router.post('/mpesa-callback', async (req, res) => {
  const body = req.body?.Body?.stkCallback;
  if (!body) return res.status(400).json({ ok: false });

  const { CheckoutRequestID, ResultCode, CallbackMetadata } = body;

  if (ResultCode === 0) {
    const items = CallbackMetadata?.Item || [];
    const receipt = items.find((i) => i.Name === 'MpesaReceiptNumber')?.Value || null;
    await pool.query(
      `UPDATE bookings SET payment_status = 'paid', mpesa_receipt = $1 WHERE mpesa_checkout_request_id = $2`,
      [receipt, CheckoutRequestID]
    );
  } else {
    await pool.query(
      `UPDATE bookings SET payment_status = 'failed' WHERE mpesa_checkout_request_id = $1`,
      [CheckoutRequestID]
    );
  }

  // Safaricom just needs a 200 acknowledging receipt of the callback.
  res.json({ ok: true });
});

// --- Reviews ---

router.post('/reviews', requireAuth, validate(reviewSchema), async (req, res) => {
  const { bookingId, rating, comment } = req.body;

  const result = await pool.query(
    'SELECT student_id, tutor_id, status FROM bookings WHERE id = $1',
    [bookingId]
  );
  const booking = result.rows[0];
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.student_id !== req.user.id) {
    return res.status(403).json({ error: 'Only the student who booked this session can review it' });
  }
  if (booking.status !== 'completed') {
    return res.status(400).json({ error: 'You can only review a completed session' });
  }

  try {
    const review = await pool.query(
      `INSERT INTO reviews (booking_id, student_id, tutor_id, rating, comment)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, rating, comment, created_at`,
      [bookingId, req.user.id, booking.tutor_id, rating, comment]
    );
    res.status(201).json({ review: review.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'You already reviewed this session' });
    }
    throw err;
  }
});

router.get('/reviews/:tutorId', async (req, res) => {
  const result = await pool.query(
    `SELECT r.id, r.rating, r.comment, r.created_at, u.full_name AS student_name
     FROM reviews r JOIN users u ON u.id = r.student_id
     WHERE r.tutor_id = $1 ORDER BY r.created_at DESC LIMIT 50`,
    [req.params.tutorId]
  );
  const avgResult = await pool.query(
    'SELECT ROUND(AVG(rating)::numeric, 1) AS avg_rating, COUNT(*) AS count FROM reviews WHERE tutor_id = $1',
    [req.params.tutorId]
  );
  res.json({ reviews: result.rows, ...avgResult.rows[0] });
});

export default router;
