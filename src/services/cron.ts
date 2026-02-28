import { Repo } from '../db/repo.js';
import { evaluateAlerts } from './alerts.js';
import { sendPushToMultiple, type PushPayload } from './push.js';

const SCAN_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

export function startCronScanner(repo: Repo) {
  console.log(`[cron] Starting auto-scanner (every ${SCAN_INTERVAL_MS / 1000 / 60 / 60}h)`);

  // Run first scan 30s after startup to let the server warm up
  setTimeout(() => runScanAll(repo), 30_000);

  // Then every 4 hours
  setInterval(() => runScanAll(repo), SCAN_INTERVAL_MS);
}

async function runScanAll(repo: Repo) {
  console.log('[cron] Starting full scan for all users...');
  const startTime = Date.now();

  try {
    const users = await repo.getAllUsersWithWatchlists();
    console.log(`[cron] Found ${users.length} users with watchlists`);

    let totalAlerts = 0;
    let usersNotified = 0;

    for (const user of users) {
      try {
        await scanUser(repo, user);
        totalAlerts++;
      } catch (e) {
        console.error(`[cron] Error scanning user ${user.userId}:`, e);
      }

      // Small delay between users to avoid rate limits
      await sleep(500);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[cron] Scan complete in ${elapsed}s — ${users.length} users processed`);
  } catch (e) {
    console.error('[cron] Scan failed:', e);
  }
}

async function scanUser(
  repo: Repo,
  user: { userId: string; venue: string; symbols: string[]; timeframes: string[] }
) {
  const settings = await repo.getSettings(user.userId);
  const macd = settings?.macd ?? { fast: 12, slow: 26, signal: 9 };
  const thresholds = settings?.thresholds ?? { great: 3, rare: 6 };
  const lookbackCross = settings?.lookbackCross ?? 3;

  // Get previous scan results for comparison
  const prevScan = await repo.getScanResults(user.userId);
  const prevAlertKeys = new Set<string>();
  if (prevScan?.results) {
    for (const r of prevScan.results) {
      for (const a of (r.alerts ?? [])) {
        prevAlertKeys.add(`${r.symbol}:${a.label}`);
      }
    }
  }

  // Run the scan
  const results: any[] = [];
  for (const symbol of user.symbols) {
    try {
      const out = await evaluateAlerts({
        venue: user.venue as any,
        symbol: symbol as any,
        timeframes: user.timeframes as any,
        settings: macd,
        thresholds,
        lookbackCross,
        limit: 500,
      });
      results.push({
        symbol,
        alerts: out.alerts,
        scores: out.scores,
        resolvedSymbol: out.resolvedSymbol,
        usedQuote: out.usedQuote,
        fallbackUsed: out.fallbackUsed,
      });
    } catch (e) {
      console.error(`[cron] Error evaluating ${symbol} for ${user.userId}:`, e);
      results.push({ symbol, alerts: [], scores: { bullScore: 0, bearScore: 0 } });
    }
  }

  // Cache results
  await repo.upsertScanResults(user.userId, results);

  // Find NEW alerts (not in previous scan)
  const newAlerts: Array<{ symbol: string; label: string }> = [];
  for (const r of results) {
    for (const a of (r.alerts ?? [])) {
      const key = `${r.symbol}:${a.label}`;
      if (!prevAlertKeys.has(key)) {
        newAlerts.push({ symbol: r.symbol, label: a.label });
      }
    }
  }

  // Send push notification if there are new alerts
  if (newAlerts.length > 0) {
    const deviceTokens = await repo.getDeviceTokens(user.userId);
    if (deviceTokens.length > 0) {
      const payload = buildPushPayload(newAlerts);
      const failedTokens = await sendPushToMultiple(deviceTokens, payload);

      // Remove invalid tokens
      for (const badToken of failedTokens) {
        await repo.removeDeviceToken(user.userId, badToken);
      }

      if (deviceTokens.length - failedTokens.length > 0) {
        console.log(`[cron] Notified ${user.userId}: ${newAlerts.length} new alerts`);
      }
    }
  }
}

function buildPushPayload(alerts: Array<{ symbol: string; label: string }>): PushPayload {
  if (alerts.length === 1) {
    const a = alerts[0];
    const emoji = a.label.includes('Rare') ? '💎' : a.label.includes('Great') ? '🔥' : '📊';
    return {
      title: `${emoji} ${a.label}`,
      body: `${a.symbol.replace('-USD', '')} just triggered a ${a.label} signal`,
      badge: 1,
      data: { type: 'alert', symbol: a.symbol },
    };
  }

  // Multiple alerts
  const rareCount = alerts.filter(a => a.label.includes('Rare')).length;
  const symbols = [...new Set(alerts.map(a => a.symbol.replace('-USD', '')))];
  const symbolList = symbols.slice(0, 3).join(', ') + (symbols.length > 3 ? ` +${symbols.length - 3}` : '');

  return {
    title: `📊 ${alerts.length} New Signals`,
    body: `${symbolList} — ${rareCount > 0 ? `including ${rareCount} Rare signal${rareCount > 1 ? 's' : ''}` : 'check your alerts'}`,
    badge: alerts.length,
    data: { type: 'alerts', count: alerts.length },
  };
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
