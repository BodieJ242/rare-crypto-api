import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import { z } from 'zod';

import { migrate } from './db/migrate.js';
import { Repo } from './db/repo.js';
import { verifyAppleIdentityToken } from './auth/apple.js';
import { evaluateAlerts as alertsEvaluate } from './services/alerts.js';
import { listCoins } from './services/coinList.js';
import { startCronScanner } from './services/cron.js';

const env = {
  PORT: Number(process.env.PORT || 3000),
  NODE_ENV: process.env.NODE_ENV || 'development',
  DATABASE_URL: process.env.DATABASE_URL || '',
  JWT_SECRET: process.env.JWT_SECRET || '',
  JWT_ISSUER: process.env.JWT_ISSUER || 'rare-crypto-api',
  JWT_AUDIENCE: process.env.JWT_AUDIENCE || 'co.rarecrypto.rarecrypto',
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '90d',
  ENABLE_AUTH_DEV: String(process.env.ENABLE_AUTH_DEV || 'false').toLowerCase() === 'true',
  APPLE_AUDIENCE_IOS: process.env.APPLE_AUDIENCE_IOS || 'co.rarecrypto.rarecrypto',
  APPLE_ISSUER: process.env.APPLE_ISSUER || 'https://appleid.apple.com',
};

if (!env.DATABASE_URL) {
  console.error('DATABASE_URL missing');
}
if (!env.JWT_SECRET) {
  console.error('JWT_SECRET missing');
}

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });
await app.register(jwt, { secret: env.JWT_SECRET });

const repo = new Repo(env.DATABASE_URL);

app.get('/healthz', async () => ({ ok: true }));
app.get('/health', async () => ({ ok: true }));

// Temporary dev auth (useful until Apple Developer is ready)
app.post('/v1/auth/dev', async (req, reply) => {
  if (!env.ENABLE_AUTH_DEV) return reply.code(403).send({ error: 'dev auth disabled' });
  const body = z.object({ userId: z.string().min(1) }).parse((req as any).body ?? {});

  await repo.ensureUser(body.userId, null);

  const token = (app as any).jwt.sign(
    { uid: body.userId },
    { issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE, expiresIn: env.JWT_EXPIRES_IN }
  );

  return { token };
});

// Apple auth: verify Apple identity token, then mint our own session JWT
app.post('/v1/auth/apple', async (req) => {
  const body = z.object({ identityToken: z.string().min(10) }).parse((req as any).body ?? {});
  const verified = await verifyAppleIdentityToken({
    token: body.identityToken,
    audience: env.APPLE_AUDIENCE_IOS,
    issuer: env.APPLE_ISSUER,
  });

  const userId = `apple:${verified.sub}`;
  await repo.ensureUser(userId, verified.sub);

  const token = (app as any).jwt.sign(
    { uid: userId },
    { issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE, expiresIn: env.JWT_EXPIRES_IN }
  );

  return { token, userId };
});

