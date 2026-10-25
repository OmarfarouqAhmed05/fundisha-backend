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

describe('tutor self-service', () => {
  it('lets a tutor read their own profile while it is unpublished (the old API could not)', async () => {
    const tutor = await makeUser({ role: 'tutor' });
    const res = await app.get('/api/tutors/me/profile').set(tutor.auth);
    assert.equal(res.status, 200);
    assert.equal(res.body.profile.isPublished, false);
    assert.deepEqual(res.body.profile.availability, []);
  });

  it('refuses to publish an incomplete profile and says exactly what is missing', async () => {
    const tutor = await makeUser({ role: 'tutor' });
    const res = await app
      .put('/api/tutors/me/profile').set(tutor.auth)
      .send({ headline: '', hourlyRateKes: 0, experienceYears: 1, skillIds: [], isPublished: true });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body.missing, ['a headline', 'an hourly rate above 0', 'at least one skill', 'at least one availability slot']);
  });

  it('saves availability, then publishes, and the profile round-trips', async () => {
    const tutor = await makeUser({ role: 'tutor' });
    const avail = await app.put('/api/tutors/me/availability').set(tutor.auth)
      .send({ slots: [{ dayOfWeek: 1, startTime: '14:00', endTime: '17:00' }] });
    assert.equal(avail.status, 200);
    const save = await app.put('/api/tutors/me/profile').set(tutor.auth).send({
      headline: 'SQL tutor', bio: 'Hi there', hourlyRateKes: 1500, experienceYears: 4, skillIds: [5, 5, 2], isPublished: true,
    });
    assert.equal(save.status, 200);
    assert.deepEqual(save.body.profile.skillIds, [2, 5]); // duplicates removed
    assert.equal(save.body.profile.bio, 'Hi there');
    assert.equal(save.body.profile.availability[0].startTime, '14:00');
    const pub = await app.get(`/api/tutors/${tutor.id}`);
    assert.equal(pub.status, 200);
    assert.equal(pub.body.bio, 'Hi there');
  });

  it('validates availability: overlaps and backwards times are rejected', async () => {
    const tutor = await makeUser({ role: 'tutor' });
    const overlap = await app.put('/api/tutors/me/availability').set(tutor.auth).send({
      slots: [{ dayOfWeek: 1, startTime: '14:00', endTime: '17:00' }, { dayOfWeek: 1, startTime: '16:00', endTime: '18:00' }],
    });
    assert.equal(overlap.status, 400);
    const backwards = await app.put('/api/tutors/me/availability').set(tutor.auth)
      .send({ slots: [{ dayOfWeek: 1, startTime: '17:00', endTime: '14:00' }] });
    assert.equal(backwards.status, 400);
  });

  it('unpublishes a tutor who clears all their availability', async () => {
    const tutor = await makeTutor();
    await app.put('/api/tutors/me/availability').set(tutor.auth).send({ slots: [] });
    assert.equal((await app.get(`/api/tutors/${tutor.id}`)).status, 404);
  });

  it('rejects unknown skills with a clear message', async () => {
    const tutor = await makeUser({ role: 'tutor' });
    const res = await app.put('/api/tutors/me/profile').set(tutor.auth)
      .send({ headline: 'x', hourlyRateKes: 100, experienceYears: 0, skillIds: [9999], isPublished: false });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /skill/i);
  });
});

