/**
 * CS-API runtime endpoint test — GET /{appId}/sessions/{sessionId}/messages/{messageId}/reasoning.
 *
 * Returns LLM reasoning for one AI message: turn_id → llm_interaction_traces →
 * tool calls + model + tokens + confidence.
 *
 * Tests:
 *   - 200 with turn_id + trace containing tool_use block → toolCalls populated
 *   - 200 with null turn_id → { reasoning: null } (human/legacy message)
 *   - 200 confidence flows from cs_message.confidence field
 *   - 404 when message not found (or wrong session/tenant)
 *   - 401 when Authorization header missing
 *   - 401 when secret is wrong
 *
 * GET /{appId}/sessions/{sessionId}/messages/{messageId}/reasoning 端点：
 * 根据消息 turn_id 查询 LLM 推理轨迹，返回工具调用、模型、token、置信度。
 */

import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-api-reasoning-test-"));
  process.env.ENCLAWS_DB_URL = `sqlite:///${tmpDir}/test.db`;

  const { initDb } = await import("../../db/index.js");
  initDb();
});

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

// ── Shared test helpers ──────────────────────────────────────────────────────

function makeRequest(opts: { method?: string; authorization?: string }): IncomingMessage {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Readable } = require("node:stream");
  const req = new Readable({
    read() {
      this.push(null);
    },
  });
  req.method = opts.method ?? "GET";
  req.headers = opts.authorization ? { authorization: opts.authorization } : {};
  return req as unknown as IncomingMessage;
}

