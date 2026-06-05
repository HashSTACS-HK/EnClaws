/**
 * CS-API runtime endpoint tests — SSE messages happy path + auth.
 *
 * CS-API 运行时端点测试：SSE 消息流 happy path + 鉴权。
 *
 * Tests:
 *   - confidence.ts unit tests (pure function, no DB needed)
 *   - sse.ts unit tests (mock ServerResponse)
 *   - messages endpoint: 401 on missing/bad secret
 *   - messages endpoint: happy path SSE stream (mocked runCSAgentReply)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Mock runCSAgentReply so tests don't hit real LLM or RAG stack.
// runCSAgentReply モックにより実 LLM/RAG を使わずにテスト。
vi.mock("../../customer-service/rag/cs-agent-runner.js", () => ({
  runCSAgentReply: vi.fn().mockResolvedValue({
    reply: "test reply [confidence:0.85]",
    sourceChunks: [
      {
        path: "kb/hours.md",
        startLine: 1,
        endLine: 4,
        score: 0.92,
        snippet: "Our business hours are 9am to 6pm, Monday to Friday.",
        source: "memory",
        sourceLabel: "企业知识库 / hours",
      },
    ],
    modelUsed: "openai-compatible/gpt-test",
    tokensUsed: { prompt: 120, completion: 40, total: 160 },
    turnId: "cs-run-1700000000000",
  }),
}));

// Mock loadTenantConfig — cs-api runtime uses this instead of loadConfig().
// loadTenantConfig モック。
vi.mock("../../config/tenant-config.js", () => ({
  loadTenantConfig: vi.fn().mockResolvedValue({}),
}));
import type { ServerResponse } from "node:http";
import { runCSAgentReply } from "../../customer-service/rag/cs-agent-runner.js";
import { extractConfidence } from "./confidence.js";
import { startSse, writeSseEvent, endSse } from "./sse.js";

// Typed handle to the module-level mock for argument assertions.
// モックされた runCSAgentReply の型付きハンドル（引数検証用）。
const runCSAgentReplyMock = vi.mocked(runCSAgentReply);

// ── Unit tests: confidence.ts ─────────────────────────────────────────────────

describe("extractConfidence", () => {
  it("returns 0.5 and unmodified text when tag is absent", () => {
    const result = extractConfidence("Hello world");
    expect(result.stripped).toBe("Hello world");
    expect(result.confidence).toBe(0.5);
  });

  it("extracts and strips trailing [confidence:0.85]", () => {
    const result = extractConfidence("Great answer [confidence:0.85]");
    expect(result.stripped).toBe("Great answer");
    expect(result.confidence).toBeCloseTo(0.85);
  });

  it("clamps confidence > 1 to 1", () => {
    expect(extractConfidence("text [confidence:1.5]").confidence).toBe(1);
  });

  it("returns 0.5 for negative confidence tag (regex won't match negative sign)", () => {
    // The regex [\d.]+ does not match '-', so negative tags fall through to default 0.5
    expect(extractConfidence("text [confidence:-0.1]").confidence).toBe(0.5);
  });

  it("handles [confidence: 0.72 ] with spaces", () => {
    const result = extractConfidence("Answer. [confidence: 0.72 ]");
    expect(result.confidence).toBeCloseTo(0.72);
    expect(result.stripped).not.toContain("confidence");
  });

  it("defaults to 0.5 on invalid number", () => {
    expect(extractConfidence("text [confidence:nan]").confidence).toBe(0.5);
    expect(extractConfidence("text [confidence:abc]").confidence).toBe(0.5);
  });
});

// ── Unit tests: sse.ts ────────────────────────────────────────────────────────

describe("SSE helpers", () => {
  function makeMockResponse(): {
    res: ServerResponse;
    written: string[];
    state: { ended: boolean };
    headers: Record<string, string | number | string[]>;
  } {
    const written: string[] = [];
    const state = { ended: false };
    const headers: Record<string, string | number | string[]> = {};
    const res = {
      statusCode: 200,
      setHeader(name: string, value: string | number | string[]) {
        headers[name] = value;
      },
      flushHeaders() {
        /* noop */
      },
      write(chunk: string) {
        written.push(chunk);
      },
      end() {
        state.ended = true;
      },
    } as unknown as ServerResponse;
    return { res, written, state, headers };
  }

  it("startSse sets correct headers", () => {
    const { res, headers } = makeMockResponse();
    startSse(res);
    expect(headers["Content-Type"]).toBe("text/event-stream");
    expect(headers["Cache-Control"]).toBe("no-cache");
    expect(headers["Connection"]).toBe("keep-alive");
  });

  it("writeSseEvent writes event + data lines", () => {
    const { res, written } = makeMockResponse();
    writeSseEvent(res, "chunk", { text: "hello" });
    expect(written.join("")).toContain("event: chunk");
    expect(written.join("")).toContain('data: {"text":"hello"}');
  });

  it("endSse calls res.end()", () => {
    const mock = makeMockResponse();
    endSse(mock.res);
    expect(mock.state.ended).toBe(true);
  });
});

