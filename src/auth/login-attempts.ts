/**
 * Persistent login-attempt storage (Phase 2, §8).
 *
 * Every auth.login call (success and failure) writes one row here, which
 * serves two purposes:
 *
 *   1. Audit trail — operators can investigate suspicious activity
 *      ("who tried to log in as admin@x.com from this IP last week?").
 *   2. Cross-restart rate-limit state — the in-memory {@link loginRateLimiter}
 *      preloads from this table on boot so gateway restarts don't reset
 *      exponential backoff counters.
 *
 * Writes are fire-and-forget: DB errors are logged but never bubble up
 * to the login handler.  This keeps auth.login resilient to transient
 * DB failures — the worst case is losing audit rows, not blocking users.
 *
 * Cleanup: `cleanupOldLoginAttempts()` deletes rows older than the
 * configured retention window (default 90 days).
 */

import crypto from "node:crypto";
import { query, getDbType, DB_SQLITE, isDbInitialized } from "../db/index.js";

export interface LoginAttemptInsert {
  ip: string;
  email: string | null;
  success: boolean;
  userAgent?: string | null;
}

export interface LoginAttemptRow {
  id: string;
  ip: string;
  email: string | null;
  success: boolean;
  userAgent: string | null;
  createdAt: Date;
}

/**
 * Default retention window for login_attempts rows.  90 days is the
 * minimum for most compliance regimes; set `LOGIN_ATTEMPTS_RETAIN_DAYS`
 * to 180 for 等保 three-year retention variants.
 */
export const DEFAULT_RETENTION_DAYS = 90;

function getRetentionDays(): number {
  const raw = process.env.LOGIN_ATTEMPTS_RETAIN_DAYS;
  if (!raw) {
    return DEFAULT_RETENTION_DAYS;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return DEFAULT_RETENTION_DAYS;
  }
  return Math.floor(n);
}

/**
 * Insert one login attempt. Never throws — errors are logged and swallowed
 * so a DB outage can't block auth.login.
 */
export async function recordLoginAttempt(input: LoginAttemptInsert): Promise<void> {
  if (!isDbInitialized()) {
    return;
  }
  try {
    if (getDbType() === DB_SQLITE) {
      const id = crypto.randomUUID();
      await query(
        `INSERT INTO login_attempts (id, ip, email, success, user_agent)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, input.ip, input.email, input.success ? 1 : 0, input.userAgent ?? null],
      );
      return;
    }
    await query(
      `INSERT INTO login_attempts (ip, email, success, user_agent)
       VALUES ($1, $2, $3, $4)`,
      [input.ip, input.email, input.success ? 1 : 0, input.userAgent ?? null],
    );
  } catch (err) {
    console.error(
      `[login-attempts] write failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function rowToRecord(row: Record<string, unknown>): LoginAttemptRow {
  return {
    id: String(row.id),
    ip: String(row.ip),
    email: (row.email as string) ?? null,
    success: Number(row.success ?? 0) === 1,
    userAgent: (row.user_agent as string) ?? null,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at)),
  };
}

/**
 * Fetch all recent FAILURE attempts within the last `windowMs` ms.
 * Used on boot to warm up the in-memory rate limiter so that a gateway
 * restart doesn't reset exponential backoff counters.
 *
 * Returns at most 5000 rows to keep startup bounded.
 */
export async function loadRecentFailures(windowMs: number): Promise<LoginAttemptRow[]> {
  if (!isDbInitialized()) {
    return [];
  }
  try {
    if (getDbType() === DB_SQLITE) {
      // Use SQLite's native date arithmetic so we compare against the
      // stored 'YYYY-MM-DD HH:MM:SS' format rather than a JS ISO string.
      const windowSeconds = Math.ceil(windowMs / 1000);
      const result = await query<Record<string, unknown>>(
        `SELECT id, ip, email, success, user_agent, created_at
           FROM login_attempts
          WHERE success = 0 AND created_at >= datetime('now', $1)
          ORDER BY created_at ASC
          LIMIT 5000`,
        [`-${windowSeconds} seconds`],
      );
      return result.rows.map((r) => rowToRecord(r));
    }
    const cutoff = new Date(Date.now() - windowMs);
    const result = await query<Record<string, unknown>>(
      `SELECT id, ip, email, success, user_agent, created_at
         FROM login_attempts
        WHERE success = 0 AND created_at >= $1
        ORDER BY created_at ASC
        LIMIT 5000`,
      [cutoff],
    );
    return result.rows.map((r) => rowToRecord(r));
  } catch (err) {
    console.error(
      `[login-attempts] preload failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/**
 * Delete login_attempts rows older than the configured retention window.
 * Returns the number of rows deleted.  Safe to call on any cadence.
 */
export async function cleanupOldLoginAttempts(): Promise<number> {
  if (!isDbInitialized()) {
    return 0;
  }
  const days = getRetentionDays();
  try {
    if (getDbType() === DB_SQLITE) {
      const result = await query(
        `DELETE FROM login_attempts WHERE created_at < datetime('now', $1)`,
        [`-${days} days`],
      );
      return result.rowCount ?? 0;
    }
    const result = await query(
      `DELETE FROM login_attempts WHERE created_at < NOW() - ($1::int || ' days')::interval`,
      [days],
    );
    return result.rowCount ?? 0;
  } catch (err) {
    console.error(
      `[login-attempts] cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 0;
  }
}

/**
 * Count failed attempts within a window for a given (ip, email) tuple.
 * Useful for operators and diagnostic endpoints.
 */
export async function countRecentFailures(
  ip: string,
  email: string | null,
  windowMs: number,
): Promise<number> {
  if (!isDbInitialized()) {
    return 0;
  }
  try {
    if (getDbType() === DB_SQLITE) {
      const windowSeconds = Math.ceil(windowMs / 1000);
      const cutoffExpr = `datetime('now', $${email ? 3 : 2})`;
      const sql = email
        ? `SELECT COUNT(*) AS count FROM login_attempts
            WHERE success = 0 AND ip = $1 AND email = $2 AND created_at >= ${cutoffExpr}`
        : `SELECT COUNT(*) AS count FROM login_attempts
            WHERE success = 0 AND ip = $1 AND email IS NULL AND created_at >= ${cutoffExpr}`;
      const windowParam = `-${windowSeconds} seconds`;
      const params = email ? [ip, email, windowParam] : [ip, windowParam];
      const result = await query<{ count: string | number }>(sql, params);
      return Number(result.rows[0]?.count ?? 0);
    }
    const cutoff = new Date(Date.now() - windowMs);
    const sql = email
      ? `SELECT COUNT(*) AS count FROM login_attempts
          WHERE success = 0 AND ip = $1 AND email = $2 AND created_at >= $3`
      : `SELECT COUNT(*) AS count FROM login_attempts
          WHERE success = 0 AND ip = $1 AND email IS NULL AND created_at >= $2`;
    const params = email ? [ip, email, cutoff] : [ip, cutoff];
    const result = await query<{ count: string | number }>(sql, params);
    return Number(result.rows[0]?.count ?? 0);
  } catch {
    return 0;
  }
}
