/**
 * Customer Service Session CRUD — dual PostgreSQL / SQLite support.
 *
 * 客服会话 CRUD，支持 PostgreSQL 和 SQLite 双后端。
 */

import { query, getDbType, DB_SQLITE } from "../index.js";
import { sqliteQuery } from "../sqlite/index.js";
import type { CSSession, CSSessionState } from "../../customer-service/types.js";

// -- Row mapper --

function rowToSession(row: Record<string, unknown>): CSSession {
  const parseJson = (val: unknown, fallback: unknown) => {
    if (typeof val === "string") {
      try { return JSON.parse(val); } catch { return fallback; }
    }
    return val ?? fallback;
  };

  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    visitorId: row.visitor_id as string,
    visitorName: (row.visitor_name as string) ?? null,
    state: (row.state as CSSessionState) ?? "ai_active",
    channel: (row.channel as string) ?? "web_widget",
    tags: parseJson(row.tags, []) as string[],
    identityAnchors: parseJson(row.identity_anchors, {}) as Record<string, string>,
    metadata: parseJson(row.metadata, {}) as Record<string, unknown>,
    assignedTo: (row.assigned_to as string) ?? null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
    closedAt: (row.closed_at as Date) ?? null,
  };
}

// -- Create --

export async function createCSSession(params: {
  tenantId: string;
  visitorId: string;
  visitorName?: string;
  channel?: string;
  metadata?: Record<string, unknown>;
}): Promise<CSSession> {
  if (getDbType() === DB_SQLITE) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    sqliteQuery(
      `INSERT INTO cs_sessions (id, tenant_id, visitor_id, visitor_name, state, channel, tags, identity_anchors, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'ai_active', ?, '[]', '{}', ?, ?, ?)`,
      [id, params.tenantId, params.visitorId, params.visitorName ?? null, params.channel ?? "web_widget", JSON.stringify(params.metadata ?? {}), now, now],
    );
    return getCSSession(id) as Promise<CSSession>;
  }

  const result = await query(
    `INSERT INTO cs_sessions (tenant_id, visitor_id, visitor_name, channel, metadata)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [params.tenantId, params.visitorId, params.visitorName ?? null, params.channel ?? "web_widget", JSON.stringify(params.metadata ?? {})],
  );
  return rowToSession(result.rows[0]);
}

// -- Get by ID --

export async function getCSSession(id: string): Promise<CSSession | null> {
  if (getDbType() === DB_SQLITE) {
    const result = sqliteQuery("SELECT * FROM cs_sessions WHERE id = ?", [id]);
    return result.rows.length > 0 ? rowToSession(result.rows[0] as Record<string, unknown>) : null;
  }
  const result = await query("SELECT * FROM cs_sessions WHERE id = $1", [id]);
  return result.rows.length > 0 ? rowToSession(result.rows[0]) : null;
}

// -- Find active session by visitor --

export async function findActiveCSSession(
  tenantId: string,
  visitorId: string,
): Promise<CSSession | null> {
  if (getDbType() === DB_SQLITE) {
    const result = sqliteQuery(
      "SELECT * FROM cs_sessions WHERE tenant_id = ? AND visitor_id = ? AND closed_at IS NULL ORDER BY created_at DESC LIMIT 1",
      [tenantId, visitorId],
    );
    return result.rows.length > 0 ? rowToSession(result.rows[0] as Record<string, unknown>) : null;
  }
  const result = await query(
    "SELECT * FROM cs_sessions WHERE tenant_id = $1 AND visitor_id = $2 AND closed_at IS NULL ORDER BY created_at DESC LIMIT 1",
    [tenantId, visitorId],
  );
  return result.rows.length > 0 ? rowToSession(result.rows[0]) : null;
}

// -- Update state --

export async function updateCSSessionState(
  id: string,
  state: CSSessionState,
): Promise<void> {
  if (getDbType() === DB_SQLITE) {
    sqliteQuery(
      "UPDATE cs_sessions SET state = ?, updated_at = ? WHERE id = ?",
      [state, new Date().toISOString(), id],
    );
    return;
  }
  await query("UPDATE cs_sessions SET state = $1, updated_at = NOW() WHERE id = $2", [state, id]);
}

// -- Update tags + identity anchors --

export async function updateCSSessionMeta(
  id: string,
  updates: { tags?: string[]; identityAnchors?: Record<string, string> },
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (getDbType() === DB_SQLITE) {
    if (updates.tags) { sets.push("tags = ?"); values.push(JSON.stringify(updates.tags)); }
    if (updates.identityAnchors) { sets.push("identity_anchors = ?"); values.push(JSON.stringify(updates.identityAnchors)); }
    if (sets.length === 0) return;
    sets.push("updated_at = ?");
    values.push(new Date().toISOString());
    values.push(id);
    sqliteQuery(`UPDATE cs_sessions SET ${sets.join(", ")} WHERE id = ?`, values);
    return;
  }

  let idx = 0;
  if (updates.tags) { idx++; sets.push(`tags = $${idx}`); values.push(JSON.stringify(updates.tags)); }
  if (updates.identityAnchors) { idx++; sets.push(`identity_anchors = $${idx}`); values.push(JSON.stringify(updates.identityAnchors)); }
  if (sets.length === 0) return;
  sets.push("updated_at = NOW()");
  idx++;
  values.push(id);
  await query(`UPDATE cs_sessions SET ${sets.join(", ")} WHERE id = $${idx}`, values);
}

// -- List sessions for tenant (admin) --

export async function listCSSessions(
  tenantId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<CSSession[]> {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  if (getDbType() === DB_SQLITE) {
    const result = sqliteQuery(
      "SELECT * FROM cs_sessions WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?",
      [tenantId, limit, offset],
    );
    return result.rows.map(rowToSession);
  }
  const result = await query(
    "SELECT * FROM cs_sessions WHERE tenant_id = $1 ORDER BY updated_at DESC LIMIT $2 OFFSET $3",
    [tenantId, limit, offset],
  );
  return result.rows.map(rowToSession);
}

// -- Record last Feishu notification time (stored in metadata JSON) --
// Avoids schema migration; metadata is a generic JSON blob.
// 将最后飞书通知时间写入 metadata，避免改表结构。

export async function updateCSSessionNotifiedAt(id: string, notifiedAt: string): Promise<void> {
  if (getDbType() === DB_SQLITE) {
    // Read-modify-write: fetch current metadata, merge, write back.
    // 读取当前 metadata → 合并 lastNotifiedAt → 写回。
    const result = sqliteQuery("SELECT metadata FROM cs_sessions WHERE id = ?", [id]);
    const raw = result.rows[0] as Record<string, unknown> | undefined;
    const existing = raw?.metadata;
    const meta: Record<string, unknown> =
      typeof existing === "string" ? (() => { try { return JSON.parse(existing); } catch { return {}; } })() :
      typeof existing === "object" && existing !== null ? existing as Record<string, unknown> : {};
    meta.lastNotifiedAt = notifiedAt;
    sqliteQuery("UPDATE cs_sessions SET metadata = ? WHERE id = ?", [JSON.stringify(meta), id]);
    return;
  }
  // PostgreSQL: use jsonb || merge operator
  // PostgreSQL 用 jsonb 合并操作符
  await query(
    "UPDATE cs_sessions SET metadata = metadata || $1::jsonb WHERE id = $2",
    [JSON.stringify({ lastNotifiedAt: notifiedAt }), id],
  );
}

// -- Count active sessions for an API object (used by delete guard) --
// -- 统计 API 对象关联的活跃会话数（用于删除前检查） --

/**
 * Count active (non-closed) sessions linked to a specific API object.
 * Returns 0 as a stub; real implementation added in Task 5.
 *
 * 统计与指定 API 对象关联的活跃会话数量。
 * 当前为存根实现（返回 0），Task 5 补充真实实现。
 */
export async function countActiveSessionsForApiObject(
  _tenantId: string,
  _appObjectId: string,
): Promise<number> {
  return 0; // placeholder; real implementation in Task 5
}

// -- Close session --

export async function closeCSSession(id: string): Promise<void> {
  if (getDbType() === DB_SQLITE) {
    const now = new Date().toISOString();
    sqliteQuery("UPDATE cs_sessions SET closed_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
    return;
  }
  await query("UPDATE cs_sessions SET closed_at = NOW(), updated_at = NOW() WHERE id = $1", [id]);
}
