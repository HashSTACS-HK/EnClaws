/**
 * Tests for the CS knowledge cascade merge (agent KB + enterprise KB).
 *
 * 客服知识库级联合并测试（agent 知识库 + 企业知识库）。
 *
 * Cascade rule ("依次", user-confirmed default):
 *   - agent-KB hits rank FIRST (priority), capped at max
 *   - enterprise-KB hits FILL the remaining quota up to max
 *   - dedup overlapping chunks (same content), agent-ranked wins
 *   - cap total at max
 */

import { describe, expect, it } from "vitest";
import type { MemorySearchResult } from "../../memory/types.js";
import { mergeCascadeResults } from "./cs-knowledge-cascade.js";

function chunk(partial: Partial<MemorySearchResult> & { snippet: string }): MemorySearchResult {
  return {
    path: partial.path ?? "doc.md",
    startLine: partial.startLine ?? 1,
    endLine: partial.endLine ?? 5,
    score: partial.score ?? 0.5,
    snippet: partial.snippet,
    source: partial.source ?? "memory",
    scope: partial.scope,
    sourceLabel: partial.sourceLabel,
    citation: partial.citation,
  };
}

describe("mergeCascadeResults", () => {
  it("agent fills quota → enterprise ignored (capped at max)", () => {
    const agent = [
      chunk({ snippet: "a1", path: "agent/1.md", score: 0.9 }),
      chunk({ snippet: "a2", path: "agent/2.md", score: 0.8 }),
      chunk({ snippet: "a3", path: "agent/3.md", score: 0.7 }),
      chunk({ snippet: "a4", path: "agent/4.md", score: 0.6 }),
      chunk({ snippet: "a5", path: "agent/5.md", score: 0.5 }),
      chunk({ snippet: "a6", path: "agent/6.md", score: 0.4 }),
    ];
    const enterprise = [chunk({ snippet: "e1", path: "ent/1.md", score: 0.95 })];

    const merged = mergeCascadeResults(agent, enterprise, 5);

    expect(merged).toHaveLength(5);
    expect(merged.map((c) => c.snippet)).toEqual(["a1", "a2", "a3", "a4", "a5"]);
  });

  it("agent partial → enterprise fills remainder up to max", () => {
    const agent = [
      chunk({ snippet: "a1", path: "agent/1.md", score: 0.9 }),
      chunk({ snippet: "a2", path: "agent/2.md", score: 0.8 }),
    ];
    const enterprise = [
      chunk({ snippet: "e1", path: "ent/1.md", score: 0.95 }),
      chunk({ snippet: "e2", path: "ent/2.md", score: 0.7 }),
      chunk({ snippet: "e3", path: "ent/3.md", score: 0.6 }),
      chunk({ snippet: "e4", path: "ent/4.md", score: 0.5 }),
    ];

    const merged = mergeCascadeResults(agent, enterprise, 5);

    expect(merged).toHaveLength(5);
    // agent first (priority), then enterprise filling remainder
    expect(merged.map((c) => c.snippet)).toEqual(["a1", "a2", "e1", "e2", "e3"]);
  });

  it("dedups a chunk present in both — kept once, agent-ranked", () => {
    const agent = [
      chunk({ snippet: "shared content", path: "agent/dup.md", score: 0.9 }),
      chunk({ snippet: "a2", path: "agent/2.md", score: 0.8 }),
    ];
    const enterprise = [
      // Same content as agent's first chunk → must be skipped.
      chunk({ snippet: "shared content", path: "ent/dup.md", score: 0.99 }),
      chunk({ snippet: "e2", path: "ent/2.md", score: 0.7 }),
    ];

    const merged = mergeCascadeResults(agent, enterprise, 5);

    expect(merged.map((c) => c.snippet)).toEqual(["shared content", "a2", "e2"]);
    // the surviving "shared content" is the agent-ranked one (score 0.9, agent path)
    const shared = merged.find((c) => c.snippet === "shared content");
    expect(shared?.path).toBe("agent/dup.md");
    expect(shared?.score).toBe(0.9);
  });

  it("preserves agent-before-enterprise ordering regardless of enterprise score", () => {
    const agent = [chunk({ snippet: "a1", path: "agent/1.md", score: 0.3 })];
    const enterprise = [chunk({ snippet: "e1", path: "ent/1.md", score: 0.99 })];

    const merged = mergeCascadeResults(agent, enterprise, 5);

    // agent first even though enterprise scored higher
    expect(merged.map((c) => c.snippet)).toEqual(["a1", "e1"]);
  });

  it("empty agent → all enterprise up to max", () => {
    const enterprise = [
      chunk({ snippet: "e1", path: "ent/1.md", score: 0.9 }),
      chunk({ snippet: "e2", path: "ent/2.md", score: 0.8 }),
      chunk({ snippet: "e3", path: "ent/3.md", score: 0.7 }),
    ];

    const merged = mergeCascadeResults([], enterprise, 2);

    expect(merged.map((c) => c.snippet)).toEqual(["e1", "e2"]);
  });

  it("empty both → empty result", () => {
    expect(mergeCascadeResults([], [], 5)).toEqual([]);
  });

  it("dedups within enterprise duplicates too (keeps first)", () => {
    const enterprise = [
      chunk({ snippet: "same", path: "ent/a.md", score: 0.9 }),
      chunk({ snippet: "same", path: "ent/b.md", score: 0.8 }),
      chunk({ snippet: "other", path: "ent/c.md", score: 0.7 }),
    ];

    const merged = mergeCascadeResults([], enterprise, 5);

    expect(merged.map((c) => c.snippet)).toEqual(["same", "other"]);
  });
});
