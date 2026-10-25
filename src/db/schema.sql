-- Fundisha schema.
-- Safe to run repeatedly, on a fresh database or on one created by the older
-- schema.sql + 002_features.sql: every statement is idempotent.

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('student', 'tutor', 'both');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE booking_status AS ENUM ('pending', 'confirmed', 'declined', 'cancelled', 'completed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_status AS ENUM ('unpaid', 'pending', 'paid', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  role          user_role NOT NULL DEFAULT 'student',
  bio           TEXT DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;
-- Bumped whenever the password changes; tokens carry the version they were issued under.
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false;

-- Emails are unique ignoring case ("A@x.com" and "a@x.com" are the same person).
DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON users (lower(email));
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'Existing accounts differ only by email case; case-insensitive index not created. Merge them and re-run.';
END $$;

CREATE TABLE IF NOT EXISTS skills (
  id       SERIAL PRIMARY KEY,
  name     TEXT UNIQUE NOT NULL,
  category TEXT NOT NULL DEFAULT 'other'
);

CREATE TABLE IF NOT EXISTS tutor_profiles (
  user_id          UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  headline         TEXT NOT NULL DEFAULT '',
  hourly_rate_kes  INTEGER NOT NULL DEFAULT 0,
  experience_years INTEGER NOT NULL DEFAULT 0,
  is_published     BOOLEAN NOT NULL DEFAULT false,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tutor_skills (
  tutor_id UUID REFERENCES users(id) ON DELETE CASCADE,
  skill_id INTEGER REFERENCES skills(id) ON DELETE CASCADE,
  PRIMARY KEY (tutor_id, skill_id)
);

-- Weekly recurring availability in Africa/Nairobi local time, e.g. "Mondays 14:00-17:00"
CREATE TABLE IF NOT EXISTS availability_slots (
  id          SERIAL PRIMARY KEY,
  tutor_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6), -- 0 = Sunday
  start_time  TIME NOT NULL,
  end_time    TIME NOT NULL,
  CHECK (end_time > start_time)
);

CREATE TABLE IF NOT EXISTS bookings (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id       UUID REFERENCES users(id) ON DELETE CASCADE,
  tutor_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  skill_id         INTEGER REFERENCES skills(id),
  scheduled_at     TIMESTAMPTZ NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 60,
  status           booking_status NOT NULL DEFAULT 'pending',
  student_note     TEXT DEFAULT '',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (student_id <> tutor_id)
);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_status payment_status NOT NULL DEFAULT 'unpaid';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS mpesa_checkout_request_id TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS mpesa_receipt TEXT;
-- Price is fixed when the booking is created, so a later rate change cannot alter what is owed.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS price_kes INTEGER;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payer_phone TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_requested_at TIMESTAMPTZ;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_checked_at TIMESTAMPTZ;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_result_desc TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS reviews (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID UNIQUE NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tutor_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating     SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment    TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tokens are stored hashed (SHA-256); the raw token only ever exists in the email link.
CREATE TABLE IF NOT EXISTS email_verification_tokens (
  token      TEXT PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token      TEXT PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used       BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tutor_skills_skill ON tutor_skills(skill_id);
CREATE INDEX IF NOT EXISTS idx_bookings_student ON bookings(student_id, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_bookings_tutor ON bookings(tutor_id, scheduled_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_checkout ON bookings(mpesa_checkout_request_id)
  WHERE mpesa_checkout_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_availability_tutor ON availability_slots(tutor_id);
CREATE INDEX IF NOT EXISTS idx_reviews_tutor ON reviews(tutor_id);
CREATE INDEX IF NOT EXISTS idx_email_verif_user ON email_verification_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_pw_reset_user ON password_reset_tokens(user_id);
