export type MacdSettings = { fast: number; slow: number; signal: number };

export function ema(values: number[], period: number): number[] {
  if (period <= 1) return [...values];
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values[0] ?? 0;
  out.push(prev);
  for (let i = 1; i < values.length; i++) {
    const v = values[i];
    prev = v * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

export function computeMacd(close: number[], s: MacdSettings): { macd: number[]; signal: number[]; hist: number[] } {
  const fast = ema(close, s.fast);
  const slow = ema(close, s.slow);
  const macd = close.map((_, i) => (fast[i] ?? 0) - (slow[i] ?? 0));
  const signal = ema(macd, s.signal);
  const hist = macd.map((m, i) => m - (signal[i] ?? 0));
  return { macd, signal, hist };
}

export function crossesUp(prevMacd: number, prevSignal: number, macd: number, signal: number): boolean {
  return prevMacd <= prevSignal && macd > signal;
}

export function crossesDown(prevMacd: number, prevSignal: number, macd: number, signal: number): boolean {
  return prevMacd >= prevSignal && macd < signal;
}
