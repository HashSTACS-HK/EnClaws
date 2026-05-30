/**
 * Handler-level wiring test for per-widget agentId (P5-T3b widget runtime).
 *
 * Proves the end-to-end seam: cs.widget.send receives `widgetId` → the handler
 * resolves the bound agentId from CSConfig.channels → passes it into
 * runCSAgentReply. Fallback (no widgetId / unmatched / unbound) omits agentId so
 * the runner uses the tenant default (S1 unchanged).
 *
 * cs.widget.send 收到 widgetId → 处理器从 CSConfig.channels 解析绑定 agentId →
 * 传入 runCSAgentReply。回退（无 widgetId / 不匹配 / 未绑定）不带 agentId，runner
 * 使用租户默认 agent（保持 S1）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the RAG runner so no real LLM / RAG stack is hit; assert its call args.
// モック runCSAgentReply：不触达真实 LLM/RAG，仅断言调用参数。
vi.mock("../../customer-service/rag/cs-agent-runner.js", () => ({
  runCSAgentReply: vi.fn().mockResolvedValue({ reply: "ok reply", sourceChunks: [] }),
}));

// Widget path loads tenant config directly (visitor connection, no user auth).
// Widget 路径直接加载租户 config（游客连接，无用户 auth）。
vi.mock("../../config/tenant-config.js", () => ({
  loadTenantConfig: vi.fn().mockResolvedValue({}),
}));

// Stub DB models — no real DB. Session is AI_ACTIVE so transition → run_rag.
// 桩 DB 模型：无真实 DB。session 为 ai_active 使 transition → run_rag。
vi.mock("../../db/models/cs-session.js", () => ({
  findActiveCSSession: vi.fn().mockResolvedValue({
    id: "sess-1",
    tenantId: "tenant-1",
    visitorId: "visitor-1",
    visitorName: null,
    state: "ai_active",
    channel: "web_widget",
    tags: [],
    identityAnchors: {},
    metadata: {},
    assignedTo: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    closedAt: null,
  }),
  createCSSession: vi.fn(),
  updateCSSessionNotifiedAt: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../db/models/cs-message.js", () => ({
  createCSMessage: vi.fn().mockResolvedValue({ id: "msg-1" }),
  // prior messages non-empty → not first message → no Feishu notify path branching
  listCSMessages: vi.fn().mockResolvedValue([{ id: "prior" }]),
}));

// Control the resolved CS config (channels) without touching disk.
// vi.hoisted so the mock fn exists before the hoisted vi.mock factory runs.
// 控制 readCSConfig 返回的 channels，不读盘。用 vi.hoisted 让 mock 在工厂提升前就存在。
const { readCSConfigMock } = vi.hoisted(() => ({ readCSConfigMock: vi.fn() }));
vi.mock("./cs-admin.js", async (importOriginal) => {
  // Keep the REAL resolveWidgetAgentId (pure) and only stub readCSConfig.
  // 保留真实的 resolveWidgetAgentId（纯函数），仅桩 readCSConfig。
  const actual = await importOriginal<typeof import("./cs-admin.js")>();
  return { ...actual, readCSConfig: readCSConfigMock };
});

import { runCSAgentReply } from "../../customer-service/rag/cs-agent-runner.js";
import { csWidgetHandlers } from "./cs-widget.js";

const runCSAgentReplyMock = vi.mocked(runCSAgentReply);

const channels = [
  { id: "ch_bound", label: "Bound", html: "<cs-widget></cs-widget>", agentId: "cs-bound-agent", enabled: true },
  { id: "ch_unbound", label: "Unbound", html: "<cs-widget></cs-widget>", enabled: true },
];

// Minimal handler invocation harness: captures the respond() outcome.
// 最小处理器调用脚手架：捕获 respond() 结果。
async function invokeSend(params: Record<string, unknown>) {
  let okResult: { ok: boolean; payload?: unknown; error?: unknown } | undefined;
  const respond = (ok: boolean, payload?: unknown, error?: unknown) => {
    okResult = { ok, payload, error };
  };
  await csWidgetHandlers["cs.widget.send"]({
    req: {} as never,
    params,
    client: null,
    isWebchatConnect: () => false,
    respond,
    context: {} as never,
  });
  return okResult;
}

describe("cs.widget.send → per-widget agentId wiring (P5-T3b)", () => {
  beforeEach(() => {
    readCSConfigMock.mockResolvedValue({ channels });
    runCSAgentReplyMock.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("passes the bound agentId to runCSAgentReply when widgetId matches a bound channel", async () => {
    const result = await invokeSend({
      tenantId: "tenant-1",
      visitorId: "visitor-1",
      text: "hello",
      widgetId: "ch_bound",
    });

    expect(result?.ok).toBe(true);
    expect(runCSAgentReplyMock).toHaveBeenCalledTimes(1);
    expect(runCSAgentReplyMock.mock.calls[0][0]).toMatchObject({ agentId: "cs-bound-agent" });
  });

  it("omits agentId (undefined) when widgetId matches an unbound channel → default agent (S1)", async () => {
    await invokeSend({
      tenantId: "tenant-1",
      visitorId: "visitor-1",
      text: "hello",
      widgetId: "ch_unbound",
    });

    expect(runCSAgentReplyMock).toHaveBeenCalledTimes(1);
    expect(runCSAgentReplyMock.mock.calls[0][0].agentId).toBeUndefined();
  });

  it("omits agentId when widgetId is absent → default agent (S1 preserved for legacy embeds)", async () => {
    await invokeSend({
      tenantId: "tenant-1",
      visitorId: "visitor-1",
      text: "hello",
    });

    expect(runCSAgentReplyMock).toHaveBeenCalledTimes(1);
    expect(runCSAgentReplyMock.mock.calls[0][0].agentId).toBeUndefined();
  });

  it("omits agentId when widgetId matches no channel → default agent (S1)", async () => {
    await invokeSend({
      tenantId: "tenant-1",
      visitorId: "visitor-1",
      text: "hello",
      widgetId: "ch_does_not_exist",
    });

    expect(runCSAgentReplyMock).toHaveBeenCalledTimes(1);
    expect(runCSAgentReplyMock.mock.calls[0][0].agentId).toBeUndefined();
  });
});
