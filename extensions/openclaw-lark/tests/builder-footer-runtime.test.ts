/**
 * Tests for pure utility functions exported from src/card/builder.ts.
 */

import { describe, expect, it } from "vitest";
import { compactNumber, formatFooterRuntimeSegments } from "../src/card/builder";

// ---------------------------------------------------------------------------
// compactNumber
// ---------------------------------------------------------------------------

describe("compactNumber", () => {
  it("formats values across ranges", () => {
    expect(compactNumber(0)).toBe("0");
    expect(compactNumber(999)).toBe("999");
    expect(compactNumber(1000)).toBe("1.0k");
    expect(compactNumber(1250)).toBe("1.3k");
    expect(compactNumber(100_000)).toBe("100k");
    expect(compactNumber(1_000_000)).toBe("1.0m");
    expect(compactNumber(123_456_789)).toBe("123m");
  });
});

// ---------------------------------------------------------------------------
// formatFooterRuntimeSegments
// ---------------------------------------------------------------------------

describe("formatFooterRuntimeSegments", () => {
  it("renders configured runtime metrics", () => {
    const result = formatFooterRuntimeSegments({
      footer: {
        status: true,
        elapsed: true,
        tokens: true,
        cache: true,
        context: true,
        model: true,
      },
      elapsedMs: 12_300,
      metrics: {
        inputTokens: 1200,
        outputTokens: 3500,
        cacheRead: 800,
        cacheWrite: 200,
        totalTokens: 4500,
        totalTokensFresh: true,
        contextTokens: 128000,
        model: "claude-opus-4-6",
      },
    });

    expect(result.zh).toEqual([
      "已完成",
      "耗时 12.3s",
      "↑ 1.2k ↓ 3.5k",
      "缓存 800/200 (36%)",
      "上下文 4.5k/128k (4%)",
      "claude-opus-4-6",
    ]);

    expect(result.en).toEqual([
      "Completed",
      "Elapsed 12.3s",
      "↑ 1.2k ↓ 3.5k",
      "Cache 800/200 (36%)",
      "Context 4.5k/128k (4%)",
      "claude-opus-4-6",
    ]);
  });

  it("respects missing metrics and status variants", () => {
    const stopped = formatFooterRuntimeSegments({
      footer: { status: true, tokens: true, cache: true, context: true, model: true },
      isAborted: true,
      metrics: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        totalTokensFresh: false,
        contextTokens: 4096,
        model: " ",
      },
    });

    expect(stopped.zh).toEqual(["已停止", "↑ 100 ↓ 50"]);
    expect(stopped.en).toEqual(["Stopped", "↑ 100 ↓ 50"]);

    const errored = formatFooterRuntimeSegments({
      footer: { status: true, elapsed: true },
      elapsedMs: 1000,
      isError: true,
    });

    expect(errored.zh).toEqual(["出错", "耗时 1.0s"]);
    expect(errored.en).toEqual(["Error", "Elapsed 1.0s"]);
  });
});
