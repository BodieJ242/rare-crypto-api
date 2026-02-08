import type { Timeframe, Venue, CanonSymbol } from '../core/timeframes.js';
import type { MacdSettings } from '../core/macd.js';
import { computeMacd, crossesDown, crossesUp } from '../core/macd.js';
import { getOhlcv } from './market.js';

type PerTf = {
  timeframe: Timeframe;
  macd: number;
  signal: number;
  hist: number;
  crossUp: boolean;
  crossDown: boolean;
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
  resolvedSymbol: string;
  usedQuote: string;
  fallbackUsed: boolean;
  perTimeframe: Record<Timeframe, PerTf>;
  mtf: { bullScore: number; bearScore: number };
}> {
  const perTimeframe = {} as Record<Timeframe, PerTf>;
  let resolvedSymbol = '';
  let usedQuote = '';
  let fallbackUsed = false;

  for (const tf of args.timeframes) {
    const o = await getOhlcv({ venue: args.venue, symbol: args.symbol, timeframe: tf, limit: args.limit });
    resolvedSymbol = o.resolvedSymbol;
    usedQuote = o.usedQuote;
    fallbackUsed = o.fallbackUsed;

    const close = o.candles.map(c => c.close);
    const series = computeMacd(close, args.settings);

    const macd = last(series.macd);
    const signal = last(series.signal);
    const hist = last(series.hist);

    const prevMacd = series.macd[series.macd.length - 2] ?? macd;
    const prevSignal = series.signal[series.signal.length - 2] ?? signal;
    const prevHist = series.hist[series.hist.length - 2] ?? hist;

    const crossUp = crossesUp(prevMacd, prevSignal, macd, signal);
    const crossDown = crossesDown(prevMacd, prevSignal, macd, signal);
    const histFlipUp = prevHist <= 0 && hist > 0;
    const histFlipDown = prevHist >= 0 && hist < 0;

    perTimeframe[tf] = { timeframe: tf, macd, signal, hist, crossUp, crossDown, histFlipUp, histFlipDown };
  }

  // Score: bullish if macd>signal, bearish if macd<signal.
  // (Matches the relaxed logic we decided on for the MCP server.)
  let bullScore = 0;
  let bearScore = 0;
  for (const tf of args.timeframes) {
    const p = perTimeframe[tf];
    if (!p) continue;
    if (p.macd > p.signal) bullScore++;
    if (p.macd < p.signal) bearScore++;
  }

  return {
    symbol: args.symbol,
    resolvedSymbol,
    usedQuote,
    fallbackUsed,
    perTimeframe,
    mtf: { bullScore, bearScore },
  };
}
