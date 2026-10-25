import { config } from './config.js';
import { pool } from './db/pool.js';
import { createApp } from './app.js';

const app = createApp();

// On Vercel the platform runs the exported app itself. Everywhere else we start our own server.
if (!process.env.VERCEL) {
  const server = app.listen(config.port, () => {
    console.log(`Fundisha API listening on port ${config.port} (${config.env})`);
    if (!config.resendApiKey) console.log('Email is off: set RESEND_API_KEY to send real emails.');
    if (!config.mpesa.consumerKey) console.log('M-Pesa is off: set MPESA_CONSUMER_KEY and MPESA_CONSUMER_SECRET.');
  });

  // Finish in-flight requests and release database connections when the host restarts us.
  function shutdown(signal) {
    console.log(`${signal} received, shutting down`);
    server.close(async () => {
      await pool.end().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

export default app;
