import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, resetDb, makeFakes, makeApp, makeUser } from './helpers.js';

let fakes, app;
beforeEach(async () => {
  await resetDb();
  fakes = makeFakes();
  app = makeApp(fakes);
});
after(() => pool.end());

const signup = (body = {}) =>
  app.post('/api/auth/register').send({
    email: 'Amina@Example.com ',
    password: 'password123',
    fullName: 'Amina Hassan',
    role: 'student',
    ...body,
  });

describe('registration', () => {
  it('normalises the email, returns a token and never returns the password hash', async () => {
    const res = await signup();
    assert.equal(res.status, 201);
    assert.equal(res.body.user.email, 'amina@example.com');
    assert.ok(res.body.token);
    assert.equal(res.body.user.password_hash, undefined);
  });

  it('treats emails that differ only by case as the same account', async () => {
    assert.equal((await signup()).status, 201);
    const dup = await signup({ email: 'AMINA@example.com' });
    assert.equal(dup.status, 409);
  });

  it('explains validation problems in plain words', async () => {
    const res = await signup({ password: 'short', fullName: 'A' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /at least 8|full name/i);
    assert.ok(res.body.details.password);
  });

  it('stores phone numbers in M-Pesa format and rejects nonsense', async () => {
    const ok = await signup({ phone: '0712 345 678' });
    assert.equal(ok.body.user.phone, '254712345678');
    const plus = await signup({ email: 'b@example.com', phone: '+254 112 345 678' });
    assert.equal(plus.body.user.phone, '254112345678');
    const bad = await signup({ email: 'c@example.com', phone: '12345' });
    assert.equal(bad.status, 400);
  });

  it('creates a tutor profile for tutors', async () => {
    const res = await signup({ role: 'tutor' });
    const { rows } = await pool.query('SELECT 1 FROM tutor_profiles WHERE user_id = $1', [res.body.user.id]);
    assert.equal(rows.length, 1);
  });

  it('still registers the user when the verification email cannot be sent', async () => {
    const broken = makeFakes();
    broken.mailer.sendVerificationEmail = async () => { throw new Error('mail down'); };
    const res = await makeApp(broken).post('/api/auth/register').send({
      email: 'z@example.com', password: 'password123', fullName: 'Zed Zed',
    });
    assert.equal(res.status, 201);
  });
});

describe('login', () => {
  it('logs in with any email casing and rejects wrong credentials with one message', async () => {
    await signup();
    const ok = await app.post('/api/auth/login').send({ email: 'AMINA@example.com', password: 'password123' });
    assert.equal(ok.status, 200);
    const wrongPw = await app.post('/api/auth/login').send({ email: 'amina@example.com', password: 'nope-nope' });
    const noUser = await app.post('/api/auth/login').send({ email: 'ghost@example.com', password: 'nope-nope' });
    assert.equal(wrongPw.status, 401);
    assert.equal(noUser.status, 401);
    assert.equal(wrongPw.body.error, noUser.body.error);
  });

  it('rejects requests with no token or a bad token', async () => {
    assert.equal((await app.get('/api/auth/me')).status, 401);
    assert.equal((await app.get('/api/auth/me').set('Authorization', 'Bearer abc')).status, 401);
  });
});

describe('email verification', () => {
  it('verifies once, stores only a hash, and rejects reuse', async () => {
    const reg = await signup();
    const raw = fakes.sent.find((m) => m.name === 'sendVerificationEmail').args[1];
    const stored = await pool.query('SELECT token FROM email_verification_tokens');
    assert.notEqual(stored.rows[0].token, raw);

    assert.equal((await app.post('/api/auth/verify-email').send({ token: raw })).status, 200);
    const me = await app.get('/api/auth/me').set('Authorization', `Bearer ${reg.body.token}`);
    assert.equal(me.body.user.email_verified, true);
    assert.equal((await app.post('/api/auth/verify-email').send({ token: raw })).status, 400);
  });

  it('can resend the link, and the old link stops working', async () => {
    const reg = await signup();
    const first = fakes.sent.find((m) => m.name === 'sendVerificationEmail').args[1];
    const res = await app.post('/api/auth/resend-verification').set('Authorization', `Bearer ${reg.body.token}`);
    assert.equal(res.status, 200);
    const second = fakes.sent.filter((m) => m.name === 'sendVerificationEmail').at(-1).args[1];
    assert.notEqual(first, second);
    assert.equal((await app.post('/api/auth/verify-email').send({ token: first })).status, 400);
    assert.equal((await app.post('/api/auth/verify-email').send({ token: second })).status, 200);
  });
});

describe('password reset', () => {
  it('resets once, signs out old sessions, and does not reveal whether an email exists', async () => {
    const reg = await signup();
    const unknown = await app.post('/api/auth/forgot-password').send({ email: 'ghost@example.com' });
    const known = await app.post('/api/auth/forgot-password').send({ email: 'amina@example.com' });
    assert.equal(unknown.status, 200);
    assert.deepEqual(unknown.body, known.body);

    const raw = fakes.sent.find((m) => m.name === 'sendPasswordResetEmail').args[1];
    const reset = await app.post('/api/auth/reset-password').send({ token: raw, newPassword: 'brand-new-pass' });
    assert.equal(reset.status, 200);
    assert.equal((await app.post('/api/auth/reset-password').send({ token: raw, newPassword: 'another-pass-1' })).status, 400);

    // The token from before the reset no longer works; the new password does.
    const old = await app.get('/api/auth/me').set('Authorization', `Bearer ${reg.body.token}`);
    assert.equal(old.status, 401);
    const login = await app.post('/api/auth/login').send({ email: 'amina@example.com', password: 'brand-new-pass' });
    assert.equal(login.status, 200);
    assert.equal((await app.get('/api/auth/me').set('Authorization', `Bearer ${login.body.token}`)).status, 200);
  });
});

describe('account settings', () => {
  it('updates name, phone and bio, and changes password', async () => {
    const reg = await signup();
    const auth = { Authorization: `Bearer ${reg.body.token}` };
    const upd = await app.put('/api/auth/me').set(auth).send({ fullName: 'Amina H.', phone: '0733 111 222', bio: 'Hello' });
    assert.equal(upd.body.user.phone, '254733111222');
    assert.equal(upd.body.user.full_name, 'Amina H.');

    const wrong = await app.post('/api/auth/change-password').set(auth).send({ currentPassword: 'bad', newPassword: 'new-password-1' });
    assert.equal(wrong.status, 400);
    const ok = await app.post('/api/auth/change-password').set(auth).send({ currentPassword: 'password123', newPassword: 'new-password-1' });
    assert.equal(ok.status, 200);
    assert.equal((await app.get('/api/auth/me').set(auth)).status, 401); // old token is dead
    assert.equal((await app.get('/api/auth/me').set('Authorization', `Bearer ${ok.body.token}`)).status, 200);
  });
});

describe('platform basics', () => {
  it('reports health, returns JSON 404s and rejects malformed JSON with 400', async () => {
    assert.equal((await app.get('/api/health')).body.database, 'up');
    assert.equal((await app.get('/api/nope')).status, 404);
    const bad = await app.post('/api/auth/login').set('Content-Type', 'application/json').send('{oops');
    assert.equal(bad.status, 400);
  });

  it('keeps role checks tight: a student cannot use tutor endpoints', async () => {
    const student = await makeUser({ role: 'student' });
    assert.equal((await app.get('/api/tutors/me/profile').set(student.auth)).status, 403);
  });
});
