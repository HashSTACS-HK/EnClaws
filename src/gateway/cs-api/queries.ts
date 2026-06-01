/**
 * CS-API query endpoints (§11.6) — sessions list / single / transcript.
 *
 * CS-API 查询端点（§11.6）：会话列表、单条会话元数据、消息流水。
 *
 * Endpoints:
 *   GET /{appId}/sessions                          — list with cursor pagination
 *   GET /{appId}/sessions/{sessionId}              — single session metadata
 *   GET /{appId}/sessions/{sessionId}/transcript   — messages with cursor pagination
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { Value } from "@sinclair/typebox/value";
import { tryAppSecretAuth } from "../../auth/app-secret.js";
import {
  listCsApiSessions,
  getCsApiSessionMetadata,
  listCsApiTranscript,
} from "../../db/models/cs-session.js";
import { ListSessionsQuery, TranscriptQuery } from "../protocol/schema/cs-api.js";
import { ErrorCodes } from "../protocol/schema/error-codes.js";
import { sendJson, sendError } from "./http-helpers.js";

// ── Handler: GET /{appId}/sessions ────────────────────────────────────────────

/**
 * List CS-API sessions with cursor pagination.
 * Supports optional filters: state, customerId, updatedAfter.
 *
 * 分页列出 CS-API 会话，支持 state / customerId / updatedAfter 过滤。
 */
export async function handleListSessions(
  req: IncomingMessage,
  res: ServerResponse,
  appId: string,
): Promise<void> {
  const auth = await tryAppSecretAuth(req, appId);
  if (!auth.ok) {
    sendError(res, 401, auth.code, auth.message);
    return;
  }

  const url = new URL(req.url ?? "", "http://_");
  const params = Object.fromEntries(url.searchParams.entries());

  // Parse limit from string → number (TypeBox validates range)
  const limitRaw = params.limit !== undefined ? Number(params.limit) : undefined;
  const parsed = {
    cursor: params.cursor,
    limit: limitRaw,
    state: params.state as "ai-handling" | "notifying" | "human-handling" | "closed" | undefined,
    customerId: params.customerId,
    updatedAfter: params.updatedAfter,
  };

  // Strip undefined keys so TypeBox optional checks work correctly
  const clean = Object.fromEntries(Object.entries(parsed).filter(([, v]) => v !== undefined));

  if (!Value.Check(ListSessionsQuery, clean)) {
    sendError(res, 400, ErrorCodes.INVALID_REQUEST, "Invalid query parameters");
    return;
  }

  const result = await listCsApiSessions({
    tenantId: auth.tenant.tenantId,
    appObjectId: auth.tenant.appObjectId,
    cursor: clean.cursor,
    limit: clean.limit,
    state: clean.state,
    customerId: clean.customerId,
    updatedAfter: clean.updatedAfter,
  });

  sendJson(res, 200, result);
}

// ── Handler: GET /{appId}/sessions/{sessionId} ────────────────────────────────

/**
 * Get a single CS-API session's metadata. No messages[] array in response.
 *
 * 获取单条 CS-API 会话元数据，响应中不含 messages 数组。
 */
export async function handleGetSession(
  req: IncomingMessage,
  res: ServerResponse,
  appId: string,
  sessionId: string,
): Promise<void> {
  const auth = await tryAppSecretAuth(req, appId);
  if (!auth.ok) {
    sendError(res, 401, auth.code, auth.message);
    return;
  }

  const session = await getCsApiSessionMetadata({
    tenantId: auth.tenant.tenantId,
    appObjectId: auth.tenant.appObjectId,
    sessionId,
  });

  if (!session) {
    sendError(res, 404, "SESSION_NOT_FOUND", "Session not found");
    return;
  }

  sendJson(res, 200, { session });
}

// ── Handler: GET /{appId}/sessions/{sessionId}/transcript ─────────────────────

/**
 * Get paginated message transcript for a session.
 * direction="before" (default) → older messages (for initial load + scroll-up)
 * direction="after" → newer messages
 *
 * 分页获取会话消息流水。before（默认）= 向历史翻页，after = 向新消息翻页。
 */
export async function handleTranscript(
  req: IncomingMessage,
  res: ServerResponse,
  appId: string,
  sessionId: string,
): Promise<void> {
  const auth = await tryAppSecretAuth(req, appId);
  if (!auth.ok) {
    sendError(res, 401, auth.code, auth.message);
    return;
  }

  const url = new URL(req.url ?? "", "http://_");
  const params = Object.fromEntries(url.searchParams.entries());

  const limitRaw = params.limit !== undefined ? Number(params.limit) : undefined;
  const parsed = {
    cursor: params.cursor,
    limit: limitRaw,
    direction: (params.direction as "before" | "after" | undefined) ?? "before",
  };

  const clean = Object.fromEntries(Object.entries(parsed).filter(([, v]) => v !== undefined));

  if (!Value.Check(TranscriptQuery, clean)) {
    sendError(res, 400, ErrorCodes.INVALID_REQUEST, "Invalid query parameters");
    return;
  }

  const result = await listCsApiTranscript({
    tenantId: auth.tenant.tenantId,
    appObjectId: auth.tenant.appObjectId,
    sessionId,
    cursor: clean.cursor,
    limit: clean.limit,
    direction: clean.direction,
  });

  // Treat empty response (session not found / not owned) as 404
  if (result.messages.length === 0 && result.nextCursor === null) {
    // Verify session exists to give proper 404 vs empty transcript
    const session = await getCsApiSessionMetadata({
      tenantId: auth.tenant.tenantId,
      appObjectId: auth.tenant.appObjectId,
      sessionId,
    });
    if (!session) {
      sendError(res, 404, "SESSION_NOT_FOUND", "Session not found");
      return;
    }
  }

  sendJson(res, 200, result);
}
