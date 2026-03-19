/**
 * SQLite Cache — Graceful Degradation
 *
 * Local cache for MCP server. On every successful Supabase query,
 * results are cached. If Supabase is unreachable, serve from cache.
 *
 * Cache TTL: 24h for markets, 1h for probabilities/odds.
 * Max size: 50MB (configurable).
 * Location: ~/.telekash/cache.db
 *
 * "Graceful degradation is trust." — Magician's Playbook #7
 */

import Database from "better-sqlite3";
import { join } from "path";
import { mkdirSync, existsSync } from "fs";
import { homedir } from "os";

const CACHE_DIR = join(homedir(), ".telekash");
const CACHE_DB = join(CACHE_DIR, "cache.db");
const MAX_SIZE_MB = 50;

// TTL in seconds
const TTL = {
  markets: 24 * 60 * 60, // 24 hours
  market_detail: 24 * 60 * 60, // 24 hours
  probabilities: 60 * 60, // 1 hour
  trending: 30 * 60, // 30 minutes
  stats: 60 * 60, // 1 hour
  default: 4 * 60 * 60, // 4 hours
};

export interface CacheEntry<T = unknown> {
  data: T;
  cached_at: string;
  age_seconds: number;
  freshness: "fresh" | "stale" | "cached";
}

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;

  // Ensure directory exists
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }

  db = new Database(CACHE_DB);

  // WAL mode for better concurrent read performance
  db.pragma("journal_mode = WAL");

  // Create table
  db.exec(`
    CREATE TABLE IF NOT EXISTS cache (
      key TEXT PRIMARY KEY,
      category TEXT NOT NULL DEFAULT 'default',
      data TEXT NOT NULL,
      cached_at INTEGER NOT NULL,
      ttl_seconds INTEGER NOT NULL
    )
  `);

  // Create index for expiry cleanup
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cache_expiry
    ON cache(cached_at, ttl_seconds)
  `);

  return db;
}

/**
 * Store a value in the cache
 */
export function cacheSet(
  key: string,
  data: unknown,
  category: keyof typeof TTL = "default",
): void {
  try {
    const database = getDb();
    const ttl = TTL[category] || TTL.default;
    const now = Math.floor(Date.now() / 1000);
    const json = JSON.stringify(data);

    database
      .prepare(
        `INSERT OR REPLACE INTO cache (key, category, data, cached_at, ttl_seconds)
       VALUES (?, ?, ?, ?, ?)`,
      )
      .run(key, category, json, now, ttl);
  } catch (err) {
    // Cache failures are non-fatal
    console.error("[Cache] Set error:", err);
  }
}

/**
 * Get a value from the cache
 * Returns null if not found or expired (unless allowStale is true)
 */
export function cacheGet<T = unknown>(
  key: string,
  allowStale = false,
): CacheEntry<T> | null {
  try {
    const database = getDb();
    const now = Math.floor(Date.now() / 1000);

    const row = database
      .prepare(`SELECT data, cached_at, ttl_seconds FROM cache WHERE key = ?`)
      .get(key) as
      | { data: string; cached_at: number; ttl_seconds: number }
      | undefined;

    if (!row) return null;

    const ageSeconds = now - row.cached_at;
    const isExpired = ageSeconds > row.ttl_seconds;

    if (isExpired && !allowStale) return null;

    const data = JSON.parse(row.data) as T;

    return {
      data,
      cached_at: new Date(row.cached_at * 1000).toISOString(),
      age_seconds: ageSeconds,
      freshness: isExpired
        ? "stale"
        : ageSeconds < row.ttl_seconds / 2
          ? "fresh"
          : "cached",
    };
  } catch (err) {
    console.error("[Cache] Get error:", err);
    return null;
  }
}

/**
 * Clear expired entries
 */
export function cachePrune(): number {
  try {
    const database = getDb();
    const now = Math.floor(Date.now() / 1000);

    const result = database
      .prepare(`DELETE FROM cache WHERE (cached_at + ttl_seconds) < ?`)
      .run(now);

    return result.changes;
  } catch (err) {
    console.error("[Cache] Prune error:", err);
    return 0;
  }
}

/**
 * Get cache stats
 */
export function cacheStats(): {
  entries: number;
  size_kb: number;
  oldest_seconds: number;
  categories: Record<string, number>;
} {
  try {
    const database = getDb();
    const now = Math.floor(Date.now() / 1000);

    const countRow = database
      .prepare(`SELECT COUNT(*) as cnt FROM cache`)
      .get() as { cnt: number };

    const sizeRow = database
      .prepare(`SELECT SUM(LENGTH(data)) as total_bytes FROM cache`)
      .get() as { total_bytes: number | null };

    const oldestRow = database
      .prepare(`SELECT MIN(cached_at) as oldest FROM cache`)
      .get() as { oldest: number | null };

    const catRows = database
      .prepare(`SELECT category, COUNT(*) as cnt FROM cache GROUP BY category`)
      .all() as Array<{ category: string; cnt: number }>;

    const categories: Record<string, number> = {};
    for (const row of catRows) {
      categories[row.category] = row.cnt;
    }

    return {
      entries: countRow.cnt,
      size_kb: Math.round((sizeRow.total_bytes || 0) / 1024),
      oldest_seconds: oldestRow.oldest ? now - oldestRow.oldest : 0,
      categories,
    };
  } catch (err) {
    console.error("[Cache] Stats error:", err);
    return { entries: 0, size_kb: 0, oldest_seconds: 0, categories: {} };
  }
}

/**
 * Enforce max cache size — delete oldest entries if over limit
 */
export function cacheEnforceSize(): void {
  try {
    const stats = cacheStats();
    const maxKb = MAX_SIZE_MB * 1024;

    if (stats.size_kb > maxKb) {
      const database = getDb();
      // Delete oldest 20% of entries
      const deleteCount = Math.ceil(stats.entries * 0.2);
      database
        .prepare(
          `DELETE FROM cache WHERE key IN (
           SELECT key FROM cache ORDER BY cached_at ASC LIMIT ?
         )`,
        )
        .run(deleteCount);
      console.log(
        `[Cache] Pruned ${deleteCount} entries (size exceeded ${MAX_SIZE_MB}MB)`,
      );
    }
  } catch (err) {
    console.error("[Cache] Size enforcement error:", err);
  }
}

/**
 * Close the database connection
 */
export function cacheClose(): void {
  if (db) {
    db.close();
    db = null;
  }
}
