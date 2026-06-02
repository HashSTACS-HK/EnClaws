import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runEmbeddedPiAgentMock = vi.hoisted(() => vi.fn());

vi.mock("../../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: runEmbeddedPiAgentMock,
}));

vi.mock("../../agents/model-fallback.js", () => ({
  runWithModelFallback: vi.fn(
    async (params: {
      provider: string;
      model: string;
      run: (provider: string, model: string) => Promise<unknown>;
    }) => ({
      result: await params.run(params.provider, params.model),
      provider: params.provider,
      model: params.model,
      attempts: [],
    }),
  ),
}));

vi.mock("../../memory/search-manager.js", () => ({
  getMemorySearchManager: vi.fn().mockResolvedValue({
    manager: { search: vi.fn().mockResolvedValue([]) },
  }),
}));

vi.mock("../../db/models/tenant.js", () => ({
  getTenantById: vi.fn().mockResolvedValue({ id: "tenant-jiumi", name: "九米" }),
}));

describe("runCSAgentReply", () => {
  let stateDir: string;
  let previousStateDir: string | undefined;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "enclaws-cs-runner-"));
    previousStateDir = process.env.ENCLAWS_STATE_DIR;
    process.env.ENCLAWS_STATE_DIR = stateDir;
    runEmbeddedPiAgentMock.mockReset();
    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "业务回复 [confidence:0.9]" }],
      meta: {
        durationMs: 1,
        agentMeta: {
          sessionId: "embedded-session",
          provider: "test-provider",
          model: "test-model",
          usage: { input: 10, output: 5, total: 15 },
        },
      },
    });
  });

  afterEach(() => {
    if (previousStateDir === undefined) {
      delete process.env.ENCLAWS_STATE_DIR;
    } else {
      process.env.ENCLAWS_STATE_DIR = previousStateDir;
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("passes tenant skills to the embedded agent as a skills snapshot", async () => {
    const skillDir = path.join(
      stateDir,
      "tenants",
      "tenant-jiumi",
      "skills",
      "jiumi-customs-order-query",
    );
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: jiumi-customs-order-query",
        "description: Use when answering Jiumi customs declaration questions.",
        "---",
        "",
        "# 九米报关订单信息查询",
      ].join("\n"),
    );

    const { runCSAgentReply } = await import("./cs-agent-runner.js");

    await runCSAgentReply({
      tenantId: "tenant-jiumi",
      sessionId: "session-001",
      customerMessage: "我的报关单提交了，但一直没有回音",
      cfg: {},
      agentId: "my-first-agent",
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const call = runEmbeddedPiAgentMock.mock.calls[0]?.[0] as {
      skillsSnapshot?: { skills?: Array<{ name?: string }> };
    };
    expect(call.skillsSnapshot?.skills?.map((skill) => skill.name)).toContain(
      "jiumi-customs-order-query",
    );
  });

  it("returns the Jiumi customs slot question before calling the model when declarationId is missing", async () => {
    const { runCSAgentReply } = await import("./cs-agent-runner.js");

    const result = await runCSAgentReply({
      tenantId: "tenant-jiumi",
      sessionId: "session-slot-001",
      customerMessage: "我的报关单提交了，但一直没有回音",
      cfg: {},
      agentId: "my-first-agent",
      businessMetadata: { business: "customs", customs: {} },
    });

    expect(result.reply).toBe("请提供报关订单号，我帮您查询当前申报状态。");
    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
  });
});
