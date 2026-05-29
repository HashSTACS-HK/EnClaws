/**
 * Tests for CS bound-agent persona loading.
 *
 * 绑定 agent persona 加载测试 —— 读取 IDENTITY.md / SOUL.md / AGENTS.md，
 * 按顺序拼接并跳过缺失文件，全空时返回空串（触发 fallback）。
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAgentPersona, selectBasePrompt } from "./cs-persona.js";

describe("loadAgentPersona", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-persona-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("concatenates all three MDs in IDENTITY → SOUL → AGENTS order with headers", async () => {
    await fs.writeFile(path.join(dir, "IDENTITY.md"), "我是小赛客服", "utf-8");
    await fs.writeFile(path.join(dir, "SOUL.md"), "始终保持耐心", "utf-8");
    await fs.writeFile(path.join(dir, "AGENTS.md"), "回复控制在三句话内", "utf-8");

    const persona = await loadAgentPersona(dir);

    expect(persona).toContain("我是小赛客服");
    expect(persona).toContain("始终保持耐心");
    expect(persona).toContain("回复控制在三句话内");
    // section headers present
    expect(persona).toContain("# 身份档案");
    expect(persona).toContain("# 行为边界");
    expect(persona).toContain("# 工作规范");
    // ordering: identity before soul before agents
    expect(persona.indexOf("我是小赛客服")).toBeLessThan(persona.indexOf("始终保持耐心"));
    expect(persona.indexOf("始终保持耐心")).toBeLessThan(persona.indexOf("回复控制在三句话内"));
  });

  it("returns only the present file when others are missing (no error)", async () => {
    await fs.writeFile(path.join(dir, "IDENTITY.md"), "我是小赛客服", "utf-8");

    const persona = await loadAgentPersona(dir);

    expect(persona).toContain("我是小赛客服");
    expect(persona).toContain("# 身份档案");
    expect(persona).not.toContain("# 行为边界");
    expect(persona).not.toContain("# 工作规范");
  });

  it("returns empty string for a nonexistent dir", async () => {
    const persona = await loadAgentPersona(path.join(dir, "does-not-exist"));
    expect(persona).toBe("");
  });

  it("returns empty string when all MD files are blank", async () => {
    await fs.writeFile(path.join(dir, "IDENTITY.md"), "   \n  ", "utf-8");
    await fs.writeFile(path.join(dir, "SOUL.md"), "", "utf-8");

    const persona = await loadAgentPersona(dir);
    expect(persona.trim()).toBe("");
  });
});

describe("selectBasePrompt", () => {
  it("uses persona as base when persona is non-empty", () => {
    const base = selectBasePrompt({
      persona: "我是小赛客服",
      customSystemPrompt: "should-not-be-used",
    });
    expect(base).toBe("我是小赛客服");
  });

  it("falls back to customSystemPrompt when persona is blank", () => {
    const base = selectBasePrompt({
      persona: "   ",
      customSystemPrompt: "custom-fallback",
    });
    expect(base).toBe("custom-fallback");
  });

  it("falls back to DEFAULT_CS_BASE_PROMPT when persona blank and no custom prompt", () => {
    const base = selectBasePrompt({ persona: "", customSystemPrompt: undefined });
    expect(base).toContain("AI 客服助手");
  });
});
