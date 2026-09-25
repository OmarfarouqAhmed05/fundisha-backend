import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
  fullName: z.string().min(2).max(100),
  role: z.enum(['student', 'tutor', 'both']).default('student'),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const tutorProfileSchema = z.object({
  headline: z.string().max(160).default(''),
  hourlyRateKes: z.number().int().min(0).max(100000),
  experienceYears: z.number().int().min(0).max(60),
  skillIds: z.array(z.number().int()).max(20),
  isPublished: z.boolean().default(false),
});

export const availabilitySchema = z.object({
  slots: z
    .array(
      z.object({
        dayOfWeek: z.number().int().min(0).max(6),
        startTime: z.string().regex(/^\d{2}:\d{2}$/),
        endTime: z.string().regex(/^\d{2}:\d{2}$/),
      })
    )
    .max(50),
});

export const bookingSchema = z.object({
  tutorId: z.string().uuid(),
  skillId: z.number().int(),
  scheduledAt: z.string().datetime(),
  durationMinutes: z.number().int().min(15).max(240).default(60),
  studentNote: z.string().max(500).default(''),
});

export const bookingStatusSchema = z.object({
  status: z.enum(['confirmed', 'declined', 'cancelled', 'completed']),
});

export function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: result.error.flatten().fieldErrors,
      });
    }
    req.body = result.data;
    next();
  };
}
