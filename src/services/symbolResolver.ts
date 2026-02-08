import type { Venue, CanonSymbol } from '../core/timeframes.js';
import { toBinanceUsSymbol, toCoinbaseProduct } from '../core/timeframes.js';

export type ResolvedSymbol = {
  requested: CanonSymbol;
  resolvedForVenue: string; // Coinbase productId or Binance symbol
  usedQuote: string;
  fallbackUsed: boolean;
};

type CacheEntry<T> = { atMs: number; value: T };
const TTL_MS = 10 * 60_000;

let binanceInfoCache: CacheEntry<Set<string>> | null = null;
let coinbaseProductsCache: CacheEntry<Set<string>> | null = null;

async function getBinanceUsSymbols(): Promise<Set<string>> {
  const now = Date.now();
  if (binanceInfoCache && now - binanceInfoCache.atMs < TTL_MS) return binanceInfoCache.value;

  const url = 'https://api.binance.us/api/v3/exchangeInfo';
  const r = await fetch(url, { headers: { 'User-Agent': 'rare-crypto-api/1.0' } });
  if (!r.ok) throw new Error(`binanceus exchangeInfo failed: ${r.status}`);
  const j = (await r.json()) as any;
  const set = new Set<string>();
  for (const s of j?.symbols ?? []) {
    if (typeof s?.symbol === 'string') set.add(s.symbol);
  }
  binanceInfoCache = { atMs: now, value: set };
  return set;
}

async function getCoinbaseProducts(): Promise<Set<string>> {
  const now = Date.now();
  if (coinbaseProductsCache && now - coinbaseProductsCache.atMs < TTL_MS) return coinbaseProductsCache.value;

  const url = 'https://api.exchange.coinbase.com/products';
  const r = await fetch(url, { headers: { 'User-Agent': 'rare-crypto-api/1.0', 'Accept': 'application/json' } });
  if (!r.ok) throw new Error(`coinbase products failed: ${r.status}`);
  const arr = (await r.json()) as any[];
  const set = new Set<string>();
  for (const p of arr ?? []) {
    if (typeof p?.id === 'string') set.add(p.id);
  }
  coinbaseProductsCache = { atMs: now, value: set };
  return set;
}

function splitCanon(sym: CanonSymbol): { base: string; quote: string } {
  const [base, quote] = sym.split('-');
  if (!base || !quote) throw new Error(`Bad symbol format (expected BASE-QUOTE): ${sym}`);
  return { base: base.toUpperCase(), quote: quote.toUpperCase() };
}

function candidatesForQuote(quote: string): string[] {
  switch (quote) {
    case 'USDC': return ['USDC', 'USD', 'USDT'];
    case 'USD': return ['USD', 'USDT', 'USDC'];
    default: return ['USDT', 'USD', 'USDC'];
  }
}

export async function resolveSymbol(venue: Venue, requested: CanonSymbol): Promise<ResolvedSymbol> {
  const { base, quote } = splitCanon(requested);
  if (!['USDT', 'USDC', 'USD'].includes(quote)) {
    throw new Error(`Unsupported quote: ${quote}. Use USDT, USDC, or USD.`);
  }

  const quotes = candidatesForQuote(quote);

  if (venue === 'binanceus') {
    const avail = await getBinanceUsSymbols();
    for (const q of quotes) {
      const bin = `${base}${q}`;
      if (avail.has(bin)) {
        return { requested, resolvedForVenue: bin, usedQuote: q, fallbackUsed: q !== quote };
      }
    }
    return { requested, resolvedForVenue: toBinanceUsSymbol(`${base}-${quotes[0]}` as CanonSymbol), usedQuote: quotes[0], fallbackUsed: true };
  }

  // coinbase
  const products = await getCoinbaseProducts();
  for (const q of quotes) {
    const product = `${base}-${q}`;
    if (products.has(product)) {
      return { requested, resolvedForVenue: product, usedQuote: q, fallbackUsed: q !== quote };
    }
  }

  const product = toCoinbaseProduct(`${base}-${quote}` as CanonSymbol);
  return { requested, resolvedForVenue: product, usedQuote: product.split('-')[1] || 'USD', fallbackUsed: true };
}
