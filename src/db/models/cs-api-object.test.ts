/**
 * cs-api-object model tests — TDD: write first, implement second.
 *
 * Covers: create / tenant isolation / secret rotation.
 * Runs against SQLite in-memory (tmp file) to keep tests hermetic.
 *
 * CS API Object 模型测试 — TDD 先写测试，再实现。
 * 测试内容：创建 / 租户隔离 / 密钥轮换。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Tenant } from "../types.js";

let tmpDir: string;
let tenantId: string;
let tenant1Id: string;
let tenant2Id: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-api-obj-test-"));
  process.env.ENCLAWS_DB_URL = `sqlite:///${tmpDir}/test.db`;

  const { initDb } = await import("../index.js");
  initDb();

  const { createTenant } = await import("./tenant.js");
  const [t, t1, t2] = await Promise.all([
    createTenant({ name: "Tenant Main" }),
    createTenant({ name: "Tenant 1" }),
    createTenant({ name: "Tenant 2" }),
  ]);
  tenantId = t.id;
  tenant1Id = t1.id;
  tenant2Id = t2.id;
});

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

describe("cs-api-object model", () => {
  it("creates an API Object scoped to tenant", async () => {
    const { createCsApiObject } = await import("./cs-api-object.js");
    const obj = await createCsApiObject({
      tenantId,
      name: "Test Object",
      agentId: "agent-1",
      appSecretHash: "$2b$10$test",
      endpointUrl: "https://example.com/cs-api",
    });
    expect(obj.appId).toMatch(/^agnr_/);
    expect(obj.isActive).toBe(true);
    expect(obj.tenantId).toBe(tenantId);
    expect(obj.name).toBe("Test Object");
    expect(obj.agentId).toBe("agent-1");
    expect(obj.endpointUrl).toBe("https://example.com/cs-api");
    expect(obj.appSecretHash).toBe("$2b$10$test");
  });

  it("fetches by appId without leaking other tenants", async () => {
    const { createCsApiObject, getCsApiObjectByAppId, listCsApiObjects } = await import("./cs-api-object.js");
    const o1 = await createCsApiObject({
      tenantId: tenant1Id,
      name: "A",
      agentId: "ag1",
      appSecretHash: "h",
      endpointUrl: "https://u1.example.com",
    });
    // create another object for tenant2 to confirm isolation
    await createCsApiObject({
      tenantId: tenant2Id,
      name: "B",
      agentId: "ag2",
      appSecretHash: "h2",
      endpointUrl: "https://u2.example.com",
    });

    const fetched = await getCsApiObjectByAppId(o1.appId);
    expect(fetched?.tenantId).toBe(tenant1Id);

    // tenant2 list should NOT include tenant1's object
    const list = await listCsApiObjects(tenant2Id);
    for (const item of list) {
      expect(item.tenantId).toBe(tenant2Id);
    }
  });

  it("rotates secret with grace period", async () => {
    const { createCsApiObject, rotateCsApiObjectSecret } = await import("./cs-api-object.js");
    const obj = await createCsApiObject({
      tenantId,
      name: "X",
      agentId: "a",
      appSecretHash: "old-hash",
      endpointUrl: "https://example.com",
    });
    const rotateUntil = new Date(Date.now() + 86400000);
    const rotated = await rotateCsApiObjectSecret(obj.id, "new-hash", rotateUntil);

    expect(rotated.appSecretHash).toBe("new-hash");
    expect(rotated.rotatingFromHash).toBe("old-hash");
    expect(rotated.rotatingUntil).toBeInstanceOf(Date);
    expect(rotated.rotatingUntil!.getTime()).toBeGreaterThan(Date.now());
  });
});
