# Fundisha API

Express + PostgreSQL API for Fundisha, a skills-tutoring marketplace for Kenya. Learners find tutors, book a
session, pay by M-Pesa, and review the tutor afterwards.

## What it does

- Accounts for learners, tutors, or both: email verification, password reset, session revocation on password change.
- Tutor profiles with skills, an hourly rate in KES, and weekly availability in Nairobi time.
- Search by skill, text and price, with ratings, sorting and pagination.
- Bookings that respect availability, with one clear lifecycle (pending, confirmed, completed, cancelled, declined).
- M-Pesa STK push payments, confirmed by Safaricom's callback or by polling when the callback never arrives.
- Reviews from learners on completed sessions, and email notifications for each step.

## Run it locally

You need Node 20+ and PostgreSQL.

```bash
createdb fundisha
cp .env.example .env     # set DATABASE_URL and JWT_SECRET
npm install
npm run db:setup         # creates the schema, the skills list and demo data
npm run dev              # http://localhost:4000, check http://localhost:4000/api/health
```

`db:setup` is safe to run again. It also upgrades a database created by the earlier version of this project.

### Demo accounts

Demo data is clearly marked as sample data (`is_demo`) so the frontend can label it. Password for both: `DemoPass123!`

| Account | Use it to |
|---|---|
| `demo.learner@example.com` | see a confirmed session ready to pay for, a finished session waiting for a review, and a pending request |
| `demo.tutor@example.com` | confirm or decline a pending request, edit the profile and availability |

`npm run db:reset-demo` rebuilds the demo data. Plain `npm run db:seed` loads only the skills list.

## Environment variables

See `.env.example` for a ready-to-copy file.

| Variable | Purpose |
|---|---|
| `DATABASE_URL`, `JWT_SECRET` | Required. The secret must be at least 32 characters in production. |
| `DATABASE_SSL` | Set `true` when your hosted Postgres requires SSL. |
| `CORS_ORIGIN` | Comma-separated frontend origins allowed to call the API. |
| `APP_URL`, `API_URL` | Frontend URL (email links) and this API's public URL (M-Pesa callback). |
| `RESEND_API_KEY`, `FROM_EMAIL` | Email through Resend. Without a key, emails are logged and skipped. |
| `REQUIRE_VERIFIED_EMAIL` | `true` makes users verify their email before booking or publishing. Default `false`. |
| `MPESA_ENV`, `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_SHORTCODE`, `MPESA_PASSKEY` | Daraja credentials. The sandbox shortcode and passkey are filled in for you. |
| `MPESA_CALLBACK_SECRET` | Random string used inside the callback URL so only Safaricom's request is accepted. |

## API

Errors are JSON: `{ "error": "A readable message", "details": { "field": ["..."] } }`.
Protected routes need `Authorization: Bearer <token>`.

**Auth** (`/api/auth`): `POST /register`, `POST /login`, `GET /me`, `PUT /me`, `POST /change-password`,
`POST /verify-email`, `POST /resend-verification`, `POST /forgot-password`, `POST /reset-password`

**Tutors** (`/api/tutors`)
- `GET /?skill=&q=&maxRate=&sort=rating|price_asc|price_desc|experience&page=&limit=`: public search
- `GET /:id`: public profile with skills, availability, rating
- `GET /:id/slots?date=YYYY-MM-DD&duration=60`: start times that can actually be booked
- `GET /me/profile`, `PUT /me/profile`, `PUT /me/availability`: the logged-in tutor's own profile

**Bookings** (`/api/bookings`)
- `POST /`, `GET /me`, `PATCH /:id/status`
- `POST /mpesa/initiate`, `GET /:id/payment` (poll this), `POST /mpesa-callback/:secret` (Safaricom only)
- `POST /reviews`, `GET /reviews/:tutorId`

`GET /api/skills`, `GET /api/health`

## Rules the API enforces

- **Time** is Africa/Nairobi. A session must fit entirely inside one of the tutor's weekly slots, start at least
  an hour from now, and be at most 60 days away. Durations are 30, 60, 90 or 120 minutes.
- **No double booking**: a tutor cannot have overlapping pending or confirmed sessions, and neither can a learner.
  Requests are serialised with a database advisory lock, so simultaneous requests cannot both succeed.
