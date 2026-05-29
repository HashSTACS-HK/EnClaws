/**
 * §11.6 query endpoint tests — sessions list / single / transcript.
 *
 * §11.6 查询端点测试：会话列表、单条会话元数据、消息流水分页。
 *
 * Strategy: SQLite in-memory test DB (tmpDir), real DB helpers.
 * No full HTTP server; handlers invoked directly with synthetic req/res.
 *
 * 测试策略：SQLite 临时数据库，真实 DB 助手，直接调用 handler，不启动 HTTP 服务器。
 */

import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// ── Mock runCSAgentReply so we don't hit LLM during import chain ──────────────
vi.mock("../../customer-service/rag/cs-agent-runner.js", () => ({
  runCSAgentReply: vi.fn().mockResolvedValue({ reply: "mocked", sourceChunks: [] }),
}));
vi.mock("../../config/tenant-config.js", () => ({
  loadTenantConfig: vi.fn().mockResolvedValue({}),
}));

// ── DB bootstrap ──────────────────────────────────────────────────────────────

let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-api-queries-test-"));
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

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Build a minimal GET IncomingMessage with optional Authorization header and query string. */
function makeGetReq(url: string, secret?: string): IncomingMessage {
  const readable = Readable.from([]) as unknown as IncomingMessage;
  readable.method = "GET";
  readable.url = url;
  readable.headers = secret ? { authorization: `Bearer ${secret}` } : {};
  return readable;
}

/** Build a mock ServerResponse that captures status + body. */
function makeRes(): ServerResponse & { _status: number; _body: string } {
  let status = 200;
  let body = "";
  const res = {
    get _status() {
      return status;
    },
    get _body() {
      return body;
    },
    get statusCode() {
      return status;
    },
    set statusCode(v: number) {
      status = v;
    },
    setHeader() {
      /* noop */
    },
    end(chunk?: string) {
      if (chunk) {
        body += chunk;
      }
    },
  } as unknown as ServerResponse & { _status: number; _body: string };
  return res;
}

/** Seed a tenant + API object and return IDs + plaintext secret. */
async function seedTenantAndObject(suffix: string): Promise<{
  tenantId: string;
  appObjectId: string;
  appId: string;
  plainSecret: string;
}> {
  const bcrypt = (await import("bcryptjs")).default;
  const { createTenant } = await import("../../db/models/tenant.js");
  const { createCsApiObject } = await import("../../db/models/cs-api-object.js");

  const tenant = await createTenant({ name: `Query Test Tenant ${suffix}` });
  const plainSecret = `test-secret-${suffix}`;
  const hash = await bcrypt.hash(plainSecret, 10);
  const obj = await createCsApiObject({
    tenantId: tenant.id,
    name: `Query Test App ${suffix}`,
    agentId: `agent-${suffix}`,
    appSecretHash: hash,
    endpointUrl: "https://example.com",
  });
  return { tenantId: tenant.id, appObjectId: obj.id, appId: obj.appId, plainSecret };
}

// ── §11.6 Test Suite ──────────────────────────────────────────────────────────

