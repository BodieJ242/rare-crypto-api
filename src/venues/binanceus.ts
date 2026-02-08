import type { Candle } from './types.js';

const BINANCEUS_BASE = 'https://api.binance.us';

function interval(tf: '1D'|'1W'|'1M'): string {
  switch (tf) {
    case '1D': return '1d';
    case '1W': return '1w';
    case '1M': return '1M';
  }
}

export async function fetchBinanceUsCandles(symbol: string, tf: '1D'|'1W'|'1M', limit: number): Promise<Candle[]> {
  const url = new URL(BINANCEUS_BASE + '/api/v3/klines');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('interval', interval(tf));
  url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 1000)));

  const r = await fetch(url.toString(), { headers: { 'User-Agent': 'rare-crypto-api/1.0' } });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`binanceus klines failed: ${r.status} ${t}`);
  }
  const arr = (await r.json()) as any[];
  if (!Array.isArray(arr)) throw new Error('binanceus klines: bad response');

  // [ openTime, open, high, low, close, volume, closeTime, ...]
  return arr.map(k => ({
    time: new Date(Number(k[0])).toISOString(),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  }));
}
