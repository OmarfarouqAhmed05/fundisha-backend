// M-Pesa Daraja client (STK Push + STK Query). Sandbox by default.
//
// Register a free developer account at developer.safaricom.co.ke, create an app to get
// MPESA_CONSUMER_KEY / MPESA_CONSUMER_SECRET, and set them in .env. Live payments additionally
// need a Safaricom-approved shortcode (see README). Everything here talks to Safaricom over
// HTTPS with a timeout, and never throws secrets into error messages.

const TIMEOUT_MS = 15000;

// Daraja timestamps are yyyyMMddHHmmss. Nairobi time keeps this independent of server timezone.
function timestamp() {
  const d = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds())
  );
}

export function createMpesaClient(cfg, { apiUrl, fetchImpl = fetch } = {}) {
  let cachedToken = null; // { value, expiresAt }

  const isConfigured = () =>
    Boolean(cfg.consumerKey && cfg.consumerSecret && cfg.shortcode && cfg.passkey && cfg.callbackSecret);

  async function getAccessToken() {
    if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) return cachedToken.value;

    const credentials = Buffer.from(`${cfg.consumerKey}:${cfg.consumerSecret}`).toString('base64');
    const res = await fetchImpl(`${cfg.baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${credentials}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Could not get an M-Pesa access token (HTTP ${res.status})`);

    const data = await res.json();
    cachedToken = {
      value: data.access_token,
      expiresAt: Date.now() + (Number(data.expires_in) || 3000) * 1000,
    };
    return cachedToken.value;
  }

  function passwordFor(ts) {
    return Buffer.from(`${cfg.shortcode}${cfg.passkey}${ts}`).toString('base64');
  }

  // phone must be 2547XXXXXXXX / 2541XXXXXXXX.
  async function initiateSTKPush({ phone, amount, accountReference, description }) {
    const accessToken = await getAccessToken();
    const ts = timestamp();

    const res = await fetchImpl(`${cfg.baseUrl}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        BusinessShortCode: cfg.shortcode,
        Password: passwordFor(ts),
        Timestamp: ts,
        TransactionType: 'CustomerPayBillOnline',
        Amount: Math.round(amount),
        PartyA: phone,
        PartyB: cfg.shortcode,
        PhoneNumber: phone,
        CallBackURL: `${apiUrl}/api/bookings/mpesa-callback/${cfg.callbackSecret}`,
        AccountReference: String(accountReference).slice(0, 12),
        TransactionDesc: String(description).slice(0, 13),
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ResponseCode !== '0') {
      throw new Error(data.errorMessage || data.ResponseDescription || `STK push failed (HTTP ${res.status})`);
    }
    return { checkoutRequestId: data.CheckoutRequestID, merchantRequestId: data.MerchantRequestID };
  }

  // Asks Safaricom what happened to a push. Used when the callback never arrives
  // (for example during local development without a public callback URL).
  // Returns { state: 'pending' | 'paid' | 'failed', description }.
  async function queryStkStatus(checkoutRequestId) {
    const accessToken = await getAccessToken();
    const ts = timestamp();

    const res = await fetchImpl(`${cfg.baseUrl}/mpesa/stkpushquery/v1/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        BusinessShortCode: cfg.shortcode,
        Password: passwordFor(ts),
        Timestamp: ts,
        CheckoutRequestID: checkoutRequestId,
      }),
    });

    const data = await res.json().catch(() => ({}));
    // Safaricom answers with an error while the customer is still looking at the prompt.
    if (data.errorCode === '500.001.1001') {
      return { state: 'pending', description: data.errorMessage || 'Transaction is being processed' };
    }
    if (!res.ok || data.ResponseCode !== '0') {
      throw new Error(data.errorMessage || data.ResponseDescription || `STK query failed (HTTP ${res.status})`);
    }
    if (Number(data.ResultCode) === 0) return { state: 'paid', description: data.ResultDesc };
    return { state: 'failed', description: data.ResultDesc || 'The payment was not completed' };
  }

  return { isConfigured, initiateSTKPush, queryStkStatus };
}