describe("§11.6 query endpoints", () => {
  // ── Test 1: list sessions with cursor pagination ───────────────────────────

  it("list with cursor pagination — seeds 25 sessions, paginates via cursor", async () => {
    const { tenantId, appObjectId, appId, plainSecret } = await seedTenantAndObject("list-pag");
    const { findOrCreateCsApiSession } = await import("../../db/models/cs-session.js");

    // Seed 25 sessions for this app object
    for (let i = 0; i < 25; i++) {
      await findOrCreateCsApiSession({
        tenantId,
        appObjectId,
        agentId: "agent-list-pag",
        customerId: `cust-list-${i.toString().padStart(3, "0")}`,
      });
    }

    const { handleListSessions } = await import("./queries.js");

    // Page 1: limit=10
    const req1 = makeGetReq(`/api/cs-api/${appId}/sessions?limit=10`, plainSecret);
    const res1 = makeRes();
    await handleListSessions(req1, res1, appId);

    expect(res1._status).toBe(200);
    const page1 = JSON.parse(res1._body) as { sessions: unknown[]; nextCursor: string | null };
    expect(page1.sessions).toHaveLength(10);
    expect(typeof page1.nextCursor).toBe("string");

    // Page 2: use nextCursor
    const cursor = page1.nextCursor as string;
    const req2 = makeGetReq(
      `/api/cs-api/${appId}/sessions?limit=10&cursor=${encodeURIComponent(cursor)}`,
      plainSecret,
    );
    const res2 = makeRes();
    await handleListSessions(req2, res2, appId);

    expect(res2._status).toBe(200);
    const page2 = JSON.parse(res2._body) as { sessions: unknown[]; nextCursor: string | null };
    expect(page2.sessions).toHaveLength(10);

    // Page 3: remaining 5 + no nextCursor
    const cursor2 = page2.nextCursor as string;
    const req3 = makeGetReq(
      `/api/cs-api/${appId}/sessions?limit=10&cursor=${encodeURIComponent(cursor2)}`,
      plainSecret,
    );
    const res3 = makeRes();
    await handleListSessions(req3, res3, appId);

    expect(res3._status).toBe(200);
    const page3 = JSON.parse(res3._body) as { sessions: unknown[]; nextCursor: string | null };
    expect(page3.sessions).toHaveLength(5);
    expect(page3.nextCursor).toBeNull();

    // All IDs across pages are unique
    const allIds = [
      ...(page1.sessions as Array<{ id: string }>).map((s) => s.id),
      ...(page2.sessions as Array<{ id: string }>).map((s) => s.id),
      ...(page3.sessions as Array<{ id: string }>).map((s) => s.id),
    ];
    expect(new Set(allIds).size).toBe(25);
  });

  // ── Test 2: single session metadata — no messages[] ────────────────────────

  it("single session metadata returns no messages array", async () => {
    const { tenantId, appObjectId, appId, plainSecret } = await seedTenantAndObject("single");
    const { findOrCreateCsApiSession, appendCsApiMessage } =
      await import("../../db/models/cs-session.js");

    const session = await findOrCreateCsApiSession({
      tenantId,
      appObjectId,
      agentId: "agent-single",
      customerId: "cust-single-001",
    });
    // Append a message so messageCount > 0
    await appendCsApiMessage({
      sessionId: session.id,
      tenantId,
      role: "customer",
      source: "upper-app-relay",
      content: "Hello",
    });

    const { handleGetSession } = await import("./queries.js");
    const req = makeGetReq(`/api/cs-api/${appId}/sessions/${session.id}`, plainSecret);
    const res = makeRes();
    await handleGetSession(req, res, appId, session.id);

    expect(res._status).toBe(200);
    const body = JSON.parse(res._body) as { session: Record<string, unknown> };
    expect(body.session).toBeDefined();
    expect(body.session.id).toBe(session.id);
    expect(body.session.state).toBe("ai-handling");
    expect(body.session.customerId).toBe("cust-single-001");
    expect(body.session.messageCount).toBe(1);

    // IMPORTANT: no messages[] array in response
    expect("messages" in body.session).toBe(false);
  });

  // ── Test 3: transcript with cursor + direction=before ──────────────────────

  it("transcript with cursor + direction=before paginates oldest-toward-newest", async () => {
    const { tenantId, appObjectId, appId, plainSecret } = await seedTenantAndObject("transcript");
    const { findOrCreateCsApiSession, appendCsApiMessage } =
      await import("../../db/models/cs-session.js");

    const session = await findOrCreateCsApiSession({
      tenantId,
      appObjectId,
      agentId: "agent-transcript",
      customerId: "cust-transcript-001",
    });

    // Append 10 messages
    for (let i = 0; i < 10; i++) {
      await appendCsApiMessage({
        sessionId: session.id,
        tenantId,
        role: i % 2 === 0 ? "customer" : "ai",
        source: i % 2 === 0 ? "upper-app-relay" : "agenora-ai",
        content: `Message ${i}`,
      });
    }

    const { handleTranscript } = await import("./queries.js");

    // First page: limit=4, direction=before (newest→oldest, returns oldest-first in array)
    const req1 = makeGetReq(
      `/api/cs-api/${appId}/sessions/${session.id}/transcript?limit=4&direction=before`,
      plainSecret,
    );
    const res1 = makeRes();
    await handleTranscript(req1, res1, appId, session.id);

    expect(res1._status).toBe(200);
    const page1 = JSON.parse(res1._body) as {
      messages: Array<{ id: string; role: string; content: string; createdAt: string }>;
      nextCursor: string | null;
      hasMore: boolean;
    };

    // With direction=before and no cursor → last 4 messages (7-10: indices 6-9)
    // The function fetches DESC then reverses → result is ascending
    expect(page1.messages).toHaveLength(4);
    expect(page1.hasMore).toBe(true);
    expect(typeof page1.nextCursor).toBe("string");

    // Each message has required fields
    for (const msg of page1.messages) {
      expect(typeof msg.id).toBe("string");
      expect(typeof msg.role).toBe("string");
      expect(typeof msg.content).toBe("string");
      expect(typeof msg.createdAt).toBe("string");
    }

    // Second page using cursor — should return more (earlier) messages
    const cursor = page1.nextCursor as string;
    const req2 = makeGetReq(
      `/api/cs-api/${appId}/sessions/${session.id}/transcript?limit=4&direction=before&cursor=${encodeURIComponent(cursor)}`,
      plainSecret,
    );
    const res2 = makeRes();
    await handleTranscript(req2, res2, appId, session.id);

    expect(res2._status).toBe(200);
    const page2 = JSON.parse(res2._body) as {
      messages: Array<{ id: string; content: string }>;
      nextCursor: string | null;
      hasMore: boolean;
    };
    expect(page2.messages.length).toBeGreaterThan(0);

    // No duplicate IDs across pages
    const ids1Set = new Set(page1.messages.map((m) => m.id));
    const ids2 = page2.messages.map((m) => m.id);
    const overlapping = ids2.filter((id) => ids1Set.has(id));
    expect(overlapping).toHaveLength(0);
  });

  // ── Additional coverage: 404 on unknown session ────────────────────────────

  it("GET single session returns 404 for unknown sessionId", async () => {
    const { appId, plainSecret } = await seedTenantAndObject("404-test");
    const { handleGetSession } = await import("./queries.js");
    const req = makeGetReq(
      `/api/cs-api/${appId}/sessions/00000000-0000-0000-0000-nonexistent`,
      plainSecret,
    );
    const res = makeRes();
    await handleGetSession(req, res, appId, "00000000-0000-0000-0000-nonexistent");
    expect(res._status).toBe(404);
    const body = JSON.parse(res._body) as { error: { code: string } };
    expect(body.error.code).toBe("SESSION_NOT_FOUND");
  });

  // ── Auth guard: 401 on missing Bearer ─────────────────────────────────────

  it("list sessions returns 401 when no auth header", async () => {
    const { appId } = await seedTenantAndObject("auth-guard");
    const { handleListSessions } = await import("./queries.js");
    const req = makeGetReq(`/api/cs-api/${appId}/sessions`);
    const res = makeRes();
    await handleListSessions(req, res, appId);
    expect(res._status).toBe(401);
    const body = JSON.parse(res._body) as { error: { code: string } };
    expect(body.error.code).toBe("MISSING_AUTH");
  });
});
