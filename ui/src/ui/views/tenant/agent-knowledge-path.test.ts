import { describe, expect, it } from "vitest";
import { normalizeAgentKnowledgeFileName } from "./agent-knowledge-path.ts";

describe("normalizeAgentKnowledgeFileName", () => {
  it("preserves Chinese filenames instead of stripping them to a dotfile", () => {
    expect(normalizeAgentKnowledgeFileName("报关资料.md")).toBe("memory/报关资料.md");
    expect(normalizeAgentKnowledgeFileName("上季度那批电滑板车.pdf")).toBe(
      "memory/上季度那批电滑板车.pdf",
    );
  });

  it("keeps safe ASCII prefixes without deleting the Chinese basename", () => {
    expect(normalizeAgentKnowledgeFileName("12_上季度那批电滑板车.md")).toBe(
      "memory/12_上季度那批电滑板车.md",
    );
  });

  it("rejects traversal and empty basenames", () => {
    expect(normalizeAgentKnowledgeFileName("../secret.md")).toBeNull();
    expect(normalizeAgentKnowledgeFileName("memory/../../secret.md")).toBeNull();
    expect(normalizeAgentKnowledgeFileName(".md")).toBeNull();
  });
});
