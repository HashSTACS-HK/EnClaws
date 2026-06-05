import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let tmpDir: string;
let tenantId: string;
let ownerId: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "embed-sso-test-"));
  process.env.ENCLAWS_DB_URL = `sqlite:///${tmpDir}/test.db`;

  const { initDb } = await import("../db/index.js");
  initDb();

  const { createTenant } = await import("../db/models/tenant.js");
  const { createUser } = await import("../db/models/user.js");
  const tenant = await createTenant({ name: "Embed SSO Tenant" });
  tenantId = tenant.id;
  const owner = await createUser(
    {
      tenantId,
      email: "owner@example.com",
      displayName: "Owner",
      role: "owner",
    },
    { skipDirInit: true },
  );
  ownerId = owner.id;
});

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

describe("embed sso", () => {
  it("creates an active key but only returns the raw key once", async () => {
    const { createEmbedSsoKey, listEmbedSsoKeys } = await import("./embed-sso.js");

    const created = await createEmbedSsoKey({ tenantId, createdBy: ownerId });
    expect(created.key).toMatch(/^agnr_embed_/);
    expect(created.record.keyPrefix).toBe(created.key.slice(0, 20));
    expect(created.record.isActive).toBe(true);

    const listed = await listEmbedSsoKeys(tenantId);
    expect(listed).toEqual([
      expect.objectContaining({
        id: created.record.id,
        keyPrefix: created.record.keyPrefix,
        isActive: true,
      }),
    ]);
    expect(JSON.stringify(listed)).not.toContain(created.key);
  });

  it("issues and consumes one-time login tokens", async () => {
    const { consumeEmbedSsoToken, createEmbedSsoKey, issueEmbedSsoToken, listEmbedSsoKeys } =
      await import("./embed-sso.js");

    const created = await createEmbedSsoKey({ tenantId, createdBy: ownerId });
    const issued = await issueEmbedSsoToken({
      apiKey: created.key,
      tenantId,
      externalUserId: "jiumi-admin",
      displayName: "九米管理员",
      targetPath: "/cs-api-management",
    });
    expect(issued.token).toMatch(/^sso_/);
    expect(issued.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const consumed = await consumeEmbedSsoToken(issued.token);
    expect(consumed.tenantId).toBe(tenantId);
    expect(consumed.user.displayName).toBe("九米管理员");
    expect(consumed.user.role).toBe("admin");
    expect(consumed.targetPath).toBe("/cs-api-management");

    await expect(consumeEmbedSsoToken(issued.token)).rejects.toThrow(/expired or consumed/i);

    const listed = await listEmbedSsoKeys(tenantId);
    expect(listed.find((item) => item.id === created.record.id)?.usageCount).toBe(1);
  });

  it("rejects disabled keys", async () => {
    const { createEmbedSsoKey, issueEmbedSsoToken, revokeEmbedSsoKey } =
      await import("./embed-sso.js");

    const created = await createEmbedSsoKey({ tenantId, createdBy: ownerId });
    await revokeEmbedSsoKey({ tenantId, keyId: created.record.id });

    await expect(
      issueEmbedSsoToken({
        apiKey: created.key,
        tenantId,
        externalUserId: "disabled-key-user",
      }),
    ).rejects.toThrow(/invalid embed sso api key/i);
  });
});
