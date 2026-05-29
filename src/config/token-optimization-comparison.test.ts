import { describe, it, expect, afterEach } from "vitest";
import { estimateCharsPerToken } from "../agents/pi-extensions/context-pruning/pruner.js";
import { getEffectiveSoftTrimSettings } from "../agents/pi-extensions/context-pruning/settings.js";
import { buildAgentSystemPrompt } from "../agents/system-prompt.js";
import {
  buildInboundMetaSystemPrompt,
  buildInboundUserContextPrefix,
} from "../auto-reply/reply/inbound-meta.js";

// Helper: rough token estimate (chars / 4)
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const TOGGLE_KEYS = [
  "ENCLAWS_TOKEN_OPT_P1",
  "ENCLAWS_TOKEN_OPT_CACHE",
  "ENCLAWS_TOKEN_OPT_TRIM",
  "ENCLAWS_TOKEN_OPT_WORKER",
  "ENCLAWS_TOKEN_OPT_COMPRESS",
  "ENCLAWS_TOKEN_OPT_DEDUP",
  "ENCLAWS_TOKEN_OPT_TOOLSYNC",
  "ENCLAWS_TOKEN_OPT_PROMPT",
  "ENCLAWS_TOKEN_OPT_TOOLLIST",
] as const;

/** Set all toggles to "false" to simulate the pre-optimization baseline. */
function disableAllToggles() {
  for (const key of TOGGLE_KEYS) {
    process.env[key] = "false";
  }
}

