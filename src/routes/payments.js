import { Router } from 'express';
import { pool } from '../db/pool.js';
import { config, rules } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { validate, mpesaInitiateSchema, idParam } from '../utils/validation.js';
import { httpError, background } from '../utils/http.js';
import { safeEqual } from '../utils/tokens.js';
import { priceFor } from '../utils/booking-rules.js';

// M-Pesa STK push payments. A booking is paid for once the tutor has confirmed it.
//
// Payment status: unpaid -> pending (prompt sent) -> paid | failed. A failed or expired
// attempt can be retried. Two independent paths can resolve a pending payment, and both
// are safe to run in any order: Safaricom's callback, and our own STK Query polling.
export function paymentRoutes({ mpesa, mailer }) {
  const router = Router();

  async function loadForNotify(bookingId) {
    const { rows } = await pool.query(
      `SELECT b.id, b.scheduled_at, b.duration_minutes, b.price_kes, b.mpesa_receipt,
              student.email AS student_email, student.full_name AS student_name,
              tutor.email AS tutor_email, tutor.full_name AS tutor_name
       FROM bookings b
       JOIN users student ON student.id = b.student_id
       JOIN users tutor ON tutor.id = b.tutor_id
       WHERE b.id = $1`,
      [bookingId]
    );
    return rows[0];
  }

  function notifyPaid(b) {
    for (const to of [b.student_email, b.tutor_email]) {
      background(
        mailer.paymentReceived({
          to,
          studentName: b.student_name,
          tutorName: b.tutor_name,
          amountKes: b.price_kes,
          receipt: b.mpesa_receipt,
          scheduledAt: b.scheduled_at,
          durationMinutes: b.duration_minutes,
        }),
        'payment email'
      );
    }
  }

  // Marks a pending payment as paid. Returns true only the first time (so emails go out once).
  async function markPaid(bookingId, receipt) {
    const { rowCount } = await pool.query(
      `UPDATE bookings
       SET payment_status = 'paid', paid_at = COALESCE(paid_at, now()),
           mpesa_receipt = COALESCE($2, mpesa_receipt), payment_result_desc = NULL
       WHERE id = $1 AND payment_status = 'pending'`,
      [bookingId, receipt]
    );
    if (rowCount === 0 && receipt) {
      // Already paid (resolved by polling); the callback just supplies the receipt number.
      await pool.query(
        `UPDATE bookings SET mpesa_receipt = $2 WHERE id = $1 AND payment_status = 'paid' AND mpesa_receipt IS NULL`,
        [bookingId, receipt]
      );
    }
    return rowCount > 0;
  }

  async function markFailed(bookingId, description) {
    await pool.query(
      `UPDATE bookings SET payment_status = 'failed', payment_result_desc = $2
       WHERE id = $1 AND payment_status = 'pending'`,
      [bookingId, String(description || 'The payment was not completed').slice(0, 200)]
    );
  }

  // --- Student starts a payment ---
  router.post('/mpesa/initiate', requireAuth, validate(mpesaInitiateSchema), async (req, res) => {
    if (!mpesa.isConfigured()) {
      throw httpError(503, 'M-Pesa payments are not set up on this server yet');
    }
    const { bookingId, phone } = req.body;

    const found = await pool.query(
      `SELECT b.id, b.student_id, b.status, b.duration_minutes,
              COALESCE(b.price_kes, tp.hourly_rate_kes * b.duration_minutes / 60) AS price
       FROM bookings b LEFT JOIN tutor_profiles tp ON tp.user_id = b.tutor_id
       WHERE b.id = $1`,
      [bookingId]
    );
    const booking = found.rows[0];
    if (!booking) throw httpError(404, 'Booking not found');
    if (booking.student_id !== req.user.id) throw httpError(403, 'Only the student on this booking can pay for it');
    if (booking.status !== 'confirmed') {
      throw httpError(409, 'You can pay once the tutor has confirmed the session');
    }
    const amount = priceFor(Number(booking.price), 60);

    // Reserve the payment slot atomically: blocks double payments and double prompts, while
    // allowing a retry after a failure or once the previous prompt has clearly expired.
    const reserved = await pool.query(
      `UPDATE bookings
       SET payment_status = 'pending', payment_requested_at = now(), payer_phone = $2,
           payment_result_desc = NULL, mpesa_checkout_request_id = NULL
       WHERE id = $1
         AND (payment_status IN ('unpaid', 'failed')
              OR (payment_status = 'pending'
                  AND payment_requested_at < now() - make_interval(secs => $3)))
       RETURNING id`,
      [bookingId, phone, rules.stkRetryAfterSeconds]
    );
    if (reserved.rowCount === 0) {
      const current = await pool.query('SELECT payment_status FROM bookings WHERE id = $1', [bookingId]);
      throw httpError(
        409,
        current.rows[0].payment_status === 'paid'
          ? 'This session has already been paid for'
          : 'A payment prompt was just sent. Check your phone, or try again in a couple of minutes.'
      );
    }

    try {
      const { checkoutRequestId } = await mpesa.initiateSTKPush({
        phone,
        amount,
        accountReference: `FND${bookingId.slice(0, 8)}`,
        description: 'Fundisha',
      });
      await pool.query('UPDATE bookings SET mpesa_checkout_request_id = $1 WHERE id = $2', [
        checkoutRequestId,
        bookingId,
      ]);
    } catch (err) {
      console.error('M-Pesa STK push failed:', err.message);
      await pool.query(
        `UPDATE bookings SET payment_status = 'failed', payment_result_desc = $2 WHERE id = $1`,
        [bookingId, 'We could not reach M-Pesa. Please try again.']
      );
      throw httpError(502, 'Could not start the M-Pesa payment. Please try again.');
    }

    res.json({ ok: true, amountKes: amount, message: 'Check your phone and enter your M-Pesa PIN to complete the payment.' });
  });

  // --- Safaricom calls this when the customer pays or cancels ---
  // The secret in the path is what proves the request came from Safaricom's registered URL.
  router.post('/mpesa-callback/:secret', async (req, res) => {
    if (!config.mpesa.callbackSecret || !safeEqual(req.params.secret, config.mpesa.callbackSecret)) {
      return res.status(404).json({ error: 'Not found' });
    }

    const body = req.body?.Body?.stkCallback;
    // Always answer 200 from here on, so Safaricom does not keep retrying.
    const accepted = { ResultCode: 0, ResultDesc: 'Accepted' };
    if (!body?.CheckoutRequestID) return res.json(accepted);

    const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = body;
    const found = await pool.query(
      'SELECT id, price_kes, payment_status FROM bookings WHERE mpesa_checkout_request_id = $1',
      [CheckoutRequestID]
    );
    const booking = found.rows[0];
    if (!booking) return res.json(accepted);

    if (Number(ResultCode) === 0) {
      const items = CallbackMetadata?.Item || [];
      const receipt = items.find((i) => i.Name === 'MpesaReceiptNumber')?.Value || null;
      const paidAmount = Number(items.find((i) => i.Name === 'Amount')?.Value);

      if (booking.price_kes && Number.isFinite(paidAmount) && paidAmount !== booking.price_kes) {
        // Money moved but not the amount we asked for: do not mark it paid; a human should look.
        console.error(
          `[mpesa] Amount mismatch for booking ${booking.id}: expected ${booking.price_kes}, got ${paidAmount} (receipt ${receipt})`
        );
        await markFailed(booking.id, 'The amount paid did not match the session price. Contact support.');
        return res.json(accepted);
      }
      if (await markPaid(booking.id, receipt)) notifyPaid(await loadForNotify(booking.id));
    } else {
      await markFailed(booking.id, ResultDesc);
    }
    res.json(accepted);
  });

  // --- The page polls this after the prompt is sent ---
  router.get('/:id/payment', requireAuth, validate(idParam, 'params'), async (req, res) => {
    const found = await pool.query(
      `SELECT id, student_id, tutor_id, payment_status, payment_requested_at, payment_checked_at,
              mpesa_checkout_request_id
       FROM bookings WHERE id = $1`,
      [req.params.id]
    );
    const b = found.rows[0];
    if (!b) throw httpError(404, 'Booking not found');
    if (b.student_id !== req.user.id && b.tutor_id !== req.user.id) {
      throw httpError(403, 'You are not part of this booking');
    }

    // No callback yet? Ask Safaricom directly, at most every few seconds per booking.
    if (b.payment_status === 'pending' && b.mpesa_checkout_request_id && mpesa.isConfigured()) {
      const ageSeconds = (Date.now() - new Date(b.payment_requested_at).getTime()) / 1000;
      if (ageSeconds > 8) {
        const claimed = await pool.query(
          `UPDATE bookings SET payment_checked_at = now()
           WHERE id = $1 AND payment_status = 'pending'
             AND (payment_checked_at IS NULL OR payment_checked_at < now() - interval '4 seconds')
           RETURNING id`,
          [b.id]
        );
        if (claimed.rowCount > 0) {
          try {
            const result = await mpesa.queryStkStatus(b.mpesa_checkout_request_id);
            if (result.state === 'paid') {
              if (await markPaid(b.id, null)) notifyPaid(await loadForNotify(b.id));
            } else if (result.state === 'failed') {
              await markFailed(b.id, result.description);
            } else if (ageSeconds > 300) {
              await markFailed(b.id, 'No response from M-Pesa. Please try again.');
            }
          } catch (err) {
            console.error('M-Pesa status query failed:', err.message);
          }
        }
      }
    }

    const current = await pool.query(
      `SELECT payment_status, mpesa_receipt, payment_result_desc, paid_at FROM bookings WHERE id = $1`,
      [b.id]
    );
    const row = current.rows[0];
    res.json({
      paymentStatus: row.payment_status,
      receipt: row.mpesa_receipt,
      message: row.payment_result_desc,
      paidAt: row.paid_at,
    });
  });

  return router;
}
