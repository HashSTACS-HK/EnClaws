/**
 * CS-API runtime endpoints — SSE messages + handoff/release/observer + reasoning.
 *
 * CS-API 运行时端点：SSE 消息流、接管/释放/观察者消息、推理摘要。
 *
 * Endpoints:
 *   POST /{appId}/messages                                              — SSE stream to AI
 *   POST /{appId}/sessions/{sessionId}/handoff-to-human
 *   POST /{appId}/sessions/{sessionId}/release-to-ai
 *   POST /{appId}/sessions/{sessionId}/messages/observer
 *   GET  /{appId}/sessions/{sessionId}/messages/{messageId}/reasoning  — LLM reasoning (P7-B2)
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Value } from "@sinclair/typebox/value";
import { tryAppSecretAuth } from "../../auth/app-secret.js";
import { loadTenantConfig } from "../../config/tenant-config.js";
import type { CSAgentReplyResult } from "../../customer-service/rag/cs-agent-runner.js";
import { runCSAgentReply } from "../../customer-service/rag/cs-agent-runner.js";
import { summarizeKnowledgeHits } from "../../customer-service/rag/cs-knowledge-summary.js";
import { dbStateToCsApi } from "../../customer-service/state-mapping.js";
import { getCsApiObjectById } from "../../db/models/cs-api-object.js";
import { getCSMessage } from "../../db/models/cs-message.js";
import {
  findOrCreateCsApiSession,
  appendCsApiMessage,
  deleteCSSessionIfNoMessages,
  setSessionState,
} from "../../db/models/cs-session.js";
import { getInteractionsByTurn } from "../../db/models/interaction-trace.js";
import { getTenantAgent } from "../../db/models/tenant-agent.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  HandoffInput,
  MarkNotifyingInput,
  ObserverInput,
  ReleaseInput,
  SendMessageInput,
} from "../protocol/schema/cs-api.js";
import { confidenceToVerdict } from "./confidence-verdict.js";
import { extractConfidence } from "./confidence.js";
import { readJsonBody, sendError, sendJson } from "./http-helpers.js";
import { buildReasoningFromTraces } from "./reasoning-builder.js";
import { endSse, startSse, writeSseEvent } from "./sse.js";

const log = createSubsystemLogger("cs-api-runtime");

// Max knowledge-base hits surfaced in the SSE done event's reasoning summary.
// Mirrors the runner's CS_KNOWLEDGE_MAX_RESULTS cap; an explicit guard so the
// done payload stays bounded even if sourceChunks grows upstream.
// done 事件推理摘要中最多回传的知识库命中数（与 runner 的检索上限对齐，独立兜底）。
const DONE_EVENT_MAX_KB_HITS = 5;

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

  // 4b. Implicit wake: if the session was previously auto-closed (300s idle
  // cron) and a customer reaches out again, transition back to ai-handling
  // before appending the new message. Per v1.2 §F state machine (Task 7),
  // closed → ai-handling is automatic on new customer activity.
  // 隐式唤醒：若会话曾被 300s cron 自动关闭，客户再次发消息时自动唤醒。
  if (session.state === "closed") {
    await setSessionState({
      tenantId,
      sessionId: session.id,
      state: "ai-handling",
      activeResponder: null,
    });
    session.state = "ai-handling";
  }

  // 5. Append customer message to DB
  try {
    await appendCsApiMessage({
      sessionId: session.id,
      tenantId,
      role: "customer",
      source: "upper-app-relay",
      content: input.content,
      metadata: input.metadata,
    });
  } catch (err) {
    if (session.isNew) {
      await deleteCSSessionIfNoMessages(session.id).catch((cleanupErr) => {
        log.warn(`cs-api: failed to clean empty session ${session.id}: ${String(cleanupErr)}`);
      });
    }
    const msg = err instanceof Error ? err.message : String(err);
    log.error(
      `cs-api messages persist customer error: appId=${appId} sessionId=${session.id} err=${msg}`,
    );
    sendError(res, 500, "MESSAGE_PERSIST_FAILED", "Failed to persist customer message");
    return;
  }

  // 6. Start SSE stream
  startSse(res);
  writeSseEvent(res, "session-start", { sessionId: session.id });

  // 7. Call runCSAgentReply — includes RAG (KB search) + CS system prompt.
  // Non-streaming: returns complete reply, then emits 1 chunk + done.
  // Jiumi is a backend relay to WeCom — true streaming has no UX value here.
  // runCSAgentReply 内部处理 RAG 和 CS prompt，返回完整回复后再发送 SSE 事件。
  let reply: string;
  let agentResult: CSAgentReplyResult;
  try {
    agentResult = await runCSAgentReply({
      tenantId,
      sessionId: session.id,
      customerMessage: input.content,
      cfg,
      businessMetadata: input.metadata,
      // Honor the agent bound to this cs-api object (resolved from auth, tenant-scoped)
      // instead of falling back to the global default agent.
      // 使用绑定到该 cs-api 对象的 agent（从鉴权解析，租户作用域），而非全局默认。
      agentId,
    });
    reply = agentResult.reply;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`cs-api messages agent error: appId=${appId} sessionId=${session.id} err=${msg}`);
    writeSseEvent(res, "error", { code: "AGENT_ERROR", message: msg });
    endSse(res);
    return;
  }

  // 8. Extract confidence + knowledge hits, append AI message (P7-B1/P8:
  // persist turnId and the per-message reasoning fields used by REST reasoning).
  // 提取置信度和知识命中，追加 AI 消息（P7-B1/P8：持久化 turnId 以及
  // REST reasoning 端点需要的单消息推理字段）。
  const { stripped, confidence } = extractConfidence(reply);
  const confidenceVerdict = confidenceToVerdict(confidence);
  const knowledgeHits = summarizeKnowledgeHits(agentResult.sourceChunks, DONE_EVENT_MAX_KB_HITS);
  try {
    await appendCsApiMessage({
      sessionId: session.id,
      tenantId,
      role: "ai",
      source: "agenora-ai",
      content: stripped,
      confidence,
      sourceChunks: knowledgeHits,
      turnId: agentResult.turnId,
    });
  } catch (err) {
    log.warn(`cs-api: failed to persist AI message: ${String(err)}`);
  }

  // 9. Emit single chunk event with full stripped reply
  writeSseEvent(res, "chunk", { text: stripped });

  // 10. Emit done event — enriched reasoning trace for the upper app (P4 step1):
  // real turnId + model (incl. fallback) + token usage + KB-hits summary.
  // `confidence` and `finishReason` are preserved. Fields the runner could not
  // resolve degrade gracefully (model "unknown", zeroed tokens) rather than fake.
  // 10. 发送 done 事件 — 给上层应用的推理依据（P4 step1）：真实 turnId / 模型
  // （含 fallback）/ token 用量 / 知识库命中摘要。confidence 与 finishReason 保留。
  // runner 无法解析的字段优雅降级（model "unknown"、token 归零），不伪造。
  writeSseEvent(res, "done", {
    confidence,
    confidenceVerdict,
    turnId: agentResult.turnId,
    modelActuallyUsed: agentResult.modelUsed ?? "unknown",
    finishReason: "stop",
    tokensUsed: agentResult.tokensUsed ?? { prompt: 0, completion: 0, total: 0 },
    knowledgeHits,
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

// ── Handler: GET /{appId} ────────────────────────────────────────────────────

/**
 * Return the readable identity of the AI service behind an appId:
 *   { appId, name, agentName }
 * where `name` is the cs-api object's service name and `agentName` is the
 * associated agent's display name (falling back to the raw agentId when the
 * agent has no display name / no tenant_agents row). jiumi (需求3) uses this
 * to render the ticket creator as "XX（AI员工）".
 *
 * 返回 appId 背后 AI 服务的可读身份：服务名 + 关联 AI 员工可读名
 * （无显示名时回退 agentId）。供 jiumi 在工单"创建人"处显示"XX（AI员工）"。
 */
