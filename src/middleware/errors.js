import { HttpError } from '../utils/http.js';

export function notFound(_req, res) {
  res.status(404).json({ error: 'Not found' });
}

// Central handler: never leaks stack traces or raw database text.
export function errorHandler(err, _req, res, _next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, ...err.extra });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'The request body is not valid JSON' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'The request body is too large' });
  }
  // Postgres: unique violation, bad uuid/number text, foreign key violation
  if (err.code === '23505') return res.status(409).json({ error: 'That record already exists' });
  if (err.code === '22P02') return res.status(400).json({ error: 'One of the values sent is not valid' });
  if (err.code === '23503') return res.status(400).json({ error: 'That item refers to something that does not exist' });

  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our end' });
}
