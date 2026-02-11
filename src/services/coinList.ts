// Fetches the list of tradeable coins from Coinbase and Binance.US
// and returns them in a normalized format for the iOS app.

export type CoinInfo = {
  symbol: string;   // Canonical: BASE-QUOTE (e.g. BTC-USD)
  base: string;     // e.g. BTC
  quote: string;    // e.g. USD
  name?: string;    // Human-readable name if available
  venue: 'coinbase' | 'binanceus';
};

type CacheEntry<T> = { atMs: number; value: T };
const TTL_MS = 5 * 60_000; // 5 min cache

let coinbaseCache: CacheEntry<CoinInfo[]> | null = null;
let binanceCache: CacheEntry<CoinInfo[]> | null = null;

const VALID_QUOTES = new Set(['USD', 'USDT', 'USDC']);

export async function listCoins(venue: 'coinbase' | 'binanceus'): Promise<CoinInfo[]> {
  if (venue === 'coinbase') return listCoinbaseCoins();
  return listBinanceUsCoins();
}

async function listCoinbaseCoins(): Promise<CoinInfo[]> {
  const now = Date.now();
  if (coinbaseCache && now - coinbaseCache.atMs < TTL_MS) return coinbaseCache.value;

  const url = 'https://api.exchange.coinbase.com/products';
  const r = await fetch(url, {
    headers: { 'User-Agent': 'rare-crypto-api/1.0', 'Accept': 'application/json' },
  });
  if (!r.ok) throw new Error(`coinbase products failed: ${r.status}`);
  const arr = (await r.json()) as any[];

  const coins: CoinInfo[] = [];
  for (const p of arr ?? []) {
    const base = (p?.base_currency ?? '').toUpperCase();
    const quote = (p?.quote_currency ?? '').toUpperCase();
    if (!base || !VALID_QUOTES.has(quote)) continue;
    // Skip stablecoin-to-stablecoin pairs
    if (VALID_QUOTES.has(base)) continue;
    // Only include actively trading pairs
    if (p?.status && p.status !== 'online') continue;

    coins.push({
      symbol: `${base}-${quote}`,
      base,
      quote,
      name: p?.display_name || undefined,
      venue: 'coinbase',
    });
  }

  // Deduplicate: prefer USD > USDC > USDT for display
  const bestByBase = new Map<string, CoinInfo>();
  const quotePriority: Record<string, number> = { USD: 0, USDC: 1, USDT: 2 };
  for (const c of coins) {
    const existing = bestByBase.get(c.base);
    if (!existing || (quotePriority[c.quote] ?? 9) < (quotePriority[existing.quote] ?? 9)) {
      bestByBase.set(c.base, c);
    }
  }

  const result = Array.from(bestByBase.values()).sort((a, b) => a.base.localeCompare(b.base));
  coinbaseCache = { atMs: now, value: result };
  return result;
}

async function listBinanceUsCoins(): Promise<CoinInfo[]> {
  const now = Date.now();
  if (binanceCache && now - binanceCache.atMs < TTL_MS) return binanceCache.value;

  const url = 'https://api.binance.us/api/v3/exchangeInfo';
  const r = await fetch(url, { headers: { 'User-Agent': 'rare-crypto-api/1.0' } });
  if (!r.ok) throw new Error(`binanceus exchangeInfo failed: ${r.status}`);
  const j = (await r.json()) as any;

  const coins: CoinInfo[] = [];
  for (const s of j?.symbols ?? []) {
    const base = (s?.baseAsset ?? '').toUpperCase();
    const quote = (s?.quoteAsset ?? '').toUpperCase();
    if (!base || !VALID_QUOTES.has(quote)) continue;
    if (VALID_QUOTES.has(base)) continue;
    // Only include trading pairs
    if (s?.status && s.status !== 'TRADING') continue;

    coins.push({
      symbol: `${base}-${quote}`,
      base,
      quote,
      venue: 'binanceus',
    });
  }

  // Deduplicate: prefer USDT > USD > USDC
  const bestByBase = new Map<string, CoinInfo>();
  const quotePriority: Record<string, number> = { USDT: 0, USD: 1, USDC: 2 };
  for (const c of coins) {
    const existing = bestByBase.get(c.base);
    if (!existing || (quotePriority[c.quote] ?? 9) < (quotePriority[existing.quote] ?? 9)) {
      bestByBase.set(c.base, c);
    }
  }

  const result = Array.from(bestByBase.values()).sort((a, b) => a.base.localeCompare(b.base));
  binanceCache = { atMs: now, value: result };
  return result;
}
