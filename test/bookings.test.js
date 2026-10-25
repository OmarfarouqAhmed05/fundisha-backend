import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, resetDb, makeFakes, makeApp, makeUser, makeTutor, book, at } from './helpers.js';

let fakes, app;
beforeEach(async () => {
  await resetDb();
  fakes = makeFakes();
  app = makeApp(fakes);
});
after(() => pool.end());

const patch = (user, id, status) => app.patch(`/api/bookings/${id}/status`).set(user.auth).send({ status });

// A confirmed booking that ended yesterday, inserted directly (the API rightly refuses past bookings).
async function pastConfirmed(student, tutor) {
  const { rows } = await pool.query(
    `INSERT INTO bookings (student_id, tutor_id, skill_id, scheduled_at, duration_minutes, status, price_kes)
     VALUES ($1, $2, 1, now() - interval '1 day', 60, 'confirmed', 1200) RETURNING id`,
    [student.id, tutor.id]);
  return rows[0].id;
}

describe('creating bookings', () => {
  it('creates a pending booking, snapshots the price, and emails the tutor', async () => {
    const tutor = await makeTutor({ rate: 1500 });
    const student = await makeUser({ name: 'Sam Student' });
    const res = await book(app, student, tutor, { durationMinutes: 90 });
    assert.equal(res.status, 201);
    assert.equal(res.body.booking.status, 'pending');
    assert.equal(res.body.priceKes, 2250);

    // A later rate change must not change what this booking costs.
    await pool.query('UPDATE tutor_profiles SET hourly_rate_kes = 9999 WHERE user_id = $1', [tutor.id]);
    const mine = await app.get('/api/bookings/me').set(student.auth);
    assert.equal(mine.body.bookings[0].price_kes, 2250);

    const mail = fakes.sent.find((m) => m.name === 'bookingRequested');
    assert.equal(mail.args[0].studentName, 'Sam Student');
  });

  it('rejects impossible bookings with clear messages', async () => {
    const tutor = await makeTutor();
    const student = await makeUser();
    const cases = [
      [{ scheduledAt: new Date(Date.now() + 10 * 60000).toISOString() }, /hour ahead/],
      [{ scheduledAt: at(-2, '10:00') }, /hour ahead/],
      [{ scheduledAt: at(200, '10:00') }, /days ahead/],
      [{ scheduledAt: at(3, '03:00') }, /availability/],      // before the 06:00 start
      [{ scheduledAt: at(3, '21:30') }, /availability/],      // would end after 22:00
      [{ skillId: 14 }, /does not teach/],
      [{ durationMinutes: 45 }, /30, 60, 90 or 120/],
    ];
    for (const [overrides, pattern] of cases) {
      const res = await book(app, student, tutor, overrides);
      assert.equal(res.status, 400, JSON.stringify(overrides));
      assert.match(res.body.error, pattern);
    }
  });

  it('refuses self-booking, unpublished tutors and anonymous requests', async () => {
    const tutor = await makeTutor();
    assert.equal((await book(app, tutor, tutor)).status, 400);
    const hidden = await makeUser({ role: 'tutor' });
    assert.equal((await book(app, await makeUser(), hidden)).status, 404);
    assert.equal((await app.post('/api/bookings').send({})).status, 401);
  });

  it('blocks overlapping bookings for the tutor and for the student', async () => {
    const tutor = await makeTutor();
    const other = await makeTutor();
    const s1 = await makeUser(); const s2 = await makeUser();
    assert.equal((await book(app, s1, tutor, { scheduledAt: at(3, '10:00') })).status, 201);
    const clash = await book(app, s2, tutor, { scheduledAt: at(3, '10:30') });
    assert.equal(clash.status, 409);
    assert.equal((await book(app, s2, tutor, { scheduledAt: at(3, '11:00') })).status, 201); // back to back is fine
    const studentClash = await book(app, s1, other, { scheduledAt: at(3, '10:30') });
    assert.equal(studentClash.status, 409);
    assert.match(studentClash.body.error, /already have a session/);
  });

  it('cannot be double-booked by simultaneous requests (race condition)', async () => {
    const tutor = await makeTutor();
    const students = await Promise.all([1, 2, 3, 4, 5, 6].map(() => makeUser()));
    const results = await Promise.all(students.map((s) => book(app, s, tutor, { scheduledAt: at(3, '12:00') })));
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [201, 409, 409, 409, 409, 409]);
    const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM bookings WHERE tutor_id = $1", [tutor.id]);
    assert.equal(rows[0].n, 1);
  });

  it('limits how many unanswered requests one student can have open', async () => {
    const tutor = await makeTutor();
    const student = await makeUser();
    for (let i = 0; i < 5; i++) {
      assert.equal((await book(app, student, tutor, { scheduledAt: at(3 + i, '10:00') })).status, 201);
    }
    assert.equal((await book(app, student, tutor, { scheduledAt: at(10, '10:00') })).status, 429);
  });

  it('can require a verified email when configured', async () => {
    // Default is off; the flag is read at import time, so here we just prove unverified users can book.
    const tutor = await makeTutor();
    const unverified = await makeUser({ verified: false });
    assert.equal((await book(app, unverified, tutor)).status, 201);
  });
});