describe("Token Optimization Comparison Tests", () => {
  afterEach(() => {
    for (const key of TOGGLE_KEYS) {
      delete process.env[key];
    }
  });

  // ============================================================
  // Section A: Output length comparison
  // ============================================================
  describe("A: Output length reduction", () => {
    it("OPT-3: inbound meta system prompt is shorter with P1 enabled", () => {
      // Cast as any to satisfy TemplateContext — these are the fields the function actually reads
      const ctx = {
        OriginatingTo: "telegram:12345",
        OriginatingChannel: "telegram",
        Provider: "anthropic",
        Surface: "telegram",
        ChatType: "direct",
      } as any;

      disableAllToggles();
      const originalOutput = buildInboundMetaSystemPrompt(ctx);

      delete process.env.ENCLAWS_TOKEN_OPT_P1;
      const optimizedOutput = buildInboundMetaSystemPrompt(ctx);

      const originalTokens = estimateTokens(originalOutput);
      const optimizedTokens = estimateTokens(optimizedOutput);

      console.log(
        `[OPT-3 meta] Original: ${originalTokens} tokens, Optimized: ${optimizedTokens} tokens, Saved: ${originalTokens - optimizedTokens} (${Math.round((1 - optimizedTokens / originalTokens) * 100)}%)`,
      );

      expect(optimizedTokens).toBeLessThan(originalTokens);
    });

    it("OPT-3: inbound user context prefix is shorter with P1 enabled (group chat)", () => {
      const ctx = {
        ChatType: "group",
        MessageSid: "msg-abc-123",
        OriginatingTo: "telegram:12345",
        OriginatingChannel: "telegram",
        Provider: "anthropic",
        SenderName: "Alice",
        SenderNumber: "+1234567890",
        InboundHistory: [
          { sender: "Bob", timestamp: 1700000000000, body: "Hello everyone" },
          { sender: "Alice", timestamp: 1700000001000, body: "Hi Bob!" },
        ],
        ThreadStarterBody: "Original thread message",
      } as any;

      disableAllToggles();
      const originalOutput = buildInboundUserContextPrefix(ctx);

      delete process.env.ENCLAWS_TOKEN_OPT_P1;
      const optimizedOutput = buildInboundUserContextPrefix(ctx);

      const originalTokens = estimateTokens(originalOutput);
      const optimizedTokens = estimateTokens(optimizedOutput);

      console.log(
        `[OPT-3 user ctx] Original: ${originalTokens} tokens, Optimized: ${optimizedTokens} tokens, Saved: ${originalTokens - optimizedTokens} (${Math.round((1 - optimizedTokens / originalTokens) * 100)}%)`,
      );

      expect(optimizedTokens).toBeLessThan(originalTokens);
    });

    it("OPT-1: system prompt memory section is shorter with P1 enabled", () => {
      const baseParams = {
        workspaceDir: "/tmp/test",
        toolNames: ["memory_search", "memory_get", "exec"],
      };

      disableAllToggles();
      const originalPrompt = buildAgentSystemPrompt(baseParams);

      delete process.env.ENCLAWS_TOKEN_OPT_P1;
      const optimizedPrompt = buildAgentSystemPrompt(baseParams);

      const originalTokens = estimateTokens(originalPrompt);
      const optimizedTokens = estimateTokens(optimizedPrompt);

      console.log(
        `[OPT-1 system prompt] Original: ${originalTokens} tokens, Optimized: ${optimizedTokens} tokens, Saved: ${originalTokens - optimizedTokens} (${Math.round((1 - optimizedTokens / originalTokens) * 100)}%)`,
      );

      expect(optimizedTokens).toBeLessThan(originalTokens);
    });

    it("OPT-6: softTrim thresholds are more aggressive with TRIM enabled", () => {
      disableAllToggles();
      const defaultExec = getEffectiveSoftTrimSettings("exec");
      expect(defaultExec.maxChars).toBe(4_000);

      delete process.env.ENCLAWS_TOKEN_OPT_TRIM;
      const optimizedExec = getEffectiveSoftTrimSettings("exec");
      const optimizedWebFetch = getEffectiveSoftTrimSettings("web_fetch");

      expect(optimizedExec.maxChars).toBeLessThan(defaultExec.maxChars);
      expect(optimizedWebFetch.maxChars).toBeLessThan(defaultExec.maxChars);

      console.log(
        `[OPT-6] exec: ${defaultExec.maxChars} → ${optimizedExec.maxChars}, web_fetch: → ${optimizedWebFetch.maxChars}`,
      );
    });
  });

  // ============================================================
  // Section B: Behavioral correctness
  // ============================================================
  describe("B: Behavioral correctness", () => {
    it("OPT-1: Memory section uses conditional text when P1 is on", () => {
      const params = {
        workspaceDir: "/tmp/test",
        toolNames: ["memory_search", "memory_get"],
      };

      disableAllToggles();
      const original = buildAgentSystemPrompt(params);
      expect(original).toContain("you MUST run `memory_search`");
      expect(original).not.toContain("Search memory ONLY when");

      delete process.env.ENCLAWS_TOKEN_OPT_P1;
      const optimized = buildAgentSystemPrompt(params);
      expect(optimized).toContain("Search memory ONLY when");
      expect(optimized).not.toContain("you MUST run `memory_search`");
    });

    it("OPT-3: JSON is compact (no newlines in JSON body) when P1 is on", () => {
      const ctx = {
        OriginatingTo: "telegram:12345",
        OriginatingChannel: "telegram",
        Provider: "anthropic",
        Surface: "telegram",
        ChatType: "direct",
      } as any;

      disableAllToggles();
      const original = buildInboundMetaSystemPrompt(ctx);
      expect(original).toContain("```json");
      expect(original).toContain('"schema": "enclaws.inbound_meta.v1"');

      delete process.env.ENCLAWS_TOKEN_OPT_P1;
      const optimized = buildInboundMetaSystemPrompt(ctx);
      expect(optimized).not.toContain("```json");
      expect(optimized).toContain('"schema":"enclaws.inbound_meta.v1"');
    });

    it("OPT-3: labels are simplified when P1 is on", () => {
      const ctx = {
        ChatType: "group",
        MessageSid: "msg-123",
        SenderName: "Alice",
        InboundHistory: [{ sender: "Bob", timestamp: 1700000000000, body: "Hi" }],
      } as any;

      disableAllToggles();
      const original = buildInboundUserContextPrefix(ctx);
      expect(original).toContain("Chat history since last reply (untrusted, for context):");

      delete process.env.ENCLAWS_TOKEN_OPT_P1;
      const optimized = buildInboundUserContextPrefix(ctx);
      expect(optimized).toContain("Chat history:");
      expect(optimized).not.toContain("untrusted");
    });

    it("OPT-3: header is simplified when P1 is on", () => {
      const ctx = {
        OriginatingTo: "telegram:12345",
        OriginatingChannel: "telegram",
        Provider: "anthropic",
        Surface: "telegram",
      } as any;

      disableAllToggles();
      const original = buildInboundMetaSystemPrompt(ctx);
      expect(original).toContain("## Inbound Context (trusted metadata)");

      delete process.env.ENCLAWS_TOKEN_OPT_P1;
      const optimized = buildInboundMetaSystemPrompt(ctx);
      expect(optimized).toContain("## Inbound Context (trusted)");
      expect(optimized).not.toContain("trusted metadata");
    });

    it("OPT-4+5: extraSystemPrompt appears at the end when CACHE is on", () => {
      const marker = "THIS_IS_DYNAMIC_EXTRA_CONTENT";
      const params = {
        workspaceDir: "/tmp/test",
        extraSystemPrompt: marker,
      };

      disableAllToggles();
      const original = buildAgentSystemPrompt(params);
      const originalMarkerIdx = original.indexOf(marker);
      const originalRuntimeIdx = original.indexOf("## Runtime");
      // In original, marker should be BEFORE Runtime section
      expect(originalMarkerIdx).toBeLessThan(originalRuntimeIdx);

      delete process.env.ENCLAWS_TOKEN_OPT_CACHE;
      const optimized = buildAgentSystemPrompt(params);
      const optimizedMarkerIdx = optimized.indexOf(marker);
      const optimizedSkillsReportIdx = optimized.indexOf("## Skills Reporting");
      // In optimized, marker should be AFTER Skills Reporting (at the very end)
      expect(optimizedMarkerIdx).toBeGreaterThan(optimizedSkillsReportIdx);
    });

    it("OPT-2: CJK text gets lower chars-per-token estimate", () => {
      expect(estimateCharsPerToken("Hello world, this is English text")).toBe(4);
      expect(estimateCharsPerToken("这是一段中文文本，用于测试字符估算")).toBe(2);
      expect(estimateCharsPerToken("Hello 你好")).toBe(4); // low CJK ratio
      expect(estimateCharsPerToken("你好世界test")).toBe(2); // high CJK ratio >30%
    });

    it("OPT-6: different tools get different trim thresholds when TRIM is on", () => {
      // TRIM is on by default now, no need to set env var
      const exec = getEffectiveSoftTrimSettings("exec");
      const webFetch = getEffectiveSoftTrimSettings("web_fetch");
      const other = getEffectiveSoftTrimSettings("some_other_tool");

      expect(exec.maxChars).toBe(2_500);
      expect(webFetch.maxChars).toBe(2_000);
      expect(other.maxChars).toBe(4_000); // default unchanged
    });

    it("all toggles are independent — disabling one does not affect others", () => {
      // Disable only CACHE and TRIM, leave everything else at default (on)
      process.env.ENCLAWS_TOKEN_OPT_CACHE = "false";
      process.env.ENCLAWS_TOKEN_OPT_TRIM = "false";

      const params = {
        workspaceDir: "/tmp/test",
        extraSystemPrompt: "MARKER_CONTENT",
      };

      const prompt = buildAgentSystemPrompt(params);
      // With CACHE off, extraSystemPrompt should be in original position
      const markerIdx = prompt.indexOf("MARKER_CONTENT");
      const runtimeIdx = prompt.indexOf("## Runtime");
      expect(markerIdx).toBeLessThan(runtimeIdx);

      // softTrim should be default (TRIM is off)
      const exec = getEffectiveSoftTrimSettings("exec");
      expect(exec.maxChars).toBe(4_000);
    });
  });

  // ============================================================
  // Section C: Summary report (informational)
  // ============================================================
  describe("C: Token savings summary", () => {
    it("prints overall comparison report", () => {
      const systemParams = {
        workspaceDir: "/tmp/test",
        toolNames: ["memory_search", "memory_get", "exec", "web_fetch"],
        extraSystemPrompt:
          "## Group Chat Context\nchat_id: test-group\nchannel: telegram\nprovider: anthropic\nsurface: telegram\nchat_type: group\ngroup_name: Test Group\nparticipants: Alice, Bob, Charlie",
      };

      const metaCtx = {
        OriginatingTo: "telegram:12345",
        OriginatingChannel: "telegram",
        Provider: "anthropic",
        Surface: "telegram",
        ChatType: "group",
        MessageSid: "msg-abc-123",
        SenderName: "Alice",
        SenderNumber: "+1234567890",
        InboundHistory: [
          {
            sender: "Bob",
            timestamp: 1700000000000,
            body: "Hello everyone, let's discuss the project",
          },
          {
            sender: "Charlie",
            timestamp: 1700000001000,
            body: "Sure, I have some updates to share",
          },
          { sender: "Alice", timestamp: 1700000002000, body: "Great, let me check my notes first" },
        ],
        ThreadStarterBody: "Project discussion thread",
      } as any;

      // === Original (all off) ===
      disableAllToggles();
      const origSystem = buildAgentSystemPrompt(systemParams);
      const origMeta = buildInboundMetaSystemPrompt(metaCtx);
      const origUserCtx = buildInboundUserContextPrefix(metaCtx);

      // === Optimized (all on — default) ===
      for (const key of TOGGLE_KEYS) {
        delete process.env[key];
      }

      const optSystem = buildAgentSystemPrompt(systemParams);
      const optMeta = buildInboundMetaSystemPrompt(metaCtx);
      const optUserCtx = buildInboundUserContextPrefix(metaCtx);

      const report = [
        "",
        "╔══════════════════════════════════════════════════════╗",
        "║       Token Optimization Phase 1+2 Report           ║",
        "╚══════════════════════════════════════════════════════╝",
        "",
        `  System Prompt:  ${estimateTokens(origSystem)} → ${estimateTokens(optSystem)} tokens (saved ${estimateTokens(origSystem) - estimateTokens(optSystem)})`,
        `  Inbound Meta:   ${estimateTokens(origMeta)} → ${estimateTokens(optMeta)} tokens (saved ${estimateTokens(origMeta) - estimateTokens(optMeta)})`,
        `  User Context:   ${estimateTokens(origUserCtx)} → ${estimateTokens(optUserCtx)} tokens (saved ${estimateTokens(origUserCtx) - estimateTokens(optUserCtx)})`,
        `  softTrim exec:  4000 → ${getEffectiveSoftTrimSettings("exec").maxChars} maxChars`,
        `  softTrim fetch: 4000 → ${getEffectiveSoftTrimSettings("web_fetch").maxChars} maxChars`,
        "",
        `  Total per-round: ~${estimateTokens(origSystem) + estimateTokens(origMeta) + estimateTokens(origUserCtx)} → ~${estimateTokens(optSystem) + estimateTokens(optMeta) + estimateTokens(optUserCtx)} tokens`,
        "",
      ].join("\n");

      console.log(report);

      // Just assert that optimization produced some savings
      const totalOrig =
        estimateTokens(origSystem) + estimateTokens(origMeta) + estimateTokens(origUserCtx);
      const totalOpt =
        estimateTokens(optSystem) + estimateTokens(optMeta) + estimateTokens(optUserCtx);
      expect(totalOpt).toBeLessThan(totalOrig);
    });
  });
});
