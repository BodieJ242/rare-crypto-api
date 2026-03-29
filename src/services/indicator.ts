import type { Timeframe, Venue, CanonSymbol } from '../core/timeframes.js';
import { tfWeight } from '../core/timeframes.js';
import type { MacdSettings } from '../core/macd.js';
import { computeMacd, crossesDown, crossesUp } from '../core/macd.js';
import { rsi, mfi, stochRsi, sma, VOLUME_SMA_LEN, VOLUME_THRESHOLD, type DailyIndicators } from '../core/indicators.js';
import { getOhlcv } from './market.js';
import type { Candle } from '../venues/types.js';

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
  perTimeframe: Record<string, PerTfState>;
  mtf: { bullScore: number; bearScore: number };
  daily: DailyIndicators | null;
}> {
  const perTimeframe = {} as Record<string, PerTfState>;

  let bullScore = 0;
  let bearScore = 0;

  let resolvedSymbol: string | null = null;
  let usedQuote: string | null = null;
  let fallbackUsed = false;

  let dailyIndicators: DailyIndicators | null = null;

  for (const tf of args.timeframes) {
    const o = await getOhlcv({ venue: args.venue, symbol: args.symbol, timeframe: tf, limit: args.limit });
    if (!resolvedSymbol) {
      resolvedSymbol = o.resolvedSymbol;
      usedQuote = o.usedQuote;
      fallbackUsed = o.fallbackUsed;
    }

    const closes = o.candles.map((c: Candle) => c.close);
    if (closes.length < args.settings.slow + args.settings.signal + 2) {
      console.warn(`Skipping ${tf}: only ${closes.length} candles (need ${args.settings.slow + args.settings.signal + 2})`);
      continue;
    }

    const series = computeMacd(closes, args.settings);

    const i = closes.length - 1;
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
      histFlipUp: histIncreasing && !histIncreasingPrev,
      histFlipDown: !histIncreasing && histIncreasingPrev,
    };

    perTimeframe[tf] = state;

    const bullTF = state.aboveZero && state.histIncreasing;
    const bearTF = !state.aboveZero && !state.histIncreasing;

    if (bullTF) bullScore += tfWeight(tf);
    if (bearTF) bearScore += tfWeight(tf);

    // Compute extra indicators on daily timeframe
    if (tf === '1D') {
      const highs = o.candles.map((c: Candle) => c.high);
      const lows = o.candles.map((c: Candle) => c.low);
      const vols = o.candles.map((c: Candle) => c.volume);

      const rsiArr = rsi(closes, 14);
      const mfiArr = mfi(highs, lows, closes, vols, 14);
      const stoch = stochRsi(closes, 14, 3, 3);
      const sma200Arr = sma(closes, 200);

      // Volume confirmation: 20-period SMA of volume
      const volSmaArr = sma(vols, VOLUME_SMA_LEN);
      const currentVol = vols[i] ?? 0;
      const currentVolAvg = volSmaArr[i] ?? NaN;
      const volumeRatio = isFinite(currentVolAvg) && currentVolAvg > 0
        ? currentVol / currentVolAvg
        : NaN;
      const highVolume = isFinite(volumeRatio) && volumeRatio >= VOLUME_THRESHOLD;

      dailyIndicators = {
        rsi: rsiArr[i] ?? NaN,
        mfi: mfiArr[i] ?? NaN,
        stochK: stoch.k[i] ?? NaN,
        stochD: stoch.d[i] ?? NaN,
        stochKPrev: stoch.k[i - 1] ?? NaN,
        stochDPrev: stoch.d[i - 1] ?? NaN,
        sma200: sma200Arr[i] ?? NaN,
        close: closes[i],
        macd: macdNow,
        signal: sigNow,
        hist: histNow,
        histPrev,
        macdLine: macdNow,
        signalLine: sigNow,
        volume: currentVol,
        volumeAvg: currentVolAvg,
        volumeRatio,
        highVolume,
      };
    }
  }

  return {
    symbol: args.symbol,
    venue: args.venue,
    resolvedSymbol: resolvedSymbol ?? (args.symbol as string),
    usedQuote: usedQuote ?? 'USDT',
    fallbackUsed,
    perTimeframe,
    mtf: { bullScore, bearScore },
    daily: dailyIndicators,
  };
}