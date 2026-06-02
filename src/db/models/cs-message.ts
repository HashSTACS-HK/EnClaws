/**
 * Customer Service Message CRUD — dual PostgreSQL / SQLite support.
 *
 * 客服消息 CRUD，支持 PostgreSQL 和 SQLite 双后端。
 */

import type { CSMessage, CSMessageRole, CSConfidence } from "../../customer-service/types.js";
import { query, getDbType, DB_SQLITE } from "../index.js";
import { sqliteQuery } from "../sqlite/index.js";

// -- Row mapper --

function rowToMessage(row: Record<string, unknown>): CSMessage {
  const parseJson = (val: unknown) => {
    if (typeof val === "string") {
      try {
        return JSON.parse(val);
      } catch {
        return null;
      }
    }
    return val ?? null;
  };

  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    tenantId: row.tenant_id as string,
    role: row.role as CSMessageRole,
    content: row.content as string,
    confidence: parseJson(row.confidence) as CSConfidence | null,
    feedbackType: (row.feedback_type as string) ?? null,
    sourceChunks: parseJson(row.source_chunks) as unknown[] | null,
    // Link to llm_interaction_traces.turn_id; null for customer/human/legacy messages.
    // 关联 llm_interaction_traces.turn_id；客户/人工/历史消息为 null。
    turnId: (row.turn_id as string) ?? null,
    createdAt: row.created_at as Date,
  };
}

// -- Create --

export async function createCSMessage(params: {
  sessionId: string;
  tenantId: string;
  role: CSMessageRole;
  content: string;
  confidence?: CSConfidence | null;
  sourceChunks?: unknown[] | null;
}): Promise<CSMessage> {
  if (getDbType() === DB_SQLITE) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    sqliteQuery(
      `INSERT INTO cs_messages (id, session_id, tenant_id, role, content, confidence, source_chunks, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        params.sessionId,
        params.tenantId,
        params.role,
        params.content,
        params.confidence ? JSON.stringify(params.confidence) : null,
        params.sourceChunks ? JSON.stringify(params.sourceChunks) : null,
        now,
      ],
    );
    return getCSMessage(id) as Promise<CSMessage>;
  }

  const result = await query(
    `INSERT INTO cs_messages (session_id, tenant_id, role, content, confidence, source_chunks)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      params.sessionId,
      params.tenantId,
      params.role,
      params.content,
      params.confidence ? JSON.stringify(params.confidence) : null,
      params.sourceChunks ? JSON.stringify(params.sourceChunks) : null,
    ],
  );
  return rowToMessage(result.rows[0]);
}

// -- Get by ID --

export async function getCSMessage(id: string): Promise<CSMessage | null> {
  if (getDbType() === DB_SQLITE) {
    const result = sqliteQuery("SELECT * FROM cs_messages WHERE id = ?", [id]);
    return result.rows.length > 0 ? rowToMessage(result.rows[0]) : null;
  }
  const result = await query("SELECT * FROM cs_messages WHERE id = $1", [id]);
  return result.rows.length > 0 ? rowToMessage(result.rows[0]) : null;
}

// -- Get last message for a session (used in session list view) --
// 获取会话最后一条消息，用于后台会话列表展示"最后发言方"。

export async function getLastCSMessageForSession(sessionId: string): Promise<CSMessage | null> {
  if (getDbType() === DB_SQLITE) {
    const result = sqliteQuery(
      "SELECT * FROM cs_messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 1",
      [sessionId],
    );
    return result.rows.length > 0 ? rowToMessage(result.rows[0]) : null;
  }
  const result = await query(
    "SELECT * FROM cs_messages WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1",
    [sessionId],
  );
  return result.rows.length > 0 ? rowToMessage(result.rows[0]) : null;
}

export async function countCSMessagesForSession(sessionId: string): Promise<number> {
  if (getDbType() === DB_SQLITE) {
    const result = sqliteQuery("SELECT COUNT(*) AS cnt FROM cs_messages WHERE session_id = ?", [
      sessionId,
    ]);
    return Number((result.rows[0] as Record<string, unknown> | undefined)?.cnt ?? 0);
  }
  const result = await query("SELECT COUNT(*) AS cnt FROM cs_messages WHERE session_id = $1", [
    sessionId,
  ]);
  return Number((result.rows[0] as Record<string, unknown> | undefined)?.cnt ?? 0);
}

// -- List by session (paginated, chronological) --

export async function listCSMessages(
  sessionId: string,
  opts?: { limit?: number; beforeId?: string },
): Promise<CSMessage[]> {
  const limit = opts?.limit ?? 50;

  if (getDbType() === DB_SQLITE) {
    if (opts?.beforeId) {
      const result = sqliteQuery(
        `SELECT * FROM cs_messages
         WHERE session_id = ? AND created_at < (SELECT created_at FROM cs_messages WHERE id = ?)
         ORDER BY created_at DESC LIMIT ?`,
        [sessionId, opts.beforeId, limit],
      );
      return result.rows.map(rowToMessage).toReversed();
    }
    const result = sqliteQuery(
      "SELECT * FROM cs_messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?",
      [sessionId, limit],
    );
    return result.rows.map(rowToMessage);
  }

  if (opts?.beforeId) {
    const result = await query(
      `SELECT * FROM cs_messages
       WHERE session_id = $1 AND created_at < (SELECT created_at FROM cs_messages WHERE id = $2)
       ORDER BY created_at DESC LIMIT $3`,
      [sessionId, opts.beforeId, limit],
    );
    return result.rows.map(rowToMessage).toReversed();
  }

  const result = await query(
    "SELECT * FROM cs_messages WHERE session_id = $1 ORDER BY created_at ASC LIMIT $2",
    [sessionId, limit],
  );
  return result.rows.map(rowToMessage);
}
