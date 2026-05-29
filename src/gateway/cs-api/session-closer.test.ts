/**
 * CS-API session auto-closer cron tests.
 *
 * Verifies the 300s idle auto-close cron:
 *   1. Closes cs-api sessions whose last customer message is older than IDLE_THRESHOLD_MS.
 *   2. Leaves fresh cs-api sessions (recent customer message) untouched.
 *   3. Leaves S1 widget sessions (app_object_id IS NULL) untouched.
 *   4. start/stop are idempotent (no double-interval, no leaked timer).
 *
 * cs-api 会话自动关闭 cron 测试：超 300s 无客户消息的会话自动 closed，
 * S1 widget 会话与活跃会话不受影响。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-api-session-closer-test-"));
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

describe("findInactiveCsApiSessions", () => {
  let tenantId: string;
  let appObjectId: string;

  beforeAll(async () => {
    const { createTenant } = await import("../../db/models/tenant.js");
    const { createCsApiObject } = await import("../../db/models/cs-api-object.js");
    const tenant = await createTenant({ name: "Closer Helper Tenant" });
    tenantId = tenant.id;
    const obj = await createCsApiObject({
      tenantId,
      name: "Closer Helper App",
      agentId: "agent-c",
      appSecretHash: "hash",
      endpointUrl: "https://example.com/c",
    });
    appObjectId = obj.id;
  });

  it("returns cs-api sessions whose last customer message is older than idleMs", async () => {
    const { findOrCreateCsApiSession, appendCsApiMessage, findInactiveCsApiSessions } =
      await import("../../db/models/cs-session.js");
    const { sqliteQuery } = await import("../../db/sqlite/index.js");

    const session = await findOrCreateCsApiSession({
      tenantId,
      appObjectId,
      agentId: "agent-c",
      customerId: "cust-stale-001",
    });
    await appendCsApiMessage({
      sessionId: session.id,
      tenantId,
      role: "customer",
      source: "upper-app-relay",
      content: "hello",
    });

    // Back-date the customer message to 10 minutes ago.
    // 把客户消息时间戳改成 10 分钟前。
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    sqliteQuery(
      "UPDATE cs_messages SET created_at = ? WHERE session_id = ? AND role = 'customer'",
      [tenMinAgo, session.id],
    );

    const stale = await findInactiveCsApiSessions(300_000);
    const staleIds = stale.map((s) => s.id);
    expect(staleIds).toContain(session.id);
  });

  it("does NOT return cs-api sessions with a recent customer message", async () => {
    const { findOrCreateCsApiSession, appendCsApiMessage, findInactiveCsApiSessions } =
      await import("../../db/models/cs-session.js");

    const session = await findOrCreateCsApiSession({
      tenantId,
      appObjectId,
      agentId: "agent-c",
      customerId: "cust-fresh-001",
    });
    await appendCsApiMessage({
      sessionId: session.id,
      tenantId,
      role: "customer",
      source: "upper-app-relay",
      content: "fresh message",
    });

    const stale = await findInactiveCsApiSessions(300_000);
    const staleIds = stale.map((s) => s.id);
    expect(staleIds).not.toContain(session.id);
  });

  it("does NOT return S1 widget sessions (app_object_id IS NULL)", async () => {
    const { createCSSession } = await import("../../db/models/cs-session.js");
    const { findInactiveCsApiSessions } = await import("../../db/models/cs-session.js");
    const { sqliteQuery } = await import("../../db/sqlite/index.js");

    const widget = await createCSSession({
      tenantId,
      visitorId: "visitor-widget-001",
      channel: "web_widget",
    });
    // Inject an old customer message — but session lacks app_object_id, so it must
    // still be excluded from the inactive list.
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    sqliteQuery(
      `INSERT INTO cs_messages (id, session_id, tenant_id, role, content, source, created_at)
       VALUES (?, ?, ?, 'customer', 'widget hello', 'upper-app-relay', ?)`,
      [crypto.randomUUID(), widget.id, tenantId, tenMinAgo],
    );

    const stale = await findInactiveCsApiSessions(300_000);
    const staleIds = stale.map((s) => s.id);
    expect(staleIds).not.toContain(widget.id);
  });

  it("does NOT return cs-api sessions already in closed state", async () => {
    const {
      findOrCreateCsApiSession,
      appendCsApiMessage,
      setSessionState,
      findInactiveCsApiSessions,
    } = await import("../../db/models/cs-session.js");
    const { sqliteQuery } = await import("../../db/sqlite/index.js");

    const session = await findOrCreateCsApiSession({
      tenantId,
      appObjectId,
      agentId: "agent-c",
      customerId: "cust-already-closed-001",
    });
    await appendCsApiMessage({
      sessionId: session.id,
      tenantId,
      role: "customer",
      source: "upper-app-relay",
      content: "old",
    });
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    sqliteQuery(
      "UPDATE cs_messages SET created_at = ? WHERE session_id = ? AND role = 'customer'",
      [tenMinAgo, session.id],
    );
    await setSessionState({
      tenantId,
      sessionId: session.id,
      state: "closed",
      activeResponder: null,
    });

    const stale = await findInactiveCsApiSessions(300_000);
    const staleIds = stale.map((s) => s.id);
    expect(staleIds).not.toContain(session.id);
  });
});

describe("startSessionCloser / stopSessionCloser", () => {
  let tenantId: string;
  let appObjectId: string;

  beforeAll(async () => {
    const { createTenant } = await import("../../db/models/tenant.js");
    const { createCsApiObject } = await import("../../db/models/cs-api-object.js");
    const tenant = await createTenant({ name: "Closer Cron Tenant" });
    tenantId = tenant.id;
    const obj = await createCsApiObject({
      tenantId,
      name: "Closer Cron App",
      agentId: "agent-cc",
      appSecretHash: "hash",
      endpointUrl: "https://example.com/cc",
    });
    appObjectId = obj.id;
  });

  it("closes stale cs-api sessions after one scan tick", async () => {
    const { findOrCreateCsApiSession, appendCsApiMessage, getCSSession } =
      await import("../../db/models/cs-session.js");
    const { sqliteQuery } = await import("../../db/sqlite/index.js");
    const { startSessionCloser, stopSessionCloser, runSessionCloserScan } =
      await import("./session-closer.js");

    const session = await findOrCreateCsApiSession({
      tenantId,
      appObjectId,
      agentId: "agent-cc",
      customerId: "cust-cron-stale-001",
    });
    await appendCsApiMessage({
      sessionId: session.id,
      tenantId,
      role: "customer",
      source: "upper-app-relay",
      content: "stale hello",
    });
    // Back-date so it qualifies as inactive.
    // 把消息时间往前推到阈值之外。
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    sqliteQuery(
      "UPDATE cs_messages SET created_at = ? WHERE session_id = ? AND role = 'customer'",
      [tenMinAgo, session.id],
    );

    startSessionCloser();
    try {
      await runSessionCloserScan();
    } finally {
      stopSessionCloser();
    }

    const after = await getCSSession(session.id);
    expect(after?.state).toBe("closed");
  });

  it("leaves fresh cs-api sessions untouched", async () => {
    const { findOrCreateCsApiSession, appendCsApiMessage, getCSSession } =
      await import("../../db/models/cs-session.js");
    const { startSessionCloser, stopSessionCloser, runSessionCloserScan } =
      await import("./session-closer.js");

    const session = await findOrCreateCsApiSession({
      tenantId,
      appObjectId,
      agentId: "agent-cc",
      customerId: "cust-cron-fresh-001",
    });
    await appendCsApiMessage({
      sessionId: session.id,
      tenantId,
      role: "customer",
      source: "upper-app-relay",
      content: "fresh hello",
    });

    startSessionCloser();
    try {
      await runSessionCloserScan();
    } finally {
      stopSessionCloser();
    }

    const after = await getCSSession(session.id);
    expect(after?.state).toBe("ai-handling");
  });

  it("start is idempotent (double start does not double-schedule)", async () => {
    const { startSessionCloser, stopSessionCloser } = await import("./session-closer.js");
    // Should not throw; second call should be no-op.
    // 第二次调用应为空操作，不抛错。
    startSessionCloser();
    startSessionCloser();
    stopSessionCloser();
    // After stop the timer is null; another start/stop pair should succeed cleanly.
    startSessionCloser();
    stopSessionCloser();
  });
});
