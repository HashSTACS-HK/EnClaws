/**
 * CS-API runtime endpoints — SSE messages + handoff/release/observer.
 *
 * CS-API 运行时端点：SSE 消息流、接管/释放/观察者消息。
 *
 * Endpoints:
 *   POST /{appId}/messages                          — SSE stream to AI
 *   POST /{appId}/sessions/{sessionId}/handoff-to-human
 *   POST /{appId}/sessions/{sessionId}/release-to-ai
 *   POST /{appId}/sessions/{sessionId}/messages/observer
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tryAppSecretAuth } from "../../auth/app-secret.js";
import {
  findOrCreateCsApiSession,
  appendCsApiMessage,
  setSessionState,
} from "../../db/models/cs-session.js";
import { loadTenantConfig } from "../../config/tenant-config.js";
import { runCSAgentReply } from "../../customer-service/rag/cs-agent-runner.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  HandoffInput,
  MarkNotifyingInput,
  ObserverInput,
  ReleaseInput,
  SendMessageInput,
} from "../protocol/schema/cs-api.js";
import { Value } from "@sinclair/typebox/value";
import { dbStateToCsApi } from "../../customer-service/state-mapping.js";
import { readJsonBody, sendError, sendJson } from "./http-helpers.js";
import { endSse, startSse, writeSseEvent } from "./sse.js";
import { extractConfidence } from "./confidence.js";

const log = createSubsystemLogger("cs-api-runtime");

// ── Handler: POST /{appId}/messages ─────────────────────────────────────────

/**
 * SSE streaming endpoint — sends customer message to AI and streams response.
 *
 * SSE 流式端点：将客户消息发送给 AI 并流式返回回复。
 */
export async function handleMessages(
  req: IncomingMessage,
  res: ServerResponse,
  appId: string,
): Promise<void> {
  // 1. Auth
  const authResult = await tryAppSecretAuth(req, appId);
  if (!authResult.ok) {
    sendError(res, 401, authResult.code, authResult.message);
    return;
  }
  const { tenantId, appObjectId, agentId } = authResult.tenant;

  // 2. Parse + validate body
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendError(res, 400, "INVALID_BODY", "Failed to parse request body");
    return;
  }
  if (!Value.Check(SendMessageInput, body)) {
    sendError(res, 400, "INVALID_INPUT", "Request body failed schema validation");
    return;
  }
  const input = body;

  // 3. Load tenant config (for runCSAgentReply — resolves agent/model from DB internally)
  const cfg = await loadTenantConfig(tenantId);

  // 4. Find or create session
  const session = await findOrCreateCsApiSession({
    tenantId,
    appObjectId,
    agentId,
    customerId: input.customerId,
    channelId: input.channelId,
    requestedSessionId: input.sessionId,
  });

  // 5. Append customer message to DB
  await appendCsApiMessage({
    sessionId: session.id,
    tenantId,
    role: "customer",
    source: "upper-app-relay",
    content: input.content,
    metadata: input.metadata,
  });

  // 6. Start SSE stream
  startSse(res);
  writeSseEvent(res, "session-start", { sessionId: session.id });

  // 7. Call runCSAgentReply — includes RAG (KB search) + CS system prompt.
  // Non-streaming: returns complete reply, then emits 1 chunk + done.
  // Jiumi is a backend relay to WeCom — true streaming has no UX value here.
  // runCSAgentReply 内部处理 RAG 和 CS prompt，返回完整回复后再发送 SSE 事件。
  let reply: string;
  try {
    const result = await runCSAgentReply({
      tenantId,
      sessionId: session.id,
      customerMessage: input.content,
      cfg,
    });
    reply = result.reply;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`cs-api messages agent error: appId=${appId} sessionId=${session.id} err=${msg}`);
    writeSseEvent(res, "error", { code: "AGENT_ERROR", message: msg });
    endSse(res);
    return;
  }

  // 8. Extract confidence, append AI message
  const { stripped, confidence } = extractConfidence(reply);
  try {
    await appendCsApiMessage({
      sessionId: session.id,
      tenantId,
      role: "ai",
      source: "agenora-ai",
      content: stripped,
      metadata: { confidence },
    });
  } catch (err) {
    log.warn(`cs-api: failed to persist AI message: ${String(err)}`);
  }

  // 9. Emit single chunk event with full stripped reply
  writeSseEvent(res, "chunk", { text: stripped });

  // 10. Emit done event
  // TODO: extend runCSAgentReply return type to expose model + usage (S3+ backlog)
  writeSseEvent(res, "done", {
    confidence,
    modelActuallyUsed: "unknown",
    finishReason: "stop",
    tokensUsed: { prompt: 0, completion: 0, total: 0 },
  });
  endSse(res);
}

// ── Handler: POST /{appId}/sessions/{sessionId}/handoff-to-human ─────────────

/**
 * Hand off a session to a human agent.
 *
 * 将会话移交给人工客服。
 */
