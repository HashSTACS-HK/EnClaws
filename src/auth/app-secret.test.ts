/**
 * app-secret auth tests — TDD: write first, implement second.
 *
 * Covers: valid secret, invalid secret, rotation grace period,
 *         unknown appId, inactive object.
 * Runs against SQLite in-memory (tmp file) to keep tests hermetic.
 *
 * app-secret 鉴权测试 — TDD 先写测试，再实现。
 * 测试内容：有效密钥 / 无效密钥 / 轮换宽限期 / 未知 appId / 停用对象。
 */

import fs from "node:fs";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import bcrypt from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let tmpDir: string;
let tenantId: string;

function mockReq(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "app-secret-test-"));
  process.env.ENCLAWS_DB_URL = `sqlite:///${tmpDir}/test.db`;

  const { initDb } = await import("../db/index.js");
  initDb();

  const { createTenant } = await import("../db/models/tenant.js");
  const t = await createTenant({ name: "Auth Test Tenant" });
  tenantId = t.id;
});

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

describe("app-secret auth", () => {
  it("validates active appSecret and returns tenant context", async () => {
    const { createCsApiObject } = await import("../db/models/cs-api-object.js");
    const { tryAppSecretAuth } = await import("./app-secret.js");

    const secret = "agnr_secret_test123";
    const hash = await bcrypt.hash(secret, 10);
    const obj = await createCsApiObject({
      tenantId,
      name: "T",
      agentId: "a",
      appSecretHash: hash,
      endpointUrl: "u",
    });

    const result = await tryAppSecretAuth(
      mockReq({ authorization: `Bearer ${secret}` }),
      obj.appId,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tenant.tenantId).toBe(tenantId);
    }
  });

  it("rejects invalid secret", async () => {
    const { createCsApiObject } = await import("../db/models/cs-api-object.js");
    const { tryAppSecretAuth } = await import("./app-secret.js");

    const hash = await bcrypt.hash("right", 10);
    const obj = await createCsApiObject({
      tenantId,
      name: "T",
      agentId: "a",
      appSecretHash: hash,
      endpointUrl: "u",
    });

    const result = await tryAppSecretAuth(mockReq({ authorization: "Bearer wrong" }), obj.appId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_APP_SECRET");
    }
  });

  it("accepts old secret during rotation grace period", async () => {
    const { createCsApiObject, rotateCsApiObjectSecret } =
      await import("../db/models/cs-api-object.js");
    const { tryAppSecretAuth } = await import("./app-secret.js");

    const oldSec = "old_sec";
    const newSec = "new_sec";
    const oldHash = await bcrypt.hash(oldSec, 10);
    const newHash = await bcrypt.hash(newSec, 10);
    const obj = await createCsApiObject({
      tenantId,
      name: "T",
      agentId: "a",
      appSecretHash: oldHash,
      endpointUrl: "u",
    });
    await rotateCsApiObjectSecret(obj.id, tenantId, newHash, new Date(Date.now() + 60_000));

    // Old secret still works during grace period
    const r1 = await tryAppSecretAuth(mockReq({ authorization: `Bearer ${oldSec}` }), obj.appId);
    expect(r1.ok).toBe(true);

    // New secret also works
    const r2 = await tryAppSecretAuth(mockReq({ authorization: `Bearer ${newSec}` }), obj.appId);
    expect(r2.ok).toBe(true);
  });

  it("returns OBJECT_NOT_FOUND for unknown appId", async () => {
    const { tryAppSecretAuth } = await import("./app-secret.js");

    const result = await tryAppSecretAuth(
      mockReq({ authorization: "Bearer x" }),
      "agnr_nonexistent",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("OBJECT_NOT_FOUND");
    }
  });

  it("returns OBJECT_INACTIVE when isActive=false", async () => {
    const { createCsApiObject, updateCsApiObject } = await import("../db/models/cs-api-object.js");
    const { tryAppSecretAuth } = await import("./app-secret.js");

    const sec = "s";
    const hash = await bcrypt.hash(sec, 10);
    const obj = await createCsApiObject({
      tenantId,
      name: "T",
      agentId: "a",
      appSecretHash: hash,
      endpointUrl: "u",
    });
    await updateCsApiObject(obj.id, tenantId, { isActive: false });

    const result = await tryAppSecretAuth(mockReq({ authorization: `Bearer ${sec}` }), obj.appId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("OBJECT_INACTIVE");
    }
  });

  it("returns MISSING_AUTH when Authorization header is absent", async () => {
    const { tryAppSecretAuth } = await import("./app-secret.js");
    const result = await tryAppSecretAuth(mockReq({}), "agnr_irrelevant");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("MISSING_AUTH");
    }
  });
});
