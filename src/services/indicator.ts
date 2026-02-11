import type { Timeframe, Venue, CanonSymbol } from '../core/timeframes.js';
import { tfWeight } from '../core/timeframes.js';
import type { MacdSettings } from '../core/macd.js';
import { computeMacd, crossesDown, crossesUp } from '../core/macd.js';
import { getOhlcv } from './market.js';

export type PerTfState = {
  timeframe: Timeframe;
  macd: number;
  signal: number;
  hist: number;
  crossUp: boolean;
  crossDown: boolean;
  aboveZero: boolean;
  histIncreasing: boolean;
  histFlipUp: boolean;
  histFlipDown: boolean;
};

function last<T>(a: T[]): T {
  if (a.length === 0) throw new Error('empty series');
  return a[a.length - 1];
}

export async function computeCmUltMacdMtf(args: {
  venue: Venue;
  symbol: CanonSymbol;
  timeframes: Timeframe[];
  settings: MacdSettings;
  limit: number;
}): Promise<{
  symbol: CanonSymbol;
  venue: Venue;
  resolvedSymbol: string;
  usedQuote: string;
  fallbackUsed: boolean;
  perTimeframe: Record<Timeframe, PerTfState>;
  mtf: { bullScore: number; bearScore: number };
}> {
  const perTimeframe = {} as Record<Timeframe, PerTfState>;

  let bullScore = 0;
  let bearScore = 0;

  let resolvedSymbol: string | null = null;
  let usedQuote: string | null = null;
  let fallbackUsed = false;

  for (const tf of args.timeframes) {
    const o = await getOhlcv({ venue: args.venue, symbol: args.symbol, timeframe: tf, limit: args.limit });
    if (!resolvedSymbol) {
      resolvedSymbol = o.resolvedSymbol;
      usedQuote = o.usedQuote;
      fallbackUsed = o.fallbackUsed;
    }

    const close = o.candles.map(c => c.close);
    if (close.length < args.settings.slow + args.settings.signal + 2) {
      throw new Error(`Not enough candles for ${tf} (got ${close.length})`);
    }

    const series = computeMacd(close, args.settings);

    const i = close.length - 1;
    const macdNow = series.macd[i];
    const sigNow = series.signal[i];
    const histNow = series.hist[i];
    const macdPrev = series.macd[i - 1] ?? macdNow;
    const sigPrev = series.signal[i - 1] ?? sigNow;
    const histPrev = series.hist[i - 1] ?? histNow;
    const histPrev2 = series.hist[i - 2] ?? histPrev;

    const histIncreasing = histNow > histPrev;
    const histIncreasingPrev = histPrev > histPrev2;

    const state: PerTfState = {
      timeframe: tf,
      macd: macdNow,
      signal: sigNow,
      hist: histNow,
      crossUp: crossesUp(macdPrev, sigPrev, macdNow, sigNow),
      crossDown: crossesDown(macdPrev, sigPrev, macdNow, sigNow),
      aboveZero: macdNow > 0,
      histIncreasing,
      // histFlip = momentum change (not zero-line cross)
      histFlipUp: histIncreasing && !histIncreasingPrev,
      histFlipDown: !histIncreasing && histIncreasingPrev,
    };

    perTimeframe[tf] = state;

    // Weighted scoring: bull requires MACD above zero AND histogram increasing
    const bullTF = state.aboveZero && state.histIncreasing;
    const bearTF = !state.aboveZero && !state.histIncreasing;

    if (bullTF) bullScore += tfWeight(tf);
    if (bearTF) bearScore += tfWeight(tf);
  }

  return {
    symbol: args.symbol,
    venue: args.venue,
    resolvedSymbol: resolvedSymbol ?? (args.symbol as string),
    usedQuote: usedQuote ?? 'USDT',
    fallbackUsed,
    perTimeframe,
    mtf: { bullScore, bearScore },
  };
}
