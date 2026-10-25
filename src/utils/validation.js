import { z } from 'zod';
import { rules } from '../config.js';
import { HttpError } from './http.js';

// --- Kenyan phone numbers -> 2547XXXXXXXX / 2541XXXXXXXX (the format M-Pesa needs) ---
export function normalizePhone(input) {
  const cleaned = String(input ?? '').replace(/[\s\-().]/g, '');
  let d = cleaned.startsWith('+') ? cleaned.slice(1) : cleaned;
  if (/^0[17]\d{8}$/.test(d)) d = '254' + d.slice(1);
  else if (/^[17]\d{8}$/.test(d)) d = '254' + d;
  return /^254[17]\d{8}$/.test(d) ? d : null;
}

const PHONE_MESSAGE = 'Enter a valid Kenyan phone number, e.g. 0712 345 678';

const requiredPhone = z
  .string()
  .trim()
  .transform((v, ctx) => {
    const n = normalizePhone(v);
    if (!n) {
      ctx.addIssue({ code: 'custom', message: PHONE_MESSAGE });
      return z.NEVER;
    }
    return n;
  });

const optionalPhone = z
  .string()
  .trim()
  .max(20, PHONE_MESSAGE)
  .default('')
  .transform((v, ctx) => {
    if (v === '') return '';
    const n = normalizePhone(v);
    if (!n) {
      ctx.addIssue({ code: 'custom', message: PHONE_MESSAGE });
      return z.NEVER;
    }
    return n;
  });

// --- Shared fields ---
const email = z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address').max(255));
// bcrypt only uses the first 72 bytes of a password, so reject anything longer.
const newPassword = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(72, 'Password must be at most 72 characters');
const fullName = z.string().trim().min(2, 'Enter your full name').max(100);
const uuid = z.uuid('That id is not valid');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour time like 14:30');

// --- Auth ---
export const registerSchema = z.object({
  email,
  password: newPassword,
  fullName,
  phone: optionalPhone,
  role: z.enum(['student', 'tutor', 'both']).default('student'),
});

export const loginSchema = z.object({
  email,
  password: z.string().min(1, 'Enter your password').max(72),
});

export const updateMeSchema = z.object({
  fullName: fullName.optional(),
  phone: optionalPhone.optional(),
  bio: z.string().trim().max(1000, 'Bio can be at most 1000 characters').optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password').max(72),
  newPassword,
});

export const verifyEmailSchema = z.object({ token: z.string().min(10) });
export const forgotPasswordSchema = z.object({ email });
export const resetPasswordSchema = z.object({ token: z.string().min(10), newPassword });

// --- Tutors ---
export const tutorProfileSchema = z.object({
  headline: z.string().trim().max(160).default(''),
  bio: z.string().trim().max(1000).default(''),
  hourlyRateKes: z.number().int().min(0).max(100000),
  experienceYears: z.number().int().min(0).max(60),
  skillIds: z
    .array(z.number().int().positive())
    .max(20)
    .transform((ids) => [...new Set(ids)]),
  isPublished: z.boolean().default(false),
});

export const availabilitySchema = z.object({
  slots: z
    .array(
      z.object({
        dayOfWeek: z.number().int().min(0).max(6),
        startTime: hhmm,
        endTime: hhmm,
      })
    )
    .max(50)
    .superRefine((slots, ctx) => {
      const byDay = new Map();
      slots.forEach((s, i) => {
        if (s.endTime <= s.startTime) {
          ctx.addIssue({ code: 'custom', message: 'Each slot must end after it starts', path: [i] });
        }
        const list = byDay.get(s.dayOfWeek) || [];
        for (const other of list) {
          if (s.startTime < other.endTime && other.startTime < s.endTime) {
            ctx.addIssue({ code: 'custom', message: 'Time slots on the same day cannot overlap', path: [i] });
          }
        }
        list.push(s);
        byDay.set(s.dayOfWeek, list);
      });
    }),
});

const blankToUndefined = (schema) => z.preprocess((v) => (v === '' ? undefined : v), schema);

export const tutorSearchSchema = z.object({
  skill: blankToUndefined(z.string().trim().max(60).optional()),
  q: blankToUndefined(z.string().trim().max(100).optional()),
  maxRate: blankToUndefined(z.coerce.number().int().min(0).max(1000000).optional()),
  sort: blankToUndefined(z.enum(['rating', 'price_asc', 'price_desc', 'experience']).default('rating')),
  page: blankToUndefined(z.coerce.number().int().min(1).max(1000).default(1)),
  limit: blankToUndefined(z.coerce.number().int().min(1).max(48).default(12)),
});

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-05')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'That date does not exist');

export const slotsQuerySchema = z.object({
  date: isoDate,
  duration: blankToUndefined(
    z.coerce
      .number()
      .int()
      .refine((n) => rules.allowedDurations.includes(n), 'Pick 30, 60, 90 or 120 minutes')
      .default(60)
  ),
});

// --- Bookings ---
export const bookingSchema = z.object({
  tutorId: uuid,
  skillId: z.number().int().positive(),
  scheduledAt: z.iso.datetime({ offset: true }),
  durationMinutes: z
    .number()
    .int()
    .refine((n) => rules.allowedDurations.includes(n), 'Pick 30, 60, 90 or 120 minutes')
    .default(60),
  studentNote: z.string().trim().max(500).default(''),
});

export const bookingStatusSchema = z.object({
  status: z.enum(['confirmed', 'declined', 'cancelled', 'completed']),
});

export const reviewSchema = z.object({
  bookingId: uuid,
  rating: z.number().int().min(1, 'Choose a rating from 1 to 5').max(5, 'Choose a rating from 1 to 5'),
  comment: z.string().trim().max(1000).default(''),
});

export const mpesaInitiateSchema = z.object({ bookingId: uuid, phone: requiredPhone });

export const idParam = z.object({ id: uuid });
export const tutorIdParam = z.object({ tutorId: uuid });

export function isUuid(value) {
  return z.uuid().safeParse(value).success;
}

// source: 'body' | 'query' | 'params'
export function validate(schema, source = 'body') {
  return (req, _res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const details = z.flattenError(result.error).fieldErrors;
      const first = result.error.issues[0]?.message || 'Validation failed';
      throw new HttpError(400, first, { details });
    }
    req[source] = result.data;
    next();
  };
}
