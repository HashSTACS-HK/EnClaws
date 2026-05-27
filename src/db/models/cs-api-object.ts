/**
 * CsApiObject CRUD — dual PostgreSQL / SQLite support.
 *
 * Stores upper-app API credentials for Agenora S2 jiumi integration.
 * Each object belongs to exactly one tenant; all list/get/update/delete
 * operations enforce tenant_id scoping.
 *
 * 存储上层应用 API 凭证，支持 PG 和 SQLite 双后端。
 * 所有操作均强制 tenant_id 作用域隔离。
 */

import { randomBytes } from "node:crypto";
import { query, getDbType, DB_SQLITE } from "../index.js";
import * as sqliteModel from "../sqlite/models/cs-api-object.js";
import type { CsApiObject } from "../types.js";

// ── Row mapper ────────────────────────────────────────────────────────────────

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
    rotatingUntil: row.rotating_until ? (row.rotating_until as Date) : undefined,
    endpointUrl: row.endpoint_url as string,
    isActive: Boolean(row.is_active),
    lastUsedAt: row.last_used_at ? (row.last_used_at as Date) : undefined,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

// ── ID generation ─────────────────────────────────────────────────────────────

function generateId(): string {
  return randomBytes(12).toString("hex");
}

function generateAppId(): string {
  return `agnr_${randomBytes(12).toString("hex")}`;
}

// ── Input types ───────────────────────────────────────────────────────────────

export interface CreateCsApiObjectInput {
  tenantId: string;
  name: string;
  description?: string;
  agentId: string;
  appSecretHash: string;
  endpointUrl: string;
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export async function createCsApiObject(input: CreateCsApiObjectInput): Promise<CsApiObject> {
  const id = generateId();
  const appId = generateAppId();
  if (getDbType() === DB_SQLITE) {
    return sqliteModel.createCsApiObject(input, id, appId);
  }
  const r = await query(
    `INSERT INTO cs_api_objects (id, tenant_id, name, description, agent_id, app_id, app_secret_hash, endpoint_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [id, input.tenantId, input.name, input.description ?? null, input.agentId, appId, input.appSecretHash, input.endpointUrl],
  );
  return rowToCsApiObject(r.rows[0]);
}

export async function getCsApiObjectByAppId(appId: string): Promise<CsApiObject | null> {
  if (getDbType() === DB_SQLITE) {
    return sqliteModel.getCsApiObjectByAppId(appId);
  }
  const r = await query(`SELECT * FROM cs_api_objects WHERE app_id = $1 LIMIT 1`, [appId]);
  return r.rows[0] ? rowToCsApiObject(r.rows[0]) : null;
}

export async function getCsApiObjectById(id: string, tenantId: string): Promise<CsApiObject | null> {
  if (getDbType() === DB_SQLITE) {
    return sqliteModel.getCsApiObjectById(id, tenantId);
  }
  const r = await query(
    `SELECT * FROM cs_api_objects WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId],
  );
  return r.rows[0] ? rowToCsApiObject(r.rows[0]) : null;
}

export async function listCsApiObjects(tenantId: string): Promise<CsApiObject[]> {
  if (getDbType() === DB_SQLITE) {
    return sqliteModel.listCsApiObjects(tenantId);
  }
  const r = await query(
    `SELECT * FROM cs_api_objects WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId],
  );
  return r.rows.map(rowToCsApiObject);
}

export async function updateCsApiObject(
  id: string,
  tenantId: string,
  fields: Partial<Pick<CsApiObject, "name" | "description" | "agentId" | "isActive">>,
): Promise<CsApiObject | null> {
  if (getDbType() === DB_SQLITE) {
    return sqliteModel.updateCsApiObject(id, tenantId, fields);
  }
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (fields.name !== undefined) {
    sets.push(`name = $${i++}`);
    vals.push(fields.name);
  }
  if (fields.description !== undefined) {
    sets.push(`description = $${i++}`);
    vals.push(fields.description);
  }
  if (fields.agentId !== undefined) {
    sets.push(`agent_id = $${i++}`);
    vals.push(fields.agentId);
  }
  if (fields.isActive !== undefined) {
    sets.push(`is_active = $${i++}`);
    vals.push(fields.isActive);
  }
  if (sets.length === 0) {
    return getCsApiObjectById(id, tenantId);
  }
  sets.push(`updated_at = NOW()`);
  vals.push(id, tenantId);
  const r = await query(
    `UPDATE cs_api_objects SET ${sets.join(", ")} WHERE id = $${i++} AND tenant_id = $${i} RETURNING *`,
    vals,
  );
  return r.rows[0] ? rowToCsApiObject(r.rows[0]) : null;
}

export async function rotateCsApiObjectSecret(
  id: string,
  tenantId: string,
  newHash: string,
  rotatingUntil: Date,
): Promise<CsApiObject> {
  if (getDbType() === DB_SQLITE) {
    return sqliteModel.rotateCsApiObjectSecret(id, tenantId, newHash, rotatingUntil);
  }
  const r = await query(
    `UPDATE cs_api_objects
     SET rotating_from_hash = app_secret_hash,
         app_secret_hash    = $1,
         rotating_until     = $2,
         updated_at         = NOW()
     WHERE id = $3 AND tenant_id = $4 RETURNING *`,
    [newHash, rotatingUntil, id, tenantId],
  );
  if (!r.rows[0]) { throw new Error(`cs_api_object not found: ${id}`); }
  return rowToCsApiObject(r.rows[0]);
}

/** No tenantId scoping — caller guarantees id authority (looked up via getCsApiObjectByAppId which doesn't tenant-scope). */
export async function clearExpiredRotation(id: string): Promise<void> {
  if (getDbType() === DB_SQLITE) {
    return sqliteModel.clearExpiredRotation(id);
  }
  await query(
    `UPDATE cs_api_objects
     SET rotating_from_hash = NULL, rotating_until = NULL, updated_at = NOW()
     WHERE id = $1 AND rotating_until < NOW()`,
    [id],
  );
}

export async function deleteCsApiObject(id: string, tenantId: string): Promise<boolean> {
  if (getDbType() === DB_SQLITE) {
    return sqliteModel.deleteCsApiObject(id, tenantId);
  }
  const r = await query(
    `DELETE FROM cs_api_objects WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** No tenantId scoping — caller guarantees id authority (looked up via getCsApiObjectByAppId which doesn't tenant-scope). */
export async function touchLastUsed(id: string): Promise<void> {
  if (getDbType() === DB_SQLITE) {
    return sqliteModel.touchLastUsed(id);
  }
  await query(`UPDATE cs_api_objects SET last_used_at = NOW() WHERE id = $1`, [id]);
}
