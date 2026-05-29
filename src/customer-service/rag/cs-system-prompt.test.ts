/**
 * Tests for CS Agent system prompt builder.
 *
 * 客服 Agent 系统提示词构建器测试。
 */

import { describe, expect, it } from "vitest";
import type { MemorySearchResult } from "../../memory/types.js";
import { buildCSSystemPrompt } from "./cs-system-prompt.js";

// Sample base prompt — buildCSSystemPrompt now requires a pre-rendered basePrompt
// (persona or default template, company name already substituted upstream).
// 已替换企业名的基础 prompt 样例；buildCSSystemPrompt 现在要求显式传入 basePrompt。
const BASE =
  "## 角色与身份\n\n你是 ACME 的 AI 客服助手。基于知识库为客户解答问题。\n\n## 行为规则\n\n1. 优先基于知识库回答。";

// Clause fragments asserted in tests (kept in sync with cs-system-prompt.ts).
// 与 cs-system-prompt.ts 中的子句保持同步的片段。
const STRICT_KB_CLAUSE = "知识库严格模式";
const HIDE_INTERNALS_CLAUSE = "暴露内部实现";
const MARKDOWN_CLAUSE = "Markdown"; // the removed disableMarkdown add-on mentioned Markdown

describe("buildCSSystemPrompt", () => {
  it("includes the provided base prompt verbatim", () => {
    const prompt = buildCSSystemPrompt({ basePrompt: BASE, knowledgeChunks: [] });
    expect(prompt).toContain("AI 客服助手");
    expect(prompt).toContain("行为规则");
  });

  it("includes knowledge chunks when provided", () => {
    const chunks: MemorySearchResult[] = [
      {
        path: "ec-faq.md",
        startLine: 1,
        endLine: 5,
        score: 0.85,
        snippet: "EC 是企业级 AI 助手容器平台",
        source: "memory",
      },
    ];
    const prompt = buildCSSystemPrompt({ basePrompt: BASE, knowledgeChunks: chunks });
    expect(prompt).toContain("知识片段 1");
    expect(prompt).toContain("ec-faq.md");
    expect(prompt).toContain("EC 是企业级 AI 助手容器平台");
    expect(prompt).toContain("0.85");
  });

  it("shows placeholder when no knowledge chunks", () => {
    const prompt = buildCSSystemPrompt({ basePrompt: BASE, knowledgeChunks: [] });
    expect(prompt).toContain("未检索到相关知识");
  });

  it("includes visitor name when provided", () => {
    const prompt = buildCSSystemPrompt({
      basePrompt: BASE,
      knowledgeChunks: [],
      visitorName: "张三",
    });
    expect(prompt).toContain("张三");
  });

  // ── Restriction clauses (T3: tools+markdown RELEASED, strictKB+hideInternals KEPT) ──
  it("adds strictKB + hideInternals clauses when those restrictions are on", () => {
    const prompt = buildCSSystemPrompt({
      basePrompt: BASE,
      knowledgeChunks: [],
      restrictions: { strictKnowledgeBase: true, hideInternals: true },
    });
    expect(prompt).toContain(STRICT_KB_CLAUSE);
    expect(prompt).toContain(HIDE_INTERNALS_CLAUSE);
  });

  it("never emits the (removed) markdown-forbid clause, even if disableMarkdown is requested", () => {
    const prompt = buildCSSystemPrompt({
      basePrompt: BASE,
      knowledgeChunks: [],
      // disableMarkdown is a now-defunct toggle: the field still exists for callers
      // (cs-admin / cs-setup) but no longer produces a prompt clause. Markdown allowed.
      restrictions: { disableMarkdown: true },
    });
    expect(prompt).not.toContain("不要使用 Markdown");
    expect(prompt).not.toContain("只输出纯文本");
  });

  it("defaults strictKB + hideInternals ON when no restrictions are passed, but does NOT forbid markdown", () => {
    const prompt = buildCSSystemPrompt({ basePrompt: BASE, knowledgeChunks: [] });
    expect(prompt).toContain(STRICT_KB_CLAUSE);
    expect(prompt).toContain(HIDE_INTERNALS_CLAUSE);
    expect(prompt).not.toContain("不要使用 Markdown");
  });

  it("omits strictKB + hideInternals clauses when both are explicitly off", () => {
    const prompt = buildCSSystemPrompt({
      basePrompt: BASE,
      knowledgeChunks: [],
      restrictions: { strictKnowledgeBase: false, hideInternals: false },
    });
    expect(prompt).not.toContain(STRICT_KB_CLAUSE);
    expect(prompt).not.toContain(HIDE_INTERNALS_CLAUSE);
    // No add-on section at all when nothing is enabled (markdown released).
    expect(prompt).not.toContain("行为附加约束");
    expect(prompt).not.toContain(MARKDOWN_CLAUSE);
  });
});
