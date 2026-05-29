/**
 * CS-API runtime endpoint test — GET /{appId}.
 *
 * Returns the readable name of the AI service (cs_api_object.name) plus the
 * display name of its associated agent (tenant_agents.name, falling back to
 * the raw agentId when the agent has no display name / no row). jiumi (需求3)
 * uses this to show "XX（AI员工）" as the ticket creator.
 *
 * Tests:
 *   - 200 happy path: returns { appId, name, agentName } with real agent name
 *   - 200 fallback: agentName degrades to agentId when no tenant_agents row
 *   - 401 unauthorized when secret missing / wrong
 *
 * GET /{appId} 端点：返回 AI 服务可读名 + 关联 AI 员工可读名（无显示名则回退 agentId）。
 */

import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-api-get-object-test-"));
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

describe("GET /{appId}", () => {
  let tenantId: string;

  beforeAll(async () => {
    const { createTenant } = await import("../../db/models/tenant.js");
    const tenant = await createTenant({ name: "Get Object Test Tenant" });
    tenantId = tenant.id;
  });

  function makeRequest(opts: { method?: string; authorization?: string }): IncomingMessage {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Readable } = require("node:stream");
    const req = new Readable({
      read() {
        this.push(null);
      },
    });
    req.method = opts.method ?? "GET";
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

  it("returns name + agentName (real agent display name)", async () => {
    const bcrypt = (await import("bcryptjs")).default;
    const { createCsApiObject } = await import("../../db/models/cs-api-object.js");
    const { createTenantAgent } = await import("../../db/models/tenant-agent.js");
    const { handleGetObject } = await import("./runtime.js");

    // Seed an agent with a known display name.
    await createTenantAgent({
      tenantId,
      agentId: "cs-go-agent",
      name: "客服小诺",
    });

    const plainSecret = "test-get-object-secret-abc";
    const hash = await bcrypt.hash(plainSecret, 10);
    const obj = await createCsApiObject({
      tenantId,
      name: "诺安 AI 客服",
      agentId: "cs-go-agent",
      appSecretHash: hash,
      endpointUrl: "https://upper-app.example.com",
    });

    const req = makeRequest({ authorization: `Bearer ${plainSecret}` });
    const mock = makePlainResponse();

    await handleGetObject(req, mock.res, obj.appId);

    expect(mock.statusCode).toBe(200);
    const parsed = JSON.parse(mock.body) as {
      appId?: string;
      name?: string;
      agentName?: string;
    };
    expect(parsed.appId).toBe(obj.appId);
    expect(parsed.name).toBe("诺安 AI 客服");
    expect(parsed.agentName).toBe("客服小诺");
  });

  it("falls back agentName to agentId when agent has no display name row", async () => {
    const bcrypt = (await import("bcryptjs")).default;
    const { createCsApiObject } = await import("../../db/models/cs-api-object.js");
    const { handleGetObject } = await import("./runtime.js");

    const plainSecret = "test-get-object-secret-fallback";
    const hash = await bcrypt.hash(plainSecret, 10);
    const obj = await createCsApiObject({
      tenantId,
      name: "无 agent 行的服务",
      agentId: "cs-go-orphan-agent",
      appSecretHash: hash,
      endpointUrl: "https://upper-app.example.com",
    });

    const req = makeRequest({ authorization: `Bearer ${plainSecret}` });
    const mock = makePlainResponse();

    await handleGetObject(req, mock.res, obj.appId);

    expect(mock.statusCode).toBe(200);
    const parsed = JSON.parse(mock.body) as { agentName?: string };
    expect(parsed.agentName).toBe("cs-go-orphan-agent");
  });

  it("returns 401 when Authorization header is missing", async () => {
    const { handleGetObject } = await import("./runtime.js");
    const req = makeRequest({ authorization: undefined });
    const mock = makePlainResponse();

    await handleGetObject(req, mock.res, "any-app-id");
    expect(mock.statusCode).toBe(401);
    const parsed = JSON.parse(mock.body) as { error?: { code?: string } };
    expect(parsed.error?.code).toBe("MISSING_AUTH");
  });

  it("returns 401 with wrong secret", async () => {
    const bcrypt = (await import("bcryptjs")).default;
    const { createCsApiObject } = await import("../../db/models/cs-api-object.js");
    const { handleGetObject } = await import("./runtime.js");

    const plainSecret = "test-get-object-secret-wrong-baseline";
    const hash = await bcrypt.hash(plainSecret, 10);
    const obj = await createCsApiObject({
      tenantId,
      name: "鉴权失败测试服务",
      agentId: "cs-go-agent",
      appSecretHash: hash,
      endpointUrl: "https://upper-app.example.com",
    });

    const req = makeRequest({ authorization: "Bearer wrong-secret-xyz" });
    const mock = makePlainResponse();

    await handleGetObject(req, mock.res, obj.appId);
    expect(mock.statusCode).toBe(401);
    const parsed = JSON.parse(mock.body) as { error?: { code?: string } };
    expect(parsed.error?.code).toBe("INVALID_APP_SECRET");
  });
});
