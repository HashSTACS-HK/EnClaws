/**
 * CS bound-agent persona loading.
 *
 * "继承 agent 能力": a tenant's CS reply runs as the BOUND agent. This module
 * loads that agent's persona files (IDENTITY.md / SOUL.md / AGENTS.md) from the
 * agent dir so tenant edits to the persona (and the future 启用推荐配置 that
 * fills these 3 MDs) actually take effect in CS replies — while promptMode
 * stays "none" (the heavy generic EC scaffolding is still skipped).
 *
 * 绑定 agent persona 加载：从 agent 目录读取 IDENTITY.md / SOUL.md / AGENTS.md，
 * 按"身份 → 边界 → 规范"顺序拼接，作为 CS 基础 prompt，使租户对 agent 人设的
 * 修改真正生效；promptMode 仍为 "none"，不引入 EC 主 prompt。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_CS_BASE_PROMPT } from "./cs-system-prompt.js";

/**
 * Persona files in load order, each paired with a human-readable section header.
 * Order: identity (who) → soul (boundaries) → agents (work norms).
 *
 * Filenames mirror the agent-runtime persona files (see DEFAULT_IDENTITY_FILENAME
 * et al. in agents/workspace.ts). Kept as local literals so the lean CS path
 * doesn't pull in the heavy agent-runtime module just for three strings.
 * persona 文件加载顺序及各自的中文小节标题：身份 → 行为边界 → 工作规范。
 */
const PERSONA_SECTIONS: ReadonlyArray<{ filename: string; header: string }> = [
  { filename: "IDENTITY.md", header: "# 身份档案" },
  { filename: "SOUL.md", header: "# 行为边界" },
  { filename: "AGENTS.md", header: "# 工作规范" },
];

/**
 * Read the bound agent's persona MDs and concatenate them with section headers.
 *
 * - Reads IDENTITY.md, SOUL.md, AGENTS.md from {agentDir} in that order.
 * - Missing files are skipped (no error). Blank files contribute nothing.
 * - Returns "" when the dir is absent or no file has content → caller falls back.
 *
 * 读取绑定 agent 的 persona 文件并拼接；缺失/空白文件跳过；全空返回 ""（触发回退）。
 */
export async function loadAgentPersona(agentDir: string): Promise<string> {
  const sections: string[] = [];

  for (const { filename, header } of PERSONA_SECTIONS) {
    let content: string;
    try {
      content = await fs.readFile(path.join(agentDir, filename), "utf-8");
    } catch {
      // Missing/unreadable file — skip it. 文件缺失或不可读，跳过。
      continue;
    }
    const trimmed = content.trim();
    if (!trimmed) {
      continue;
    }
    sections.push(`${header}\n${trimmed}`);
  }

  return sections.join("\n\n");
}

/**
 * Choose the base system prompt for a CS reply.
 *
 * - Non-empty persona → use the persona (the bound agent's people-set wins).
 * - Blank persona → fall back to customSystemPrompt, else DEFAULT_CS_BASE_PROMPT,
 *   preserving behavior for agents without persona (no regression).
 *
 * 选择 CS 基础 prompt：persona 非空则用 persona；为空回退自定义 prompt / 默认模板。
 */
export function selectBasePrompt(params: {
  persona: string;
  customSystemPrompt?: string;
}): string {
  if (params.persona.trim()) {
    return params.persona;
  }
  return params.customSystemPrompt || DEFAULT_CS_BASE_PROMPT;
}
