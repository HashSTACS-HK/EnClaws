/**
 * CS-API runtime endpoint test — POST /{appId}/sessions/{sessionId}/mark-notifying.
 *
 * Mark-notifying endpoint transitions a cs-api session into the "notifying"
 * state (intermediate state where AI has paused awaiting human takeover).
 *
 * Tests:
 *   - 200 happy path: ai-handling → notifying, response state mapped to cs-api enum
 *   - 404 when session does not exist
 *   - 401 unauthorized when secret missing / wrong
 *   - 400 invalid body (unknown extra field)
 *
 * mark-notifying 端点：把 cs-api 会话切到 "notifying" 状态（AI 暂停等待人工接管）。
 */

import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-api-mark-notifying-test-"));
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

describe("POST /{appId}/sessions/{sessionId}/mark-notifying", () => {
  let tenantId: string;
  let appId: string;
  let appObjectId: string;
  let plainSecret: string;

  beforeAll(async () => {
    const bcrypt = (await import("bcryptjs")).default;
    const { createTenant } = await import("../../db/models/tenant.js");
    const { createCsApiObject } = await import("../../db/models/cs-api-object.js");

    const tenant = await createTenant({ name: "Mark Notifying Test Tenant" });
    tenantId = tenant.id;

    plainSecret = "test-notifying-secret-abc";
    const hash = await bcrypt.hash(plainSecret, 10);
    const obj = await createCsApiObject({
      tenantId,
      name: "MN Test App",
      agentId: "cs-mn-agent",
      appSecretHash: hash,
      endpointUrl: "https://upper-app.example.com",
    });
    appId = obj.appId;
    appObjectId = obj.id;
  });

  function makeRequest(opts: {
    method?: string;
    authorization?: string;
    body?: unknown;
  }): IncomingMessage {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
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

  it("transitions ai-handling → notifying and maps state via dbStateToCsApi", async () => {
    const { handleMarkNotifying } = await import("./runtime.js");
    const { findOrCreateCsApiSession } = await import("../../db/models/cs-session.js");

    // Seed: create a fresh session in default ai-handling state.
    const seeded = await findOrCreateCsApiSession({
      tenantId,
      appObjectId,
      agentId: "cs-mn-agent",
      customerId: "cust-mn-happy-001",
    });
    expect(seeded.state).toBe("ai-handling");

    const req = makeRequest({
      authorization: `Bearer ${plainSecret}`,
      body: { reason: "low-confidence" },
    });
    const mock = makePlainResponse();

    await handleMarkNotifying(req, mock.res, appId, seeded.id);

    expect(mock.statusCode).toBe(200);
    const parsed = JSON.parse(mock.body) as { session?: { state?: string; id?: string } };
    expect(parsed.session?.id).toBe(seeded.id);
    expect(parsed.session?.state).toBe("notifying");
  });

  it("returns 404 when session does not exist", async () => {
    const { handleMarkNotifying } = await import("./runtime.js");
    const req = makeRequest({
      authorization: `Bearer ${plainSecret}`,
      body: { reason: "other" },
    });
    const mock = makePlainResponse();

    await handleMarkNotifying(req, mock.res, appId, "00000000-0000-0000-0000-nonexistent");
    expect(mock.statusCode).toBe(404);
    const parsed = JSON.parse(mock.body) as { error?: { code?: string } };
    expect(parsed.error?.code).toBe("SESSION_NOT_FOUND");
  });

  it("returns 401 when Authorization header is missing", async () => {
    const { handleMarkNotifying } = await import("./runtime.js");
    const req = makeRequest({ authorization: undefined, body: {} });
    const mock = makePlainResponse();

    await handleMarkNotifying(req, mock.res, appId, "any-session-id");
    expect(mock.statusCode).toBe(401);
    const parsed = JSON.parse(mock.body) as { error?: { code?: string } };
    expect(parsed.error?.code).toBe("MISSING_AUTH");
  });

  it("returns 401 with wrong secret", async () => {
    const { handleMarkNotifying } = await import("./runtime.js");
    const req = makeRequest({
      authorization: "Bearer wrong-secret-xyz",
      body: { reason: "low-confidence" },
    });
    const mock = makePlainResponse();

    await handleMarkNotifying(req, mock.res, appId, "any-session-id");
    expect(mock.statusCode).toBe(401);
    const parsed = JSON.parse(mock.body) as { error?: { code?: string } };
    expect(parsed.error?.code).toBe("INVALID_APP_SECRET");
  });

  it("returns 400 when body has unknown extra field", async () => {
    const { handleMarkNotifying } = await import("./runtime.js");
    const { findOrCreateCsApiSession } = await import("../../db/models/cs-session.js");
    const seeded = await findOrCreateCsApiSession({
      tenantId,
      appObjectId,
      agentId: "cs-mn-agent",
      customerId: "cust-mn-bad-body-001",
    });

    const req = makeRequest({
      authorization: `Bearer ${plainSecret}`,
      body: { reason: "low-confidence", surprise: "boom" },
    });
    const mock = makePlainResponse();

    await handleMarkNotifying(req, mock.res, appId, seeded.id);
    expect(mock.statusCode).toBe(400);
    const parsed = JSON.parse(mock.body) as { error?: { code?: string } };
    expect(parsed.error?.code).toBe("INVALID_INPUT");
  });
});