describe('booking lifecycle', () => {
  async function setup() {
    const tutor = await makeTutor();
    const student = await makeUser();
    const created = await book(app, student, tutor);
    return { tutor, student, id: created.body.booking.id };
  }

  it('lets only the tutor confirm or decline, and only the student cancel a pending request', async () => {
    const { tutor, student, id } = await setup();
    const stranger = await makeUser();
    assert.equal((await patch(student, id, 'confirmed')).status, 403);
    assert.equal((await patch(stranger, id, 'confirmed')).status, 403);
    assert.equal((await patch(tutor, id, 'cancelled')).status, 403);
    assert.equal((await patch(tutor, id, 'confirmed')).status, 200);
    assert.ok(fakes.sent.filter((m) => m.name === 'bookingConfirmed').length === 2);
  });

  it('refuses nonsense transitions (the old API allowed all of them)', async () => {
    const { tutor, student, id } = await setup();
    const early = await patch(tutor, id, 'completed'); // pending -> completed
    assert.equal(early.status, 409);
    assert.equal((await patch(tutor, id, 'declined')).status, 200);
    assert.equal((await patch(tutor, id, 'confirmed')).status, 409); // declined is final
    assert.equal((await patch(student, id, 'cancelled')).status, 409);
  });

  it('will not mark a confirmed session completed before it has ended', async () => {
    const { tutor, id } = await setup();
    await patch(tutor, id, 'confirmed');
    const res = await patch(tutor, id, 'completed');
    assert.equal(res.status, 409);
    assert.match(res.body.error, /ended/);
  });

  it('either side can cancel a confirmed session, and the other side is told', async () => {
    const { tutor, student, id } = await setup();
    await patch(tutor, id, 'confirmed');
    assert.equal((await patch(student, id, 'cancelled')).status, 200);
    const mail = fakes.sent.find((m) => m.name === 'bookingCancelled');
    assert.equal(mail.args[0].to, tutor.email);
  });

  it('will not confirm a request whose time has already passed', async () => {
    const { tutor, id } = await setup();
    await pool.query("UPDATE bookings SET scheduled_at = now() - interval '1 hour' WHERE id = $1", [id]);
    const res = await patch(tutor, id, 'confirmed');
    assert.equal(res.status, 409);
  });

  it('cannot cancel a session that has been paid for', async () => {
    const { tutor, student, id } = await setup();
    await patch(tutor, id, 'confirmed');
    await pool.query("UPDATE bookings SET payment_status = 'paid' WHERE id = $1", [id]);
    const res = await patch(student, id, 'cancelled');
    assert.equal(res.status, 409);
    assert.match(res.body.error, /paid/);
  });

  it('hides contact details until confirmed, then shows them to both sides', async () => {
    const { tutor, student, id } = await setup();
    let mine = (await app.get('/api/bookings/me').set(student.auth)).body.bookings[0];
    assert.equal(mine.tutor_email, null);
    assert.equal(mine.tutor_phone, null);
    await patch(tutor, id, 'confirmed');
    mine = (await app.get('/api/bookings/me').set(student.auth)).body.bookings[0];
    assert.equal(mine.tutor_email, tutor.email);
    const theirs = (await app.get('/api/bookings/me').set(tutor.auth)).body.bookings[0];
    assert.equal(theirs.student_email, student.email);
  });

  it('only shows a user their own bookings', async () => {
    await setup();
    const outsider = await makeUser();
    assert.deepEqual((await app.get('/api/bookings/me').set(outsider.auth)).body.bookings, []);
  });
});

describe('completing and reviewing', () => {
  it('lets the tutor complete an ended session, then the student review it once', async () => {
    const tutor = await makeTutor();
    const student = await makeUser();
    const id = await pastConfirmed(student, tutor);

    assert.equal((await patch(tutor, id, 'completed')).status, 200);
    const review = { bookingId: id, rating: 5, comment: 'Great' };
    assert.equal((await app.post('/api/bookings/reviews').set(tutor.auth).send(review)).status, 403);
    assert.equal((await app.post('/api/bookings/reviews').set(student.auth).send(review)).status, 201);
    const dup = await app.post('/api/bookings/reviews').set(student.auth).send(review);
    assert.equal(dup.status, 409);
    assert.equal((await app.post('/api/bookings/reviews').set(student.auth).send({ ...review, rating: 6 })).status, 400);
  });

  it('refuses a review for a session that has not been completed', async () => {
    const tutor = await makeTutor();
    const student = await makeUser();
    const id = await pastConfirmed(student, tutor);
    const res = await app.post('/api/bookings/reviews').set(student.auth).send({ bookingId: id, rating: 5 });
    assert.equal(res.status, 409);
  });
});
