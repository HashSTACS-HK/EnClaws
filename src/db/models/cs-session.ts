/**
 * Customer Service Session CRUD — dual PostgreSQL / SQLite support.
 *
 * 客服会话 CRUD，支持 PostgreSQL 和 SQLite 双后端。
 */

import { query, getDbType, DB_SQLITE } from "../index.js";
import { sqliteQuery } from "../sqlite/index.js";
import type { CSSession, CSSessionState } from "../../customer-service/types.js";

// ── CS-API session types (Agenora S2 jiumi) ─────────────────────────────────

/**
 * State values for sessions created via the CS API (different from legacy widget states).
 *
 * CS API 会话状态，与旧版 widget 状态独立。
 */
export type CsApiSessionState = "ai-handling" | "human-handling" | "closed";

/**
 * Active responder shape for handoff/release operations.
 *
 * 接管/释放操作中的响应方信息。
 */
export interface CsApiActiveResponder {
  type: "human";
  party: string;
}

/**
 * Minimal CS-API session shape returned by findOrCreateCsApiSession.
 * Includes message history for agent context.
 *
 * findOrCreateCsApiSession 返回的最小会话结构，含消息历史供 agent 使用。
 */
export interface CsApiSession {
  id: string;
  tenantId: string;
  customerId: string;
  appObjectId: string | null;
  agentId: string;
  state: CsApiSessionState;
  channel: string;
  activeResponder: CsApiActiveResponder | null;
  metadata: Record<string, unknown>;
  createdAt: Date | string;
  updatedAt: Date | string;
  /** Message history for agent context (chronological). */
  messages: Array<{ role: string; content: string }>;
}

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
    return result.rows.length > 0 ? rowToSession(result.rows[0]) : null;
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
    return result.rows.length > 0 ? rowToSession(result.rows[0]) : null;
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
    if (sets.length === 0) {return;}
    sets.push("updated_at = ?");
    values.push(new Date().toISOString());
    values.push(id);
    sqliteQuery(`UPDATE cs_sessions SET ${sets.join(", ")} WHERE id = ?`, values);
    return;
  }

  let idx = 0;
  if (updates.tags) { idx++; sets.push(`tags = $${idx}`); values.push(JSON.stringify(updates.tags)); }
  if (updates.identityAnchors) { idx++; sets.push(`identity_anchors = $${idx}`); values.push(JSON.stringify(updates.identityAnchors)); }
  if (sets.length === 0) {return;}
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
 * Count active sessions linked to a specific CS API object.
 * "Active" = state IN ('ai-handling', 'human-handling').
 *
 * 统计与指定 API 对象关联的活跃会话数量（state 为 ai-handling 或 human-handling）。
 */
