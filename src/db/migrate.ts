import { Client } from 'pg';

const MIGRATIONS: Array<{ id: string; sql: string }> = [
  {
    id: '001_init',
    sql: `
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  apple_sub TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS watchlists (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  venue TEXT NOT NULL,
  symbols JSONB NOT NULL,
  timeframes JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  macd JSONB NOT NULL,
  thresholds JSONB NOT NULL,
  lookback_cross INT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`,
  },
  {
    id: '002_device_tokens_and_scan_cache',
    sql: `
CREATE TABLE IF NOT EXISTS device_tokens (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'ios',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, token)
);

CREATE TABLE IF NOT EXISTS last_scan_results (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  results JSONB NOT NULL,
  scanned_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`,
  },
];

export async function migrate(databaseUrl: string) {
  const sslNeeded =
    (process.env.NODE_ENV || '').toLowerCase() === 'production' ||
    /sslmode=/i.test(databaseUrl);

  const client = new Client({
    connectionString: databaseUrl,
    ...(sslNeeded ? { ssl: { rejectUnauthorized: false } } : {}),
  });
  await client.connect();

  try {
    for (const m of MIGRATIONS) {
      const already = await client.query('SELECT 1 FROM migrations WHERE id=$1', [m.id]).then(r => (r.rowCount ?? 0) > 0).catch(() => false);
      if (already) continue;
      await client.query('BEGIN');
      await client.query(m.sql);
      await client.query('INSERT INTO migrations(id) VALUES ($1)', [m.id]);
      await client.query('COMMIT');
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await client.end();
  }
}
