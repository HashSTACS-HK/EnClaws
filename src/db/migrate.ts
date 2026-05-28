/**
 * Database migration runner.
 *
 * Usage:
 *   node --import tsx src/db/migrate.ts          # run pending migrations
 *   node --import tsx src/db/migrate.ts --status  # show migration status
 *
 * Supports both PostgreSQL and SQLite based on ENCLAWS_DB_URL.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotEnv } from "../infra/dotenv.js";
import { initDb, closeDb, withTransaction, query, getDbType, DB_SQLITE } from "./index.js";
import { getSqliteDb, sqliteQuery } from "./sqlite/index.js";

// Load .env so that ENCLAWS_DB_URL is available when running standalone
// (e.g. `pnpm db:migrate`).  The gateway gets this via run-main.ts, but
// migrate.ts is its own entry point.
loadDotEnv({ quiet: true });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "migrations");

interface MigrationRecord {
  name: string;
  applied_at: Date;
}

async function ensureMigrationsTable(): Promise<void> {
  if (getDbType() === DB_SQLITE) {
    // But ensure it exists in case of fresh db without schema init
    sqliteQuery(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    return;
  }
  await query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id         SERIAL PRIMARY KEY,
      name       VARCHAR(255) NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);
}

async function getAppliedMigrations(): Promise<Set<string>> {
  const result = await query<MigrationRecord>("SELECT name FROM _migrations ORDER BY id");
  return new Set(result.rows.map((r) => r.name));
}

function getPendingMigrations(applied: Set<string>): string[] {
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .toSorted();
  return files.filter((f) => !applied.has(f));
}

async function runMigrations(): Promise<void> {
  initDb();

  // ================================================================
  // Migration strategy (fresh-install only):
  //
  //   • PG     — runs 001_init.sql (consolidated full schema)
  //   • SQLite — uses schema-sql.ts at initDb() time, no migrations
  //
  // Incremental upgrades for existing deployments are not supported
  // here yet — the project currently wipes the dev DB on each restart.
  // Re-introduce inline ALTER blocks / legacy migration markers when
  // production deployments need rolling schema upgrades.
  // ================================================================

  await ensureMigrationsTable();
  const applied = await getAppliedMigrations();
  const pending = getPendingMigrations(applied);

  if (getDbType() === DB_SQLITE) {
    // SQLite already has its full schema from schema-sql.ts. Mark any
    // .sql files as applied without executing them — they are PG-only.
    for (const file of pending) {
      sqliteQuery("INSERT OR IGNORE INTO _migrations (name) VALUES (?)", [file]);
    }
    console.log("[migrate] SQLite uses schema-sql.ts; no .sql migrations executed.");
    await closeDb();
    return;
  }

  if (pending.length === 0) {
    console.log("[migrate] All migrations already applied.");
    await closeDb();
    return;
  }

  console.log(`[migrate] ${pending.length} pending migration(s):`);
  for (const file of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
    console.log(`[migrate]   applying ${file}...`);
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query("INSERT INTO _migrations (name) VALUES ($1)", [file]);
    });
    console.log(`[migrate]   ✓ ${file}`);
  }

  console.log("[migrate] Done.");
  await closeDb();
}

async function showStatus(): Promise<void> {
  initDb();
  await ensureMigrationsTable();

  const applied = await getAppliedMigrations();
  const pending = getPendingMigrations(applied);

  console.log(`[migrate] Applied: ${applied.size}, Pending: ${pending.length}`);
  if (applied.size > 0) {
    console.log("[migrate] Applied migrations:");
    for (const name of applied) {
      console.log(`  ✓ ${name}`);
    }
  }
  if (pending.length > 0) {
    console.log("[migrate] Pending migrations:");
    for (const name of pending) {
      console.log(`  ○ ${name}`);
    }
  }

  await closeDb();
}

// CLI entry
const args = process.argv.slice(2);
if (args.includes("--status")) {
  showStatus().catch((err) => {
    console.error("[migrate] Error:", err);
    process.exit(1);
  });
} else {
  runMigrations().catch((err) => {
    console.error("[migrate] Error:", err);
    process.exit(1);
  });
}