describe('searching tutors', () => {
  it('returns skills, rating and pagination, and only published tutors', async () => {
    const a = await makeTutor({ name: 'Ann Alpha', rate: 1000 });
    await makeTutor({ name: 'Bob Beta', rate: 3000 });
    await makeUser({ role: 'tutor', name: 'Hidden Unpublished' });
    const res = await app.get('/api/tutors');
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 2);
    assert.deepEqual(res.body.tutors[0].skills, ['JavaScript', 'Python']);
    assert.equal(res.body.tutors[0].avg_rating, null);
    assert.equal(res.body.tutors[0].review_count, 0);

    const cheap = await app.get('/api/tutors?maxRate=1500');
    assert.deepEqual(cheap.body.tutors.map((t) => t.id), [a.id]);
    const paged = await app.get('/api/tutors?limit=1&page=2&sort=price_desc');
    assert.equal(paged.body.tutors.length, 1);
    assert.equal(paged.body.pages, 2);
    assert.equal(paged.body.tutors[0].id, a.id);
  });

  it('filters by skill and by free text (name, headline or skill name), escaping wildcards', async () => {
    await makeTutor({ name: 'Ann Alpha' });
    assert.equal((await app.get('/api/tutors?skill=Python')).body.total, 1);
    assert.equal((await app.get('/api/tutors?skill=Guitar')).body.total, 0);
    assert.equal((await app.get('/api/tutors?q=alpha')).body.total, 1);
    assert.equal((await app.get('/api/tutors?q=javascript')).body.total, 1);
    assert.equal((await app.get('/api/tutors?q=%25')).body.total, 0); // "%" is searched literally
  });

  it('answers bad input with a 400/404, never a 500', async () => {
    assert.equal((await app.get('/api/tutors?maxRate=abc')).status, 400);
    assert.equal((await app.get('/api/tutors?limit=9999')).status, 400);
    assert.equal((await app.get('/api/tutors/not-a-uuid')).status, 404);
    assert.equal((await app.get('/api/tutors/3f2b0d1e-5c1a-4b0e-9d3f-1a2b3c4d5e6f')).status, 404);
    assert.equal((await app.get('/api/bookings/reviews/not-a-uuid')).status, 400);
  });

  it('shows the average rating once reviews exist', async () => {
    const tutor = await makeTutor();
    const s1 = await makeUser(); const s2 = await makeUser();
    for (const [student, rating] of [[s1, 5], [s2, 4]]) {
      const b = await pool.query(
        `INSERT INTO bookings (student_id, tutor_id, skill_id, scheduled_at, status) VALUES ($1, $2, 1, now() - interval '2 days', 'completed') RETURNING id`,
        [student.id, tutor.id]);
      await pool.query('INSERT INTO reviews (booking_id, student_id, tutor_id, rating) VALUES ($1, $2, $3, $4)', [b.rows[0].id, student.id, tutor.id, rating]);
    }
    const list = await app.get('/api/tutors');
    assert.equal(list.body.tutors[0].avg_rating, 4.5);
    assert.equal(list.body.tutors[0].review_count, 2);
    const reviews = await app.get(`/api/bookings/reviews/${tutor.id}`);
    assert.equal(reviews.body.count, 2);
    assert.equal(reviews.body.avg_rating, 4.5);
  });
});

describe('bookable slots', () => {
  it('offers start times inside availability and hides ones that are taken', async () => {
    const tutor = await makeTutor();
    const student = await makeUser();
    const date = at(3, '10:00').slice(0, 10); // a Nairobi 10:00 is the same UTC date
    const before = await app.get(`/api/tutors/${tutor.id}/slots?date=${date}&duration=60`);
    assert.equal(before.status, 200);
    const labels = before.body.slots.map((s) => s.label);
    assert.ok(labels.includes('10:00') && labels.includes('10:30'));
    assert.ok(!labels.includes('21:30')); // a 60-minute session from 21:30 would run past the 22:00 slot end

    assert.equal((await book(app, student, tutor, { scheduledAt: at(3, '10:00') })).status, 201);
    const after = (await app.get(`/api/tutors/${tutor.id}/slots?date=${date}&duration=60`)).body.slots.map((s) => s.label);
    assert.ok(!after.includes('10:00') && !after.includes('10:30')); // overlaps 10:00-11:00
    assert.ok(after.includes('09:00') && after.includes('11:00'));
  });

  it('returns nothing for the past and validates the date', async () => {
    const tutor = await makeTutor();
    const yesterday = at(-1, '10:00').slice(0, 10);
    assert.deepEqual((await app.get(`/api/tutors/${tutor.id}/slots?date=${yesterday}`)).body.slots, []);
    assert.equal((await app.get(`/api/tutors/${tutor.id}/slots?date=2026-02-31`)).status, 400);
  });
});
