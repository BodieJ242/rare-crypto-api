import type { Timeframe, Venue, CanonSymbol } from '../core/timeframes.js';
import type { MacdSettings } from '../core/macd.js';
import { computeCmUltMacdMtf } from './indicator.js';
import type { DailyIndicators } from '../core/indicators.js';

// ─── Alert Types ─────────────────────────────────────────────────

export type AlertLabel =
  // Buy tiers
  | 'Early Buy Setup'
  | 'Momentum Buy'
  | 'Rare Accumulation'
  // Sell tiers
  | 'Good Sell'
  | 'Great Sell';

export type Alert = {
  label: AlertLabel;
  timeframe: '1D' | 'MTF';
  at: string;
  confidence: number;
  why: string[];
  indicators?: {
    rsi?: number;
    mfi?: number;
    stochK?: number;
    stochD?: number;
    sma200?: number;
    close?: number;
  };
};

// ─── Scoring helpers ─────────────────────────────────────────────

function fmt(n: number): string {
  return isFinite(n) ? n.toFixed(2) : 'n/a';
}

// ─── BUY scoring (out of 4.0, matching your Python scanner) ─────

function scoreBuy(d: DailyIndicators, weeklyMacdBullish: boolean): { score: number; reasons: string[]; timingRisk: boolean } {
  let score = 0;
  const reasons: string[] = [];
  let timingRisk = false;

  // +1: Weekly trend bullish (weekly MACD histogram increasing or above zero)
  if (weeklyMacdBullish) {
    score += 1;
    reasons.push('Weekly MACD bullish (+1)');
  }

  // +1: Daily MACD momentum bullish (histogram improving)
  if (d.hist > d.histPrev) {
    score += 1;
    reasons.push(`Daily MACD momentum bullish (+1): hist ${fmt(d.histPrev)} → ${fmt(d.hist)}`);
  }

  // +0.5: Daily RSI < 55 (not overbought)
  if (isFinite(d.rsi) && d.rsi < 55) {
    score += 0.5;
    reasons.push(`Daily RSI < 55 (+0.5): ${fmt(d.rsi)}`);
  }

  // +0.5: Daily MFI < 60 (money flow not overextended)
  if (isFinite(d.mfi) && d.mfi < 60) {
    score += 0.5;
    reasons.push(`Daily MFI < 60 (+0.5): ${fmt(d.mfi)}`);
  }

  // Timing risk: StochRSI overheated/rolling over
  if (isFinite(d.stochK) && isFinite(d.stochD)) {
    if (d.stochK > 80 || (d.stochKPrev > d.stochDPrev && d.stochK < d.stochD)) {
      timingRisk = true;
    }
  }

  return { score, reasons, timingRisk };
}

/** Momentum Add Zone: the upgrade from Early Buy Setup */
function isMomentumBuyZone(d: DailyIndicators, weeklyMacdBullish: boolean): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];

  // All conditions must be true:
  const macdAboveSignal = d.macdLine > d.signalLine;
  const histAboveZero = d.hist > 0;
  const histRising = d.hist > d.histPrev;
  const rsiOk = isFinite(d.rsi) && d.rsi <= 58;
  const mfiOk = isFinite(d.mfi) && d.mfi <= 60;

  if (macdAboveSignal) reasons.push(`MACD line > signal (${fmt(d.macdLine)} > ${fmt(d.signalLine)})`);
  if (histAboveZero) reasons.push(`Histogram > 0 (${fmt(d.hist)})`);
  if (histRising) reasons.push(`Histogram rising (${fmt(d.histPrev)} → ${fmt(d.hist)})`);
  if (rsiOk) reasons.push(`RSI ≤ 58 (${fmt(d.rsi)})`);
  if (mfiOk) reasons.push(`MFI ≤ 60 (${fmt(d.mfi)})`);
  if (weeklyMacdBullish) reasons.push('Weekly MACD confirms');

  const pass = macdAboveSignal && histAboveZero && histRising && rsiOk && mfiOk && weeklyMacdBullish;

  return { pass, reasons };
}

// ─── SELL scoring (out of 3.5, matching your Python scanner) ────

