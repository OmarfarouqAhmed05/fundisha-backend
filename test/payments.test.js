import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, resetDb, makeFakes, makeApp, makeUser, makeTutor, book } from './helpers.js';

let fakes, app, tutor, student, bookingId;
const SECRET = 'test-callback-secret';

beforeEach(async () => {
  await resetDb();
  fakes = makeFakes();
  app = makeApp(fakes);
  tutor = await makeTutor({ rate: 1500 });
  student = await makeUser({ name: 'Sam Student' });
  bookingId = (await book(app, student, tutor, { durationMinutes: 60 })).body.booking.id;
});
after(() => pool.end());

const confirm = () => app.patch(`/api/bookings/${bookingId}/status`).set(tutor.auth).send({ status: 'confirmed' });
const pay = (phone = '0712 345 678') => app.post('/api/bookings/mpesa/initiate').set(student.auth).send({ bookingId, phone });
const status = async () => (await pool.query('SELECT * FROM bookings WHERE id = $1', [bookingId])).rows[0];
const callback = (checkoutId, { code = 0, amount = 1500, receipt = 'QWE123', secret = SECRET } = {}) =>
  app.post(`/api/bookings/mpesa-callback/${secret}`).send({
    Body: { stkCallback: {
      MerchantRequestID: 'm1', CheckoutRequestID: checkoutId, ResultCode: code,
      ResultDesc: code === 0 ? 'The service request is processed successfully.' : 'Request cancelled by user',
      ...(code === 0 ? { CallbackMetadata: { Item: [
        { Name: 'Amount', Value: amount }, { Name: 'MpesaReceiptNumber', Value: receipt }, { Name: 'PhoneNumber', Value: 254712345678 },
      ] } } : {}),
    } },
  });

describe('starting a payment', () => {
  it('only works after the tutor confirms, and only for the student', async () => {
    assert.equal((await pay()).status, 409);
    await confirm();
    const stranger = await makeUser();
    const res = await app.post('/api/bookings/mpesa/initiate').set(stranger.auth).send({ bookingId, phone: '0712345678' });
    assert.equal(res.status, 403);
  });

  it('sends the STK push with the stored price and a normalised phone number', async () => {
    await confirm();
    const res = await pay('0712 345 678');
    assert.equal(res.status, 200);
    assert.equal(res.body.amountKes, 1500);
    assert.equal(fakes.mpesa.pushes[0].phone, '254712345678');
    assert.equal(fakes.mpesa.pushes[0].amount, 1500);
    assert.ok(fakes.mpesa.pushes[0].accountReference.length <= 12);
    assert.equal((await status()).payment_status, 'pending');
  });

  it('rejects an invalid phone, a double tap, and an unconfigured server', async () => {
    await confirm();
    assert.equal((await pay('12345')).status, 400);
    assert.equal((await pay()).status, 200);
    const again = await pay();
    assert.equal(again.status, 409); // prompt already sent
    assert.equal(fakes.mpesa.pushes.length, 1);

    fakes.mpesa.configured = false;
    await pool.query("UPDATE bookings SET payment_status = 'unpaid' WHERE id = $1", [bookingId]);
    assert.equal((await pay()).status, 503);
  });

  it('marks the attempt failed (and retryable) if Safaricom cannot be reached', async () => {
    await confirm();
    fakes.mpesa.initiateSTKPush = async () => { throw new Error('boom'); };
    const res = await pay();
    assert.equal(res.status, 502);
    assert.equal((await status()).payment_status, 'failed');
    fakes.mpesa.initiateSTKPush = async () => ({ checkoutRequestId: 'ws_CO_retry' });
    assert.equal((await pay()).status, 200);
  });
});

