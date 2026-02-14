// Core technical indicator functions
// RSI, MFI, StochRSI, SMA — ported from the original rarcrypto Cloudflare Worker

export function sma(arr: number[], len: number): number[] {
  const out: number[] = new Array(arr.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= len) sum -= arr[i - len];
    if (i >= len - 1) out[i] = sum / len;
  }
  return out;
}

export function rsi(close: number[], len = 14): number[] {
  const out: number[] = new Array(close.length).fill(NaN);
  let avgG = 0, avgL = 0;
  let gain = 0, loss = 0;
  for (let i = 1; i < close.length; i++) {
    const ch = close[i] - close[i - 1];
    const g = Math.max(0, ch);
    const l = Math.max(0, -ch);
    if (i <= len) {
      gain += g;
      loss += l;
      if (i === len) {
        avgG = gain / len;
        avgL = loss / len;
        out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
      }
    } else {
      avgG = (avgG * (len - 1) + g) / len;
      avgL = (avgL * (len - 1) + l) / len;
      out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
    }
  }
  return out;
}

export function stochRsi(close: number[], rsiLen = 14, kLen = 3, dLen = 3): { k: number[]; d: number[] } {
  const r = rsi(close, rsiLen);
  const rawK: number[] = new Array(r.length).fill(NaN);

  for (let i = rsiLen; i < r.length; i++) {
    let min = Infinity, max = -Infinity;
    for (let j = i - rsiLen + 1; j <= i; j++) {
      const v = r[j];
      if (!isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const denom = max - min;
    rawK[i] = denom === 0 ? 50 : ((r[i] - min) / denom) * 100;
  }

  const k = smaSeries(rawK, kLen);
  const d = smaSeries(k, dLen);
  return { k, d };
}

export function mfi(high: number[], low: number[], close: number[], vol: number[], len = 14): number[] {
  const tp = close.map((_, i) => (high[i] + low[i] + close[i]) / 3);
  const pmf: number[] = new Array(tp.length).fill(0);
  const nmf: number[] = new Array(tp.length).fill(0);

  for (let i = 1; i < tp.length; i++) {
    const mf = tp[i] * vol[i];
    if (tp[i] > tp[i - 1]) pmf[i] = mf;
    else if (tp[i] < tp[i - 1]) nmf[i] = mf;
  }

  const out: number[] = new Array(tp.length).fill(NaN);
  for (let i = len; i < tp.length; i++) {
    let pos = 0, neg = 0;
    for (let j = i - len + 1; j <= i; j++) {
      pos += pmf[j];
      neg += nmf[j];
    }
    if (neg === 0) out[i] = 100;
    else {
      const mr = pos / neg;
      out[i] = 100 - 100 / (1 + mr);
    }
  }
  return out;
}

function smaSeries(arr: number[], len: number): number[] {
  const out: number[] = new Array(arr.length).fill(NaN);
  let sum = 0;
  const q: number[] = [];
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    q.push(isFinite(v) ? v : NaN);
    sum += isFinite(v) ? v : 0;
    if (q.length > len) {
      const r = q.shift()!;
      if (isFinite(r)) sum -= r;
    }
    if (q.length === len && q.every(x => isFinite(x))) out[i] = sum / len;
  }
  return out;
}

/** All daily indicator values needed for alert evaluation */
export type DailyIndicators = {
  rsi: number;
  mfi: number;
  stochK: number;
  stochD: number;
  stochKPrev: number;
  stochDPrev: number;
  sma200: number;
  close: number;
  // MACD (passed through from existing system)
  macd: number;
  signal: number;
  hist: number;
  histPrev: number;
  macdLine: number;
  signalLine: number;
};