function scoreSell(d: DailyIndicators): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  // +1: Daily MFI >= 80 (overbought money flow)
  if (isFinite(d.mfi) && d.mfi >= 80) {
    score += 1;
    reasons.push(`Daily MFI ≥ 80 (+1): ${fmt(d.mfi)}`);
  }

  // +1: Daily StochRSI bearish cross
  if (isFinite(d.stochK) && isFinite(d.stochD) && isFinite(d.stochKPrev) && isFinite(d.stochDPrev)) {
    const prevBullish = d.stochKPrev >= d.stochDPrev;
    const nowBearish = d.stochK < d.stochD;
    if (prevBullish && nowBearish) {
      score += 1;
      reasons.push(`Daily StochRSI bearish cross (+1): K/D ${fmt(d.stochKPrev)}/${fmt(d.stochDPrev)} → ${fmt(d.stochK)}/${fmt(d.stochD)}`);
    }
  }

  // +1: Daily MACD weakening (histogram declining while positive, or increasingly negative)
  if (d.hist < d.histPrev) {
    score += 1;
    reasons.push(`Daily MACD weakening (+1): hist ${fmt(d.histPrev)} → ${fmt(d.hist)}`);
  }

  // +0.5: Daily RSI >= 65 (approaching overbought)
  if (isFinite(d.rsi) && d.rsi >= 65) {
    score += 0.5;
    reasons.push(`Daily RSI ≥ 65 (+0.5): ${fmt(d.rsi)}`);
  }

  return { score, reasons };
}

// ─── Cycle alert: Rare Accumulation ──────────────────────────────

function checkRareAccumulation(d: DailyIndicators): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const belowSma200 = isFinite(d.sma200) && d.close < d.sma200;
  const rsiOversold = isFinite(d.rsi) && d.rsi < 35;

  if (belowSma200) {
    const pct = ((d.close - d.sma200) / d.sma200 * 100).toFixed(1);
    reasons.push(`Close < SMA200 (${fmt(d.close)} < ${fmt(d.sma200)}, ${pct}%)`);
  }
  if (rsiOversold) {
    reasons.push(`RSI < 35 (${fmt(d.rsi)})`);
  }

  return { pass: belowSma200 && rsiOversold, reasons };
}

// ─── Main evaluation ─────────────────────────────────────────────