export async function countActiveSessionsForApiObject(
  tenantId: string,
  appObjectId: string,
): Promise<number> {
  if (getDbType() === DB_SQLITE) {
    const result = sqliteQuery(
      `SELECT COUNT(*) as cnt FROM cs_sessions
       WHERE tenant_id = ? AND app_object_id = ?
         AND state IN ('ai-handling', 'human-handling')`,
      [tenantId, appObjectId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return Number(row?.cnt ?? 0);
  }
  const result = await query(
    `SELECT COUNT(*)::int AS cnt FROM cs_sessions
     WHERE tenant_id = $1 AND app_object_id = $2
       AND state IN ('ai-handling', 'human-handling')`,
    [tenantId, appObjectId],
  );
  return Number(result.rows[0]?.cnt ?? 0);
}

// ── CS-API session helpers (Agenora S2 jiumi) ────────────────────────────────

/**
 * Row mapper for CS-API sessions (includes app_object_id, active_responder).
 *
 * CS-API 会话行映射器（含 app_object_id 和 active_responder）。
 */
function rowToCsApiSession(row: Record<string, unknown>): CsApiSession {
  const parseJson = <T>(val: unknown, fallback: T): T => {
    if (typeof val === "string") {
      try { return JSON.parse(val) as T; } catch { return fallback; }
    }
    return (val as T) ?? fallback;
  };

  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    customerId: (row.visitor_id as string) ?? "",
    appObjectId: (row.app_object_id as string | null) ?? null,
    agentId: (row.metadata_agent_id as string) ?? "",
    state: (row.state as CsApiSessionState) ?? "ai-handling",
    channel: (row.channel as string) ?? "cs-api",
    activeResponder: parseJson<CsApiActiveResponder | null>(row.metadata_active_responder, null),
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
    createdAt: (row.created_at as Date | string),
    updatedAt: (row.updated_at as Date | string),
    messages: [],
  };
}

/**
 * Find or create a CS-API session for a customer/app-object pair.
 *
 * Lookup priority:
 *   1. `requestedSessionId` provided → return it (if found, any state)
 *   2. Existing session for (tenantId, customerId, appObjectId) with active state → return it
 *   3. Create new session
 *
 * 查找或创建 CS-API 会话，附带消息历史（供 agent 使用）。
 */
export async function findOrCreateCsApiSession(params: {
  tenantId: string;
  appObjectId: string;
  agentId: string;
  customerId: string;
  channelId?: string;
  requestedSessionId?: string;
}): Promise<CsApiSession> {
  const { tenantId, appObjectId, agentId, customerId, channelId, requestedSessionId } = params;
  const channel = channelId ?? "cs-api";

  // Helper: load messages for a session id
  async function loadMessages(sessionId: string): Promise<Array<{ role: string; content: string }>> {
    if (getDbType() === DB_SQLITE) {
      const r = sqliteQuery(
        "SELECT role, content FROM cs_messages WHERE session_id = ? ORDER BY created_at ASC LIMIT 100",
        [sessionId],
      );
      return r.rows.map((row) => {
        const r2 = row;
        return { role: r2.role as string, content: r2.content as string };
      });
    }
    const r = await query(
      "SELECT role, content FROM cs_messages WHERE session_id = $1 ORDER BY created_at ASC LIMIT 100",
      [sessionId],
    );
    return r.rows.map((row) => ({ role: row.role as string, content: row.content as string }));
  }

  // Helper: build metadata JSON with agentId embedded
  function buildMetadata(extra?: Record<string, unknown>): string {
    return JSON.stringify({ agentId, ...extra });
  }

  // 1. Requested session id lookup
  if (requestedSessionId) {
    if (getDbType() === DB_SQLITE) {
      const r = sqliteQuery(
        "SELECT * FROM cs_sessions WHERE id = ? AND tenant_id = ?",
        [requestedSessionId, tenantId],
      );
      if (r.rows.length > 0) {
        const sess = rowToCsApiSession(flattenMetadata(r.rows[0]));
        sess.messages = await loadMessages(sess.id);
        return sess;
      }
    } else {
      const r = await query(
        "SELECT * FROM cs_sessions WHERE id = $1 AND tenant_id = $2",
        [requestedSessionId, tenantId],
      );
      if (r.rows.length > 0) {
        const sess = rowToCsApiSession(flattenMetadata(r.rows[0]));
        sess.messages = await loadMessages(sess.id);
        return sess;
      }
    }
  }

  // 2. Existing active session lookup
  if (getDbType() === DB_SQLITE) {
    const r = sqliteQuery(
      `SELECT * FROM cs_sessions
       WHERE tenant_id = ? AND visitor_id = ? AND app_object_id = ?
         AND state IN ('ai-handling', 'human-handling')
       ORDER BY created_at DESC LIMIT 1`,
      [tenantId, customerId, appObjectId],
    );
    if (r.rows.length > 0) {
      const sess = rowToCsApiSession(flattenMetadata(r.rows[0]));
      sess.messages = await loadMessages(sess.id);
      return sess;
    }
  } else {
    const r = await query(
      `SELECT * FROM cs_sessions
       WHERE tenant_id = $1 AND visitor_id = $2 AND app_object_id = $3
         AND state IN ('ai-handling', 'human-handling')
       ORDER BY created_at DESC LIMIT 1`,
      [tenantId, customerId, appObjectId],
    );
    if (r.rows.length > 0) {
      const sess = rowToCsApiSession(flattenMetadata(r.rows[0]));
      sess.messages = await loadMessages(sess.id);
      return sess;
    }
  }

  // 3. Create new session
  const meta = buildMetadata();
  if (getDbType() === DB_SQLITE) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    sqliteQuery(
      `INSERT INTO cs_sessions
         (id, tenant_id, visitor_id, state, channel, app_object_id, tags, identity_anchors, metadata, created_at, updated_at)
       VALUES (?, ?, ?, 'ai-handling', ?, ?, '[]', '{}', ?, ?, ?)`,
      [id, tenantId, customerId, channel, appObjectId, meta, now, now],
    );
    const r2 = sqliteQuery("SELECT * FROM cs_sessions WHERE id = ?", [id]);
    const sess = rowToCsApiSession(flattenMetadata(r2.rows[0]));
    sess.agentId = agentId;
    sess.messages = [];
    return sess;
  }

  const r = await query(
    `INSERT INTO cs_sessions
       (tenant_id, visitor_id, state, channel, app_object_id, metadata)
     VALUES ($1, $2, 'ai-handling', $3, $4, $5)
     RETURNING *`,
    [tenantId, customerId, channel, appObjectId, meta],
  );
  const sess = rowToCsApiSession(flattenMetadata(r.rows[0]));
  sess.agentId = agentId;
  sess.messages = [];
  return sess;
}

