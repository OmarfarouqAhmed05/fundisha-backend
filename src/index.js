import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import 'dotenv/config';
import 'express-async-errors'; // must be imported before the routes that use it

import authRoutes from './routes/auth.js';
import tutorRoutes from './routes/tutors.js';
import skillRoutes from './routes/skills.js';
import bookingRoutes from './routes/bookings.js';

const app = express();
const PORT = process.env.PORT || 4000;
const ALLOWED_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';

app.set('trust proxy', 1); // needed for correct rate-limiting behind a reverse proxy (Render/Railway/etc.)

app.use(helmet());
app.use(
  cors({
    origin: ALLOWED_ORIGIN,
    credentials: true,
  })
);
app.use(express.json({ limit: '100kb' })); // small cap — this API has no file uploads
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Baseline rate limit across the whole API; auth routes have a stricter one of their own.
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

app.use('/api/auth', authRoutes);
app.use('/api/tutors', tutorRoutes);
app.use('/api/skills', skillRoutes);
app.use('/api/bookings', bookingRoutes);

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Centralized error handler — never leak stack traces or raw DB errors to the client.
app.use((err, req, res, _next) => {
  console.error(err);
  if (err.code === '23505') {
    return res.status(409).json({ error: 'That record already exists' });
  }
  res.status(500).json({ error: 'Something went wrong on our end' });
});

app.listen(PORT, () => {
  console.log(`Fundisha API listening on port ${PORT}`);
});
