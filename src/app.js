import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import 'express-async-errors'; // lets async route handlers throw; must load before the routes

import { config } from './config.js';
import { pool } from './db/pool.js';
import { createMailer } from './utils/email.js';
import { createMpesaClient } from './utils/mpesa.js';
import { originMatcher } from './utils/cors.js';
import { errorHandler, notFound } from './middleware/errors.js';
import { authRoutes } from './routes/auth.js';
import tutorRoutes from './routes/tutors.js';
import skillRoutes from './routes/skills.js';
import { bookingRoutes } from './routes/bookings.js';
import { paymentRoutes } from './routes/payments.js';
import reviewRoutes from './routes/reviews.js';

// mailer and mpesa can be swapped for fakes, which is how the tests run without
// touching Resend or Safaricom.
export function createApp({
  mailer = createMailer({
    apiKey: config.resendApiKey,
    from: config.fromEmail,
    appUrl: config.appUrl,
  }),
  mpesa = createMpesaClient(config.mpesa, { apiUrl: config.apiUrl }),
} = {}) {
  const app = express();

  app.set('trust proxy', 1); // correct client IPs for rate limiting behind Render, Railway and similar
  app.disable('x-powered-by');

  app.use(helmet());
  const originAllowed = originMatcher(config.corsOrigins);
  app.use(
    cors({
      origin(origin, callback) {
        // No Origin header means curl, a server, or a same-origin request.
        callback(null, !origin || originAllowed(origin));
      },
    })
  );
  app.use(express.json({ limit: '100kb' })); // no file uploads in this API
  if (config.env !== 'test') app.use(morgan(config.isProd ? 'combined' : 'dev'));

  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: config.env === 'test' ? 100000 : 300,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Too many requests. Please slow down.' },
    })
  );

  app.get('/api/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok', database: 'up' });
    } catch {
      res.status(503).json({ status: 'degraded', database: 'down' });
    }
  });

  app.use('/api/auth', authRoutes({ mailer }));
  app.use('/api/tutors', tutorRoutes);
  app.use('/api/skills', skillRoutes);
  // Reviews and payments live under /bookings so existing URLs keep working.
  app.use('/api/bookings/reviews', reviewRoutes);
  app.use('/api/bookings', paymentRoutes({ mpesa, mailer }));
  app.use('/api/bookings', bookingRoutes({ mailer }));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
