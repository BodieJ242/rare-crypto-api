export type Venue = 'coinbase' | 'binanceus';
export type Timeframe = '1D' | '1W' | '1M';

export const TIMEFRAMES: Timeframe[] = ['1D', '1W', '1M'];

export function tfWeight(tf: Timeframe): number {
  switch (tf) {
    case '1D': return 1;
    case '1W': return 2;
    case '1M': return 3;
  }
}

// Canonical symbol format used by the app/API: BASE-QUOTE
export type CanonSymbol = `${string}-${string}`;

export function toBinanceUsSymbol(sym: CanonSymbol): string {
  const [base, quote] = sym.split('-');
  return `${base}${quote}`.toUpperCase();
}

export function toCoinbaseProduct(sym: CanonSymbol): string {
  // Coinbase Exchange often lacks USDT pairs; USD is usually supported.
  const [base, quote] = sym.split('-');
  const q = quote.toUpperCase() === 'USDT' ? 'USD' : quote.toUpperCase();
  return `${base.toUpperCase()}-${q}`;
}