/**
 * Flatten metadata JSON into row fields for simpler mapper access.
 * Extracts `agentId` and `activeResponder` from the metadata blob.
 *
 * 将 metadata JSON 中的字段展开到行记录上，方便 mapper 读取。
 */
function flattenMetadata(row: Record<string, unknown>): Record<string, unknown> {
  let meta: Record<string, unknown> = {};
  if (typeof row.metadata === "string") {
    try { meta = JSON.parse(row.metadata) as Record<string, unknown>; } catch { /* ignore */ }
  } else if (typeof row.metadata === "object" && row.metadata !== null) {
    meta = row.metadata as Record<string, unknown>;
  }
  return {
    ...row,
    metadata_agent_id: meta.agentId,
    metadata_active_responder: meta.activeResponder ?? null,
  };
}

/**
 * Append a message to a CS-API session (cs_messages table).
 * Returns the new message id.
 *
 * 向 CS-API 会话追加一条消息，返回新消息 id。
 */
export async function appendCsApiMessage(params: {
  sessionId: string;
  tenantId: string;
  role: string;
  source: "agenora-ai" | "upper-app-relay";
  content: string;
  senderParty?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ id: string }> {
  const { sessionId, tenantId, role, source, content, senderParty, metadata } = params;
  const confidenceJson = null;
  const sourceChunksJson = senderParty
    ? JSON.stringify([{ senderParty }])
    : metadata
      ? JSON.stringify([{ metadata }])
      : null;

  if (getDbType() === DB_SQLITE) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    sqliteQuery(
      `INSERT INTO cs_messages
         (id, session_id, tenant_id, role, content, confidence, source_chunks, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, sessionId, tenantId, role, content, confidenceJson, sourceChunksJson, source, now],
    );
    return { id };
  }

  const r = await query(
    `INSERT INTO cs_messages
       (session_id, tenant_id, role, content, confidence, source_chunks, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [sessionId, tenantId, role, content, confidenceJson, sourceChunksJson, source],
  );
  return { id: r.rows[0].id as string };
}

/**
 * Update the state and active_responder of a CS-API session.
 * Returns the updated session or null if not found.
 *
 * 更新 CS-API 会话状态及响应方，返回更新后的会话。
 */
export async function setSessionState(params: {
  tenantId: string;
  sessionId: string;
  state: CsApiSessionState;
  activeResponder: CsApiActiveResponder | null;
}): Promise<CsApiSession | null> {
  const { tenantId, sessionId, state, activeResponder } = params;

  // We store activeResponder in the metadata JSON blob
  if (getDbType() === DB_SQLITE) {
    // Read current metadata
    const cur = sqliteQuery(
      "SELECT metadata FROM cs_sessions WHERE id = ? AND tenant_id = ?",
      [sessionId, tenantId],
    );
    if (cur.rows.length === 0) { return null; }
    const row0 = cur.rows[0];
    let meta: Record<string, unknown> = {};
    if (typeof row0.metadata === "string") {
      try { meta = JSON.parse(row0.metadata) as Record<string, unknown>; } catch { /* ignore */ }
    }
    meta.activeResponder = activeResponder;
    const now = new Date().toISOString();
    sqliteQuery(
      "UPDATE cs_sessions SET state = ?, metadata = ?, updated_at = ? WHERE id = ? AND tenant_id = ?",
      [state, JSON.stringify(meta), now, sessionId, tenantId],
    );
    const r2 = sqliteQuery("SELECT * FROM cs_sessions WHERE id = ?", [sessionId]);
    if (r2.rows.length === 0) { return null; }
    const sess = rowToCsApiSession(flattenMetadata(r2.rows[0]));
    sess.activeResponder = activeResponder;
    return sess;
  }

  // PostgreSQL
  const cur = await query(
    "SELECT metadata FROM cs_sessions WHERE id = $1 AND tenant_id = $2",
    [sessionId, tenantId],
  );
  if (cur.rows.length === 0) { return null; }
  let meta: Record<string, unknown> = {};
  const metaVal = cur.rows[0].metadata;
  if (typeof metaVal === "string") {
    try { meta = JSON.parse(metaVal) as Record<string, unknown>; } catch { /* ignore */ }
  } else if (metaVal && typeof metaVal === "object") {
    meta = metaVal as Record<string, unknown>;
  }
  meta.activeResponder = activeResponder;
  const r = await query(
    `UPDATE cs_sessions SET state = $1, metadata = $2, updated_at = NOW()
     WHERE id = $3 AND tenant_id = $4 RETURNING *`,
    [state, JSON.stringify(meta), sessionId, tenantId],
  );
  if (r.rows.length === 0) { return null; }
  const sess = rowToCsApiSession(flattenMetadata(r.rows[0]));
  sess.activeResponder = activeResponder;
  return sess;
}

// ── CS-API query helpers (§11.6) ──────────────────────────────────────────────

/**
 * Encode a cursor from (updatedAt, id) for session list pagination.
 * Cursor encodes { u: ISO string, i: id string }.
 *
 * 将 (updatedAt, id) 编码为 base64 cursor，用于会话列表分页。
 */
function encodeCursor(updatedAt: Date | string, id: string): string {
  const iso = typeof updatedAt === "string" ? updatedAt : updatedAt.toISOString();
  return Buffer.from(JSON.stringify({ u: iso, i: id })).toString("base64");
}

/**
 * Decode a session list cursor.
 * Returns null on parse failure.
 *
 * 解码会话列表 cursor，解析失败返回 null。
 */
function decodeSessionCursor(s: string): { updatedAt: string; id: string } | null {
  try {
    const obj = JSON.parse(Buffer.from(s, "base64").toString("utf8")) as { u?: unknown; i?: unknown };
    if (typeof obj.u !== "string" || typeof obj.i !== "string") { return null; }
    return { updatedAt: obj.u, id: obj.i };
  } catch { return null; }
}

/**
 * Encode a cursor from (createdAt, id) for transcript pagination.
 *
 * 将 (createdAt, id) 编码为 base64 cursor，用于消息流水分页。
 */
function encodeTranscriptCursor(createdAt: Date | string, id: string): string {
  const iso = typeof createdAt === "string" ? createdAt : createdAt.toISOString();
  return Buffer.from(JSON.stringify({ c: iso, i: id })).toString("base64");
}

/**
 * Decode a transcript cursor.
 *
 * 解码消息流水 cursor。
 */
function decodeTranscriptCursor(s: string): { createdAt: string; id: string } | null {
  try {
    const obj = JSON.parse(Buffer.from(s, "base64").toString("utf8")) as { c?: unknown; i?: unknown };
    if (typeof obj.c !== "string" || typeof obj.i !== "string") { return null; }
    return { createdAt: obj.c, id: obj.i };
  } catch { return null; }
}

export interface CsApiSessionSummary {
  id: string;
  state: string;
  customerId: string | null;
  channelId: string | null;
  activeResponder: { type: string; party: string } | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  participants?: string[];
}

export interface ListCsApiSessionsParams {
  tenantId: string;
  appObjectId: string;
  cursor?: string;
  limit?: number;
  state?: "ai-handling" | "human-handling" | "closed";
  customerId?: string;
  updatedAfter?: string;
}

export interface ListCsApiTranscriptParams {
  tenantId: string;
  appObjectId: string;
  sessionId: string;
  cursor?: string;
  limit?: number;
  direction?: "before" | "after";
}

export interface CsApiMessage {
  id: string;
  role: string;
  source: string;
  content: string;
  senderParty?: string;
  toolCalls?: unknown;
  createdAt: string;
}

/**
 * Map a raw cs_sessions row to CsApiSessionSummary.
 * Attaches lastMessageAt/lastMessagePreview/messageCount from aggregated fields.
 *
 * 将 cs_sessions 行映射为 CsApiSessionSummary（含聚合消息字段）。
 */
function rowToSessionSummary(
  row: Record<string, unknown>,
  meta: { lastMessageAt: string | null; lastMessagePreview: string | null; messageCount: number },
): CsApiSessionSummary {
  const parseJson = <T>(val: unknown, fallback: T): T => {
    if (typeof val === "string") {
      try { return JSON.parse(val) as T; } catch { return fallback; }
    }
    return (val as T) ?? fallback;
  };

  let sessionMeta: Record<string, unknown> = {};
  if (typeof row.metadata === "string") {
    try { sessionMeta = JSON.parse(row.metadata) as Record<string, unknown>; } catch { /* ignore */ }
  } else if (row.metadata && typeof row.metadata === "object") {
    sessionMeta = row.metadata as Record<string, unknown>;
  }

  const activeResponder = parseJson<{ type: string; party: string } | null>(
    sessionMeta.activeResponder ?? null,
    null,
  );

  const createdAt = typeof row.created_at === "string" ? row.created_at : (row.created_at as Date)?.toISOString?.() ?? "";
  const updatedAt = typeof row.updated_at === "string" ? row.updated_at : (row.updated_at as Date)?.toISOString?.() ?? "";

  return {
    id: row.id as string,
    state: row.state as string,
    customerId: (row.visitor_id as string) ?? null,
    channelId: (row.channel as string) ?? null,
    activeResponder,
    lastMessageAt: meta.lastMessageAt,
    lastMessagePreview: meta.lastMessagePreview,
    messageCount: meta.messageCount,
    createdAt,
    updatedAt,
  };
}

/**
 * List CS-API sessions for a tenant + appObjectId with cursor pagination.
 * Supports optional filters: state, customerId, updatedAfter.
 * Cursor encodes (updated_at DESC, id DESC) for stable ordering.
 *
 * 分页列出指定租户和 appObjectId 下的 CS-API 会话，支持 state / customerId / updatedAfter 过滤。
 */
export async function listCsApiSessions(
  p: ListCsApiSessionsParams,
): Promise<{ sessions: CsApiSessionSummary[]; nextCursor: string | null }> {
  const limit = Math.min(p.limit ?? 20, 50);
  const { tenantId, appObjectId, state, customerId, updatedAfter, cursor } = p;

  const cursorDecoded = cursor ? decodeSessionCursor(cursor) : null;

  if (getDbType() === DB_SQLITE) {
    // Build WHERE conditions
    const conditions: string[] = [
      "s.tenant_id = ?",
      "s.app_object_id = ?",
    ];
    const values: unknown[] = [tenantId, appObjectId];

    if (state) { conditions.push("s.state = ?"); values.push(state); }
    if (customerId) { conditions.push("s.visitor_id = ?"); values.push(customerId); }
    if (updatedAfter) { conditions.push("s.updated_at > ?"); values.push(updatedAfter); }
    if (cursorDecoded) {
      conditions.push("(s.updated_at < ? OR (s.updated_at = ? AND s.id < ?))");
      values.push(cursorDecoded.updatedAt, cursorDecoded.updatedAt, cursorDecoded.id);
    }

    // Fetch limit+1 to detect hasMore
    const sql = `
      SELECT s.*
      FROM cs_sessions s
      WHERE ${conditions.join(" AND ")}
      ORDER BY s.updated_at DESC, s.id DESC
      LIMIT ?
    `;
    values.push(limit + 1);

    const rows = sqliteQuery(sql, values).rows as Record<string, unknown>[];
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    // For each session, get message count + last message
    const sessions: CsApiSessionSummary[] = [];
    for (const row of pageRows) {
      const sessionId = row.id as string;
      const cntResult = sqliteQuery(
        "SELECT COUNT(*) as cnt FROM cs_messages WHERE session_id = ?",
        [sessionId],
      ).rows[0] as Record<string, unknown> | undefined;
      const messageCount = Number(cntResult?.cnt ?? 0);

      const lastMsgResult = sqliteQuery(
        "SELECT content, created_at FROM cs_messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 1",
        [sessionId],
      ).rows[0] as Record<string, unknown> | undefined;
      const lastMessageAt = lastMsgResult?.created_at
        ? (typeof lastMsgResult.created_at === "string" ? lastMsgResult.created_at : String(lastMsgResult.created_at))
        : null;
      const rawContent = lastMsgResult?.content as string | null ?? null;
      const lastMessagePreview = rawContent ? rawContent.slice(0, 120) : null;

      sessions.push(rowToSessionSummary(row, { lastMessageAt, lastMessagePreview, messageCount }));
    }

    const nextCursor = hasMore && pageRows.length > 0
      ? encodeCursor(pageRows[pageRows.length - 1].updated_at as string, pageRows[pageRows.length - 1].id as string)
      : null;

    return { sessions, nextCursor };
  }

  // PostgreSQL
  const conditions: string[] = [
    "s.tenant_id = $1",
    "s.app_object_id = $2",
  ];
  const values: unknown[] = [tenantId, appObjectId];
  let idx = 2;

  if (state) { idx++; conditions.push(`s.state = $${idx}`); values.push(state); }
  if (customerId) { idx++; conditions.push(`s.visitor_id = $${idx}`); values.push(customerId); }
  if (updatedAfter) { idx++; conditions.push(`s.updated_at > $${idx}`); values.push(updatedAfter); }
  if (cursorDecoded) {
    idx++; const uIdx = idx;
    idx++; const iIdx = idx;
    conditions.push(`(s.updated_at < $${uIdx} OR (s.updated_at = $${uIdx} AND s.id < $${iIdx}))`);
    values.push(cursorDecoded.updatedAt, cursorDecoded.id);
  }

  idx++;
  const sql = `
    SELECT
      s.*,
      COUNT(m.id)::int AS msg_count,
      MAX(m.created_at) AS last_message_at,
      (
        SELECT content FROM cs_messages
        WHERE session_id = s.id
        ORDER BY created_at DESC LIMIT 1
      ) AS last_message_content
    FROM cs_sessions s
    LEFT JOIN cs_messages m ON m.session_id = s.id
    WHERE ${conditions.join(" AND ")}
    GROUP BY s.id
    ORDER BY s.updated_at DESC, s.id DESC
    LIMIT $${idx}
  `;
  values.push(limit + 1);

  const result = await query(sql, values);
  const rows = result.rows as Record<string, unknown>[];
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  const sessions: CsApiSessionSummary[] = pageRows.map((row) => {
    const messageCount = Number(row.msg_count ?? 0);
    const lastMessageAt = row.last_message_at
      ? (row.last_message_at instanceof Date ? row.last_message_at.toISOString() : String(row.last_message_at))
      : null;
    const rawContent = row.last_message_content as string | null ?? null;
    const lastMessagePreview = rawContent ? rawContent.slice(0, 120) : null;
    return rowToSessionSummary(row, { lastMessageAt, lastMessagePreview, messageCount });
  });

  const nextCursor = hasMore && pageRows.length > 0
    ? encodeCursor(
        pageRows[pageRows.length - 1].updated_at as Date,
        pageRows[pageRows.length - 1].id as string,
      )
    : null;

  return { sessions, nextCursor };
}

/**
 * Get a single CS-API session's metadata (no messages[]).
 * Returns null if not found or not owned by appObjectId.
 *
 * 获取单条 CS-API 会话元数据（不含 messages 字段）。
 */
export async function getCsApiSessionMetadata(p: {
  tenantId: string;
  appObjectId: string;
  sessionId: string;
}): Promise<CsApiSessionSummary | null> {
  const { tenantId, appObjectId, sessionId } = p;

  if (getDbType() === DB_SQLITE) {
    const r = sqliteQuery(
      "SELECT * FROM cs_sessions WHERE id = ? AND tenant_id = ? AND app_object_id = ?",
      [sessionId, tenantId, appObjectId],
    );
    if (r.rows.length === 0) { return null; }
    const row = r.rows[0] as Record<string, unknown>;

    const cntResult = sqliteQuery(
      "SELECT COUNT(*) as cnt FROM cs_messages WHERE session_id = ?",
      [sessionId],
    ).rows[0] as Record<string, unknown> | undefined;
    const messageCount = Number(cntResult?.cnt ?? 0);

    const lastMsgResult = sqliteQuery(
      "SELECT content, created_at FROM cs_messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 1",
      [sessionId],
    ).rows[0] as Record<string, unknown> | undefined;
    const lastMessageAt = lastMsgResult?.created_at
      ? (typeof lastMsgResult.created_at === "string" ? lastMsgResult.created_at : String(lastMsgResult.created_at))
      : null;
    const rawContent = lastMsgResult?.content as string | null ?? null;
    const lastMessagePreview = rawContent ? rawContent.slice(0, 120) : null;

    return rowToSessionSummary(row, { lastMessageAt, lastMessagePreview, messageCount });
  }

  const r = await query(
    `SELECT
       s.*,
       COUNT(m.id)::int AS msg_count,
       MAX(m.created_at) AS last_message_at,
       (SELECT content FROM cs_messages WHERE session_id = s.id ORDER BY created_at DESC LIMIT 1) AS last_message_content
     FROM cs_sessions s
     LEFT JOIN cs_messages m ON m.session_id = s.id
     WHERE s.id = $1 AND s.tenant_id = $2 AND s.app_object_id = $3
     GROUP BY s.id`,
    [sessionId, tenantId, appObjectId],
  );
  if (r.rows.length === 0) { return null; }
  const row = r.rows[0] as Record<string, unknown>;
  const messageCount = Number(row.msg_count ?? 0);
  const lastMessageAt = row.last_message_at
    ? (row.last_message_at instanceof Date ? row.last_message_at.toISOString() : String(row.last_message_at))
    : null;
  const rawContent = row.last_message_content as string | null ?? null;
  const lastMessagePreview = rawContent ? rawContent.slice(0, 120) : null;
  return rowToSessionSummary(row, { lastMessageAt, lastMessagePreview, messageCount });
}

/**
 * List messages for a session (transcript) with cursor pagination.
 * direction="before" → older messages (default, for scroll-up history)
 * direction="after"  → newer messages
 *
 * 分页列出指定会话的消息流水（transcript），支持 before/after 两种方向。
 */
export async function listCsApiTranscript(
  p: ListCsApiTranscriptParams,
): Promise<{ messages: CsApiMessage[]; nextCursor: string | null; hasMore: boolean }> {
  const limit = Math.min(p.limit ?? 30, 100);
  const direction = p.direction ?? "before";
  const { tenantId, appObjectId, sessionId, cursor } = p;

  const cursorDecoded = cursor ? decodeTranscriptCursor(cursor) : null;

  // Verify session ownership before loading messages
  if (getDbType() === DB_SQLITE) {
    const sessionCheck = sqliteQuery(
      "SELECT id FROM cs_sessions WHERE id = ? AND tenant_id = ? AND app_object_id = ?",
      [sessionId, tenantId, appObjectId],
    );
    if (sessionCheck.rows.length === 0) {
      return { messages: [], nextCursor: null, hasMore: false };
    }
  } else {
    const sessionCheck = await query(
      "SELECT id FROM cs_sessions WHERE id = $1 AND tenant_id = $2 AND app_object_id = $3",
      [sessionId, tenantId, appObjectId],
    );
    if (sessionCheck.rows.length === 0) {
      return { messages: [], nextCursor: null, hasMore: false };
    }
  }

  if (getDbType() === DB_SQLITE) {
    const conditions: string[] = ["session_id = ?"];
    const values: unknown[] = [sessionId];

    if (cursorDecoded) {
      if (direction === "before") {
        conditions.push("(created_at < ? OR (created_at = ? AND id < ?))");
        values.push(cursorDecoded.createdAt, cursorDecoded.createdAt, cursorDecoded.id);
      } else {
        conditions.push("(created_at > ? OR (created_at = ? AND id > ?))");
        values.push(cursorDecoded.createdAt, cursorDecoded.createdAt, cursorDecoded.id);
      }
    }

    const orderDir = direction === "before" ? "DESC" : "ASC";
    const sql = `
      SELECT id, role, source, content, source_chunks, created_at
      FROM cs_messages
      WHERE ${conditions.join(" AND ")}
      ORDER BY created_at ${orderDir}, id ${orderDir}
      LIMIT ?
    `;
    values.push(limit + 1);

    const rows = sqliteQuery(sql, values).rows as Record<string, unknown>[];
    const hasMore = rows.length > limit;
    let pageRows = hasMore ? rows.slice(0, limit) : rows;

    // For "before" direction: re-order ascending so caller gets oldest-first
    if (direction === "before") {
      pageRows = pageRows.toReversed();
    }

    const messages: CsApiMessage[] = pageRows.map((row) => {
      const sourceChunks = (() => {
        try { return typeof row.source_chunks === "string" ? JSON.parse(row.source_chunks) as unknown[] : null; } catch { return null; }
      })();
      const senderParty = Array.isArray(sourceChunks) && sourceChunks.length > 0
        ? (sourceChunks[0] as Record<string, unknown>)?.senderParty as string | undefined
        : undefined;
      return {
        id: row.id as string,
        role: row.role as string,
        source: (row.source as string) ?? "agenora-ai",
        content: row.content as string,
        ...(senderParty ? { senderParty } : {}),
        createdAt: typeof row.created_at === "string" ? row.created_at : String(row.created_at),
      };
    });

    // nextCursor: points to the "edge" message for next page
    let nextCursor: string | null = null;
    if (hasMore && pageRows.length > 0) {
      const edgeRow = direction === "before" ? pageRows[0] : pageRows[pageRows.length - 1];
      nextCursor = encodeTranscriptCursor(
        edgeRow.created_at as string,
        edgeRow.id as string,
      );
    }

    return { messages, nextCursor, hasMore };
  }

  // PostgreSQL
  const conditions: string[] = ["session_id = $1"];
  const values: unknown[] = [sessionId];
  let idx = 1;

  if (cursorDecoded) {
    if (direction === "before") {
      idx++; const cIdx = idx;
      idx++; const iIdx = idx;
      conditions.push(`(created_at < $${cIdx} OR (created_at = $${cIdx} AND id < $${iIdx}))`);
      values.push(cursorDecoded.createdAt, cursorDecoded.id);
    } else {
      idx++; const cIdx = idx;
      idx++; const iIdx = idx;
      conditions.push(`(created_at > $${cIdx} OR (created_at = $${cIdx} AND id > $${iIdx}))`);
      values.push(cursorDecoded.createdAt, cursorDecoded.id);
    }
  }

  idx++;
  const orderDir = direction === "before" ? "DESC" : "ASC";
  const sql = `
    SELECT id, role, source, content, source_chunks, created_at
    FROM cs_messages
    WHERE ${conditions.join(" AND ")}
    ORDER BY created_at ${orderDir}, id ${orderDir}
    LIMIT $${idx}
  `;
  values.push(limit + 1);

  const result = await query(sql, values);
  const rows = result.rows as Record<string, unknown>[];
  const hasMore = rows.length > limit;
  let pageRows = hasMore ? rows.slice(0, limit) : rows;

  if (direction === "before") {
    pageRows = pageRows.toReversed();
  }

  const messages: CsApiMessage[] = pageRows.map((row) => {
    const sourceChunks = (() => {
      if (typeof row.source_chunks === "string") {
        try { return JSON.parse(row.source_chunks) as unknown[]; } catch { return null; }
      }
      return Array.isArray(row.source_chunks) ? row.source_chunks as unknown[] : null;
    })();
    const senderParty = Array.isArray(sourceChunks) && sourceChunks.length > 0
      ? (sourceChunks[0] as Record<string, unknown>)?.senderParty as string | undefined
      : undefined;
    return {
      id: row.id as string,
      role: row.role as string,
      source: (row.source as string) ?? "agenora-ai",
      content: row.content as string,
      ...(senderParty ? { senderParty } : {}),
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    };
  });

  let nextCursor: string | null = null;
  if (hasMore && messages.length > 0) {
    // For "before": edge is the oldest (first after reversal), cursor points caller further back
    // For "after": edge is the newest (last), cursor points caller forward
    const edgeMsg = direction === "before" ? messages[0] : messages[messages.length - 1];
    nextCursor = encodeTranscriptCursor(edgeMsg.createdAt, edgeMsg.id);
  }

  return { messages, nextCursor, hasMore };
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