export async function handleHandoff(
  req: IncomingMessage,
  res: ServerResponse,
  appId: string,
  sessionId: string,
): Promise<void> {
  const authResult = await tryAppSecretAuth(req, appId);
  if (!authResult.ok) {
    sendError(res, 401, authResult.code, authResult.message);
    return;
  }
  const { tenantId } = authResult.tenant;

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendError(res, 400, "INVALID_BODY", "Failed to parse request body");
    return;
  }
  if (!Value.Check(HandoffInput, body)) {
    sendError(res, 400, "INVALID_INPUT", "Request body failed schema validation");
    return;
  }
  const input = body;

  const session = await setSessionState({
    tenantId,
    sessionId,
    state: "human-handling",
    activeResponder: { type: "human", party: input.takenOverBy },
  });

  if (!session) {
    sendError(res, 404, "SESSION_NOT_FOUND", `Session not found: ${sessionId}`);
    return;
  }

  sendJson(res, 200, { session });
}

// ── Handler: POST /{appId}/sessions/{sessionId}/release-to-ai ───────────────

/**
 * Release a session back to AI handling.
 *
 * 将会话释放回 AI 处理。
 */
export async function handleRelease(
  req: IncomingMessage,
  res: ServerResponse,
  appId: string,
  sessionId: string,
): Promise<void> {
  const authResult = await tryAppSecretAuth(req, appId);
  if (!authResult.ok) {
    sendError(res, 401, authResult.code, authResult.message);
    return;
  }
  const { tenantId } = authResult.tenant;

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendError(res, 400, "INVALID_BODY", "Failed to parse request body");
    return;
  }
  if (!Value.Check(ReleaseInput, body)) {
    sendError(res, 400, "INVALID_INPUT", "Request body failed schema validation");
    return;
  }

  const session = await setSessionState({
    tenantId,
    sessionId,
    state: "ai-handling",
    activeResponder: null,
  });

  if (!session) {
    sendError(res, 404, "SESSION_NOT_FOUND", `Session not found: ${sessionId}`);
    return;
  }

  sendJson(res, 200, { session });
}

// ── Handler: POST /{appId}/sessions/{sessionId}/mark-notifying ───────────────

/**
 * Transition a session to the `notifying` state (v1.2 §F.2 4-value enum):
 * AI paused, awaiting human takeover. Response state is normalized via
 * `dbStateToCsApi` so jiumi always receives one of the cs-api 4 values.
 *
 * 将会话切到 notifying 状态（AI 暂停等待人工接管）。响应经 dbStateToCsApi
 * 归一化，对外永远是 cs-api 四值之一。
 */
export async function handleMarkNotifying(
  req: IncomingMessage,
  res: ServerResponse,
  appId: string,
  sessionId: string,
): Promise<void> {
  const authResult = await tryAppSecretAuth(req, appId);
  if (!authResult.ok) {
    sendError(res, 401, authResult.code, authResult.message);
    return;
  }
  const { tenantId } = authResult.tenant;

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendError(res, 400, "INVALID_BODY", "Failed to parse request body");
    return;
  }
  if (!Value.Check(MarkNotifyingInput, body)) {
    sendError(res, 400, "INVALID_INPUT", "Request body failed schema validation");
    return;
  }

  // notifying = AI paused, no human responder yet → activeResponder stays null.
  // notifying 状态尚无具体接管方，activeResponder 保持 null。
  const session = await setSessionState({
    tenantId,
    sessionId,
    state: "notifying",
    activeResponder: null,
  });

  if (!session) {
    sendError(res, 404, "SESSION_NOT_FOUND", `Session not found: ${sessionId}`);
    return;
  }

  // Option B mapping at the endpoint boundary — normalize raw DB state to cs-api enum.
  // 端点边界做映射：把 DB 原值规范化为 cs-api 四值枚举。
  const apiState = dbStateToCsApi(session.state);
  if (!apiState) {
    sendError(res, 500, "INVALID_DB_STATE", `Unknown session state: ${session.state}`);
    return;
  }

  sendJson(res, 200, { session: { ...session, state: apiState } });
}

// ── Handler: POST /{appId}/sessions/{sessionId}/messages/observer ────────────

/**
 * Append an observer message (from human-staff or relayed customer message).
 *
 * 追加观察者消息（人工客服或转发的客户消息）。
 */
export async function handleObserver(
  req: IncomingMessage,
  res: ServerResponse,
  appId: string,
  sessionId: string,
): Promise<void> {
  const authResult = await tryAppSecretAuth(req, appId);
  if (!authResult.ok) {
    sendError(res, 401, authResult.code, authResult.message);
    return;
  }
  const { tenantId } = authResult.tenant;

  // Verify session exists for this tenant
  const _runId = randomUUID(); // for future trace

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendError(res, 400, "INVALID_BODY", "Failed to parse request body");
    return;
  }
  if (!Value.Check(ObserverInput, body)) {
    sendError(res, 400, "INVALID_INPUT", "Request body failed schema validation");
    return;
  }
  const input = body;

  // Map ObserverInput.role to cs_messages role
  // "human-staff" → stored as "boss" (matches legacy CSMessageRole)
  // "customer" → stored as "customer"
  const dbRole = input.role === "human-staff" ? "boss" : "customer";

  let messageId: string;
  try {
    const result = await appendCsApiMessage({
      sessionId,
      tenantId,
      role: dbRole,
      source: "upper-app-relay",
      content: input.content,
      senderParty: input.senderParty,
      metadata: input.metadata,
    });
    messageId = result.id;
  } catch {
    sendError(res, 404, "SESSION_NOT_FOUND", `Session not found or inaccessible: ${sessionId}`);
    return;
  }

  sendJson(res, 201, { messageId });
}
