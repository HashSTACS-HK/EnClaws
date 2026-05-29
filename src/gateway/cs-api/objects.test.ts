/**
 * Unit tests for cs-api objects CRUD handlers.
 *
 * Strategy: mock all external dependencies (DB models, auth middleware,
 * bcryptjs) and invoke handlers directly with synthetic req/res objects.
 * No full HTTP server is started.
 *
 * 测试策略：mock 所有外部依赖，直接调用 handler，不启动 HTTP 服务器。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Must vi.mock before importing the module under test so Vitest hoists them.

vi.mock("../../auth/middleware.js", () => ({
  tryJwtAuth: vi.fn(),
}));

vi.mock("../../db/models/cs-api-object.js", () => ({
  createCsApiObject: vi.fn(),
  listCsApiObjects: vi.fn(),
  getCsApiObjectById: vi.fn(),
  updateCsApiObject: vi.fn(),
  rotateCsApiObjectSecret: vi.fn(),
  deleteCsApiObject: vi.fn(),
}));

vi.mock("../../db/models/audit-log.js", () => ({
  createAuditLog: vi.fn(),
}));

vi.mock("../../db/models/cs-session.js", () => ({
  countActiveSessionsForApiObject: vi.fn().mockResolvedValue(0),
}));

vi.mock("bcryptjs", () => ({
  default: {
    hash: vi.fn().mockResolvedValue("$2b$10$fakehash"),
  },
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { tryJwtAuth, type MultiTenantAuthResult } from "../../auth/middleware.js";
import { createCsApiObject, updateCsApiObject } from "../../db/models/cs-api-object.js";
import { createObject, listObjects } from "./objects.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal mock IncomingMessage with a JSON body. */
function makeReq(body: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const raw = JSON.stringify(body);
  const readable = Readable.from([Buffer.from(raw)]) as unknown as IncomingMessage;
  readable.headers = { "content-type": "application/json", ...headers };
  readable.method = "POST";
  readable.url = "/api/cs-api/objects";
  return readable;
}

/** Build a mock ServerResponse that captures status code and body. */
function makeRes(): ServerResponse & { _status: number; _body: string } {
  let status = 200;
  let body = "";
  const headers: Record<string, string> = {};

  const res = {
    get _status() {
      return status;
    },
    get _body() {
      return body;
    },
    statusCode: 200,
    setHeader(k: string, v: string) {
      headers[k] = v;
    },
    end(chunk?: string) {
      body = chunk ?? "";
      status = res.statusCode;
    },
  } as unknown as ServerResponse & { _status: number; _body: string };

  return res;
}

/** A valid admin tenant context returned by tryJwtAuth. */
function adminAuth(): MultiTenantAuthResult {
  return {
    ok: true,
    method: "token",
    tenant: {
      tenantId: "tenant-123",
      userId: "user-admin",
      role: "admin" as const,
      scopes: ["read", "write"],
    },
  };
}

/** A member tenant context (insufficient role). */
function memberAuth(): MultiTenantAuthResult {
  return {
    ok: true,
    method: "token",
    tenant: {
      tenantId: "tenant-123",
      userId: "user-member",
      role: "member" as const,
      scopes: ["read"],
    },
  };
}

/** A realistic CsApiObject returned by createCsApiObject. */
function fakeCsApiObject() {
  return {
    id: "obj-abc123",
    tenantId: "tenant-123",
    name: "Test Integration",
    description: undefined,
    agentId: "agent-001",
    appId: "agnr_deadbeefcafe1234",
    appSecretHash: "$2b$10$fakehash",
    rotatingFromHash: undefined,
    rotatingUntil: undefined,
    endpointUrl: "pending",
    isActive: true,
    lastUsedAt: undefined,
    createdAt: new Date("2026-05-28T00:00:00Z"),
    updatedAt: new Date("2026-05-28T00:00:00Z"),
  };
}

