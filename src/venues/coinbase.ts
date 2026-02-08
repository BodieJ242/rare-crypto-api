import type { Candle } from './types.js';

// Coinbase Exchange candles endpoint supports granularity up to 1D.
// We'll fetch daily candles and resample to 1W / 1M.

export async function fetchCoinbaseDailyCandles(product: string, limit: number): Promise<Candle[]> {
  // Coinbase returns newest-first: [ time, low, high, open, close, volume ]
  const end = new Date();
  const start = new Date(end.getTime() - (limit + 5) * 24 * 60 * 60 * 1000);
  const url = new URL(`https://api.exchange.coinbase.com/products/${encodeURIComponent(product)}/candles`);
  url.searchParams.set('granularity', '86400');
  url.searchParams.set('start', start.toISOString());
  url.searchParams.set('end', end.toISOString());

  const r = await fetch(url.toString(), {
    headers: {
      'User-Agent': 'rare-crypto-api/1.0',
      'Accept': 'application/json',
    },
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`coinbase candles failed: ${r.status} ${t}`);
  }
  const data = (await r.json()) as any[];
  if (!Array.isArray(data)) throw new Error('coinbase candles: bad response');

  const candles = data
    .map(row => ({
      time: new Date(row[0] * 1000).toISOString(),
      low: Number(row[1]),
      high: Number(row[2]),
      open: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
    }))
    .reverse();

  return candles.slice(-limit);
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