// Auth hook
app.addHook('preHandler', async (req, reply) => {
  if ((req as any).url.startsWith('/v1/') && !(req as any).url.startsWith('/v1/auth/')) {
    try {
      await (req as any).jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  }
});

// Token refresh: issue a new JWT if the current one is still valid (requires auth)
app.post('/v1/token/refresh', async (req) => {
  const uid = (req as any).user.uid;
  const token = (app as any).jwt.sign(
    { uid },
    { issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE, expiresIn: env.JWT_EXPIRES_IN }
  );
  return { token, userId: uid };
});

app.get('/v1/coins/list', async (req) => {
  const venue = ((req as any).query?.venue ?? 'coinbase') as 'coinbase' | 'binanceus';
  if (venue !== 'coinbase' && venue !== 'binanceus') {
    return { error: 'venue must be coinbase or binanceus' };
  }
  const coins = await listCoins(venue);
  return { venue, count: coins.length, coins };
});

app.get('/v1/watchlist/get', async (req) => {
  const uid = (req as any).user.uid;
  const w = await repo.getWatchlist(uid);
  return w ?? { userId: uid, venue: 'binanceus', symbols: [], timeframes: ['1D','1W','1M'] };
});

app.post('/v1/watchlist/set', async (req) => {
  const uid = (req as any).user.uid;
  const body = z.object({
    venue: z.enum(['coinbase','binanceus']),
    symbols: z.array(z.string()),
    timeframes: z.array(z.enum(['1D','1W','1M'])),
  }).parse((req as any).body ?? {});

  await repo.upsertWatchlist({ userId: uid, venue: body.venue, symbols: body.symbols, timeframes: body.timeframes });
  return { ok: true };
});

app.get('/v1/settings/get', async (req) => {
  const uid = (req as any).user.uid;
  const s = await repo.getSettings(uid);
  return (
    s ?? {
      userId: uid,
      macd: { fast: 12, slow: 26, signal: 9 },
      thresholds: { great: 3, rare: 6 },
      lookbackCross: 3,
    }
  );
});

app.post('/v1/settings/set', async (req) => {
  const uid = (req as any).user.uid;

  const body = z
    .object({
      macd: z.object({ fast: z.number().int().min(1).max(200), slow: z.number().int().min(2).max(400), signal: z.number().int().min(1).max(200) }).optional(),
      thresholds: z.object({ great: z.number().int().min(1).max(6), rare: z.number().int().min(1).max(6) }).optional(),
      lookbackCross: z.number().int().min(1).max(30).optional(),
    })
    .parse((req as any).body ?? {});

  const prev = await repo.getSettings(uid);
  const next = {
    userId: uid,
    macd: body.macd ?? prev?.macd ?? { fast: 12, slow: 26, signal: 9 },
    thresholds: body.thresholds ?? prev?.thresholds ?? { great: 3, rare: 6 },
    lookbackCross: body.lookbackCross ?? prev?.lookbackCross ?? 3,
  };

  await repo.upsertSettings(next);
  return { ok: true, settings: next };
});

// ── Push Notification Device Tokens ──────────────────────────────────
app.post('/v1/device/register', async (req) => {
  const uid = (req as any).user.uid;
  const body = z.object({
    token: z.string().min(10),
    platform: z.enum(['ios', 'android']).default('ios'),
  }).parse((req as any).body ?? {});

  await repo.upsertDeviceToken(uid, body.token, body.platform);
  return { ok: true };
});

app.post('/v1/device/unregister', async (req) => {
  const uid = (req as any).user.uid;
  const body = z.object({ token: z.string().min(10) }).parse((req as any).body ?? {});
  await repo.removeDeviceToken(uid, body.token);
  return { ok: true };
});

// ── Cached Scan Results (for widget / quick load) ───────────────────
app.get('/v1/alerts/latest', async (req) => {
  const uid = (req as any).user.uid;
  const cached = await repo.getScanResults(uid);
  if (!cached) return { userId: uid, results: [], scannedAt: null };
  return { userId: uid, results: cached.results, scannedAt: cached.scannedAt };
});

// ── Account Deletion ───────────────────────────────────────────────
app.delete('/v1/account/delete', async (req) => {
  const uid = (req as any).user.uid;
  await repo.deleteUser(uid);
  return { ok: true, message: 'Account and all associated data have been permanently deleted.' };
});

app.post('/v1/alerts/run-batch', async (req) => {
  const uid = (req as any).user.uid;
  const w = await repo.getWatchlist(uid);
  const s = await repo.getSettings(uid);

  if (!w) return { userId: uid, results: [] };

  // DEBUG: if ?test=true, return fake alerts to verify the UI
  const useTestData = (req as any).query?.test === 'true';
  if (useTestData) {
    const now = new Date().toISOString();
    const fakeIndicators = (rsi: number, mfi: number, k: number, d: number, sma: number, close: number) => ({
      rsi, mfi, stochK: k, stochD: d, sma200: sma, close,
    });
    return {
      userId: uid,
      results: [
        {
          symbol: w.symbols[0] ?? 'BTC-USD',
          alerts: [{
            label: 'Momentum Buy', timeframe: 'MTF', at: now, confidence: 0.75,
            why: ['Momentum expansion confirmed (scale-in zone)', 'MACD line > signal', 'Histogram > 0 and rising', 'RSI ≤ 58 (42.5)', 'MFI ≤ 60 (38.2)', 'Weekly MACD confirms', 'Score: 3.0/4.0'],
            indicators: fakeIndicators(42.5, 38.2, 65.3, 58.1, 98500, 67200),
          }],
          scores: { bullScore: 4, bearScore: 0 },
          indicators: fakeIndicators(42.5, 38.2, 65.3, 58.1, 98500, 67200),
          resolvedSymbol: w.symbols[0] ?? 'BTC-USD', usedQuote: 'USD', fallbackUsed: false,
        },
        {
          symbol: w.symbols[1] ?? 'ETH-USD',
          alerts: [{
            label: 'Early Buy Setup', timeframe: '1D', at: now, confidence: 0.5,
            why: ['Daily MACD momentum bullish (+1): hist -9.45 → 5.00', 'Daily RSI < 55 (+0.5): 36.70', 'Daily MFI < 60 (+0.5): 28.89', 'RSI: 36.70 | MFI: 28.89 | StochRSI K/D: 89.11/71.66', 'Score: 2.0/4.0', '⚠ Timing risk: StochRSI overheated/rolling over'],
            indicators: fakeIndicators(36.7, 28.9, 89.1, 71.7, 3554, 1955),
          }],
          scores: { bullScore: 0, bearScore: 2 },
          indicators: fakeIndicators(36.7, 28.9, 89.1, 71.7, 3554, 1955),
          resolvedSymbol: w.symbols[1] ?? 'ETH-USD', usedQuote: 'USD', fallbackUsed: false,
        },
        {
          symbol: w.symbols[2] ?? 'SOL-USD',
          alerts: [{
            label: 'Great Sell', timeframe: '1D', at: now, confidence: 0.86,
            why: ['High-probability profit-taking zone', 'Daily MFI ≥ 80 (+1): 85.20', 'Daily StochRSI bearish cross (+1): K/D 92.1/88.3 → 87.5/89.1', 'Daily MACD weakening (+1): hist 2.45 → 1.98', 'RSI: 72.30 | MFI: 85.20 | StochRSI K/D: 87.50/89.10', 'Score: 3.0/3.5'],
            indicators: fakeIndicators(72.3, 85.2, 87.5, 89.1, 163.7, 128.5),
          }],
          scores: { bullScore: 3, bearScore: 0 },
          indicators: fakeIndicators(72.3, 85.2, 87.5, 89.1, 163.7, 128.5),
          resolvedSymbol: w.symbols[2] ?? 'SOL-USD', usedQuote: 'USD', fallbackUsed: false,
        },
        {
          symbol: w.symbols[3] ?? 'XRP-USD',
          alerts: [{
            label: 'Rare Accumulation', timeframe: '1D', at: now, confidence: 0.9,
            why: ['Close < SMA200 (0.42 < 1.85, -77.3%)', 'RSI < 35 (22.10)', 'StochRSI K/D: 15.30/18.40'],
            indicators: fakeIndicators(22.1, 18.5, 15.3, 18.4, 1.85, 0.42),
          }],
          scores: { bullScore: 0, bearScore: 5 },
          indicators: fakeIndicators(22.1, 18.5, 15.3, 18.4, 1.85, 0.42),
          resolvedSymbol: w.symbols[3] ?? 'XRP-USD', usedQuote: 'USD', fallbackUsed: false,
        },
        {
          symbol: w.symbols[4] ?? 'DOGE-USD',
          alerts: [],
          scores: { bullScore: 1, bearScore: 2 },
          resolvedSymbol: w.symbols[4] ?? 'DOGE-USD', usedQuote: 'USD', fallbackUsed: false,
        },
      ],
    };
  }

  const settings = s?.macd ?? { fast: 12, slow: 26, signal: 9 };
  // Weighted scoring: 1D=1, 1W=2, 1M=3 → max=6. great=3 means weekly+daily aligned, rare=6 means all three.
  const thresholds = s?.thresholds ?? { great: 3, rare: 6 };
  const lookbackCross = s?.lookbackCross ?? 3;

  const results = [] as any[];
  for (let i = 0; i < w.symbols.length; i++) {
    const symbol = w.symbols[i];
    const out = await alertsEvaluate({
      venue: w.venue,
      symbol: symbol as any,
      timeframes: w.timeframes as any,
      settings,
      thresholds,
      lookbackCross,
      limit: 500,
    });
    results.push({ symbol, alerts: out.alerts, scores: out.scores, resolvedSymbol: out.resolvedSymbol, usedQuote: out.usedQuote, fallbackUsed: out.fallbackUsed });

    // Throttle between symbols to avoid Coinbase rate limits
    if (i < w.symbols.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 400));
    }
  }

  return { userId: uid, results };
});

async function start() {
  if (env.DATABASE_URL) {
    await migrate(env.DATABASE_URL);
  }
  await app.listen({ port: env.PORT, host: '0.0.0.0' });

  // Start background scanner (scans all users every 4 hours)
  startCronScanner(repo);
}
// ── Debug / Test ───────────────────────────────────────────────
app.post('/v1/debug/test-push', async (req) => {
  const uid = (req as any).user.uid;
  const deviceTokens = await repo.getDeviceTokens(uid);
  
  if (deviceTokens.length === 0) {
    return { ok: false, message: 'No device tokens found for your account' };
  }

  const { sendPushToMultiple } = await import('./services/push.js');
  const failed = await sendPushToMultiple(deviceTokens, {
    title: '💎 Test Notification',
    body: 'RareCrypto push notifications are working!',
    badge: 1,
    data: { type: 'test' },
  });

  return {
    ok: true,
    tokenCount: deviceTokens.length,
    failedCount: failed.length,
    message: failed.length === 0 ? 'Push sent successfully!' : 'Some tokens failed',
  };
});

start().catch((e) => {
  app.log.error(e);
  process.exit(1);
});
