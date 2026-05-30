/**
 * Unit tests for per-widget agentId resolution (P5-T3b widget runtime wiring).
 *
 * The embedded widget forwards its `data-widget-id` as `widgetId` on cs.widget.send.
 * The gateway resolves the bound agentId from CSConfig.channels via this pure helper,
 * then passes it into runCSAgentReply. Fallback (return undefined) preserves S1:
 * runCSAgentReply uses the tenant/global default agent when agentId is omitted.
 *
 * 每 widget agentId 解析单测（P5-T3b widget 运行时打通）。嵌入 widget 把
 * data-widget-id 作为 widgetId 随 cs.widget.send 上送；gateway 用此纯函数从
 * CSConfig.channels 解析绑定 agentId，再传入 runCSAgentReply。回退（返回
 * undefined）保留 S1：缺省时 runCSAgentReply 使用租户/全局默认 agent。
 */

import { describe, expect, it } from "vitest";
import type { CSConfig } from "./cs-admin.js";
import { resolveWidgetAgentId } from "./cs-admin.js";

type Channels = NonNullable<CSConfig["channels"]>;

const channels: Channels = [
  { id: "ch_alpha", label: "Alpha", html: "<cs-widget></cs-widget>", agentId: "cs-alpha-agent", enabled: true },
  { id: "ch_beta", label: "Beta", html: "<cs-widget></cs-widget>", enabled: true }, // agentId unset
  { id: "ch_disabled", label: "Disabled", html: "<cs-widget></cs-widget>", agentId: "cs-disabled-agent", enabled: false },
];

describe("resolveWidgetAgentId", () => {
  it("returns the bound agentId when widgetId matches a channel with agentId set", () => {
    expect(resolveWidgetAgentId(channels, "ch_alpha")).toBe("cs-alpha-agent");
  });

  it("returns undefined when the matched channel has no agentId (→ default agent, S1)", () => {
    expect(resolveWidgetAgentId(channels, "ch_beta")).toBeUndefined();
  });

  it("returns undefined when widgetId matches no channel (→ default agent, S1)", () => {
    expect(resolveWidgetAgentId(channels, "ch_unknown")).toBeUndefined();
  });

  it("returns undefined when widgetId is absent/empty (→ default agent, S1)", () => {
    expect(resolveWidgetAgentId(channels, undefined)).toBeUndefined();
    expect(resolveWidgetAgentId(channels, "")).toBeUndefined();
  });

  it("returns undefined when channels is undefined (legacy config, no widgets)", () => {
    expect(resolveWidgetAgentId(undefined, "ch_alpha")).toBeUndefined();
  });

  it("soft isolation: a disabled widget still resolves its bound agentId (no hard block in T3b)", () => {
    // Per decision, T3b does NOT hard-block disabled widgets at runtime; resolution
    // is independent of enabled. Hard-disable enforcement is out of scope.
    // 决策：T3b 不在运行时硬阻断已禁用 widget；解析与 enabled 无关，硬禁用属范围外。
    expect(resolveWidgetAgentId(channels, "ch_disabled")).toBe("cs-disabled-agent");
  });
});
