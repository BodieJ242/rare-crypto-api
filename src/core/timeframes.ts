export type Venue = 'coinbase' | 'binanceus';
export type Timeframe = '1D' | '1W' | '1M';

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
