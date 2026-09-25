# Fundisha — Backend

Express + PostgreSQL API for an open skills-tutoring marketplace: account
registration (student/tutor/both), tutor profiles with skills and hourly
rates, availability, and a full booking lifecycle.

## Local setup

Requires PostgreSQL running locally (see the main Mac setup guide for
`brew install postgresql` if you don't have it yet).

```bash
createdb fundisha
cp .env.example .env   # then edit DATABASE_URL and JWT_SECRET
npm install
npm run migrate         # applies src/db/schema.sql
npm run seed             # loads starter skills
npm run dev
```

API runs on `http://localhost:4000` by default. Health check:
`curl http://localhost:4000/api/health`.

## Environment variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Long random string (32+ chars) — required, the server refuses to boot without one |
| `PORT` | API port, defaults to 4000 |
| `CORS_ORIGIN` | The frontend's origin — only this origin can call the API |
| `NODE_ENV` | `development` or `production` |

## API overview

- `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me`
- `GET /api/tutors?skill=&q=&maxRate=` — public search
- `GET /api/tutors/:id` — public profile
- `PUT /api/tutors/me/profile`, `PUT /api/tutors/me/availability` — tutor-only
- `GET /api/skills`
- `POST /api/bookings`, `GET /api/bookings/me`, `PATCH /api/bookings/:id/status`

## Security notes

- Passwords hashed with bcrypt (cost factor 12).
- JWT auth, 7-day expiry.
- Auth endpoints rate-limited (20 requests/15 min) separately from the rest
  of the API (300/15 min) to blunt brute-force attempts.
- All queries are parameterized — no string-concatenated SQL anywhere.
- Zod validates every request body before it touches the database.
- Helmet sets standard security headers; CORS is locked to one configured origin.
- Errors are logged server-side but never returned to the client with stack
  traces or raw database error text.

## Deploying

This needs a host that runs a persistent Node process with a real Postgres
database attached — **not** Vercel (that's for the static frontend/portfolio).
Render and Railway both work well and have usable free tiers:

1. Push this folder to its own GitHub repo.
2. On Render/Railway: create a PostgreSQL database, then a Web Service
   pointed at this repo, with `npm start` as the run command.
3. Set the environment variables above (`DATABASE_URL` comes from the
   database you just created; generate a fresh `JWT_SECRET`).
4. Run `npm run migrate` and `npm run seed` once against the production
   database (most platforms give you a one-off shell/console to do this).
5. Copy the resulting live URL (e.g. `https://fundisha-api.onrender.com`) —
   you'll set this as `VITE_API_URL` in the frontend.