- **Lifecycle**: pending to confirmed or declined (tutor) or cancelled (learner); confirmed to completed (tutor, only
  after the session ends) or cancelled (either side). Declined, cancelled and completed are final.
- **Price** is fixed when the booking is created. A paid session cannot be cancelled online.
- **Contact details** (email, phone) appear only once a session is confirmed.
- **Reviews**: only the learner, only on a completed session, once.
- **Publishing a profile** needs a headline, a rate above zero, at least one skill and one availability slot.

## M-Pesa

Payments use the Daraja STK push. A learner can pay once the tutor confirms. Status moves from `unpaid` to
`pending` to `paid` or `failed`, and a failed or expired attempt can be retried.

- **Sandbox first.** Register at developer.safaricom.co.ke, create an app, and put its consumer key and secret in
  `.env`. The sandbox shortcode and passkey are Safaricom's published test values.
- **Locally**, Safaricom cannot reach `localhost`, so no callback arrives. That is fine: the frontend polls
  `GET /bookings/:id/payment`, and the API then asks Safaricom for the result itself. To test the callback path
  too, expose the API with a tunnel (for example ngrok) and set `API_URL` to its HTTPS address.
- **Going live** needs a Safaricom-approved Paybill or Till and approval of your Daraja app. Until then this
  runs in the sandbox only.
- Refunds are not built. For that reason a paid session cannot be cancelled online.

## Email

Verification, password reset, booking requests, confirmations, declines, cancellations and payment receipts.
Sending failures never block a request. Resend's shared test sender (`onboarding@resend.dev`) is limited to the
account owner's own address, so verify a sending domain in Resend before real users sign up.

## Deploy on Vercel

Vercel runs the Express app as one serverless function, so `src/index.js` exports the app and only starts its own
server when it is not on Vercel. A few things behave differently from a normal server, and the code accounts for them:

- **Emails and other post-response work** use Vercel's `waitUntil`, so the function is not paused before an email
  is sent.
- **Database connections:** each instance keeps a small pool (5 by default, set `DB_POOL_MAX` to change it) that is
  registered with Vercel so idle connections are closed cleanly. Use your database provider's *pooled* connection
  string (Neon's has `-pooler` in the host name) so many instances do not exhaust the database.
- **Rate limits** are counted per running instance, so treat them as soft limits.

Steps:

1. **Create the database** with any hosted Postgres. Take a snapshot or branch first if the database already holds data.
2. **Migrate from your own computer** (Vercel does not run migrations):
   ```bash
   DATABASE_URL="<production connection string>" npm run db:migrate
   DATABASE_URL="<production connection string>" npm run db:seed        # skills only
   # optional, adds the public sample accounts:
   DATABASE_URL="<production connection string>" npm run db:seed:demo
   ```
3. **Set environment variables** in the Vercel project (Production, and Preview if you test branches):
   `DATABASE_URL`, `JWT_SECRET` (32+ characters), `NODE_ENV=production`, `CORS_ORIGIN`, `APP_URL`, `API_URL`
   (this project's own public URL), `DATABASE_SSL=true` if your provider needs it, and the `MPESA_*` and
   `RESEND_*` values. For previews, `CORS_ORIGIN` accepts a wildcard such as
   `https://fundisha-frontend-*-youruser.vercel.app`.
4. **Deploy**, then open `https://<your-api>/api/health`. It should report the database as up.
5. **Point the frontend at it:** set `VITE_API_URL=https://<your-api>/api` in the frontend project and redeploy it.

## Tests

```bash
createdb fundisha_test
# add this line to .env (use your own user and password):
# TEST_DATABASE_URL=postgresql://postgres:yourpassword@localhost:5432/fundisha_test
npm test
```

59 tests run against a real Postgres database, with fake M-Pesa and email clients. The runner refuses to start
unless the database name contains `test`, so it cannot touch real data. They cover the rules above, including
simultaneous bookings and the whole payment flow.

## Project layout

```
src/
  app.js, index.js        app factory (takes fake mailer and mpesa in tests) and server entry point
  config.js               environment parsing and business rules
  db/                     pool, idempotent schema.sql, migrate.js, seed.js
  middleware/             auth (token plus live user lookup), error handling
  routes/                 auth, tutors, bookings, payments, reviews, skills
  utils/                  validation (Zod), time (Nairobi), booking rules, mpesa, email, cors
test/                     helpers and the five test files
```
