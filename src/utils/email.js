import { formatNairobi } from './time.js';

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function layout(heading, bodyHtml) {
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#222;line-height:1.5">
    <h2 style="margin:0 0 16px">${escapeHtml(heading)}</h2>
    ${bodyHtml}
    <p style="color:#888;font-size:12px;margin-top:32px">Fundisha, skills tutoring in Kenya.</p>
  </div>`;
}

const button = (href, label) =>
  `<p><a href="${escapeHtml(href)}" style="background:#5fa8d3;color:#0a0e12;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">${escapeHtml(
    label
  )}</a></p><p style="font-size:12px;color:#666">Or paste this link into your browser:<br>${escapeHtml(href)}</p>`;

// Every method resolves (never rejects), so a failed email can never break a request.
export function createMailer({ apiKey, from, appUrl, fetchImpl = fetch }) {
  async function send({ to, subject, html }) {
    if (!apiKey) {
      console.warn(`[email] RESEND_API_KEY not set, skipping "${subject}" to ${to}`);
      return { skipped: true };
    }
    try {
      const res = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to, subject, html }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error(`[email] Resend rejected "${subject}" to ${to} (${res.status}): ${body}`);
        return { skipped: true, error: true };
      }
      return await res.json();
    } catch (err) {
      console.error(`[email] Could not send "${subject}" to ${to}:`, err.message);
      return { skipped: true, error: true };
    }
  }

  const when = (d, mins) => `${formatNairobi(d)} (Nairobi time), ${mins} minutes`;

  return {
    sendVerificationEmail(to, token) {
      const link = `${appUrl}/verify-email?token=${encodeURIComponent(token)}`;
      return send({
        to,
        subject: 'Verify your Fundisha account',
        html: layout('Verify your email', `<p>Welcome to Fundisha. Confirm your email address to finish setting up your account.</p>${button(link, 'Verify email')}<p>This link expires in 24 hours.</p>`),
      });
    },

    sendPasswordResetEmail(to, token) {
      const link = `${appUrl}/reset-password?token=${encodeURIComponent(token)}`;
      return send({
        to,
        subject: 'Reset your Fundisha password',
        html: layout('Reset your password', `<p>Use the button below to choose a new password. If you did not ask for this, ignore this email.</p>${button(link, 'Reset password')}<p>This link expires in 1 hour.</p>`),
      });
    },

    bookingRequested({ to, tutorName, studentName, skillName, scheduledAt, durationMinutes, note }) {
      return send({
        to,
        subject: `New session request from ${studentName}`,
        html: layout(
          'You have a new session request',
          `<p>Hi ${escapeHtml(tutorName)}, ${escapeHtml(studentName)} would like a <b>${escapeHtml(skillName)}</b> session.</p>
           <p><b>${escapeHtml(when(scheduledAt, durationMinutes))}</b></p>
           ${note ? `<p>Their note: "${escapeHtml(note)}"</p>` : ''}
           ${button(`${appUrl}/dashboard`, 'Review the request')}`
        ),
      });
    },

    bookingConfirmed({ to, tutorName, studentName, skillName, scheduledAt, durationMinutes, contactLines }) {
      return send({
        to,
        subject: 'Your Fundisha session is confirmed',
        html: layout(
          'Session confirmed',
          `<p>${escapeHtml(studentName)} and ${escapeHtml(tutorName)} are booked for <b>${escapeHtml(skillName)}</b>.</p>
           <p><b>${escapeHtml(when(scheduledAt, durationMinutes))}</b></p>
           <p>${contactLines.map((l) => escapeHtml(l)).join('<br>')}</p>
           ${button(`${appUrl}/dashboard`, 'Open your dashboard')}`
        ),
      });
    },

    bookingDeclined({ to, tutorName, studentName, skillName, scheduledAt, durationMinutes }) {
      return send({
        to,
        subject: 'Your session request was declined',
        html: layout(
          'Request declined',
          `<p>Hi ${escapeHtml(studentName)}, ${escapeHtml(tutorName)} can't make your <b>${escapeHtml(skillName)}</b> session on ${escapeHtml(when(scheduledAt, durationMinutes))}.</p>
           <p>You can pick another time or another tutor.</p>${button(`${appUrl}/browse`, 'Find a tutor')}`
        ),
      });
    },

    bookingCancelled({ to, cancelledByName, skillName, scheduledAt, durationMinutes }) {
      return send({
        to,
        subject: 'A Fundisha session was cancelled',
        html: layout(
          'Session cancelled',
          `<p>${escapeHtml(cancelledByName)} cancelled the <b>${escapeHtml(skillName)}</b> session on ${escapeHtml(when(scheduledAt, durationMinutes))}.</p>${button(`${appUrl}/dashboard`, 'Open your dashboard')}`
        ),
      });
    },

    paymentReceived({ to, studentName, tutorName, amountKes, receipt, scheduledAt, durationMinutes }) {
      return send({
        to,
        subject: 'M-Pesa payment received',
        html: layout(
          'Payment received',
          `<p>KSh ${escapeHtml(amountKes)} was paid for the session between ${escapeHtml(studentName)} and ${escapeHtml(tutorName)}.</p>
           <p>${escapeHtml(when(scheduledAt, durationMinutes))}</p>
           ${receipt ? `<p>M-Pesa receipt: <b>${escapeHtml(receipt)}</b></p>` : ''}`
        ),
      });
    },
  };
}