export async function handleGetObject(
  req: IncomingMessage,
  res: ServerResponse,
  appId: string,
): Promise<void> {
  const authResult = await tryAppSecretAuth(req, appId);
  if (!authResult.ok) {
    sendError(res, 401, authResult.code, authResult.message);
    return;
  }
  const { tenantId, appObjectId, agentId } = authResult.tenant;

  // Re-fetch tenant-scoped to read the service name (auth context carries ids only).
  // 按 tenant 作用域回读服务名（鉴权上下文只带 id，不带 name）。
  const obj = await getCsApiObjectById(appObjectId, tenantId);
  if (!obj) {
    sendError(res, 404, "OBJECT_NOT_FOUND", `API Object not found: ${appId}`);
    return;
  }

  // Resolve agent display name; fall back to agentId when missing.
  // 解析 AI 员工可读名，缺失则回退 agentId。
  const agent = await getTenantAgent(tenantId, agentId);
  const agentName = agent?.name ?? agentId;

  sendJson(res, 200, { appId, name: obj.name, agentName });
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

// ── Handler: GET /{appId}/sessions/{sessionId}/messages/{messageId}/reasoning ─

/**
 * Return the LLM reasoning behind a single AI message (P7-B2).
 *
 * Reads the message's turn_id, fetches the corresponding llm_interaction_traces,
 * and returns a structured reasoning summary: KB hits + tool calls + model +
 * tokens + confidence.
 *
 * Returns { reasoning: null } for messages with no turn_id (customer/human/
 * legacy messages that were not produced by an LLM call).
 *
 * 返回单条 AI 消息背后的 LLM 推理摘要（P7-B2）。
 * 读取消息的 turn_id → 查询 llm_interaction_traces → 返回结构化推理依据。
 * turn_id 为 null 的消息（客户/人工/历史消息）返回 { reasoning: null }。
 */
export async function handleReasoning(
  req: IncomingMessage,
  res: ServerResponse,
  appId: string,
  sessionId: string,
  messageId: string,
): Promise<void> {
  // 1. Auth — appSecret required (same pattern as all cs-api runtime endpoints).
  // 1. 鉴权：所有 cs-api runtime 端点统一要求 appSecret。
  const authResult = await tryAppSecretAuth(req, appId);
  if (!authResult.ok) {
    sendError(res, 401, authResult.code, authResult.message);
    return;
  }
  const { tenantId } = authResult.tenant;

  // 2. Load message — then verify tenant + session ownership.
  // 2. 加载消息，校验 tenant + session 归属。
  const message = await getCSMessage(messageId);
  if (!message || message.tenantId !== tenantId || message.sessionId !== sessionId) {
    sendError(res, 404, "SESSION_OR_MESSAGE_NOT_FOUND", `Message not found: ${messageId}`);
    return;
  }

  // 3. No turn_id → human/legacy message, no LLM trace.
  // 3. 无 turn_id → 客户/人工/历史消息，无 LLM 轨迹，直接返回 null。
  if (!message.turnId) {
    sendJson(res, 200, { reasoning: null });
    return;
  }

  // 4. Fetch traces by turn_id and verify tenant ownership.
  // 4. 按 turn_id 查询 trace，校验 tenant 归属。
  const traces = await getInteractionsByTurn(message.turnId);
  // Tenant guard: turn_id is global (not namespaced by tenant in the query),
  // so we verify the first trace's tenantId matches the authenticated tenant.
  // turn_id 在 DB 查询层不含 tenant 过滤，在此处做二次校验。
  const tenantTraces = traces.filter((t) => t.tenantId === tenantId);

  // 5. Build and return reasoning struct.
  // 5. 构建并返回推理摘要。
  const reasoning = buildReasoningFromTraces(
    tenantTraces,
    message.confidence,
    message.sourceChunks ?? [],
  );
  sendJson(res, 200, { reasoning });
}