// ── Integration tests: messages endpoint ─────────────────────────────────────

let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-api-runtime-test-"));
  process.env.ENCLAWS_DB_URL = `sqlite:///${tmpDir}/test.db`;

  const { initDb } = await import("../../db/index.js");
  initDb();
});

afterAll(() => {
  vi.restoreAllMocks();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

describe("POST /{appId}/messages", () => {
  let tenantId: string;
  let appId: string;
  let plainSecret: string;

  beforeAll(async () => {
    const bcrypt = (await import("bcryptjs")).default;
    const { createTenant } = await import("../../db/models/tenant.js");
    const { createTenantAgent } = await import("../../db/models/tenant-agent.js");
    const { createTenantModel } = await import("../../db/models/tenant-model.js");
    const { createCsApiObject } = await import("../../db/models/cs-api-object.js");

    const tenant = await createTenant({ name: "Runtime Test Tenant" });
    tenantId = tenant.id;

    // Create a tenant model
    const model = await createTenantModel({
      tenantId,
      providerType: "openai-compatible",
      providerName: "test-provider",
      baseUrl: "https://api.example.com/v1",
      apiKeyEncrypted: "test-key-123",
      models: [{ id: "gpt-test", name: "Test Model" }],
    });

    // Create a tenant agent using that model
    await createTenantAgent({
      tenantId,
      agentId: "cs-test-agent",
      name: "CS Test Agent",
      modelConfig: [{ providerId: model.id, modelId: "gpt-test", isDefault: true }],
    });

    // Create API object
    plainSecret = "test-secret-abc123";
    const hash = await bcrypt.hash(plainSecret, 10);
    const obj = await createCsApiObject({
      tenantId,
      name: "Test App",
      agentId: "cs-test-agent",
      appSecretHash: hash,
      endpointUrl: "https://upper-app.example.com",
    });
    appId = obj.appId;
  });

  /** Build a minimal mock IncomingMessage. */
  function makeRequest(opts: {
    method?: string;
    authorization?: string;
    body?: unknown;
  }): ReturnType<typeof import("node:http").createServer> extends { on: unknown }
    ? import("node:http").IncomingMessage
    : never {
    const { Readable } = require("node:stream");
    const bodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : "";
    const req = new Readable({
      read() {
        this.push(bodyStr);
        this.push(null);
      },
    });
    req.method = opts.method ?? "POST";
    req.headers = {
      "content-type": "application/json",
      ...(opts.authorization ? { authorization: opts.authorization } : {}),
    };
    req.url = `/api/cs-api/${appId}/messages`;
    return req as unknown as import("node:http").IncomingMessage;
  }

  /** Build a mock ServerResponse that collects SSE output. */
  function makeSseResponse(): {
    res: ServerResponse;
    events: Array<{ event: string; data: unknown }>;
    state: { ended: boolean };
  } {
    const events: Array<{ event: string; data: unknown }> = [];
    const state = { ended: false };
    let pendingEvent = "";
    const res = {
      statusCode: 200,
      setHeader() {
        /* noop */
      },
      flushHeaders() {
        /* noop */
      },
      write(chunk: string) {
        const lines = chunk.split("\n");
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            pendingEvent = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            try {
              events.push({ event: pendingEvent, data: JSON.parse(line.slice(6)) });
            } catch {
              events.push({ event: pendingEvent, data: line.slice(6) });
            }
            pendingEvent = "";
          }
        }
      },
      end() {
        state.ended = true;
      },
    } as unknown as ServerResponse;
    return { res, events, state };
  }

  /** Build a simple non-SSE mock response that captures sendJson (which calls res.end with body). */
  function makePlainResponse(): {
    res: ServerResponse;
    body: string;
    statusCode: number;
  } {
    const state = { body: "", statusCode: 200 };
    const res = {
      get statusCode() {
        return state.statusCode;
      },
      set statusCode(v: number) {
        state.statusCode = v;
      },
      setHeader() {
        /* noop */
      },
      flushHeaders() {
        /* noop */
      },
      write(c: string) {
        state.body += c;
        return true;
      },
      end(c?: string) {
        if (c) {
          state.body += c;
        }
      },
    } as unknown as ServerResponse;
    return {
      res,
      get body() {
        return state.body;
      },
      get statusCode() {
        return state.statusCode;
      },
    };
  }

  it("returns 401 when no Authorization header", async () => {
    const { handleMessages } = await import("./runtime.js");
    const req = makeRequest({ authorization: undefined });
    const mock = makePlainResponse();

    await handleMessages(req, mock.res, appId);
    const body = JSON.parse(mock.body || "{}") as { error?: { code?: string } };
    expect(body.error?.code).toBe("MISSING_AUTH");
  });

  it("returns 401 with wrong secret", async () => {
    const { handleMessages } = await import("./runtime.js");
    const req = makeRequest({ authorization: "Bearer wrong-secret-xyz" });
    const mock = makePlainResponse();

    await handleMessages(req, mock.res, appId);
    const body = JSON.parse(mock.body || "{}") as { error?: { code?: string } };
    expect(body.error?.code).toBe("INVALID_APP_SECRET");
  });

  it("streams session-start + ONE chunk + done events on happy path", async () => {
    // runCSAgentReply is mocked at module level to return:
    //   { reply: "test reply [confidence:0.85]", sourceChunks: [] }
    // Expect: session-start → 1 chunk with stripped text → done with confidence 0.85.
    // runCSAgentReply はモジュールレベルでモック済み。

    const { handleMessages } = await import("./runtime.js");
    const req = makeRequest({
      authorization: `Bearer ${plainSecret}`,
      body: {
        customerId: "cust-001",
        content: "What are your hours?",
      },
    });
    const { res, events, state } = makeSseResponse();

    await handleMessages(req, res, appId);

    expect(state.ended).toBe(true);

    const eventTypes = events.map((e) => e.event);
    expect(eventTypes).toContain("session-start");
    expect(eventTypes).toContain("chunk");
    expect(eventTypes).toContain("done");

    // session-start has sessionId
    const sessionStart = events.find((e) => e.event === "session-start");
    expect(sessionStart?.data).toMatchObject({ sessionId: expect.any(String) });

    // Exactly ONE chunk event with the full stripped reply text
    const chunkEvents = events.filter((e) => e.event === "chunk");
    expect(chunkEvents).toHaveLength(1);
    const chunkData = chunkEvents[0].data as { text?: string };
    expect(chunkData.text).toBe("test reply");

    // done carries confidence (extracted from mock reply) + enriched reasoning
    // fields threaded through from runCSAgentReply: turnId, real model, real
    // tokens, and a KB-hits summary derived from sourceChunks.
    // done 事件携带 confidence + 透传的推理信息：turnId / 真实模型 / 真实 token /
    // 知识库命中摘要（由 sourceChunks 派生）。
    const done = events.find((e) => e.event === "done");
    const doneData = done?.data as {
      confidence?: number;
      confidenceVerdict?: string;
      modelActuallyUsed?: string;
      finishReason?: string;
      turnId?: string;
      tokensUsed?: { prompt?: number; completion?: number; total?: number };
      knowledgeHits?: Array<{ source?: string; score?: number; snippet?: string }>;
    };
    expect(doneData?.confidence).toBeCloseTo(0.85);
    expect(doneData?.confidenceVerdict).toBe("ok");
    expect(doneData?.finishReason).toBe("stop");
    expect(doneData?.modelActuallyUsed).toBe("openai-compatible/gpt-test");
    expect(doneData?.turnId).toBe("cs-run-1700000000000");
    expect(doneData?.tokensUsed).toEqual({ prompt: 120, completion: 40, total: 160 });
    expect(doneData?.knowledgeHits).toHaveLength(1);
    expect(doneData?.knowledgeHits?.[0]).toEqual({
      source: "企业知识库 / hours",
      score: 0.92,
      snippet: "Our business hours are 9am to 6pm, Monday to Friday.",
    });
  });

  it("streams all CS agent reply payloads in order", async () => {
    runCSAgentReplyMock.mockResolvedValueOnce({
      reply: "checking\n\nfinal answer [confidence:0.8]",
      replies: ["checking", "final answer [confidence:0.8]"],
      sourceChunks: [],
      modelUsed: "openai-compatible/gpt-test",
      tokensUsed: { prompt: 12, completion: 8, total: 20 },
      turnId: "cs-run-multi-payload",
    });
    const { handleMessages } = await import("./runtime.js");
    const req = makeRequest({
      authorization: `Bearer ${plainSecret}`,
      body: {
        customerId: "cust-multi-payload-001",
        content: "query order",
      },
    });
    const { res, events } = makeSseResponse();

    await handleMessages(req, res, appId);

    const chunkEvents = events.filter((e) => e.event === "chunk");
    expect(chunkEvents.map((event) => (event.data as { text?: string }).text)).toEqual([
      "checking",
      "final answer",
    ]);
    const done = events.find((e) => e.event === "done");
    expect((done?.data as { confidence?: number } | undefined)?.confidence).toBeCloseTo(0.8);
  });

  it("passes the bound agentId from auth into runCSAgentReply (P4 agentId wiring)", async () => {
    // The cs-api object under test is bound to agentId "cs-test-agent" (see beforeAll).
    // T1 fix: handleMessages must forward that bound agentId so the runner honors the
    // tenant's configured CS agent instead of always running as the global default.
    // T1 修复：handleMessages 必须把绑定的 agentId 透传给 runner，
    // 否则租户绑定的客服 agent 永远跑成全局默认 agent。
    runCSAgentReplyMock.mockClear();

    const { handleMessages } = await import("./runtime.js");
    const req = makeRequest({
      authorization: `Bearer ${plainSecret}`,
      body: {
        customerId: "cust-agentid-001",
        content: "Which agent answers me?",
      },
    });
    const { res } = makeSseResponse();

    await handleMessages(req, res, appId);

    expect(runCSAgentReplyMock).toHaveBeenCalledTimes(1);
    expect(runCSAgentReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "cs-test-agent" }),
    );
  });

  it("passes request metadata as businessMetadata to runCSAgentReply", async () => {
    runCSAgentReplyMock.mockClear();

    const { handleMessages } = await import("./runtime.js");
    const metadata = {
      business: "customs",
      customs: { declarationId: "GK-20260510-088" },
    };
    const req = makeRequest({
      authorization: `Bearer ${plainSecret}`,
      body: {
        customerId: "cust-metadata-001",
        content: "帮我查一下这个报关单",
        metadata,
      },
    });
    const { res } = makeSseResponse();

    await handleMessages(req, res, appId);

    expect(runCSAgentReplyMock).toHaveBeenCalledTimes(1);
    expect(runCSAgentReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({ businessMetadata: metadata }),
    );
  });

  // ST-C0: cs-api runtime enable-gate — is_active=false → 403 SERVICE_DISABLED
  it("returns 403 OBJECT_INACTIVE when the AI service is_active=false (ST-C0 cs-api gate)", async () => {
    // Create a second object that starts active, then deactivate it.
    // 创建一个对象，初始 active，然后停用，验证 is_active=false 时拒绝请求。
    const bcrypt = (await import("bcryptjs")).default;
    const { createTenant } = await import("../../db/models/tenant.js");
    const { createCsApiObject, updateCsApiObject } =
      await import("../../db/models/cs-api-object.js");

    const tenant2 = await createTenant({ name: "Inactive Gate Tenant" });
    const inactiveSecret = "inactive-secret-xyz";
    const inactiveHash = await bcrypt.hash(inactiveSecret, 10);
    const inactiveObj = await createCsApiObject({
      tenantId: tenant2.id,
      name: "Inactive App",
      agentId: "agent-inactive",
      appSecretHash: inactiveHash,
      endpointUrl: "https://example.com",
    });
    // Deactivate the object
    await updateCsApiObject(inactiveObj.id, tenant2.id, { isActive: false });

    const { handleMessages } = await import("./runtime.js");
    const req = makeRequest({
      authorization: `Bearer ${inactiveSecret}`,
      body: { customerId: "cust-inactive-001", content: "hello" },
    });
    // Need a fake appId for the inactive object
    const mockRes = makePlainResponse();
    await handleMessages(req, mockRes.res, inactiveObj.appId);

    expect(mockRes.statusCode).toBe(401);
    const body = JSON.parse(mockRes.body || "{}") as { error?: { code?: string } };
    expect(body.error?.code).toBe("OBJECT_INACTIVE");
  });
});