function makePlainResponse(): {
  res: ServerResponse;
  readonly body: string;
  readonly statusCode: number;
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

// ── Test Suite ───────────────────────────────────────────────────────────────

describe("GET /{appId}/sessions/{sessionId}/messages/{messageId}/reasoning", () => {
  let tenantId: string;
  let appId: string;
  let appObjectId: string;
  let agentId: string;
  let plainSecret: string;

  beforeAll(async () => {
    const bcrypt = (await import("bcryptjs")).default;
    const { createTenant } = await import("../../db/models/tenant.js");
    const { createCsApiObject } = await import("../../db/models/cs-api-object.js");

    const tenant = await createTenant({ name: "Reasoning Test Tenant" });
    tenantId = tenant.id;
    agentId = "cs-reasoning-agent";

    plainSecret = "test-reasoning-secret-xyz";
    const hash = await bcrypt.hash(plainSecret, 10);
    const obj = await createCsApiObject({
      tenantId,
      name: "Reasoning Test App",
      agentId,
      appSecretHash: hash,
      endpointUrl: "https://upper-app.example.com",
    });
    appId = obj.appId;
    appObjectId = obj.id;
  });

  it("returns reasoning with toolCalls when turn_id is set and trace has tool_use block", async () => {
    const { handleReasoning } = await import("./runtime.js");
    const { findOrCreateCsApiSession, appendCsApiMessage } =
      await import("../../db/models/cs-session.js");
    const { createInteractionTrace } = await import("../../db/models/interaction-trace.js");

    // Seed: session → AI message with turnId → trace with tool_use
    const session = await findOrCreateCsApiSession({
      tenantId,
      appObjectId,
      agentId,
      customerId: "cust-reasoning-001",
    });

    const turnId = `cs-run-test-tool-${Date.now()}`;

    const { id: messageId } = await appendCsApiMessage({
      sessionId: session.id,
      tenantId,
      role: "ai",
      source: "agenora-ai",
      content: "AI reply with tool usage",
      turnId,
      confidence: { score: 0.85, verdict: "ok" },
      sourceChunks: [
        {
          source: "kb://refund-policy",
          score: 0.91,
          snippet: "Refunds are processed within 7 business days.",
        },
      ],
    });

    // Seed trace with a tool_use block in messages JSONB
    await createInteractionTrace({
      tenantId,
      turnId,
      turnIndex: 0,
      sessionKey: session.id,
      agentId,
      channel: "cs-api",
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      inputTokens: 120,
      outputTokens: 45,
      messages: [
        { role: "user", content: "What is the refund policy?" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_01abc",
              name: "search_knowledge_base",
              input: { query: "refund policy" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_01abc",
              content:
                "Refunds are processed within 7 business days. Customers must request within 30 days of purchase.",
            },
          ],
        },
      ],
      stopReason: "end_turn",
    });

    const req = makeRequest({ authorization: `Bearer ${plainSecret}` });
    const mock = makePlainResponse();

    await handleReasoning(req, mock.res, appId, session.id, messageId);

    expect(mock.statusCode).toBe(200);
    const parsed = JSON.parse(mock.body) as {
      reasoning: {
        turnId: string;
        model: string;
        tokensUsed: { prompt: number; completion: number; total: number };
        confidence: { score: number; verdict: string } | null;
        knowledgeHits: Array<{ source: string; score: number; snippet: string }>;
        toolCalls: Array<{ name: string; input: unknown; resultSummary: string }>;
      };
    };

    expect(parsed.reasoning).not.toBeNull();
    expect(parsed.reasoning.turnId).toBe(turnId);
    expect(parsed.reasoning.model).toBe("claude-sonnet-4-5");
    expect(parsed.reasoning.tokensUsed.prompt).toBe(120);
    expect(parsed.reasoning.tokensUsed.completion).toBe(45);
    expect(parsed.reasoning.tokensUsed.total).toBe(165);
    expect(parsed.reasoning.confidence).toEqual({ score: 0.85, verdict: "ok" });
    expect(parsed.reasoning.knowledgeHits).toEqual([
      {
        source: "kb://refund-policy",
        score: 0.91,
        snippet: "Refunds are processed within 7 business days.",
      },
    ]);

    expect(Array.isArray(parsed.reasoning.toolCalls)).toBe(true);
    expect(parsed.reasoning.toolCalls.length).toBeGreaterThan(0);
    const tc = parsed.reasoning.toolCalls[0];
    expect(tc.name).toBe("search_knowledge_base");
    expect(tc.resultSummary).toContain("Refunds are processed");

    expect(Array.isArray(parsed.reasoning.knowledgeHits)).toBe(true);
  });

  it("returns { reasoning: null } when message has null turn_id (human/legacy message)", async () => {
    const { handleReasoning } = await import("./runtime.js");
    const { findOrCreateCsApiSession, appendCsApiMessage } =
      await import("../../db/models/cs-session.js");

    const session = await findOrCreateCsApiSession({
      tenantId,
      appObjectId,
      agentId,
      customerId: "cust-reasoning-no-turn",
    });

    // Customer message: no turn_id
    const { id: messageId } = await appendCsApiMessage({
      sessionId: session.id,
      tenantId,
      role: "customer",
      source: "upper-app-relay",
      content: "Hello, I need help",
      // no turnId → null
    });

    const req = makeRequest({ authorization: `Bearer ${plainSecret}` });
    const mock = makePlainResponse();

    await handleReasoning(req, mock.res, appId, session.id, messageId);

    expect(mock.statusCode).toBe(200);
    const parsed = JSON.parse(mock.body) as { reasoning: null };
    expect(parsed.reasoning).toBeNull();
  });

  it("confidence flows from cs_message.confidence field", async () => {
    const { handleReasoning } = await import("./runtime.js");
    const { findOrCreateCsApiSession } = await import("../../db/models/cs-session.js");
    const { createInteractionTrace } = await import("../../db/models/interaction-trace.js");
    const { sqliteQuery } = await import("../../db/sqlite/index.js");

    const session = await findOrCreateCsApiSession({
      tenantId,
      appObjectId,
      agentId,
      customerId: "cust-reasoning-confidence",
    });

    const turnId = `cs-run-test-conf-${Date.now()}`;

    // Raw sqliteQuery still exercises the low-level row mapper path for legacy
    // rows that already have confidence persisted.
    // 直接用 sqliteQuery 继续覆盖已持久化 confidence 的历史行映射路径。
    const msgId = crypto.randomUUID();
    const now = new Date().toISOString();
    sqliteQuery(
      `INSERT INTO cs_messages (id, session_id, tenant_id, role, content, confidence, source_chunks, source, turn_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        msgId,
        session.id,
        tenantId,
        "ai",
        "Answer with known confidence",
        JSON.stringify({ score: 0.92, verdict: "ok" }),
        null,
        "agenora-ai",
        turnId,
        now,
      ],
    );

    await createInteractionTrace({
      tenantId,
      turnId,
      turnIndex: 0,
      model: "claude-haiku-3-5",
      inputTokens: 50,
      outputTokens: 30,
      messages: [],
      stopReason: "end_turn",
    });

    const req = makeRequest({ authorization: `Bearer ${plainSecret}` });
    const mock = makePlainResponse();

    await handleReasoning(req, mock.res, appId, session.id, msgId);

    expect(mock.statusCode).toBe(200);
    const parsed = JSON.parse(mock.body) as {
      reasoning: { confidence: { score: number; verdict: string } };
    };
    expect(parsed.reasoning.confidence).not.toBeNull();
    expect(parsed.reasoning.confidence.score).toBe(0.92);
    expect(parsed.reasoning.confidence.verdict).toBe("ok");
  });

  it("returns 404 when message does not exist", async () => {
    const { handleReasoning } = await import("./runtime.js");
    const { findOrCreateCsApiSession } = await import("../../db/models/cs-session.js");

    const session = await findOrCreateCsApiSession({
      tenantId,
      appObjectId,
      agentId,
      customerId: "cust-reasoning-404",
    });

    const req = makeRequest({ authorization: `Bearer ${plainSecret}` });
    const mock = makePlainResponse();

    await handleReasoning(
      req,
      mock.res,
      appId,
      session.id,
      "00000000-0000-0000-0000-nonexistent00",
    );

    expect(mock.statusCode).toBe(404);
    const parsed = JSON.parse(mock.body) as { error?: { code?: string } };
    expect(parsed.error?.code).toBe("SESSION_OR_MESSAGE_NOT_FOUND");
  });

  it("returns 404 when message belongs to a different session", async () => {
    const { handleReasoning } = await import("./runtime.js");
    const { findOrCreateCsApiSession, appendCsApiMessage } =
      await import("../../db/models/cs-session.js");

    // Seed message in session A
    const sessionA = await findOrCreateCsApiSession({
      tenantId,
      appObjectId,
      agentId,
      customerId: "cust-reasoning-session-a",
    });
    const { id: messageId } = await appendCsApiMessage({
      sessionId: sessionA.id,
      tenantId,
      role: "ai",
      source: "agenora-ai",
      content: "Reply in session A",
    });

    // Seed session B
    const sessionB = await findOrCreateCsApiSession({
      tenantId,
      appObjectId,
      agentId,
      customerId: "cust-reasoning-session-b",
    });

    // Request message from session A using session B id
    const req = makeRequest({ authorization: `Bearer ${plainSecret}` });
    const mock = makePlainResponse();

    await handleReasoning(req, mock.res, appId, sessionB.id, messageId);

    expect(mock.statusCode).toBe(404);
    const parsed = JSON.parse(mock.body) as { error?: { code?: string } };
    expect(parsed.error?.code).toBe("SESSION_OR_MESSAGE_NOT_FOUND");
  });

  it("returns 401 when Authorization header is missing", async () => {
    const { handleReasoning } = await import("./runtime.js");
    const req = makeRequest({ authorization: undefined });
    const mock = makePlainResponse();

    await handleReasoning(req, mock.res, appId, "any-session-id", "any-message-id");

    expect(mock.statusCode).toBe(401);
    const parsed = JSON.parse(mock.body) as { error?: { code?: string } };
    expect(parsed.error?.code).toBe("MISSING_AUTH");
  });

  it("returns 401 when secret is wrong", async () => {
    const { handleReasoning } = await import("./runtime.js");
    const req = makeRequest({ authorization: "Bearer wrong-secret-xyz" });
    const mock = makePlainResponse();

    await handleReasoning(req, mock.res, appId, "any-session-id", "any-message-id");

    expect(mock.statusCode).toBe(401);
    const parsed = JSON.parse(mock.body) as { error?: { code?: string } };
    expect(parsed.error?.code).toBe("INVALID_APP_SECRET");
  });
});
