import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import { z } from 'zod';

import { migrate } from './db/migrate.js';
import { Repo } from './db/repo.js';
import { verifyAppleIdentityToken } from './auth/apple.js';
import { evaluateAlerts as alertsEvaluate } from './services/alerts.js';
import { listCoins } from './services/coinList.js';

const env = {
  PORT: Number(process.env.PORT || 3000),
  NODE_ENV: process.env.NODE_ENV || 'development',
  DATABASE_URL: process.env.DATABASE_URL || '',
  JWT_SECRET: process.env.JWT_SECRET || '',
  JWT_ISSUER: process.env.JWT_ISSUER || 'rare-crypto-api',
  JWT_AUDIENCE: process.env.JWT_AUDIENCE || 'co.rarecrypto.rarecrypto',
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '1h',
  ENABLE_AUTH_DEV: String(process.env.ENABLE_AUTH_DEV || 'true').toLowerCase() === 'true',
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

app.post('/v1/alerts/run-batch', async (req) => {
  const uid = (req as any).user.uid;
  const w = await repo.getWatchlist(uid);
  const s = await repo.getSettings(uid);

  if (!w) return { userId: uid, results: [] };

  const settings = s?.macd ?? { fast: 12, slow: 26, signal: 9 };
  // Weighted scoring: 1D=1, 1W=2, 1M=3 → max=6. great=3 means weekly+daily aligned, rare=6 means all three.
  const thresholds = s?.thresholds ?? { great: 3, rare: 6 };
  const lookbackCross = s?.lookbackCross ?? 3;

  const results = [] as any[];
  for (const symbol of w.symbols) {
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
  }

  return { userId: uid, results };
});

async function start() {
  if (env.DATABASE_URL) {
    await migrate(env.DATABASE_URL);
  }
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}

start().catch((e) => {
  app.log.error(e);
  process.exit(1);
});
