import { Pool } from 'pg';

export type Venue = 'coinbase' | 'binanceus';
export type Timeframe = '1D' | '1W' | '1M';

export type Watchlist = {
  userId: string;
  venue: Venue;
  symbols: string[];
  timeframes: Timeframe[];
};

export type Settings = {
  userId: string;
  macd: { fast: number; slow: number; signal: number };
  thresholds: { great: number; rare: number };
  lookbackCross: number;
};

export class Repo {
  private pool: Pool;

  constructor(databaseUrl: string) {
    // Render Postgres typically requires SSL. Internal URLs may still enforce it.
    // We enable SSL when running in production or when sslmode is present.
    const sslNeeded =
      (process.env.NODE_ENV || '').toLowerCase() === 'production' ||
      /sslmode=/i.test(databaseUrl);

    this.pool = new Pool({
      connectionString: databaseUrl,
      ...(sslNeeded ? { ssl: { rejectUnauthorized: false } } : {}),
    });
  }

  async ensureUser(id: string, appleSub?: string | null) {
    await this.pool.query(
      'INSERT INTO users(id, apple_sub) VALUES($1, $2) ON CONFLICT (id) DO UPDATE SET apple_sub=COALESCE(users.apple_sub, EXCLUDED.apple_sub)',
      [id, appleSub ?? null]
    );
  }

  async upsertWatchlist(w: Watchlist) {
    await this.pool.query(
      `INSERT INTO watchlists(user_id, venue, symbols, timeframes)
       VALUES($1,$2,$3,$4)
       ON CONFLICT (user_id) DO UPDATE SET venue=EXCLUDED.venue, symbols=EXCLUDED.symbols, timeframes=EXCLUDED.timeframes, updated_at=now()`,
      [w.userId, w.venue, JSON.stringify(w.symbols), JSON.stringify(w.timeframes)]
    );
  }

  async getWatchlist(userId: string): Promise<Watchlist | null> {
    const r = await this.pool.query('SELECT user_id, venue, symbols, timeframes FROM watchlists WHERE user_id=$1', [userId]);
    if (r.rowCount === 0) return null;
    const row = r.rows[0];

    const symbols = typeof row.symbols === 'string' ? JSON.parse(row.symbols) : row.symbols;
    const timeframes = typeof row.timeframes === 'string' ? JSON.parse(row.timeframes) : row.timeframes;

    return {
      userId: row.user_id,
      venue: row.venue,
      symbols: Array.isArray(symbols) ? symbols : [],
      timeframes: Array.isArray(timeframes) ? timeframes : ['1D', '1W', '1M'],
    };
  }

  async upsertSettings(s: Settings) {
    await this.pool.query(
      `INSERT INTO settings(user_id, macd, thresholds, lookback_cross)
       VALUES($1,$2,$3,$4)
       ON CONFLICT (user_id) DO UPDATE SET macd=EXCLUDED.macd, thresholds=EXCLUDED.thresholds, lookback_cross=EXCLUDED.lookback_cross, updated_at=now()`,
      [s.userId, JSON.stringify(s.macd), JSON.stringify(s.thresholds), s.lookbackCross]
    );
  }

  async getSettings(userId: string): Promise<Settings | null> {
    const r = await this.pool.query('SELECT user_id, macd, thresholds, lookback_cross FROM settings WHERE user_id=$1', [userId]);
    if (r.rowCount === 0) return null;
    const row = r.rows[0];

    const macd = typeof row.macd === 'string' ? JSON.parse(row.macd) : row.macd;
    const thresholds = typeof row.thresholds === 'string' ? JSON.parse(row.thresholds) : row.thresholds;

    return {
      userId: row.user_id,
      macd,
      thresholds,
      lookbackCross: row.lookback_cross,
    };
  }

  async deleteUser(userId: string) {
    await this.pool.query('DELETE FROM device_tokens WHERE user_id=$1', [userId]);
    await this.pool.query('DELETE FROM last_scan_results WHERE user_id=$1', [userId]);
    await this.pool.query('DELETE FROM settings WHERE user_id=$1', [userId]);
    await this.pool.query('DELETE FROM watchlists WHERE user_id=$1', [userId]);
    await this.pool.query('DELETE FROM users WHERE id=$1', [userId]);
  }

  // ── Device Tokens ──────────────────────────────────────────────────

  async upsertDeviceToken(userId: string, token: string, platform = 'ios') {
    await this.pool.query(
      `INSERT INTO device_tokens(user_id, token, platform)
       VALUES($1, $2, $3)
       ON CONFLICT (user_id, token) DO NOTHING`,
      [userId, token, platform]
    );
  }

  async removeDeviceToken(userId: string, token: string) {
    await this.pool.query('DELETE FROM device_tokens WHERE user_id=$1 AND token=$2', [userId, token]);
  }

  async getDeviceTokens(userId: string): Promise<string[]> {
    const r = await this.pool.query('SELECT token FROM device_tokens WHERE user_id=$1', [userId]);
    return r.rows.map((row: any) => row.token);
  }

  // ── Scan Cache ─────────────────────────────────────────────────────

  async upsertScanResults(userId: string, results: any) {
    await this.pool.query(
      `INSERT INTO last_scan_results(user_id, results, scanned_at)
       VALUES($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE SET results=EXCLUDED.results, scanned_at=now()`,
      [userId, JSON.stringify(results)]
    );
  }

  async getScanResults(userId: string): Promise<{ results: any; scannedAt: string } | null> {
    const r = await this.pool.query('SELECT results, scanned_at FROM last_scan_results WHERE user_id=$1', [userId]);
    if (r.rowCount === 0) return null;
    const row = r.rows[0];
    return { results: typeof row.results === 'string' ? JSON.parse(row.results) : row.results, scannedAt: row.scanned_at };
  }

  // ── All Users with Watchlists (for cron) ──────────────────────────

  async getAllUsersWithWatchlists(): Promise<Array<{ userId: string; venue: string; symbols: string[]; timeframes: string[] }>> {
    const r = await this.pool.query(`
      SELECT w.user_id, w.venue, w.symbols, w.timeframes
      FROM watchlists w
      JOIN users u ON u.id = w.user_id
      WHERE jsonb_array_length(w.symbols) > 0
    `);
    return r.rows.map((row: any) => ({
      userId: row.user_id,
      venue: row.venue,
      symbols: typeof row.symbols === 'string' ? JSON.parse(row.symbols) : row.symbols,
      timeframes: typeof row.timeframes === 'string' ? JSON.parse(row.timeframes) : row.timeframes,
    }));
  }
}
