/**
 * SQLite connection management and query adapter.
 *
 * Uses Node's built-in `node:sqlite` (DatabaseSync).
 * Provides a query interface compatible with pg's QueryResult shape.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { requireNodeSqlite } from "../../memory/sqlite.js";
import { SQLITE_SCHEMA_SQL } from "./schema-sql.js";

type DatabaseSync = InstanceType<ReturnType<typeof requireNodeSqlite>["DatabaseSync"]>;

let db: DatabaseSync | null = null;

export interface SqliteQueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

/**
 * Initialize SQLite database from a sqlite:// URL.
 * Automatically creates the database file and schema if they don't exist.
 */
export function initSqliteDb(url: string): void {
  if (db) return;

  // Parse sqlite:///path/to/data.db → /path/to/data.db
  let dbPath: string;
  if (url.startsWith("sqlite:///")) {
    dbPath = url.slice("sqlite://".length); // keeps leading /
  } else if (url.startsWith("sqlite://")) {
    dbPath = url.slice("sqlite://".length);
  } else {
    throw new Error(`[sqlite] Invalid SQLite URL: ${url}`);
  }

  // On Windows, handle paths like sqlite:///D:/path or sqlite:///D:\path
  // The path after sqlite:// may start with /D: which needs the leading slash stripped
  if (process.platform === "win32" && /^\/[A-Za-z]:/.test(dbPath)) {
    dbPath = dbPath.slice(1);
  }

  // Expand leading ~ to the user's home directory
  if (dbPath.startsWith("~/") || dbPath === "~") {
    dbPath = path.join(os.homedir(), dbPath.slice(1));
  }

  // Ensure parent directory exists
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });

  const { DatabaseSync } = requireNodeSqlite();
  db = new DatabaseSync(dbPath);

  // Enable WAL mode and foreign keys
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  // Initialize schema + seed data (inlined as TS constant to survive bundling)
  db.exec(SQLITE_SCHEMA_SQL);

  // Lightweight column migrations for existing databases where CREATE TABLE
  // IF NOT EXISTS is a no-op. Each ADD COLUMN is attempted once; a duplicate
  // column error is swallowed so the call is idempotent.
  const addColumnIfMissing = (table: string, column: string, ddl: string) => {
    try {
      db!.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
      console.log(`[sqlite] added column ${table}.${column}`);
    } catch (err) {
      const msg = String(err);
      if (!msg.includes("duplicate column") && !msg.includes("duplicate_column")) {
        throw err;
      }
    }
  };
  addColumnIfMissing("plans", "max_cron_jobs", "INTEGER NOT NULL DEFAULT 5");
  addColumnIfMissing("cs_messages", "source", "TEXT NOT NULL DEFAULT 'agenora-ai' CHECK (source IN ('agenora-ai','upper-app-relay'))");

  // Re-seed plan rows so freshly-added column picks up correct per-plan values.
  // Use INSERT OR REPLACE against the primary key.
  db.exec(`
    INSERT OR REPLACE INTO plans (id, name, max_users, max_agents, max_channels, max_tokens_per_month, max_cron_jobs) VALUES
      ('free',       '免费版', 10, 5,  5,  20000000, 5),
      ('pro',        '专业版', 20, 20, 20, 200000000, 20),
      ('enterprise', '企业版', -1, -1, -1, -1, 50);
  `);

  console.log(`[sqlite] Database initialized at ${dbPath}`);
}

/**
 * Get the active SQLite database. Throws if not initialized.
 */
export function getSqliteDb(): DatabaseSync {
  if (!db) {
    throw new Error("[sqlite] Database not initialized. Call initSqliteDb() first.");
  }
  return db;
}

/**
 * Close the SQLite database.
 */
export function closeSqliteDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Convert PostgreSQL-style parameterized query ($1, $2, ...) to SQLite (?, ?, ...).
 * Also handles NOW() → datetime('now') conversion.
 */
