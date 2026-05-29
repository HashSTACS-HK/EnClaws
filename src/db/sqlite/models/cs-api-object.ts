/**
 * CsApiObject CRUD — SQLite implementation.
 *
 * Mirrors src/db/models/cs-api-object.ts for the SQLite path.
 * Uses synchronous sqliteQuery (no async needed, kept async for interface parity).
 *
 * 与 PG model 接口对称，使用同步 SQLiteQuery，保持 async 签名供统一调用。
 */

import type { CreateCsApiObjectInput } from "../../models/cs-api-object.js";
import type { CsApiObject } from "../../types.js";
import { sqliteQuery } from "../index.js";

// ── Row mapper ────────────────────────────────────────────────────────────────

/**
 * Parse a SQLite datetime string as UTC.
 *
 * SQLite stores datetimes as "YYYY-MM-DD HH:MM:SS[.SSS]" without a timezone
 * suffix. We always store UTC values (via `datetime('now')` / `toISOString()`),
 * so we must re-attach the Z suffix before parsing — otherwise Node.js on
 * systems with a non-UTC local timezone will misinterpret the value.
 *
 * SQLite 存储的日期字符串格式为 "YYYY-MM-DD HH:MM:SS"，没有时区后缀。
 * 我们统一存储 UTC 时间，解析时需补回 Z 以保证正确性。
 */
function parseSqliteDate(val: unknown): Date {
  const s = val as string;
  // Already has timezone info (e.g. contains + or Z) — parse as-is
  if (s.includes("Z") || s.includes("+")) {
    return new Date(s);
  }
  // Convert "YYYY-MM-DD HH:MM:SS[.SSS]" → "YYYY-MM-DDTHH:MM:SS[.SSS]Z"
  return new Date(s.replace(" ", "T") + "Z");
}

function rowToCsApiObject(row: Record<string, unknown>): CsApiObject {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    name: row.name as string,
    description: (row.description as string | null) ?? undefined,
    agentId: row.agent_id as string,
    appId: row.app_id as string,
    appSecretHash: row.app_secret_hash as string,
    rotatingFromHash: (row.rotating_from_hash as string | null) ?? undefined,
    rotatingUntil: row.rotating_until ? parseSqliteDate(row.rotating_until) : undefined,
    endpointUrl: row.endpoint_url as string,
    isActive: Boolean(row.is_active),
    lastUsedAt: row.last_used_at ? parseSqliteDate(row.last_used_at) : undefined,
    createdAt: parseSqliteDate(row.created_at),
    updatedAt: parseSqliteDate(row.updated_at),
  };
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export async function createCsApiObject(
  input: CreateCsApiObjectInput,
  id: string,
  appId: string,
): Promise<CsApiObject> {
  sqliteQuery(
    `INSERT INTO cs_api_objects (id, tenant_id, name, description, agent_id, app_id, app_secret_hash, endpoint_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.tenantId,
      input.name,
      input.description ?? null,
      input.agentId,
      appId,
      input.appSecretHash,
      input.endpointUrl,
    ],
  );
  const r = sqliteQuery(`SELECT * FROM cs_api_objects WHERE id = ?`, [id]);
  return rowToCsApiObject(r.rows[0]);
}

export async function getCsApiObjectByAppId(appId: string): Promise<CsApiObject | null> {
  const r = sqliteQuery(`SELECT * FROM cs_api_objects WHERE app_id = ? LIMIT 1`, [appId]);
  return r.rows[0] ? rowToCsApiObject(r.rows[0]) : null;
}

export async function getCsApiObjectById(
  id: string,
  tenantId: string,
): Promise<CsApiObject | null> {
  const r = sqliteQuery(`SELECT * FROM cs_api_objects WHERE id = ? AND tenant_id = ?`, [
    id,
    tenantId,
  ]);
  return r.rows[0] ? rowToCsApiObject(r.rows[0]) : null;
}

export async function listCsApiObjects(tenantId: string): Promise<CsApiObject[]> {
  const r = sqliteQuery(
    `SELECT * FROM cs_api_objects WHERE tenant_id = ? ORDER BY created_at DESC`,
    [tenantId],
  );
  return r.rows.map(rowToCsApiObject);
}

export async function updateCsApiObject(
  id: string,
  tenantId: string,
  fields: Partial<Pick<CsApiObject, "name" | "description" | "agentId" | "isActive">>,
): Promise<CsApiObject | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (fields.name !== undefined) {
    sets.push("name = ?");
    vals.push(fields.name);
  }
  if (fields.description !== undefined) {
    sets.push("description = ?");
    vals.push(fields.description);
  }
  if (fields.agentId !== undefined) {
    sets.push("agent_id = ?");
    vals.push(fields.agentId);
  }
  if (fields.isActive !== undefined) {
    sets.push("is_active = ?");
    vals.push(fields.isActive ? 1 : 0);
  }
  if (sets.length === 0) {
    return getCsApiObjectById(id, tenantId);
  }
  sets.push("updated_at = datetime('now')");
  vals.push(id, tenantId);
  sqliteQuery(`UPDATE cs_api_objects SET ${sets.join(", ")} WHERE id = ? AND tenant_id = ?`, vals);
  return getCsApiObjectById(id, tenantId);
}

export async function rotateCsApiObjectSecret(
  id: string,
  tenantId: string,
  newHash: string,
  rotatingUntil: Date,
): Promise<CsApiObject> {
  // Single atomic UPDATE … RETURNING (SQLite ≥ 3.35 supports RETURNING with self-referential SET)
  const r = sqliteQuery(
    `UPDATE cs_api_objects
     SET rotating_from_hash = app_secret_hash,
         app_secret_hash    = ?,
         rotating_until     = ?,
         updated_at         = datetime('now')
     WHERE id = ? AND tenant_id = ?
     RETURNING *`,
    [newHash, rotatingUntil.toISOString().replace("T", " ").replace("Z", ""), id, tenantId],
  );
  if (!r.rows[0]) {
    throw new Error(`cs_api_object not found: ${id}`);
  }
  return rowToCsApiObject(r.rows[0]);
}

/** No tenantId scoping — caller guarantees id authority (looked up via getCsApiObjectByAppId which doesn't tenant-scope). */
export async function clearExpiredRotation(id: string): Promise<void> {
  sqliteQuery(
    `UPDATE cs_api_objects
     SET rotating_from_hash = NULL, rotating_until = NULL, updated_at = datetime('now')
     WHERE id = ? AND rotating_until < datetime('now')`,
    [id],
  );
}

export async function deleteCsApiObject(id: string, tenantId: string): Promise<boolean> {
  const r = sqliteQuery(`DELETE FROM cs_api_objects WHERE id = ? AND tenant_id = ?`, [
    id,
    tenantId,
  ]);
  return r.rowCount > 0;
}

/** No tenantId scoping — caller guarantees id authority (looked up via getCsApiObjectByAppId which doesn't tenant-scope). */
export async function touchLastUsed(id: string): Promise<void> {
  sqliteQuery(`UPDATE cs_api_objects SET last_used_at = datetime('now') WHERE id = ?`, [id]);
}
