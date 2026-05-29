/**
 * Unit tests for summarizeKnowledgeHits — pure KB-hits reasoning summary.
 *
 * summarizeKnowledgeHits 的单元测试：纯函数，把检索命中转成精简的
 * {source, score, snippet} 列表（用于 SSE done 事件的 knowledgeHits）。
 */

import { describe, expect, it } from "vitest";
import type { MemorySearchResult } from "../../memory/types.js";
import { summarizeKnowledgeHits } from "./cs-knowledge-summary.js";

function hit(overrides: Partial<MemorySearchResult> = {}): MemorySearchResult {
  return {
    path: "kb/faq.md",
    startLine: 1,
    endLine: 10,
    score: 0.9,
    snippet: "Our business hours are 9am to 6pm.",
    source: "memory",
    ...overrides,
  };
}

describe("summarizeKnowledgeHits", () => {
  it("maps source/score/snippet field shape", () => {
    const out = summarizeKnowledgeHits([hit()], 5);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      source: "kb/faq.md",
      score: 0.9,
      snippet: "Our business hours are 9am to 6pm.",
    });
  });

  it("prefers sourceLabel over path for the source field when present", () => {
    const out = summarizeKnowledgeHits([hit({ sourceLabel: "企业知识库 / FAQ" })], 5);
    expect(out[0].source).toBe("企业知识库 / FAQ");
  });

  it("caps the result count at max", () => {
    const hits = Array.from({ length: 8 }, (_, i) =>
      hit({ path: `kb/${i}.md`, score: 1 - i * 0.1 }),
    );
    const out = summarizeKnowledgeHits(hits, 3);
    expect(out).toHaveLength(3);
    // preserves incoming order (already score-sorted upstream)
    expect(out.map((h) => h.source)).toEqual(["kb/0.md", "kb/1.md", "kb/2.md"]);
  });

  it("truncates long snippets with an ellipsis", () => {
    const long = "x".repeat(500);
    const out = summarizeKnowledgeHits([hit({ snippet: long })], 5);
    expect(out[0].snippet.length).toBeLessThan(long.length);
    expect(out[0].snippet.endsWith("…")).toBe(true);
    // truncated body (excluding the ellipsis) does not exceed the cap
    expect(out[0].snippet.slice(0, -1).length).toBeLessThanOrEqual(200);
  });

  it("does not append an ellipsis to short snippets", () => {
    const out = summarizeKnowledgeHits([hit({ snippet: "short" })], 5);
    expect(out[0].snippet).toBe("short");
  });

  it("collapses internal whitespace/newlines in the snippet", () => {
    const out = summarizeKnowledgeHits([hit({ snippet: "line one\n\n   line two\t\tend" })], 5);
    expect(out[0].snippet).toBe("line one line two end");
  });

  it("returns an empty array for empty input", () => {
    expect(summarizeKnowledgeHits([], 5)).toEqual([]);
  });

  it("returns an empty array when max is 0 or negative", () => {
    expect(summarizeKnowledgeHits([hit()], 0)).toEqual([]);
    expect(summarizeKnowledgeHits([hit()], -1)).toEqual([]);
  });
});
