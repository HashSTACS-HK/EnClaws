import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runEmbeddedPiAgentMock = vi.hoisted(() => vi.fn());
const listCSMessagesMock = vi.hoisted(() => vi.fn());

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
  getTenantById: vi.fn().mockResolvedValue({ id: "tenant-jiumi", name: "Jiumi" }),
}));

vi.mock("../../db/models/cs-message.js", () => ({
  listCSMessages: listCSMessagesMock,
}));

describe("runCSAgentReply", () => {
  let stateDir: string;
  let previousStateDir: string | undefined;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "enclaws-cs-runner-"));
    previousStateDir = process.env.ENCLAWS_STATE_DIR;
    process.env.ENCLAWS_STATE_DIR = stateDir;
    runEmbeddedPiAgentMock.mockReset();
    listCSMessagesMock.mockReset();
    listCSMessagesMock.mockResolvedValue([]);
    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "business reply [confidence:0.9]" }],
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
        "# Jiumi customs order query",
      ].join("\n"),
    );

    const { runCSAgentReply } = await import("./cs-agent-runner.js");

    await runCSAgentReply({
      tenantId: "tenant-jiumi",
      sessionId: "session-001",
      customerMessage: "submitted no reply",
      cfg: {},
      agentId: "my-first-agent",
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const call = runEmbeddedPiAgentMock.mock.calls[0]?.[0] as {
      promptMode?: string;
      skillsSnapshot?: { prompt?: string; skills?: Array<{ name?: string }> };
    };
    expect(call.promptMode).toBe("minimal");
    expect(call.skillsSnapshot?.skills?.map((skill) => skill.name)).toContain(
      "jiumi-customs-order-query",
    );
    expect(call.skillsSnapshot?.prompt).toContain("<name>jiumi-customs-order-query</name>");
  });

  it("returns the Jiumi customs slot question before calling the model when declarationId is missing", async () => {
    const { runCSAgentReply } = await import("./cs-agent-runner.js");

    const result = await runCSAgentReply({
      tenantId: "tenant-jiumi",
      sessionId: "session-slot-001",
      customerMessage: "submitted no reply",
      cfg: {},
      agentId: "my-first-agent",
      businessMetadata: { business: "customs", customs: {} },
    });

    expect(result.reply).toMatch(/\S/);
    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
  });

  it("includes recent CS conversation context so confirmation turns can resolve prior order numbers", async () => {
    listCSMessagesMock.mockResolvedValue([
      {
        role: "customer",
        content: "query BG20260528001 order status",
      },
      {
        role: "ai",
        content: "Please confirm customs order BG20260528001.",
      },
      {
        role: "customer",
        content: "yes",
      },
    ]);
    const { runCSAgentReply } = await import("./cs-agent-runner.js");

    await runCSAgentReply({
      tenantId: "tenant-jiumi",
      sessionId: "session-confirm-001",
      customerMessage: "yes",
      cfg: {},
      agentId: "my-first-agent",
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const call = runEmbeddedPiAgentMock.mock.calls[0]?.[0] as {
      extraSystemPrompt?: string;
      timeoutMs?: number;
    };
    expect(call.timeoutMs).toBe(90_000);
    expect(call.extraSystemPrompt).toContain("<customer_service_platform_policy>");
    expect(call.extraSystemPrompt).toContain("[confidence:X.XX]");
    expect(call.extraSystemPrompt).toContain("<customer_service_behavior_and_knowledge>");
    expect(call.extraSystemPrompt).toContain("<customer_service_conversation_context>");
    expect(call.extraSystemPrompt).toContain("query BG20260528001 order status");
    expect(call.extraSystemPrompt).toContain("Please confirm customs order BG20260528001.");
    expect(call.extraSystemPrompt).not.toContain("yes");
  });

  it("passes through all customer-visible assistant text payloads in order", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [
        { text: "User confirmed the customs order number, I will query it now." },
        {
          text:
            "Customs order BG20260528001 is waiting for inspection.\n\n" +
            "> Skills used: jiumi-customs-order-query",
        },
      ],
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
    const { runCSAgentReply } = await import("./cs-agent-runner.js");

    const result = await runCSAgentReply({
      tenantId: "tenant-jiumi",
      sessionId: "session-payload-passthrough-001",
      customerMessage: "confirm",
      cfg: {},
      agentId: "my-first-agent",
    });

    expect(result.replies).toEqual([
      "User confirmed the customs order number, I will query it now.",
      "Customs order BG20260528001 is waiting for inspection.",
    ]);
    expect(result.reply).toBe(
      [
        "User confirmed the customs order number, I will query it now.",
        "Customs order BG20260528001 is waiting for inspection.",
      ].join("\n\n"),
    );
  });
});
