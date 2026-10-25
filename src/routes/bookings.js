import { Router } from 'express';
import { pool, withTransaction } from '../db/pool.js';
import { requireAuth, requireVerifiedEmail } from '../middleware/auth.js';
import { validate, bookingSchema, bookingStatusSchema, idParam } from '../utils/validation.js';
import { httpError, background } from '../utils/http.js';
import { rules } from '../config.js';
import { addMinutes, isWithinAvailability } from '../utils/time.js';
import { whoMayMove, priceFor } from '../utils/booking-rules.js';

const MINUTE = 60 * 1000;

export function bookingRoutes({ mailer }) {
  const router = Router();

  // A student requests a session with a tutor.
  router.post('/', requireAuth, requireVerifiedEmail, validate(bookingSchema), async (req, res) => {
    const studentId = req.user.id;
    const { tutorId, skillId, scheduledAt, durationMinutes, studentNote } = req.body;

    if (tutorId === studentId) throw httpError(400, 'You cannot book a session with yourself');

    const start = new Date(scheduledAt);
    const end = addMinutes(start, durationMinutes);
    const now = Date.now();
    if (start.getTime() < now + rules.minLeadMinutes * MINUTE) {
      throw httpError(400, 'Sessions must be booked at least an hour ahead');
    }
    if (start.getTime() > now + rules.maxHorizonDays * 24 * 60 * MINUTE) {
      throw httpError(400, `Sessions can be booked up to ${rules.maxHorizonDays} days ahead`);
    }

    const { booking, hourlyRateKes, notify } = await withTransaction(async (db) => {
      // Serialise bookings per tutor (and per student) so two simultaneous requests
      // cannot both pass the overlap check below. Tutor lock first, always, to avoid deadlocks.
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`tutor:${tutorId}`]);
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`student:${studentId}`]);

      const tutor = await db.query(
        `SELECT tp.hourly_rate_kes, u.full_name, u.email,
                (SELECT 1 FROM tutor_skills WHERE tutor_id = tp.user_id AND skill_id = $2) AS teaches_skill,
                (SELECT name FROM skills WHERE id = $2) AS skill_name
         FROM tutor_profiles tp JOIN users u ON u.id = tp.user_id
         WHERE tp.user_id = $1 AND tp.is_published = true`,
        [tutorId, skillId]
      );
      const t = tutor.rows[0];
      if (!t) throw httpError(404, 'Tutor not found or not currently accepting bookings');
      if (!t.teaches_skill) throw httpError(400, 'This tutor does not teach that skill');

      const slots = await db.query(
        'SELECT day_of_week, start_time::text AS start_time, end_time::text AS end_time FROM availability_slots WHERE tutor_id = $1',
        [tutorId]
      );
      if (!isWithinAvailability(slots.rows, start, durationMinutes)) {
        throw httpError(400, "That time is outside the tutor's availability");
      }

      // Two ranges overlap iff a_start < b_end AND b_start < a_end.
      const overlapSql = (column) => `
        SELECT 1 FROM bookings
        WHERE ${column} = $1 AND status IN ('pending', 'confirmed')
          AND scheduled_at < $3 AND scheduled_at + make_interval(mins => duration_minutes) > $2
        LIMIT 1`;
      if ((await db.query(overlapSql('tutor_id'), [tutorId, start, end])).rowCount > 0) {
        throw httpError(409, 'That time slot is no longer available for this tutor');
      }
      if ((await db.query(overlapSql('student_id'), [studentId, start, end])).rowCount > 0) {
        throw httpError(409, 'You already have a session at that time');
      }

      const pending = await db.query(
        `SELECT COUNT(*)::int AS n FROM bookings WHERE student_id = $1 AND status = 'pending'`,
        [studentId]
      );
      if (pending.rows[0].n >= rules.maxPendingPerStudent) {
        throw httpError(429, 'You have several requests waiting for a reply. Wait for those first.');
      }

      const inserted = await db.query(
        `INSERT INTO bookings (student_id, tutor_id, skill_id, scheduled_at, duration_minutes, student_note, price_kes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, status, scheduled_at, duration_minutes, payment_status, price_kes, created_at`,
        [studentId, tutorId, skillId, start, durationMinutes, studentNote, priceFor(t.hourly_rate_kes, durationMinutes)]
      );
      const student = await db.query('SELECT full_name FROM users WHERE id = $1', [studentId]);

      return {
        booking: inserted.rows[0],
        hourlyRateKes: t.hourly_rate_kes,
        notify: {
          to: t.email,
          tutorName: t.full_name,
          studentName: student.rows[0].full_name,
          skillName: t.skill_name,
        },
      };
    });

    background(
      mailer.bookingRequested({ ...notify, scheduledAt: start, durationMinutes, note: studentNote }),
      'booking request email'
    );
    res.status(201).json({ booking, hourlyRateKes, priceKes: booking.price_kes });
  });

  // Everything the logged-in user is involved in, as either student or tutor.
  // The other person's email and phone appear only once the session is confirmed
  // (and stay visible after it is completed).
  router.get('/me', requireAuth, async (req, res) => {
    const { rows } = await pool.query(
      `SELECT b.id, b.status, b.scheduled_at, b.duration_minutes, b.student_note, b.created_at,
              b.scheduled_at + make_interval(mins => b.duration_minutes) AS ends_at,
              b.payment_status, b.paid_at, b.mpesa_receipt, b.payment_result_desc,
              COALESCE(b.price_kes, ROUND(tp.hourly_rate_kes * b.duration_minutes / 60.0)::int) AS price_kes,
              s.name AS skill_name, s.id AS skill_id,
              student.id AS student_id, student.full_name AS student_name,
              tutor.id AS tutor_id, tutor.full_name AS tutor_name,
              CASE WHEN b.status IN ('confirmed', 'completed') THEN student.email END AS student_email,
              CASE WHEN b.status IN ('confirmed', 'completed') THEN student.phone END AS student_phone,
              CASE WHEN b.status IN ('confirmed', 'completed') THEN tutor.email END AS tutor_email,
              CASE WHEN b.status IN ('confirmed', 'completed') THEN tutor.phone END AS tutor_phone,
              EXISTS(SELECT 1 FROM reviews r WHERE r.booking_id = b.id) AS has_review
       FROM bookings b
       JOIN skills s ON s.id = b.skill_id
       JOIN users student ON student.id = b.student_id
       JOIN users tutor ON tutor.id = b.tutor_id
       LEFT JOIN tutor_profiles tp ON tp.user_id = b.tutor_id
       WHERE b.student_id = $1 OR b.tutor_id = $1
       ORDER BY b.scheduled_at DESC`,
      [req.user.id]
    );
    res.json({ bookings: rows });
  });

  // Move a booking along its lifecycle. See utils/booking-rules.js for the allowed moves.
  router.patch(
    '/:id/status',
    requireAuth,
    validate(idParam, 'params'),
    validate(bookingStatusSchema),
    async (req, res) => {
      const { id } = req.params;
      const next = req.body.status;

      const { updated, notify } = await withTransaction(async (db) => {
        const found = await db.query(
          `SELECT b.id, b.student_id, b.tutor_id, b.status, b.scheduled_at, b.duration_minutes, b.payment_status,
                  s.name AS skill_name,
                  student.email AS student_email, student.full_name AS student_name, student.phone AS student_phone,
                  tutor.email AS tutor_email, tutor.full_name AS tutor_name, tutor.phone AS tutor_phone
           FROM bookings b
           JOIN skills s ON s.id = b.skill_id
           JOIN users student ON student.id = b.student_id
           JOIN users tutor ON tutor.id = b.tutor_id
           WHERE b.id = $1 FOR UPDATE OF b`,
          [id]
        );
        const b = found.rows[0];
        if (!b) throw httpError(404, 'Booking not found');

        const isTutor = b.tutor_id === req.user.id;
        const isStudent = b.student_id === req.user.id;
        if (!isTutor && !isStudent) throw httpError(403, 'You are not part of this booking');

        const allowedFor = whoMayMove(b.status, next);
        if (!allowedFor) throw httpError(409, `A ${b.status} booking cannot be changed to ${next}`);
        if (allowedFor === 'tutor' && !isTutor) throw httpError(403, 'Only the tutor can do that');
        if (allowedFor === 'student' && !isStudent) throw httpError(403, 'Only the student can do that');

        const start = new Date(b.scheduled_at);
        const end = addMinutes(start, b.duration_minutes);
        if (next === 'confirmed' && start.getTime() <= Date.now()) {
          throw httpError(409, 'That session time has already passed. Decline the request instead.');
        }
        if (next === 'completed' && end.getTime() > Date.now()) {
          throw httpError(409, 'You can mark a session completed once it has ended');
        }
        if (next === 'cancelled' && b.payment_status === 'paid') {
          throw httpError(409, 'This session has been paid for, so it cannot be cancelled online. Contact the other person to arrange a refund.');
        }

        const updatedRow = await db.query(
          'UPDATE bookings SET status = $1 WHERE id = $2 RETURNING id, status',
          [next, id]
        );
        return { updated: updatedRow.rows[0], notify: { b, isTutor, start } };
      });

      const { b, isTutor, start } = notify;
      const base = { scheduledAt: start, durationMinutes: b.duration_minutes, skillName: b.skill_name };
      if (next === 'confirmed') {
        const contactLines = [
          `Student: ${b.student_name}, ${b.student_email}${b.student_phone ? ', ' + b.student_phone : ''}`,
          `Tutor: ${b.tutor_name}, ${b.tutor_email}${b.tutor_phone ? ', ' + b.tutor_phone : ''}`,
        ];
        for (const to of [b.student_email, b.tutor_email]) {
          background(
            mailer.bookingConfirmed({ to, tutorName: b.tutor_name, studentName: b.student_name, contactLines, ...base }),
            'confirmed email'
          );
        }
      } else if (next === 'declined') {
        background(
          mailer.bookingDeclined({ to: b.student_email, tutorName: b.tutor_name, studentName: b.student_name, ...base }),
          'declined email'
        );
      } else if (next === 'cancelled') {
        background(
          mailer.bookingCancelled({
            to: isTutor ? b.student_email : b.tutor_email,
            cancelledByName: isTutor ? b.tutor_name : b.student_name,
            ...base,
          }),
          'cancelled email'
        );
      }

      res.json({ booking: updated });
    }
  );

  return router;
}
