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
import { getTenantAgent } from "../../db/models/tenant-agent.js";
import { getTenantModel } from "../../db/models/tenant-model.js";
import {
  findOrCreateCsApiSession,
  appendCsApiMessage,
  setSessionState,
} from "../../db/models/cs-session.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  HandoffInput,
  ObserverInput,
  ReleaseInput,
  SendMessageInput,
} from "../protocol/schema/cs-api.js";
import { Value } from "@sinclair/typebox/value";
import { readJsonBody, sendError, sendJson } from "./http-helpers.js";
import { endSse, startSse, writeSseEvent } from "./sse.js";
import { extractConfidence } from "./confidence.js";

const log = createSubsystemLogger("cs-api-runtime");

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Stream text from an LLM via SSE, accumulating the full response. */
async function streamLlmResponse(params: {
  baseUrl: string;
  apiKey: string | null;
  extraHeaders: Record<string, string>;
  modelId: string;
  messages: Array<{ role: string; content: string }>;
  res: ServerResponse;
}): Promise<{
  buffered: string;
  modelUsed: string;
  finishReason: string;
  tokensUsed: number;
}> {
  const { baseUrl, apiKey, extraHeaders, modelId, messages, res } = params;
  const llmUrl = `${baseUrl}/chat/completions`;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) { headers["Authorization"] = `Bearer ${apiKey}`; }
  Object.assign(headers, extraHeaders);

  const fetchRes = await fetch(llmUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: modelId, messages, stream: true }),
  });

  if (!fetchRes.ok || !fetchRes.body) {
    const errText = await fetchRes.text().catch(() => "unknown");
    throw new Error(`LLM request failed: ${fetchRes.status} ${errText.slice(0, 200)}`);
  }

  let buffered = "";
  let finishReason = "stop";
  let completionTokens = 0;
  let promptTokens = 0;

  // Read streaming SSE from the LLM provider
  const reader = fetchRes.body.getReader();
  const decoder = new TextDecoder();
  let partial = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) { break; }
    partial += decoder.decode(value, { stream: true });

    // Process complete SSE lines
    const lines = partial.split("\n");
    partial = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) { continue; }
      const dataStr = line.slice(6).trim();
      if (dataStr === "[DONE]") { continue; }
      try {
        const chunk = JSON.parse(dataStr) as Record<string, unknown>;
        const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
        const delta = (choices?.[0]?.delta as Record<string, unknown> | undefined);
        const text = delta?.content as string | undefined;
        if (text) {
          buffered += text;
          writeSseEvent(res, "chunk", { text });
        }
        const fr = choices?.[0]?.finish_reason as string | undefined;
        if (fr) { finishReason = fr; }
        // Accumulate usage if present
        const usage = chunk.usage as Record<string, number> | undefined;
        if (usage) {
          completionTokens += usage.completion_tokens ?? 0;
          promptTokens += usage.prompt_tokens ?? 0;
        }
      } catch {
        // Skip malformed chunks
      }
    }
  }

  return {
    buffered,
    modelUsed: modelId,
    finishReason,
    tokensUsed: promptTokens + completionTokens,
  };
}

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

  // 3. Load agent + model config
  const agent = await getTenantAgent(tenantId, agentId);
  if (!agent) {
    sendError(res, 404, "AGENT_NOT_FOUND", `Agent not found: ${agentId}`);
    return;
  }
  const defaultModel = agent.modelConfig?.find((m) => m.isDefault);
  if (!defaultModel) {
    sendError(res, 404, "MODEL_NOT_CONFIGURED", "No default model configured for agent");
    return;
  }
  const tenantModel = await getTenantModel(tenantId, defaultModel.providerId);
  if (!tenantModel || !tenantModel.baseUrl) {
    sendError(res, 404, "MODEL_NOT_FOUND", "Tenant model provider not found or missing baseUrl");
    return;
  }

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

  // 6. Build message history for LLM (existing + new customer message)
  const llmMessages: Array<{ role: string; content: string }> = [
    ...session.messages.map((m) => ({
      role: m.role === "ai" ? "assistant" : m.role === "customer" ? "user" : m.role,
      content: m.content,
    })),
    { role: "user", content: input.content },
  ];

  // 7. Start SSE stream
  startSse(res);
  writeSseEvent(res, "session-start", { sessionId: session.id });

  // 8. Call LLM with streaming
  let buffered = "";
  let modelUsed = defaultModel.modelId;
  let finishReason = "stop";
  let tokensUsed = 0;

  try {
    const result = await streamLlmResponse({
      baseUrl: tenantModel.baseUrl.replace(/\/+$/, ""),
      apiKey: tenantModel.apiKeyEncrypted ?? null,
      extraHeaders: tenantModel.extraHeaders ?? {},
      modelId: defaultModel.modelId,
      messages: llmMessages,
      res,
    });
    buffered = result.buffered;
    modelUsed = result.modelUsed;
    finishReason = result.finishReason;
    tokensUsed = result.tokensUsed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`cs-api messages LLM error: appId=${appId} sessionId=${session.id} err=${msg}`);
    writeSseEvent(res, "error", { code: "LLM_ERROR", message: msg });
    endSse(res);
    return;
  }

  // 9. Extract confidence, append AI message
  const { stripped, confidence } = extractConfidence(buffered);
  try {
    await appendCsApiMessage({
      sessionId: session.id,
      tenantId,
      role: "ai",
      source: "agenora-ai",
      content: stripped,
      metadata: { confidence, modelUsed },
    });
  } catch (err) {
    log.warn(`cs-api: failed to persist AI message: ${String(err)}`);
  }

  // 10. Emit done event
  writeSseEvent(res, "done", {
    confidence,
    modelActuallyUsed: modelUsed,
    finishReason,
    tokensUsed,
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