// ── Reset mocks between tests ─────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("createObject", () => {
  it("POST creates object and returns one-time secret", async () => {
    vi.mocked(tryJwtAuth).mockResolvedValue(adminAuth());
    const obj = fakeCsApiObject();
    vi.mocked(createCsApiObject).mockResolvedValue(obj);
    vi.mocked(updateCsApiObject).mockResolvedValue(obj);

    const req = makeReq({
      name: "Test Integration",
      agentId: "agent-001",
    });
    const res = makeRes();

    await createObject(req, res);

    expect(res._status).toBe(201);
    const parsed = JSON.parse(res._body) as Record<string, unknown>;

    // appId must start with agnr_
    expect(typeof parsed.appId).toBe("string");
    expect((parsed.appId as string).startsWith("agnr_")).toBe(true);

    // appSecret must start with agnr_secret_
    expect(typeof parsed.appSecret).toBe("string");
    expect((parsed.appSecret as string).startsWith("agnr_secret_")).toBe(true);

    // isActive must be true
    expect(parsed.isActive).toBe(true);

    // createCsApiObject was called with correct tenant
    expect(createCsApiObject).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant-123", name: "Test Integration" }),
    );
  });

  it("returns 403 for non-admin (member role)", async () => {
    vi.mocked(tryJwtAuth).mockResolvedValue(memberAuth());

    const req = makeReq({ name: "Test", agentId: "agent-001" });
    const res = makeRes();

    await createObject(req, res);

    expect(res._status).toBe(403);
    const parsed = JSON.parse(res._body) as { error: { code: string } };
    expect(parsed.error.code).toBe("FORBIDDEN");

    // DB should not have been touched
    expect(createCsApiObject).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid input (empty name)", async () => {
    vi.mocked(tryJwtAuth).mockResolvedValue(adminAuth());

    const req = makeReq({ name: "", agentId: "agent-001" }); // name fails NonEmptyString
    const res = makeRes();

    await createObject(req, res);

    expect(res._status).toBe(400);
    const parsed = JSON.parse(res._body) as { error: { code: string } };
    expect(parsed.error.code).toBe("INVALID_REQUEST");

    expect(createCsApiObject).not.toHaveBeenCalled();
  });
});

describe("listObjects", () => {
  it("returns 200 with objects array for admin", async () => {
    vi.mocked(tryJwtAuth).mockResolvedValue(adminAuth());
    const { listCsApiObjects } = await import("../../db/models/cs-api-object.js");
    vi.mocked(listCsApiObjects).mockResolvedValue([fakeCsApiObject()]);

    const req = makeReq({});
    req.method = "GET";
    const res = makeRes();

    await listObjects(req, res);

    expect(res._status).toBe(200);
    const parsed = JSON.parse(res._body) as { objects: unknown[] };
    expect(Array.isArray(parsed.objects)).toBe(true);
    expect(parsed.objects).toHaveLength(1);
  });
});

// ── endpointUrlFor env handling ───────────────────────────────────────────────
// Uses vi.resetModules() + dynamic import so each test gets a fresh module
// evaluation with the desired env vars set.

describe("endpointUrlFor env handling", () => {
  let originalBaseUrl: string | undefined;
  let originalPublicUrl: string | undefined;
  let originalPort: string | undefined;

  beforeEach(() => {
    originalBaseUrl = process.env.AGENORA_BASE_URL;
    originalPublicUrl = process.env.AGENORA_PUBLIC_URL;
    originalPort = process.env.ENCLAWS_GATEWAY_PORT;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalBaseUrl === undefined) {
      delete process.env.AGENORA_BASE_URL;
    } else {
      process.env.AGENORA_BASE_URL = originalBaseUrl;
    }
    if (originalPublicUrl === undefined) {
      delete process.env.AGENORA_PUBLIC_URL;
    } else {
      process.env.AGENORA_PUBLIC_URL = originalPublicUrl;
    }
    if (originalPort === undefined) {
      delete process.env.ENCLAWS_GATEWAY_PORT;
    } else {
      process.env.ENCLAWS_GATEWAY_PORT = originalPort;
    }
  });

  it("uses AGENORA_BASE_URL when set", async () => {
    delete process.env.AGENORA_PUBLIC_URL;
    process.env.AGENORA_BASE_URL = "https://prod.example.com";
    const { endpointUrlFor } = await import("./objects.js");
    expect(endpointUrlFor("appid-1")).toBe("https://prod.example.com/api/cs-api/appid-1");
  });

  it("falls back to ENCLAWS_GATEWAY_PORT when AGENORA_BASE_URL unset", async () => {
    delete process.env.AGENORA_BASE_URL;
    delete process.env.AGENORA_PUBLIC_URL;
    process.env.ENCLAWS_GATEWAY_PORT = "12345";
    const { endpointUrlFor } = await import("./objects.js");
    expect(endpointUrlFor("appid-2")).toBe("http://localhost:12345/api/cs-api/appid-2");
  });
});
