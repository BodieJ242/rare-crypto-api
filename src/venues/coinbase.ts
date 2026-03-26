import type { Candle } from './types.js';

// Coinbase Exchange candles endpoint supports granularity up to 1D.
// IMPORTANT: Coinbase caps the number of returned candles (~300) for a given time range.
// So for large limits we page backwards in time.

const MAX_CANDLES_PER_REQUEST = 300;
const DAY_MS = 24 * 60 * 60 * 1000;

// Rate-limit handling
const PAGE_DELAY_MS = 300;   // Pause between pagination requests for the same symbol
const MAX_RETRIES = 4;       // Max attempts on 429 / transient errors
const RETRY_BASE_MS = 1000;  // Base back-off: 1 s, 2 s, 4 s, 8 s

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchCoinbaseDailyCandlesPage(params: {
  product: string;
  start: Date;
  end: Date;
}): Promise<Candle[]> {
  const url = new URL(`https://api.exchange.coinbase.com/products/${encodeURIComponent(params.product)}/candles`);
  url.searchParams.set('granularity', '86400');
  url.searchParams.set('start', params.start.toISOString());
  url.searchParams.set('end', params.end.toISOString());

  let lastError: Error | undefined;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // Exponential back-off between retries: 1 s, 2 s, 4 s …
      await sleep(RETRY_BASE_MS * Math.pow(2, attempt - 1));
    }

    const r = await fetch(url.toString(), {
      headers: {
        'User-Agent': 'rare-crypto-api/1.0',
        'Accept': 'application/json',
      },
    });

    if (r.status === 429) {
      // Respect Retry-After if provided, otherwise back off exponentially
      const retryAfter = r.headers.get('Retry-After');
      const waitMs = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : RETRY_BASE_MS * Math.pow(2, attempt);
      console.warn(`[coinbase] Rate limited (429) for ${params.product}, waiting ${waitMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await sleep(waitMs);
      lastError = new Error(`coinbase candles rate limited: 429`);
      continue;
    }

    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error(`coinbase candles failed: ${r.status} ${t}`);
    }

    const data = (await r.json()) as any[];
    if (!Array.isArray(data)) throw new Error('coinbase candles: bad response');

    return data
      .map(row => ({
        time: new Date(row[0] * 1000).toISOString(),
        low: Number(row[1]),
        high: Number(row[2]),
        open: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5]),
      }))
      // Coinbase returns newest-first
      .reverse();
  }

  throw lastError ?? new Error('coinbase candles: max retries exceeded');
}

export async function fetchCoinbaseDailyCandles(product: string, limit: number): Promise<Candle[]> {
  const need = Math.min(Math.max(limit, 1), 2000); // internal safety cap

  // Page backwards until we have enough.
  let end = new Date();
  const out: Candle[] = [];
  const seen = new Set<string>();
  let firstPage = true;

  while (out.length < need) {
    // Throttle between pagination requests to stay within Coinbase rate limits
    if (!firstPage) {
      await sleep(PAGE_DELAY_MS);
    }
    firstPage = false;

    const remaining = need - out.length;
    // Request at most 300 candles; add a small buffer.
    const pageSize = Math.min(MAX_CANDLES_PER_REQUEST, Math.max(50, remaining + 5));
    const start = new Date(end.getTime() - pageSize * DAY_MS);

    const page = await fetchCoinbaseDailyCandlesPage({ product, start, end });
    if (page.length === 0) break;

    for (const c of page) {
      if (seen.has(c.time)) continue;
      seen.add(c.time);
      out.push(c);
    }

    // Move the window back to just before the earliest candle in this page.
    const earliest = page[0];
    end = new Date(new Date(earliest.time).getTime() - 1000);

    // If Coinbase returned fewer than requested, we've probably hit the beginning.
    if (page.length < 10) break;
  }

  // Ensure chronological order and take the most recent N.
  out.sort((a, b) => a.time.localeCompare(b.time));
  return out.slice(-need);
}

function startOfWeekUtc(d: Date): Date {
  // Monday-based week
  const day = d.getUTCDay(); // 0..6 (Sun..Sat)
  const diff = (day === 0 ? -6 : 1 - day);
  const out = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  out.setUTCDate(out.getUTCDate() + diff);
  return out;
}

function startOfMonthUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export function resampleDailyToWeekly(daily: Candle[]): Candle[] {
  const buckets = new Map<string, Candle[]>();
  for (const c of daily) {
    const d = new Date(c.time);
    const k = startOfWeekUtc(d).toISOString().slice(0, 10);
    const arr = buckets.get(k) || [];
    arr.push(c);
    buckets.set(k, arr);
  }

  const keys = Array.from(buckets.keys()).sort();
  const out: Candle[] = [];
  for (const k of keys) {
    const arr = buckets.get(k)!;
    arr.sort((a, b) => a.time.localeCompare(b.time));
    const open = arr[0].open;
    const close = arr[arr.length - 1].close;
    const high = Math.max(...arr.map(x => x.high));
    const low = Math.min(...arr.map(x => x.low));
    const volume = arr.reduce((s, x) => s + x.volume, 0);
    out.push({ time: new Date(k + 'T00:00:00.000Z').toISOString(), open, high, low, close, volume });
  }
  return out;
}

export function resampleDailyToMonthly(daily: Candle[]): Candle[] {
  const buckets = new Map<string, Candle[]>();
  for (const c of daily) {
    const d = new Date(c.time);
    const k = startOfMonthUtc(d).toISOString().slice(0, 7); // YYYY-MM
    const arr = buckets.get(k) || [];
    arr.push(c);
    buckets.set(k, arr);
  }

  const keys = Array.from(buckets.keys()).sort();
  const out: Candle[] = [];
  for (const k of keys) {
    const arr = buckets.get(k)!;
    arr.sort((a, b) => a.time.localeCompare(b.time));
    const open = arr[0].open;
    const close = arr[arr.length - 1].close;
    const high = Math.max(...arr.map(x => x.high));
    const low = Math.min(...arr.map(x => x.low));
    const volume = arr.reduce((s, x) => s + x.volume, 0);
    out.push({ time: new Date(k + '-01T00:00:00.000Z').toISOString(), open, high, low, close, volume });
  }
  return out;
}