export async function evaluateAlerts(args: {
  venue: Venue;
  symbol: CanonSymbol;
  timeframes: Timeframe[];
  settings: MacdSettings;
  thresholds: { great: number; rare: number };
  lookbackCross: number;
  limit: number;
}): Promise<{
  symbol: CanonSymbol;
  resolvedSymbol: string;
  usedQuote: string;
  fallbackUsed: boolean;
  alerts: Alert[];
  scores: { bullScore: number; bearScore: number };
  indicators?: {
    rsi?: number;
    mfi?: number;
    stochK?: number;
    stochD?: number;
    sma200?: number;
    close?: number;
  };
}> {
  const res = await computeCmUltMacdMtf({
    venue: args.venue,
    symbol: args.symbol,
    timeframes: args.timeframes,
    settings: args.settings,
    limit: args.limit,
  });

  const daily = res.perTimeframe['1D'];
  const weekly = res.perTimeframe['1W'];
  const bullScore = res.mtf.bullScore;
  const bearScore = res.mtf.bearScore;
  const d = res.daily; // DailyIndicators (RSI, MFI, StochRSI, SMA200)

  const alerts: Alert[] = [];
  const now = new Date().toISOString();

  // Indicator snapshot for response
  const indicatorSnapshot = d ? {
    rsi: isFinite(d.rsi) ? Number(d.rsi.toFixed(2)) : undefined,
    mfi: isFinite(d.mfi) ? Number(d.mfi.toFixed(2)) : undefined,
    stochK: isFinite(d.stochK) ? Number(d.stochK.toFixed(2)) : undefined,
    stochD: isFinite(d.stochD) ? Number(d.stochD.toFixed(2)) : undefined,
    sma200: isFinite(d.sma200) ? Number(d.sma200.toFixed(6)) : undefined,
    close: d.close,
  } : undefined;

  if (!d || !daily) {
    // No daily data — can't evaluate
    return {
      symbol: args.symbol,
      resolvedSymbol: res.resolvedSymbol,
      usedQuote: res.usedQuote,
      fallbackUsed: res.fallbackUsed,
      alerts,
      scores: { bullScore, bearScore },
      indicators: indicatorSnapshot,
    };
  }

  // Weekly MACD bullish = weekly histogram increasing or MACD above zero
  const weeklyMacdBullish = weekly
    ? (weekly.aboveZero || weekly.histIncreasing)
    : false;

  // ─── BUY ALERTS ────────────────────────────────────────────────

  // Check if daily MACD momentum is improving (required for any buy momentum alert)
  const dailyMomentumImproving = d.hist > d.histPrev;

  if (dailyMomentumImproving) {
    // Check Momentum Add Zone first (higher tier)
    const momentum = isMomentumBuyZone(d, weeklyMacdBullish);
    if (momentum.pass) {
      const buyScore = scoreBuy(d, weeklyMacdBullish);
      alerts.push({
        label: 'Momentum Buy',
        timeframe: 'MTF',
        at: now,
        confidence: Math.min(1, buyScore.score / 4),
        why: [
          'Momentum expansion confirmed (scale-in zone)',
          ...momentum.reasons,
          `Score: ${buyScore.score.toFixed(1)}/4.0`,
        ],
        indicators: indicatorSnapshot,
      });
    } else {
      // Check Early Buy Setup (lower tier)
      const buyScore = scoreBuy(d, weeklyMacdBullish);
      if (buyScore.score >= 2.0) {
        const why = [
          ...buyScore.reasons,
          `RSI: ${fmt(d.rsi)} | MFI: ${fmt(d.mfi)} | StochRSI K/D: ${fmt(d.stochK)}/${fmt(d.stochD)}`,
          `MACD hist: ${fmt(d.hist)} vs ${fmt(d.histPrev)}`,
          `Score: ${buyScore.score.toFixed(1)}/4.0`,
        ];
        if (buyScore.timingRisk) {
          why.push('⚠ Timing risk: StochRSI overheated/rolling over');
        }
        alerts.push({
          label: 'Early Buy Setup',
          timeframe: '1D',
          at: now,
          confidence: Math.min(1, buyScore.score / 4),
          why,
          indicators: indicatorSnapshot,
        });
      }
    }
  }

  // Rare Accumulation (cycle alert — independent of momentum)
  const accum = checkRareAccumulation(d);
  if (accum.pass) {
    alerts.push({
      label: 'Rare Accumulation',
      timeframe: '1D',
      at: now,
      confidence: 0.9,
      why: [
        ...accum.reasons,
        `StochRSI K/D: ${fmt(d.stochK)}/${fmt(d.stochD)}`,
      ],
      indicators: indicatorSnapshot,
    });
  }

  // ─── SELL ALERTS ───────────────────────────────────────────────

  const sellScore = scoreSell(d);
  if (sellScore.score >= 3.0) {
    alerts.push({
      label: 'Great Sell',
      timeframe: '1D',
      at: now,
      confidence: Math.min(1, sellScore.score / 3.5),
      why: [
        'High-probability profit-taking zone',
        ...sellScore.reasons,
        `RSI: ${fmt(d.rsi)} | MFI: ${fmt(d.mfi)} | StochRSI K/D: ${fmt(d.stochK)}/${fmt(d.stochD)}`,
        `Score: ${sellScore.score.toFixed(1)}/3.5`,
      ],
      indicators: indicatorSnapshot,
    });
  } else if (sellScore.score >= 2.0) {
    alerts.push({
      label: 'Good Sell',
      timeframe: '1D',
      at: now,
      confidence: Math.min(1, sellScore.score / 3.5),
      why: [
        'Consider trimming or tightening stops',
        ...sellScore.reasons,
        `RSI: ${fmt(d.rsi)} | MFI: ${fmt(d.mfi)} | StochRSI K/D: ${fmt(d.stochK)}/${fmt(d.stochD)}`,
        `Score: ${sellScore.score.toFixed(1)}/3.5`,
      ],
      indicators: indicatorSnapshot,
    });
  }

  return {
    symbol: args.symbol,
    resolvedSymbol: res.resolvedSymbol,
    usedQuote: res.usedQuote,
    fallbackUsed: res.fallbackUsed,
    alerts,
    scores: { bullScore, bearScore },
    indicators: indicatorSnapshot,
  };
}