function adaptSql(text: string): string {
  // Replace $N placeholders with ?
  let adapted = text.replace(/\$\d+/g, "?");
  // Replace NOW() with datetime('now')
  adapted = adapted.replace(/\bNOW\(\)/gi, "datetime('now')");
  // Remove ::text and other PG type casts
  adapted = adapted.replace(/::\w+(\[\])?/g, "");
  // Replace RETURNING * — handled at call site
  return adapted;
}

/**
 * Execute a query against SQLite, returning pg-compatible result shape.
 *
 * Handles:
 * - $N → ? parameter conversion
 * - NOW() → datetime('now')
 * - RETURNING * → separate SELECT after mutation
 * - Boolean ↔ integer conversion
 */
export function sqliteQuery<T = Record<string, unknown>>(
  text: string,
  values?: unknown[],
): SqliteQueryResult<T> {
  const database = getSqliteDb();
  const trimmed = text.trim();
  const hasReturning = /\bRETURNING\b/i.test(trimmed);
  let sql = adaptSql(trimmed);
  const params = values ?? [];

  // Convert boolean values to integers for SQLite
  const adaptedParams = params.map((v) => {
    if (v === true) return 1;
    if (v === false) return 0;
    if (v instanceof Date) return v.toISOString().replace("T", " ").replace("Z", "");
    if (v === undefined) return null;
    return v;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any[];

  if (hasReturning) {
    // Remove RETURNING clause (RETURNING *, RETURNING col1, col2, etc.)
    sql = sql.replace(/\s+RETURNING\s+.+$/im, "");

    const upperSql = sql.trimStart().toUpperCase();

    if (upperSql.startsWith("INSERT")) {
      // Extract table name from INSERT INTO <table>
      const tableMatch = sql.match(/INSERT\s+INTO\s+(\w+)/i);
      const table = tableMatch?.[1];

      const stmt = database.prepare(sql);
      stmt.run(...adaptedParams);

      // Get the last inserted row
      if (table) {
        const selectStmt = database.prepare(
          `SELECT * FROM ${table} WHERE rowid = last_insert_rowid()`,
        );
        const rows = selectStmt.all() as T[];
        return { rows: rows.map((r) => adaptRow(r) as T), rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    }

    if (upperSql.startsWith("UPDATE")) {
      const whereMatch = sql.match(/\bWHERE\b.+$/is);
      const tableMatch = sql.match(/UPDATE\s+(\w+)/i);
      const table = tableMatch?.[1];

      if (table && whereMatch) {
        // Capture matching rowids BEFORE the UPDATE, because the UPDATE may
        // change columns referenced in the WHERE clause (e.g. SET revoked = true
        // with WHERE revoked = false). Re-selecting with the original WHERE
        // after the UPDATE would return zero rows in that scenario.
        const whereClause = whereMatch[0];
        const beforeWhere = sql.slice(0, sql.indexOf(whereClause));
        const paramsBefore = (beforeWhere.match(/\?/g) || []).length;
        const whereParams = adaptedParams.slice(paramsBefore);

        const rowidStmt = database.prepare(`SELECT rowid FROM ${table} ${whereClause}`);
        const matchingRowids = rowidStmt.all(...whereParams) as { rowid: number }[];

        // Perform the UPDATE
        const stmt = database.prepare(sql);
        stmt.run(...adaptedParams);

        // Re-select updated rows by rowid (post-update values, like PG RETURNING)
        if (matchingRowids.length > 0) {
          const placeholders = matchingRowids.map(() => "?").join(",");
          const selectStmt = database.prepare(
            `SELECT * FROM ${table} WHERE rowid IN (${placeholders})`,
          );
          const rows = selectStmt.all(
            ...matchingRowids.map((r) => r.rowid),
          ) as T[];
          return { rows: rows.map((r) => adaptRow(r) as T), rowCount: rows.length };
        }
        return { rows: [], rowCount: 0 };
      }

      const stmt = database.prepare(sql);
      const result = stmt.run(...adaptedParams);
      return { rows: [], rowCount: result.changes as number };
    }
  }

  const upperSql = sql.trimStart().toUpperCase();

  if (
    upperSql.startsWith("SELECT") ||
    upperSql.startsWith("WITH")
  ) {
    const stmt = database.prepare(sql);
    const rows = stmt.all(...adaptedParams) as T[];
    return { rows: rows.map((r) => adaptRow(r) as T), rowCount: rows.length };
  }

  // INSERT, UPDATE, DELETE without RETURNING
  const stmt = database.prepare(sql);
  const result = stmt.run(...adaptedParams);
  return { rows: [] as T[], rowCount: result.changes as number };
}

/**
 * Adapt a SQLite row to match PG expectations:
 * - INTEGER boolean fields → real booleans
 * - JSON TEXT fields → parsed objects
 * - Timestamp fields: append 'Z' if missing, so JS Date parses as UTC not local time.
 *   SQLite datetime('now') returns "YYYY-MM-DD HH:MM:SS" without timezone marker.
 *   Without 'Z', new Date() treats it as local time → 8-hour offset in UTC+8.
 *
 * SQLite 时间字段修正：datetime('now') 存储无时区标记的字符串，JS 会误认为本地时间。
 * 统一在此补 Z，使 new Date() 正确解析为 UTC，前端再按用户时区格式化。
 * 一处修改，全局所有表（含 CS 模块）自动继承。
 */
function adaptRow(row: unknown): unknown {
  if (!row || typeof row !== "object") return row;
  const r = row as Record<string, unknown>;
  const adapted: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(r)) {
    // Convert known boolean columns from integer to boolean
    if (isBooleanColumn(key) && typeof value === "number") {
      adapted[key] = value !== 0;
    }
    // Parse known JSON columns
    else if (isJsonColumn(key) && typeof value === "string") {
      try {
        adapted[key] = JSON.parse(value);
      } catch {
        adapted[key] = value;
      }
    }
    // Normalize timestamp strings: "YYYY-MM-DD HH:MM:SS" → "YYYY-MM-DDTHH:MM:SSZ"
    // Matches columns ending in _at, _date, recorded_at, applied_at, etc.
    // 补全时区标记：将 SQLite 无时区时间串转为标准 UTC ISO 格式。
    else if (isTimestampColumn(key) && typeof value === "string" && value.length >= 19 && !value.endsWith("Z") && !value.includes("+")) {
      adapted[key] = value.slice(0, 19).replace(" ", "T") + "Z";
    }
    else {
      adapted[key] = value;
    }
  }

  return adapted;
}

/** Timestamp column name patterns: *_at, *_date, applied_at, recorded_at, etc. */
function isTimestampColumn(name: string): boolean {
  return name.endsWith("_at") || name.endsWith("_date") || name === "timestamp";
}

const BOOLEAN_COLUMNS = new Set([
  "is_active",
  "revoked",
  "trace_enabled",
  "allow_real_ip_fallback",
  "enabled",
]);

const JSON_COLUMNS = new Set([
  "settings",
  "quotas",
  "config",
  "metadata",
  "detail",
  "messages",
  "tools",
  "request_params",
  "response",
  "open_ids",
  "extra_headers",
  "extra_config",
  "models",
  "tailscale",
  "remote",
  "reload",
  "tls",
  "http",
  "nodes",
  "trusted_proxies",
  "auth",
  "multi_tenant",
  "redact_patterns",
  "allow",
  "deny",
  "load",
  "slots",
  "entries",
  "installs",
]);

function isBooleanColumn(name: string): boolean {
  return BOOLEAN_COLUMNS.has(name);
}

function isJsonColumn(name: string): boolean {
  return JSON_COLUMNS.has(name);
}

/**
 * Run a callback within a SQLite transaction (synchronous, since DatabaseSync is sync).
 * The callback receives a thin client-like object with a query method.
 */
export function withSqliteTransaction<T>(
  fn: (client: { query: typeof sqliteQuery }) => T,
): T {
  const database = getSqliteDb();
  database.exec("BEGIN");
  try {
    const result = fn({ query: sqliteQuery });
    database.exec("COMMIT");
    return result;
  } catch (err) {
    database.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Generate a UUID v4 for use as primary key.
 */
export function generateUUID(): string {
  return crypto.randomUUID();
}

