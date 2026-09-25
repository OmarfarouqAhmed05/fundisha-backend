-- Fundisha schema
-- Run with: psql -U <user> -d fundisha -f src/db/schema.sql

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- for gen_random_uuid()

CREATE TYPE user_role AS ENUM ('student', 'tutor', 'both');
CREATE TYPE booking_status AS ENUM ('pending', 'confirmed', 'declined', 'cancelled', 'completed');

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  role          user_role NOT NULL DEFAULT 'student',
  bio           TEXT DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE skills (
  id   SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  category TEXT NOT NULL DEFAULT 'other'
);

CREATE TABLE tutor_profiles (
  user_id          UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  headline         TEXT NOT NULL DEFAULT '',
  hourly_rate_kes  INTEGER NOT NULL DEFAULT 0,
  experience_years INTEGER NOT NULL DEFAULT 0,
  is_published     BOOLEAN NOT NULL DEFAULT false,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tutor_skills (
  tutor_id UUID REFERENCES users(id) ON DELETE CASCADE,
  skill_id INTEGER REFERENCES skills(id) ON DELETE CASCADE,
  PRIMARY KEY (tutor_id, skill_id)
);

-- Weekly recurring availability, e.g. "Mondays 14:00-17:00"
CREATE TABLE availability_slots (
  id           SERIAL PRIMARY KEY,
  tutor_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  day_of_week  SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6), -- 0 = Sunday
  start_time   TIME NOT NULL,
  end_time     TIME NOT NULL,
  CHECK (end_time > start_time)
);

CREATE TABLE bookings (
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

CREATE INDEX idx_tutor_skills_skill ON tutor_skills(skill_id);
CREATE INDEX idx_bookings_student ON bookings(student_id);
CREATE INDEX idx_bookings_tutor ON bookings(tutor_id);
CREATE INDEX idx_availability_tutor ON availability_slots(tutor_id);
