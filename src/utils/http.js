import { waitUntil } from '@vercel/functions';

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const httpError = (status, message, extra) => new HttpError(status, message, extra);

// Fire-and-forget for side effects such as email: never blocks or fails the request.
// On Vercel a function can be frozen the moment the response is sent, which would silently drop
// an unfinished email, so the work is registered with waitUntil to keep it alive until it finishes.
// Anywhere else (your laptop, tests) waitUntil is a no-op and this behaves like a plain promise.
export function background(promise, label = 'background task') {
  const safe = Promise.resolve(promise).catch((err) => console.error(`[${label}] failed:`, err?.message || err));
  try {
    waitUntil(safe);
  } catch {
    // not running on Vercel
  }
}
