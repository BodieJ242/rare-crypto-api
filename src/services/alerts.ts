import type { Timeframe, Venue, CanonSymbol } from '../core/timeframes.js';
import type { MacdSettings } from '../core/macd.js';
import { computeMacd, crossesDown, crossesUp } from '../core/macd.js';
import { computeCmUltMacdMtf } from './indicator.js';
import { getOhlcv } from './market.js';

export type AlertLabel =
  | 'Good Buy'
  | 'Great Buy'
  | 'Rare Buy'
  | 'Good Sell'
  | 'Great Sell'
  | 'Rare Sell';

export type Alert = {
  label: AlertLabel;
  timeframe: '1D' | 'MTF';
  at: string; // ISO
  confidence: number;
  why: string[];
};

export async function evaluateAlerts(args: {
  venue: Venue;
  symbol: CanonSymbol;
  timeframes: Timeframe[];
  settings: MacdSettings;
  thresholds: { great: number; rare: number };
  lookbackCross: number;
  limit: number;
}): Promise<{ symbol: CanonSymbol; resolvedSymbol: string; usedQuote: string; fallbackUsed: boolean; alerts: Alert[]; scores: { bullScore: number; bearScore: number } }> {
  const res = await computeCmUltMacdMtf({
    venue: args.venue,
    symbol: args.symbol,
    timeframes: args.timeframes,
    settings: args.settings,
    limit: args.limit,
  });

  const daily = res.perTimeframe['1D'];
  const bullScore = res.mtf.bullScore;
  const bearScore = res.mtf.bearScore;

  const alerts: Alert[] = [];
  const now = new Date().toISOString();

  const dailyBuyEvent = daily.crossUp || daily.histFlipUp;
  const dailySellEvent = daily.crossDown || daily.histFlipDown;

  // Rare requires a MACD cross within the last N *closed* daily candles.
  const lookback = Math.max(1, Math.floor(args.lookbackCross || 1));
  const need = Math.max(args.settings.slow + args.settings.signal + 5, lookback + 5);
  const ohlcv1d = await getOhlcv({
    venue: args.venue,
    symbol: args.symbol,
    timeframe: '1D',
    limit: Math.min(Math.max(args.limit || 200, need), 500),
  });
  const close = ohlcv1d.candles.map(c => c.close);
  const series = computeMacd(close, args.settings);

  function crossUpWithinLastN(): boolean {
    const n = Math.min(lookback, close.length - 1);
    for (let i = close.length - n; i < close.length; i++) {
      if (i <= 0) continue;
      if (crossesUp(series.macd[i - 1], series.signal[i - 1], series.macd[i], series.signal[i])) return true;
    }
    return false;
  }

  function crossDownWithinLastN(): boolean {
    const n = Math.min(lookback, close.length - 1);
    for (let i = close.length - n; i < close.length; i++) {
      if (i <= 0) continue;
      if (crossesDown(series.macd[i - 1], series.signal[i - 1], series.macd[i], series.signal[i])) return true;
    }
    return false;
  }

  const dailyCrossUpWithin = crossUpWithinLastN();
  const dailyCrossDownWithin = crossDownWithinLastN();

  if (bullScore === args.thresholds.rare && dailyCrossUpWithin) {
    alerts.push({
      label: 'Rare Buy',
      timeframe: 'MTF',
      at: now,
      confidence: 1.0,
      why: [`bullScore=${bullScore} (all timeframes bullish)`, `daily crossUp within last ${lookback} candles`],
    });
  } else if (bullScore >= args.thresholds.great && dailyBuyEvent) {
    alerts.push({
      label: 'Great Buy',
      timeframe: 'MTF',
      at: now,
      confidence: Math.min(1, bullScore / 6),
      why: [`bullScore=${bullScore} >= ${args.thresholds.great}`, `daily event=${daily.crossUp ? 'crossUp' : 'histFlipUp'}`],
    });
  } else if (dailyBuyEvent) {
    alerts.push({
      label: 'Good Buy',
      timeframe: '1D',
      at: now,
      confidence: 0.5,
      why: [`daily event=${daily.crossUp ? 'crossUp' : 'histFlipUp'}`],
    });
  }

  if (bearScore === args.thresholds.rare && dailyCrossDownWithin) {
    alerts.push({
      label: 'Rare Sell',
      timeframe: 'MTF',
      at: now,
      confidence: 1.0,
      why: [`bearScore=${bearScore} (all timeframes bearish)`, `daily crossDown within last ${lookback} candles`],
    });
  } else if (bearScore >= args.thresholds.great && dailySellEvent) {
    alerts.push({
      label: 'Great Sell',
      timeframe: 'MTF',
      at: now,
      confidence: Math.min(1, bearScore / 6),
      why: [`bearScore=${bearScore} >= ${args.thresholds.great}`, `daily event=${daily.crossDown ? 'crossDown' : 'histFlipDown'}`],
    });
  } else if (dailySellEvent) {
    alerts.push({
      label: 'Good Sell',
      timeframe: '1D',
      at: now,
      confidence: 0.5,
      why: [`daily event=${daily.crossDown ? 'crossDown' : 'histFlipDown'}`],
    });
  }

  return {
    symbol: args.symbol,
    resolvedSymbol: res.resolvedSymbol,
    usedQuote: res.usedQuote,
    fallbackUsed: res.fallbackUsed,
    alerts,
    scores: { bullScore, bearScore },
  };
}