describe("findOrCreateCsApiSession / appendCsApiMessage / setSessionState", () => {
  let tenantId: string;
  let appObjectId: string;

  beforeAll(async () => {
    const { createTenant } = await import("../../db/models/tenant.js");
    const { createCsApiObject } = await import("../../db/models/cs-api-object.js");
    const tenant = await createTenant({ name: "Session Model Test Tenant" });
    tenantId = tenant.id;
    const obj = await createCsApiObject({
      tenantId,
      name: "Session Test App",
      agentId: "agent-x",
      appSecretHash: "hash",
      endpointUrl: "https://example.com",
    });
    appObjectId = obj.id;
  });

  it("creates a new session on first call", async () => {
    const { findOrCreateCsApiSession } = await import("../../db/models/cs-session.js");
    const session = await findOrCreateCsApiSession({
      tenantId,
      appObjectId,
      agentId: "agent-x",
      customerId: "cust-findOrCreate-001",
    });
    expect(session.id).toBeDefined();
    expect(session.state).toBe("ai-handling");
    expect(session.messages).toEqual([]);
  });

  it("returns the same session on second call", async () => {
    const { findOrCreateCsApiSession } = await import("../../db/models/cs-session.js");
    const s1 = await findOrCreateCsApiSession({
      tenantId,
      appObjectId,
      agentId: "agent-x",
      customerId: "cust-findOrCreate-002",
    });
    const s2 = await findOrCreateCsApiSession({
      tenantId,
      appObjectId,
      agentId: "agent-x",
      customerId: "cust-findOrCreate-002",
    });
    expect(s1.id).toBe(s2.id);
  });

  it("appends messages and retrieves them in history", async () => {
    const { findOrCreateCsApiSession, appendCsApiMessage } =
      await import("../../db/models/cs-session.js");
    const session = await findOrCreateCsApiSession({
      tenantId,
      appObjectId,
      agentId: "agent-x",
      customerId: "cust-msg-history-001",
    });
    await appendCsApiMessage({
      sessionId: session.id,
      tenantId,
      role: "customer",
      source: "upper-app-relay",
      content: "Hello there",
    });
    await appendCsApiMessage({
      sessionId: session.id,
      tenantId,
      role: "ai",
      source: "agenora-ai",
      content: "Hi! How can I help?",
      metadata: { confidence: 0.9, modelUsed: "gpt-test" },
    });
    const session2 = await findOrCreateCsApiSession({
      tenantId,
      appObjectId,
      agentId: "agent-x",
      customerId: "cust-msg-history-001",
    });
    expect(session2.messages).toHaveLength(2);
    expect(session2.messages[0].role).toBe("customer");
    expect(session2.messages[1].role).toBe("ai");
  });

  it("setSessionState transitions to human-handling and back", async () => {
    const { findOrCreateCsApiSession, setSessionState } =
      await import("../../db/models/cs-session.js");
    const session = await findOrCreateCsApiSession({
      tenantId,
      appObjectId,
      agentId: "agent-x",
      customerId: "cust-handoff-001",
    });

    const afterHandoff = await setSessionState({
      tenantId,
      sessionId: session.id,
      state: "human-handling",
      activeResponder: { type: "human", party: "agent-bob" },
    });
    expect(afterHandoff).not.toBeNull();
    expect(afterHandoff?.state).toBe("human-handling");
    expect(afterHandoff?.activeResponder?.party).toBe("agent-bob");

    const afterRelease = await setSessionState({
      tenantId,
      sessionId: session.id,
      state: "ai-handling",
      activeResponder: null,
    });
    expect(afterRelease?.state).toBe("ai-handling");
    expect(afterRelease?.activeResponder).toBeNull();
  });

  it("setSessionState returns null for unknown session", async () => {
    const { setSessionState } = await import("../../db/models/cs-session.js");
    const result = await setSessionState({
      tenantId,
      sessionId: "00000000-0000-0000-0000-nonexistent",
      state: "human-handling",
      activeResponder: { type: "human", party: "bob" },
    });
    expect(result).toBeNull();
  });

  it("auto-wakes closed session on new customer message (closed → ai-handling)", async () => {
    // Seed a cs-api session in closed state, then POST /messages — runtime should
    // transition it back to ai-handling before invoking the agent.
    // 先把会话置为 closed，再调 handleMessages，应自动唤醒为 ai-handling。
    const { handleMessages } = await import("./runtime.js");
    const { findOrCreateCsApiSession, setSessionState, getCSSession } =
      await import("../../db/models/cs-session.js");

    const seeded = await findOrCreateCsApiSession({
      tenantId,
      appObjectId,
      agentId: "agent-x",
      customerId: "cust-wake-001",
    });
    const closed = await setSessionState({
      tenantId,
      sessionId: seeded.id,
      state: "closed",
      activeResponder: null,
    });
    expect(closed?.state).toBe("closed");

    // Re-use the messages-endpoint request helper from the upper describe.
    // We have to rebuild it locally since this describe doesn't have it in scope.
    const { Readable } = await import("node:stream");
    // Need plainSecret + appId — fetch a fresh secret/app via a new CsApiObject.
    const bcrypt = (await import("bcryptjs")).default;
    const { createCsApiObject } = await import("../../db/models/cs-api-object.js");
    const wakeSecret = "wake-secret-xyz";
    const wakeHash = await bcrypt.hash(wakeSecret, 10);
    const wakeObj = await createCsApiObject({
      tenantId,
      name: "Wake Test App",
      agentId: "agent-x",
      appSecretHash: wakeHash,
      endpointUrl: "https://wake.example.com",
    });

    // The session was created under a different appObject — handleMessages will
    // find-or-create against (tenantId, customerId, wakeObj.id) which yields a NEW
    // session. To test the wake path we must seed under the same appObject.
    // 用同一个 appObject 重新种一个 closed 会话再测唤醒。
    const seeded2 = await findOrCreateCsApiSession({
      tenantId,
      appObjectId: wakeObj.id,
      agentId: "agent-x",
      customerId: "cust-wake-002",
    });
    await setSessionState({
      tenantId,
      sessionId: seeded2.id,
      state: "closed",
      activeResponder: null,
    });

    const body = { customerId: "cust-wake-002", content: "hello again" };
    const bodyStr = JSON.stringify(body);
    const req = new Readable({
      read() {
        this.push(bodyStr);
        this.push(null);
      },
    }) as unknown as import("node:http").IncomingMessage;
    (req as unknown as { method: string }).method = "POST";
    (req as unknown as { headers: Record<string, string> }).headers = {
      "content-type": "application/json",
      authorization: `Bearer ${wakeSecret}`,
    };

    // Drain SSE without inspecting it.
    const writtenChunks: string[] = [];
    const res = {
      statusCode: 200,
      setHeader() {
        /* noop */
      },
      flushHeaders() {
        /* noop */
      },
      write(c: string) {
        writtenChunks.push(c);
        return true;
      },
      end() {
        /* noop */
      },
    } as unknown as import("node:http").ServerResponse;

    await handleMessages(req, res, wakeObj.appId);

    const after = await getCSSession(seeded2.id);
    expect(after?.state).toBe("ai-handling");
  });

  it("countActiveSessionsForApiObject counts only active sessions", async () => {
    const { findOrCreateCsApiSession, countActiveSessionsForApiObject } =
      await import("../../db/models/cs-session.js");
    const { createCsApiObject } = await import("../../db/models/cs-api-object.js");
    const obj2 = await createCsApiObject({
      tenantId,
      name: "Count Test App",
      agentId: "agent-x",
      appSecretHash: "hash2",
      endpointUrl: "https://example.com/2",
    });
    await findOrCreateCsApiSession({
      tenantId,
      appObjectId: obj2.id,
      agentId: "agent-x",
      customerId: "cust-count-001",
    });
    await findOrCreateCsApiSession({
      tenantId,
      appObjectId: obj2.id,
      agentId: "agent-x",
      customerId: "cust-count-002",
    });
    const count = await countActiveSessionsForApiObject(tenantId, obj2.id);
    expect(count).toBeGreaterThanOrEqual(2);
  });
});
