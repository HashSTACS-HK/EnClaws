import { describe, expect, it } from "vitest";
import { normalizeKnowledgeFileName } from "./knowledge-path.ts";

describe("normalizeKnowledgeFileName", () => {
  it("preserves Chinese filenames instead of stripping them to a dotfile", () => {
    expect(normalizeKnowledgeFileName("报关资料.md")).toBe("memory/报关资料.md");
    expect(normalizeKnowledgeFileName("上季度那批电滑板车.pdf")).toBe(
      "memory/上季度那批电滑板车.pdf",
    );
  });

  it("keeps safe ASCII prefixes without deleting the Chinese basename", () => {
    expect(normalizeKnowledgeFileName("12_上季度那批电滑板车.md")).toBe(
      "memory/12_上季度那批电滑板车.md",
    );
  });

  it("rejects traversal and empty basenames", () => {
    expect(normalizeKnowledgeFileName("../secret.md")).toBeNull();
    expect(normalizeKnowledgeFileName("memory/../../secret.md")).toBeNull();
    expect(normalizeKnowledgeFileName(".md")).toBeNull();
  });
});
