import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  workspaceDir: "",
  defaultStorePath: "",
  sync: vi.fn(async () => {}),
  movePathToTrash: vi.fn(async (target: string) => target),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: () => ({}),
}));

vi.mock("../tenant-session-utils.js", () => ({
  resolveRequestConfig: vi.fn(async () => ({})),
}));

vi.mock("../../config/sessions/tenant-paths.js", () => ({
  resolveTenantAgentKnowledgeDir: vi.fn(() => mocks.workspaceDir),
  resolveTenantAgentMemoryIndexPath: vi.fn(() => mocks.defaultStorePath),
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

const { memoryHandlers } = await import("./memory.js");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function invokeMemory(method: keyof typeof memoryHandlers, params: Record<string, unknown>) {
  const respond = vi.fn();
  const promise = memoryHandlers[method]({
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

describe("agents.memory handlers", () => {
  beforeEach(async () => {
    mocks.workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-test-"));
    mocks.defaultStorePath = path.join(mocks.workspaceDir, "index.sqlite");
    mocks.sync.mockReset();
    mocks.sync.mockResolvedValue(undefined);
    mocks.movePathToTrash.mockReset();
    mocks.movePathToTrash.mockImplementation(async (target: string) => {
      await fs.rm(target, { force: true });
      return target;
    });
  });

  afterEach(async () => {
    await fs.rm(mocks.workspaceDir, { recursive: true, force: true });
  });

  it("accepts Chinese knowledge filenames", async () => {
    const { respond, promise } = await invokeMemory("agents.memory.set", {
      agentId: "my-first-agent",
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
      fs.readFile(path.join(mocks.workspaceDir, "memory", "报关资料.md"), "utf-8"),
    ).resolves.toBe("hello");
  });

  it("responds to uploads before index sync completes", async () => {
    const gate = deferred();
    mocks.sync.mockReturnValueOnce(gate.promise);

    const { respond, promise } = await invokeMemory("agents.memory.set", {
      agentId: "my-first-agent",
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

  it("responds to deletes before index sync completes", async () => {
    const target = path.join(mocks.workspaceDir, "memory", "快速删除.md");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "hello", "utf-8");
    const gate = deferred();
    mocks.sync.mockReturnValueOnce(gate.promise);

    const { respond, promise } = await invokeMemory("agents.memory.delete", {
      agentId: "my-first-agent",
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
