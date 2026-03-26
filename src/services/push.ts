import { SignJWT, importPKCS8 } from 'jose';

const APNS_KEY_ID = process.env.APNS_KEY_ID || '';
const APNS_TEAM_ID = process.env.APNS_TEAM_ID || '';
const APNS_PRIVATE_KEY = process.env.APNS_PRIVATE_KEY || '';
const APNS_TOPIC = process.env.APNS_TOPIC || 'co.rarecrypto.rarecrypto';
const APNS_HOST = (process.env.NODE_ENV === 'production')
  ? 'https://api.push.apple.com'
  : 'https://api.sandbox.push.apple.com';

let cachedToken: { jwt: string; expiresAt: number } | null = null;
let privateKey: any = null;

async function getPrivateKey() {
  if (privateKey) return privateKey;
  if (!APNS_PRIVATE_KEY) throw new Error('APNS_PRIVATE_KEY env var is not set');
  privateKey = await importPKCS8(APNS_PRIVATE_KEY, 'ES256');
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

  cachedToken = { jwt, expiresAt: now + 50 * 60 };
  return jwt;
}

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

    const response = await fetch(`${APNS_HOST}/3/device/${deviceToken}`, {
      method: 'POST',
      headers: {
        'authorization': `bearer ${token}`,
        'apns-topic': APNS_TOPIC,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-expiration': String(expirationEpoch),
        'content-type': 'application/json',
      },
      body: JSON.stringify(apnsPayload),
    });

    if (response.ok) {
      console.log(`[push] Sent successfully to ${deviceToken.slice(0, 10)}...`);
      return 'sent';
    }

    const err = await response.json().catch(() => ({}));
    const reason = (err as any)?.reason ?? '';
    console.error(`[push] APNs error (${response.status}) reason=${reason}:`, err);

    // 410 = device unregistered; specific reasons = token permanently invalid.
    // Only in these cases should the token be removed from the DB.
    if (response.status === 410 || INVALID_TOKEN_REASONS.has(reason)) {
      console.log(`[push] Marking token for removal: ${deviceToken.slice(0, 10)}... (${reason || 410})`);
      return 'invalid-token';
    }

    // Anything else (500, 429, network error, etc.) is transient — keep the token.
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