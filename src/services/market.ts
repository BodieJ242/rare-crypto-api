import type { Candle } from '../venues/types.js';
import type { Timeframe, Venue, CanonSymbol } from '../core/timeframes.js';
import { fetchCoinbaseDailyCandles, resampleDailyToMonthly, resampleDailyToWeekly } from '../venues/coinbase.js';
import { fetchBinanceUsCandles } from '../venues/binanceus.js';
import { resolveSymbol } from './symbolResolver.js';

export async function getOhlcv(params: {
  venue: Venue;
  symbol: CanonSymbol;
  timeframe: Timeframe;
  limit: number;
}): Promise<{ symbol: CanonSymbol; timeframe: Timeframe; candles: Candle[]; resolvedSymbol: string; fallbackUsed: boolean; usedQuote: string }> {
  const { venue, symbol, timeframe } = params;
  const limit = Math.min(Math.max(params.limit ?? 500, 1), 500);

  const resolved = await resolveSymbol(venue, symbol);

  if (venue === 'binanceus') {
    const candles = await fetchBinanceUsCandles(resolved.resolvedForVenue, timeframe, limit);
    return { symbol, timeframe, candles, resolvedSymbol: resolved.resolvedForVenue, fallbackUsed: resolved.fallbackUsed, usedQuote: resolved.usedQuote };
  }

  // coinbase
  const product = resolved.resolvedForVenue;
  if (timeframe === '1D') {
    const candles = await fetchCoinbaseDailyCandles(product, limit);
    return { symbol, timeframe, candles, resolvedSymbol: product, fallbackUsed: resolved.fallbackUsed, usedQuote: resolved.usedQuote };
  }

  const daily = await fetchCoinbaseDailyCandles(product, timeframe === '1M' ? Math.max(limit * 31, 1200) : Math.max(limit * 7, 200));
  const candles = timeframe === '1W' ? resampleDailyToWeekly(daily) : resampleDailyToMonthly(daily);
  return { symbol, timeframe, candles: candles.slice(-limit), resolvedSymbol: product, fallbackUsed: resolved.fallbackUsed, usedQuote: resolved.usedQuote };
}
