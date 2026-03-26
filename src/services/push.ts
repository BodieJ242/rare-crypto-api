import * as http2 from 'node:http2';
import { SignJWT, importPKCS8 } from 'jose';

const APNS_KEY_ID = process.env.APNS_KEY_ID || '';
const APNS_TEAM_ID = process.env.APNS_TEAM_ID || '';
const APNS_PRIVATE_KEY = process.env.APNS_PRIVATE_KEY || '';
const APNS_TOPIC = process.env.APNS_TOPIC || 'co.rarecrypto.rarecrypto';

// APNs requires HTTP/2. The host is determined by environment.
const APNS_HOST = (process.env.NODE_ENV === 'production')
  ? 'https://api.push.apple.com'
  : 'https://api.sandbox.push.apple.com';

// ── JWT token cache ────────────────────────────────────────────────

let cachedToken: { jwt: string; expiresAt: number } | null = null;
let privateKey: any = null;

async function getPrivateKey() {
  if (privateKey) return privateKey;
  if (!APNS_PRIVATE_KEY) throw new Error('APNS_PRIVATE_KEY env var is not set');
  // Render and other platforms sometimes store multiline env vars with literal \n
  // instead of real newlines. Normalize either way so PEM parsing works correctly.
  const keyData = APNS_PRIVATE_KEY.replace(/\\n/g, '\n');
  privateKey = await importPKCS8(keyData, 'ES256');
  return privateKey;
}

async function getApnsToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now) {
    return cachedToken.jwt;
  }

  const key = await getPrivateKey();
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: APNS_KEY_ID })
    .setIssuer(APNS_TEAM_ID)
    .setIssuedAt(now)
    .sign(key);

  console.log(`[push] APNs JWT — kid=${APNS_KEY_ID} iss=${APNS_TEAM_ID} topic=${APNS_TOPIC} host=${APNS_HOST}`);

  cachedToken = { jwt, expiresAt: now + 50 * 60 };
  return jwt;
}

// ── HTTP/2 session management ──────────────────────────────────────
// APNs mandates HTTP/2. Node's built-in fetch (undici) speaks HTTP/1.1
// for outgoing TLS connections, so we use node:http2 directly.

let apnsSession: http2.ClientHttp2Session | null = null;

function getApnsSession(): http2.ClientHttp2Session {
  if (apnsSession && !apnsSession.destroyed && !apnsSession.closed) {
    return apnsSession;
  }
  apnsSession = http2.connect(APNS_HOST);
  apnsSession.on('error', (err) => {
    console.error('[push] APNs HTTP/2 session error:', err);
    apnsSession = null;
  });
  apnsSession.on('close', () => {
    apnsSession = null;
  });
  return apnsSession;
}

function apnsRequestOnce(
  deviceToken: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const session = getApnsSession();
    const req = session.request({
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      ...headers,
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
    });

    let status = 0;
    let responseBody = '';

    req.on('response', (h) => {
      status = h[':status'] as number;
    });
    req.on('data', (chunk) => {
      responseBody += chunk;
    });
    req.on('end', () => resolve({ status, body: responseBody }));
    req.on('error', reject);

    req.write(body);
    req.end();
  });
}

// Wraps apnsRequestOnce with one retry on ECONNRESET, since APNs
// sometimes resets the HTTP/2 session after an auth error or idle timeout.
async function apnsRequest(
  deviceToken: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; body: string }> {
  try {
    return await apnsRequestOnce(deviceToken, headers, body);
  } catch (err: any) {
    if (err?.code === 'ECONNRESET' || err?.code === 'ERR_HTTP2_STREAM_ERROR') {
      console.warn('[push] APNs connection reset, retrying with fresh session...');
      apnsSession = null; // force new session
      return await apnsRequestOnce(deviceToken, headers, body);
    }
    throw err;
  }
}

// ── Public API ─────────────────────────────────────────────────────

export type PushPayload = {
  title: string;
  body: string;
  badge?: number;
  sound?: string;
  data?: Record<string, any>;
};

// APNs error reasons that mean the token is permanently dead and should be removed.
// All other errors (500s, network failures, etc.) are transient — don't remove the token.
const INVALID_TOKEN_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'MissingDeviceToken']);

type PushResult = 'sent' | 'invalid-token' | 'error';

export async function sendPush(deviceToken: string, payload: PushPayload): Promise<PushResult> {
  if (!APNS_KEY_ID || !APNS_TEAM_ID || !APNS_PRIVATE_KEY) {
    console.warn('APNs not configured — skipping push');
    return 'error';
  }

  try {
    const token = await getApnsToken();
    const apnsPayload = {
      aps: {
        alert: {
          title: payload.title,
          body: payload.body,
        },
        badge: payload.badge ?? 1,
        sound: payload.sound ?? 'default',
      },
      ...payload.data,
    };

    // apns-expiration: allow APNs to store & retry delivery for up to 1 hour
    // if the device is temporarily offline. Without this it defaults to 0 (discard immediately).
    const expirationEpoch = Math.floor(Date.now() / 1000) + 60 * 60;

    const response = await apnsRequest(
      deviceToken,
      {
        'authorization': `bearer ${token}`,
        'apns-topic': APNS_TOPIC,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-expiration': String(expirationEpoch),
      },
      JSON.stringify(apnsPayload),
    );

    if (response.status === 200) {
      console.log(`[push] Sent successfully to ${deviceToken.slice(0, 10)}...`);
      return 'sent';
    }

    let err: any = {};
    try { err = JSON.parse(response.body); } catch {}
    const reason = err?.reason ?? '';
    console.error(`[push] APNs error (${response.status}) reason=${reason}:`, err);

    // 410 = device unregistered; specific reasons = token permanently invalid.
    // Only in these cases should the token be removed from the DB.
    if (response.status === 410 || INVALID_TOKEN_REASONS.has(reason)) {
      console.log(`[push] Marking token for removal: ${deviceToken.slice(0, 10)}... (${reason || 410})`);
      return 'invalid-token';
    }

    // Anything else is transient — keep the token.
    return 'error';
  } catch (e) {
    console.error('[push] Send failed:', e);
    return 'error';
  }
}

// Returns only the tokens that are permanently invalid and should be removed.
// Transient send failures are logged but the token is kept.
export async function sendPushToMultiple(
  deviceTokens: string[],
  payload: PushPayload
): Promise<string[]> {
  const invalidTokens: string[] = [];
  for (const token of deviceTokens) {
    const result = await sendPush(token, payload);
    if (result === 'invalid-token') invalidTokens.push(token);
  }
  return invalidTokens;
}