describe('the Safaricom callback', () => {
  async function pending() {
    await confirm();
    await pay();
    return (await status()).mpesa_checkout_request_id;
  }

  it('rejects callbacks that do not carry the secret (the old API accepted anyone)', async () => {
    const id = await pending();
    const res = await callback(id, { secret: 'guessed-wrong' });
    assert.equal(res.status, 404);
    assert.equal((await status()).payment_status, 'pending');
  });

  it('marks the booking paid, stores the receipt, and emails both people once', async () => {
    const id = await pending();
    assert.equal((await callback(id)).status, 200);
    const b = await status();
    assert.equal(b.payment_status, 'paid');
    assert.equal(b.mpesa_receipt, 'QWE123');
    assert.ok(b.paid_at);
    assert.equal(fakes.sent.filter((m) => m.name === 'paymentReceived').length, 2);

    await callback(id); // Safaricom retries: must be harmless
    assert.equal(fakes.sent.filter((m) => m.name === 'paymentReceived').length, 2);
    assert.equal((await pay()).status, 409); // cannot pay twice
  });

  it('records a cancelled prompt as failed, with a readable reason, and allows a retry', async () => {
    const id = await pending();
    await callback(id, { code: 1032 });
    const b = await status();
    assert.equal(b.payment_status, 'failed');
    assert.match(b.payment_result_desc, /cancelled/i);
    assert.equal((await pay()).status, 200);
  });

  it('does not mark a booking paid when the amount does not match', async () => {
    const id = await pending();
    await callback(id, { amount: 1 });
    assert.equal((await status()).payment_status, 'failed');
  });

  it('acknowledges unknown or malformed callbacks without touching anything', async () => {
    await pending();
    assert.equal((await callback('ws_CO_unknown')).status, 200);
    const empty = await app.post(`/api/bookings/mpesa-callback/${SECRET}`).send({});
    assert.equal(empty.status, 200);
    assert.equal((await status()).payment_status, 'pending');
  });
});

describe('polling when no callback arrives', () => {
  async function pendingAged(seconds) {
    await confirm();
    await pay();
    await pool.query(`UPDATE bookings SET payment_requested_at = now() - make_interval(secs => $2) WHERE id = $1`, [bookingId, seconds]);
  }
  const poll = (user = student) => app.get(`/api/bookings/${bookingId}/payment`).set(user.auth);

  it('asks Safaricom directly and settles a successful payment', async () => {
    await pendingAged(30);
    fakes.mpesa.queryResult = { state: 'paid', description: 'ok' };
    const res = await poll();
    assert.equal(res.body.paymentStatus, 'paid');
    assert.equal(fakes.sent.filter((m) => m.name === 'paymentReceived').length, 2);
    // The callback arriving later only fills in the receipt.
    const id = (await status()).mpesa_checkout_request_id;
    await callback(id, { receipt: 'LATE999' });
    assert.equal((await status()).mpesa_receipt, 'LATE999');
    assert.equal(fakes.sent.filter((m) => m.name === 'paymentReceived').length, 2);
  });

  it('settles a declined payment as failed', async () => {
    await pendingAged(30);
    fakes.mpesa.queryResult = { state: 'failed', description: 'Request cancelled by user' };
    const res = await poll();
    assert.equal(res.body.paymentStatus, 'failed');
    assert.match(res.body.message, /cancelled/i);
  });

  it('leaves a payment pending while the customer is still deciding, and gives up after five minutes', async () => {
    await pendingAged(30);
    assert.equal((await poll()).body.paymentStatus, 'pending');
    await pool.query("UPDATE bookings SET payment_requested_at = now() - interval '10 minutes', payment_checked_at = NULL WHERE id = $1", [bookingId]);
    assert.equal((await poll()).body.paymentStatus, 'failed');
  });

  it('does not query too eagerly and only serves people on the booking', async () => {
    await pendingAged(3); // too fresh to query
    fakes.mpesa.queryResult = { state: 'paid' };
    assert.equal((await poll()).body.paymentStatus, 'pending');
    const stranger = await makeUser();
    assert.equal((await poll(stranger)).status, 403);
    assert.equal((await poll(tutor)).status, 200);
  });
});
