import { SignJWT, importPKCS8 } from 'jose';
import * as fs from 'fs';

const APNS_KEY_ID = process.env.APNS_KEY_ID || '';
const APNS_TEAM_ID = process.env.APNS_TEAM_ID || '';
const APNS_KEY_PATH = process.env.APNS_KEY_PATH || './apns-key.p8';
const APNS_TOPIC = process.env.APNS_TOPIC || 'co.rarecrypto.rarecrypto'; // bundle ID
const APNS_HOST = (process.env.NODE_ENV === 'production')
  ? 'https://api.push.apple.com'
  : 'https://api.sandbox.push.apple.com';

let cachedToken: { jwt: string; expiresAt: number } | null = null;
let privateKey: any = null;

async function getPrivateKey() {
  if (privateKey) return privateKey;
  const keyData = fs.readFileSync(APNS_KEY_PATH, 'utf8');
  privateKey = await importPKCS8(keyData, 'ES256');
  return privateKey;
}

async function getApnsToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  // Reuse token if valid (APNs tokens last up to 60 min, we refresh at 50)
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

export async function sendPush(deviceToken: string, payload: PushPayload): Promise<boolean> {
  if (!APNS_KEY_ID || !APNS_TEAM_ID) {
    console.warn('APNs not configured — skipping push');
    return false;
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

    const response = await fetch(`${APNS_HOST}/3/device/${deviceToken}`, {
      method: 'POST',
      headers: {
        'authorization': `bearer ${token}`,
        'apns-topic': APNS_TOPIC,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'content-type': 'application/json',
      },
      body: JSON.stringify(apnsPayload),
    });

    if (response.ok) {
      return true;
    }

    const err = await response.json().catch(() => ({}));
    console.error(`APNs error (${response.status}):`, err);

    // If token is invalid, caller should remove it
    if (response.status === 410 || (err as any)?.reason === 'BadDeviceToken') {
      return false;
    }

    return false;
  } catch (e) {
    console.error('Push send failed:', e);
    return false;
  }
}

export async function sendPushToMultiple(
  deviceTokens: string[],
  payload: PushPayload
): Promise<string[]> {
  const failedTokens: string[] = [];
  for (const token of deviceTokens) {
    const ok = await sendPush(token, payload);
    if (!ok) failedTokens.push(token);
  }
  return failedTokens;
}
