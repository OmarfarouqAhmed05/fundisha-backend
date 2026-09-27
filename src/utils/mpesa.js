// M-Pesa Daraja API (STK Push) — sandbox by default.
//
// To use this for real, register a free developer account at
// developer.safaricom.co.ke, create an app to get MPESA_CONSUMER_KEY and
// MPESA_CONSUMER_SECRET, and set them as env vars. The sandbox shortcode
// (174379) and passkey below are Safaricom's own published test values —
// safe to commit, they only work against the sandbox environment.

const BASE_URL =
  process.env.MPESA_ENV === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';

const SHORTCODE = process.env.MPESA_SHORTCODE || '174379';
const PASSKEY =
  process.env.MPESA_PASSKEY ||
  'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919'; // Safaricom's published sandbox passkey

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

async function getAccessToken() {
  const key = process.env.MPESA_CONSUMER_KEY;
  const secret = process.env.MPESA_CONSUMER_SECRET;
  if (!key || !secret) {
    throw new Error('MPESA_CONSUMER_KEY / MPESA_CONSUMER_SECRET not configured');
  }

  const credentials = Buffer.from(`${key}:${secret}`).toString('base64');
  const res = await fetch(`${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${credentials}` },
  });

  if (!res.ok) {
    throw new Error(`Failed to get M-Pesa access token (${res.status})`);
  }
  const data = await res.json();
  return data.access_token;
}

// Initiates an STK push — a payment prompt that appears directly on the
// payer's phone. `phone` must be in 2547XXXXXXXX format (no leading 0/+).
export async function initiateSTKPush({ phone, amount, accountReference, description }) {
  const accessToken = await getAccessToken();
  const ts = timestamp();
  const password = Buffer.from(`${SHORTCODE}${PASSKEY}${ts}`).toString('base64');

  const res = await fetch(`${BASE_URL}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      BusinessShortCode: SHORTCODE,
      Password: password,
      Timestamp: ts,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.round(amount),
      PartyA: phone,
      PartyB: SHORTCODE,
      PhoneNumber: phone,
      CallBackURL: `${process.env.API_URL}/api/bookings/mpesa-callback`,
      AccountReference: accountReference.slice(0, 20),
      TransactionDesc: description.slice(0, 20),
    }),
  });

  const data = await res.json();
  if (!res.ok || data.ResponseCode !== '0') {
    throw new Error(data.errorMessage || data.ResponseDescription || 'STK push failed');
  }

  return {
    checkoutRequestId: data.CheckoutRequestID,
    merchantRequestId: data.MerchantRequestID,
  };
}
