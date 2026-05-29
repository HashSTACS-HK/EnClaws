/**
 * CS DB model tests — unit + regression coverage for cs-session and cs-message CRUD.
 *
 * Regression guard:
 *   - sqliteQuery returns { rows, rowCount }, NOT a plain array.
 *     Before the fix, listCSSessions crashed with "sqliteQuery(...).map is not a function"
 *     and createCSSession returned null (causing "Cannot read properties of null (reading 'id')").
 *
 * 客服 DB 模型测试 — 单元测试 + 回归用例（SQLite 模式）。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Tenant } from "../types.js";

// ── DB bootstrap ─────────────────────────────────────────────────────────────

let tmpDir: string;

// Tenants created once; IDs used across all tests.
// cs_sessions.tenant_id is a FK → tenants.id, so tenant must exist first.
let tenantA: Tenant;   // primary test tenant
let tenantB: Tenant;   // used for listCSSessions isolation tests
let tenantC: Tenant;   // pagination
let tenantMsgList: Tenant;
let tenantMsgBefore: Tenant;
let tenantMsgLimit: Tenant;
let tenantCsApiState: Tenant;   // §F.2 cs-api state widening tests

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-db-test-"));
  process.env.ENCLAWS_DB_URL = `sqlite:///${tmpDir}/test.db`;

  // Dynamic import AFTER env var is set so initDb reads the correct URL.
  // initDb() is a singleton — safe to call once per worker process (vitest forks).
  const { initDb } = await import("../index.js");
  initDb();

  const { createTenant } = await import("./tenant.js");

  // Create all tenant fixtures upfront so FK constraints are satisfied.
  // 先建好租户记录，满足 cs_sessions.tenant_id 外键约束。
  [tenantA, tenantB, tenantC, tenantMsgList, tenantMsgBefore, tenantMsgLimit, tenantCsApiState] =
    await Promise.all([
      createTenant({ name: "Tenant A", slug: "tenant-a" }),
      createTenant({ name: "Tenant B", slug: "tenant-b" }),
      createTenant({ name: "Tenant C", slug: "tenant-c" }),
      createTenant({ name: "Tenant Msg List", slug: "tenant-msg-list" }),
      createTenant({ name: "Tenant Msg Before", slug: "tenant-msg-before" }),
      createTenant({ name: "Tenant Msg Limit", slug: "tenant-msg-limit" }),
      createTenant({ name: "Tenant CsApi State", slug: "tenant-csapi-state" }),
    ]);
});

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

// ── cs-session CRUD ───────────────────────────────────────────────────────────

describe("cs-session SQLite CRUD", () => {
  const VISITOR = "visitor-abc-123";

  it("createCSSession — returns a valid session object (not null)", async () => {
    const { createCSSession } = await import("./cs-session.js");
    const session = await createCSSession({
      tenantId: tenantA.id,
      visitorId: VISITOR,
      visitorName: "Test User",
      channel: "web_widget",
    });

    // REGRESSION: before fix, getCSSession returned null because sqliteQuery result
    // was accessed as an array (rows.length was undefined → falsy → returned null).
    // createCSSession then returned that null, causing "Cannot read properties of null (reading 'id')".
    expect(session).not.toBeNull();
    expect(session.id).toBeTruthy();
    expect(session.tenantId).toBe(tenantA.id);
    expect(session.visitorId).toBe(VISITOR);
    expect(session.visitorName).toBe("Test User");
    expect(session.state).toBe("ai_active");
    expect(session.channel).toBe("web_widget");
  });

  it("getCSSession — retrieves existing session by id", async () => {
    const { createCSSession, getCSSession } = await import("./cs-session.js");
    const created = await createCSSession({ tenantId: tenantA.id, visitorId: "visitor-get-test" });
    const fetched = await getCSSession(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.visitorId).toBe("visitor-get-test");
  });

  it("getCSSession — returns null for unknown id", async () => {
    const { getCSSession } = await import("./cs-session.js");
    const result = await getCSSession("00000000-0000-0000-0000-000000000000");
    expect(result).toBeNull();
  });

  it("findActiveCSSession — finds open session, null when closed", async () => {
    const { createCSSession, findActiveCSSession, closeCSSession } = await import("./cs-session.js");
    const visitorId = "visitor-find-test";
    const session = await createCSSession({ tenantId: tenantA.id, visitorId });

    const found = await findActiveCSSession(tenantA.id, visitorId);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(session.id);

    await closeCSSession(session.id);
    const afterClose = await findActiveCSSession(tenantA.id, visitorId);
    expect(afterClose).toBeNull();
  });

  it("listCSSessions — returns an array (not undefined)", async () => {
    // REGRESSION: before fix, sqliteQuery result was cast directly as an array,
    // so .map() threw "sqliteQuery(...).map is not a function".
    const { listCSSessions } = await import("./cs-session.js");
    const sessions = await listCSSessions(tenantA.id);
    expect(Array.isArray(sessions)).toBe(true);
  });

  it("listCSSessions — returns only sessions for the requested tenant", async () => {
    const { createCSSession, listCSSessions } = await import("./cs-session.js");
    await createCSSession({ tenantId: tenantB.id, visitorId: "v1" });
    await createCSSession({ tenantId: tenantB.id, visitorId: "v2" });

    const sessions = await listCSSessions(tenantB.id);
    expect(sessions.length).toBe(2);
    for (const s of sessions) {
      expect(s.tenantId).toBe(tenantB.id);
    }
  });

  it("listCSSessions — respects limit and offset", async () => {
    const { createCSSession, listCSSessions } = await import("./cs-session.js");
    for (let i = 0; i < 5; i++) {
      await createCSSession({ tenantId: tenantC.id, visitorId: `visitor-page-${i}` });
    }
    const page1 = await listCSSessions(tenantC.id, { limit: 2, offset: 0 });
    const page2 = await listCSSessions(tenantC.id, { limit: 2, offset: 2 });
    expect(page1.length).toBe(2);
    expect(page2.length).toBe(2);
    expect(page1[0].id).not.toBe(page2[0].id);
  });

  it("updateCSSessionState — transitions state correctly", async () => {
    const { createCSSession, getCSSession, updateCSSessionState } = await import("./cs-session.js");
    const session = await createCSSession({ tenantId: tenantA.id, visitorId: "visitor-state-test" });
    expect(session.state).toBe("ai_active");

    await updateCSSessionState(session.id, "human_active");
    const updated = await getCSSession(session.id);
    expect(updated!.state).toBe("human_active");
  });
});

// ── §F.2 cs-api state widening ───────────────────────────────────────────────
//
// Task 5 (Phase 2 DB work) — let cs-api endpoint layer use the 4-value enum
// (ai-handling / notifying / human-handling / closed) without disturbing S1
// widget paths. We do NOT touch rowToSession or CSSessionState type.
//
// 验证 cs-api 边界放宽：state 列接受 "notifying" 新值，
// 且 countActiveSessionsForApiObject 统计含 notifying 的会话。

describe("§F.2 cs-api state widening", () => {
  it("updateCSSessionState accepts cs-api new value 'notifying'", async () => {
    // Setup: create a cs-api session via findOrCreateCsApiSession (writes state='ai-handling').
    // 通过 cs-api 路径建会话，state 列直接接受新值，无 CHECK 约束。
    const { createCsApiObject } = await import("./cs-api-object.js");
    const { findOrCreateCsApiSession, updateCSSessionState } = await import("./cs-session.js");
    const { query, getDbType, DB_SQLITE } = await import("../index.js");
    const { sqliteQuery } = await import("../sqlite/index.js");

    const obj = await createCsApiObject({
      tenantId: tenantCsApiState.id,
      name: "F2 Update Test App",
      agentId: "agent-f2-update",
      appSecretHash: "hash-f2-update",
      endpointUrl: "https://example.com/f2-update",
    });
    const sess = await findOrCreateCsApiSession({
      tenantId: tenantCsApiState.id,
      appObjectId: obj.id,
      agentId: "agent-f2-update",
      customerId: "cust-f2-update",
    });

    // The point: updateCSSessionState must accept "notifying" without throwing
    // at TS time (parameter type wide enough) AND at runtime (no DB CHECK).
    // 关键：参数类型放宽到 string，运行时写入应成功，DB 列存储字面量 'notifying'。
    await updateCSSessionState(sess.id, "notifying");

    // Verify raw DB row holds "notifying" (we bypass rowToSession which is unchanged).
    // 直接读 DB 行验证，rowToSession 不被修改，所以走原始 SQL。
    let rawState: string | undefined;
    if (getDbType() === DB_SQLITE) {
      const r = sqliteQuery("SELECT state FROM cs_sessions WHERE id = ?", [sess.id]);
      rawState = r.rows[0]?.state as string | undefined;
    } else {
      const r = await query("SELECT state FROM cs_sessions WHERE id = $1", [sess.id]);
      rawState = r.rows[0]?.state as string | undefined;
    }
    expect(rawState).toBe("notifying");
  });

  it("countActiveSessionsForApiObject counts 'notifying' state rows", async () => {
    // Setup: create cs-api object + session, transition to 'notifying',
    // then ensure the count includes it.
    // 建一个 cs-api session → 切到 notifying → 检验 count >= 1。
    const { createCsApiObject } = await import("./cs-api-object.js");
    const { findOrCreateCsApiSession, updateCSSessionState, countActiveSessionsForApiObject } =
      await import("./cs-session.js");

    const obj = await createCsApiObject({
      tenantId: tenantCsApiState.id,
      name: "F2 Count Test App",
      agentId: "agent-f2-count",
      appSecretHash: "hash-f2-count",
      endpointUrl: "https://example.com/f2-count",
    });

    const sess = await findOrCreateCsApiSession({
      tenantId: tenantCsApiState.id,
      appObjectId: obj.id,
      agentId: "agent-f2-count",
      customerId: "cust-f2-count",
    });
    // Initially state='ai-handling' → count == 1
    const baseline = await countActiveSessionsForApiObject(tenantCsApiState.id, obj.id);
    expect(baseline).toBe(1);

    // Transition to 'notifying' — should still be counted as active.
    // 切到 notifying 也应被视为活跃。
    await updateCSSessionState(sess.id, "notifying");
    const after = await countActiveSessionsForApiObject(tenantCsApiState.id, obj.id);
    expect(after).toBe(1);
  });
});

// ── cs-message CRUD ───────────────────────────────────────────────────────────

describe("cs-message SQLite CRUD", () => {
  let sessionId: string;

  beforeAll(async () => {
    const { createCSSession } = await import("./cs-session.js");
    const session = await createCSSession({ tenantId: tenantA.id, visitorId: "visitor-msg-root" });
    sessionId = session.id;
  });

  it("createCSMessage — returns a valid message object (not null)", async () => {
    const { createCSMessage } = await import("./cs-message.js");
    const msg = await createCSMessage({
      sessionId,
      tenantId: tenantA.id,
      role: "customer",
      content: "Hello, I need help",
    });

    // REGRESSION: same sqliteQuery array-access bug; getCSMessage returned null
    // so createCSMessage returned null too.
    expect(msg).not.toBeNull();
    expect(msg.id).toBeTruthy();
    expect(msg.sessionId).toBe(sessionId);
    expect(msg.tenantId).toBe(tenantA.id);
    expect(msg.role).toBe("customer");
    expect(msg.content).toBe("Hello, I need help");
  });

  it("getCSMessage — retrieves message by id", async () => {
    const { createCSMessage, getCSMessage } = await import("./cs-message.js");
    const created = await createCSMessage({ sessionId, tenantId: tenantA.id, role: "ai", content: "AI reply" });
    const fetched = await getCSMessage(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.role).toBe("ai");
  });

  it("getCSMessage — returns null for unknown id", async () => {
    const { getCSMessage } = await import("./cs-message.js");
    const result = await getCSMessage("00000000-0000-0000-0000-000000000000");
    expect(result).toBeNull();
  });

  it("listCSMessages — returns array in ascending chronological order", async () => {
    // REGRESSION: same sqliteQuery array-access bug as listCSSessions.
    const { createCSSession } = await import("./cs-session.js");
    const { createCSMessage, listCSMessages } = await import("./cs-message.js");
    const session = await createCSSession({ tenantId: tenantMsgList.id, visitorId: "visitor-list" });

    await createCSMessage({ sessionId: session.id, tenantId: tenantMsgList.id, role: "customer", content: "msg 1" });
    await createCSMessage({ sessionId: session.id, tenantId: tenantMsgList.id, role: "ai", content: "msg 2" });
    await createCSMessage({ sessionId: session.id, tenantId: tenantMsgList.id, role: "customer", content: "msg 3" });

    const messages = await listCSMessages(session.id);
    expect(Array.isArray(messages)).toBe(true);
    expect(messages.length).toBe(3);
    expect(messages[0].content).toBe("msg 1");
    expect(messages[2].content).toBe("msg 3");
  });

  it("listCSMessages with beforeId — returns older messages in correct order", async () => {
    const { createCSSession } = await import("./cs-session.js");
    const { createCSMessage, listCSMessages } = await import("./cs-message.js");
    const session = await createCSSession({ tenantId: tenantMsgBefore.id, visitorId: "visitor-before" });

    // SQLite datetime('now') has second-level precision.
    // Insert messages with 1.1s gaps so each gets a distinct created_at timestamp,
    // ensuring the `created_at <` comparison in beforeId works correctly.
    // SQLite 时间精度是秒，消息之间需要间隔 > 1s 才能区分前后顺序。
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const m1 = await createCSMessage({ sessionId: session.id, tenantId: tenantMsgBefore.id, role: "customer", content: "first" });
    await sleep(1100);
    const m2 = await createCSMessage({ sessionId: session.id, tenantId: tenantMsgBefore.id, role: "ai", content: "second" });
    await sleep(1100);
    await createCSMessage({ sessionId: session.id, tenantId: tenantMsgBefore.id, role: "customer", content: "third" });

    // beforeId = m2 means: messages created before m2 (only m1)
    const older = await listCSMessages(session.id, { beforeId: m2.id });
    expect(Array.isArray(older)).toBe(true);
    expect(older.length).toBe(1);
    expect(older[0].id).toBe(m1.id);
  });

  it("listCSMessages — respects limit", async () => {
    const { createCSSession } = await import("./cs-session.js");
    const { createCSMessage, listCSMessages } = await import("./cs-message.js");
    const session = await createCSSession({ tenantId: tenantMsgLimit.id, visitorId: "visitor-limit" });

    for (let i = 0; i < 5; i++) {
      await createCSMessage({ sessionId: session.id, tenantId: tenantMsgLimit.id, role: "customer", content: `msg ${i}` });
    }
    const limited = await listCSMessages(session.id, { limit: 3 });
    expect(limited.length).toBe(3);
  });
});
