import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tenantDir: "",
  storePath: "",
  sync: vi.fn(async () => {}),
  createAuditLog: vi.fn(async () => {}),
  movePathToTrash: vi.fn(async (target: string) => target),
}));

vi.mock("../../db/index.js", () => ({
  isDbInitialized: vi.fn(() => true),
}));

vi.mock("../../db/models/audit-log.js", () => ({
  createAuditLog: mocks.createAuditLog,
}));

vi.mock("../../db/models/tenant.js", () => ({
  getTenantById: vi.fn(async () => ({ id: "tenant-1", name: "Tenant", identityPrompt: "" })),
  updateTenant: vi.fn(async () => ({ id: "tenant-1", name: "Tenant", identityPrompt: "" })),
}));

vi.mock("../../config/sessions/tenant-paths.js", () => ({
  resolveTenantDir: vi.fn(() => mocks.tenantDir),
  resolveTenantMemoryIndexPath: vi.fn(() => mocks.storePath),
}));

vi.mock("../tenant-session-utils.js", () => ({
  resolveRequestConfig: vi.fn(async () => ({})),
}));

vi.mock("../../memory/index.js", () => ({
  getMemorySearchManager: vi.fn(async () => ({
    manager: {
      sync: mocks.sync,
      status: () => ({ chunks: 0, sourceCounts: [] }),
    },
  })),
}));

vi.mock("../../browser/trash.js", () => ({
  movePathToTrash: mocks.movePathToTrash,
}));

const { tenantSettingsHandlers } = await import("./tenant-settings-api.js");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function invokeTenantMemory(
  method: keyof typeof tenantSettingsHandlers,
  params: Record<string, unknown>,
) {
  const respond = vi.fn();
  const promise = tenantSettingsHandlers[method]({
    req: { type: "req", id: "1", method },
    params,
    client: {
      connect: { client: "webchat", version: "test" },
      tenant: {
        tenantId: "tenant-1",
        userId: "user-1",
        role: "owner",
        email: "owner@example.com",
      },
    } as never,
    isWebchatConnect: () => false,
    respond,
    context: {} as never,
  });
  return { respond, promise };
}

describe("tenant.memory handlers", () => {
  beforeEach(async () => {
    mocks.tenantDir = await fs.mkdtemp(path.join(os.tmpdir(), "tenant-memory-test-"));
    mocks.storePath = path.join(mocks.tenantDir, "index.sqlite");
    mocks.sync.mockReset();
    mocks.sync.mockResolvedValue(undefined);
    mocks.createAuditLog.mockClear();
    mocks.movePathToTrash.mockReset();
    mocks.movePathToTrash.mockImplementation(async (target: string) => {
      await fs.rm(target, { force: true });
      return target;
    });
  });

  afterEach(async () => {
    await fs.rm(mocks.tenantDir, { recursive: true, force: true });
  });

  it("accepts Chinese enterprise knowledge filenames", async () => {
    const { respond, promise } = await invokeTenantMemory("tenant.memory.file.set", {
      name: "memory/报关资料.md",
      content: "hello",
    });
    await promise;

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        file: expect.objectContaining({ name: "memory/报关资料.md" }),
      }),
    );
    await expect(
      fs.readFile(path.join(mocks.tenantDir, "memory", "报关资料.md"), "utf-8"),
    ).resolves.toBe("hello");
  });

  it("responds to enterprise uploads before index sync completes", async () => {
    const gate = deferred();
    mocks.sync.mockReturnValueOnce(gate.promise);

    const { respond, promise } = await invokeTenantMemory("tenant.memory.file.set", {
      name: "memory/快速上传.md",
      content: "hello",
    });

    await vi.waitFor(
      () =>
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            ok: true,
            file: expect.objectContaining({ name: "memory/快速上传.md" }),
          }),
        ),
      { timeout: 500 },
    );

    gate.resolve();
    await promise;
  });

  it("responds to enterprise deletes before index sync completes", async () => {
    const target = path.join(mocks.tenantDir, "memory", "快速删除.md");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "hello", "utf-8");
    const gate = deferred();
    mocks.sync.mockReturnValueOnce(gate.promise);

    const { respond, promise } = await invokeTenantMemory("tenant.memory.delete", {
      name: "memory/快速删除.md",
    });

    await vi.waitFor(
      () =>
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            ok: true,
            name: "memory/快速删除.md",
          }),
        ),
      { timeout: 500 },
    );

    gate.resolve();
    await promise;
  });
});
