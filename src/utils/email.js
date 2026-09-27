const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'Fundisha <onboarding@resend.dev>';
const APP_URL = process.env.APP_URL || 'http://localhost:5173';

async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY) {
    // Don't crash the request over a missing email config in dev — log and move on.
    console.warn(`[email] RESEND_API_KEY not set — skipping email to ${to}: "${subject}"`);
    return { skipped: true };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[email] Resend request failed (${res.status}): ${body}`);
    // A failed email shouldn't fail the whole request (e.g. registration) —
    // the caller decides whether that matters for their flow.
    return { skipped: true, error: true };
  }

  return res.json();
}

export function sendVerificationEmail(to, token) {
  const link = `${APP_URL}/verify-email?token=${token}`;
  return sendEmail({
    to,
    subject: 'Verify your Fundisha account',
    html: `
      <p>Welcome to Fundisha — click below to verify your email:</p>
      <p><a href="${link}">${link}</a></p>
      <p>This link expires in 24 hours.</p>
    `,
  });
}

export function sendPasswordResetEmail(to, token) {
  const link = `${APP_URL}/reset-password?token=${token}`;
  return sendEmail({
    to,
    subject: 'Reset your Fundisha password',
    html: `
      <p>Click below to reset your password. If you didn't request this, ignore this email.</p>
      <p><a href="${link}">${link}</a></p>
      <p>This link expires in 1 hour.</p>
    `,
  });
}

export function sendBookingConfirmedEmail(to, tutorName, studentName, scheduledAt, contactInfo) {
  return sendEmail({
    to,
    subject: 'Your Fundisha session is confirmed',
    html: `
      <p>Your session between ${studentName} and ${tutorName} on
      ${new Date(scheduledAt).toLocaleString()} is confirmed.</p>
      <p>Contact: ${contactInfo}</p>
    `,
  });
}
