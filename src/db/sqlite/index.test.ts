import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { closeSqliteDb, initSqliteDb } from "./index.ts";

function createLegacyDbWithoutTurnId(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE cs_messages (
      id             TEXT PRIMARY KEY,
      session_id     TEXT NOT NULL,
      tenant_id      TEXT NOT NULL,
      role           TEXT NOT NULL,
      content        TEXT NOT NULL,
      confidence     TEXT,
      feedback_type  TEXT,
      source_chunks  TEXT,
      source         TEXT NOT NULL DEFAULT 'agenora-ai',
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.close();
}

function columnNames(dbPath: string, table: string): string[] {
  const db = new DatabaseSync(dbPath);
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  db.close();
  return rows.map((row) => row.name);
}

describe("initSqliteDb migrations", () => {
  afterEach(() => {
    closeSqliteDb();
  });

  it("adds cs_messages.turn_id to existing SQLite databases", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enclaws-sqlite-migration-"));
    const dbPath = path.join(dir, "legacy.db");
    createLegacyDbWithoutTurnId(dbPath);

    initSqliteDb(`sqlite:///${dbPath}`);

    expect(columnNames(dbPath, "cs_messages")).toContain("turn_id");
  });
});
