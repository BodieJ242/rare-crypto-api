// Simple bridge that calls rare-crypto-mcp logic in-process by importing its services.
// This avoids stdio process management inside the API.

import type { Venue } from '../db/repo.js';

// Import directly from the MCP package workspace (sibling directory).
// NOTE: This is a monorepo-style relative import; in production we may publish a shared package.
// TypeScript doesn't know types for this path, so we use dynamic imports.
const loadAlerts = async () => {
  // TS can't resolve types for this file-path import; runtime is fine.
  // @ts-ignore
  return await import('../../../rare-crypto-mcp/dist/services/alerts.js');
};

const loadIndicator = async () => {
  // @ts-ignore
  return await import('../../../rare-crypto-mcp/dist/services/indicator.js');
};

export async function alertsEvaluate(params: {
  venue: Venue;
  symbol: string;
  timeframes: Array<'1D'|'1W'|'1M'>;
  settings: { fast: number; slow: number; signal: number };
  thresholds: { great: number; rare: number };
  lookbackCross: number;
  limit?: number;
}) {
  const { evaluateAlerts } = await loadAlerts() as any;
  return await evaluateAlerts({
    venue: params.venue as any,
    symbol: params.symbol as any,
    timeframes: params.timeframes as any,
    settings: params.settings as any,
    thresholds: params.thresholds,
    lookbackCross: params.lookbackCross,
    limit: params.limit ?? 500,
  });
}

export async function indicatorCompute(params: {
  venue: Venue;
  symbol: string;
  timeframes: Array<'1D'|'1W'|'1M'>;
  settings: { fast: number; slow: number; signal: number };
  limit?: number;
}) {
  const { computeCmUltMacdMtf } = await loadIndicator() as any;
  return await computeCmUltMacdMtf({
    venue: params.venue as any,
    symbol: params.symbol as any,
    timeframes: params.timeframes as any,
    settings: params.settings as any,
    limit: params.limit ?? 500,
  });
}
