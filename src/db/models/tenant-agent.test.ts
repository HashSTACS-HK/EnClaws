/**
 * Unit tests for tenant-agent pure helpers.
 *
 * Regression guard: tenant_agents.skills is a denylist of bundled skills
 * (see src/agents/skills/defaults.ts, ui/.../tenant-agents.ts:2014).
 * It is consumed via getTenantAgent → disabledBundledSkills in get-reply.ts.
 * If toConfigAgentsList leaks this array into cfg.agents.list[*].skills,
 * resolveAgentSkillsFilter would misread the denylist as a legacy allowlist
 * and filterSkillEntries would strip every non-listed skill from the prompt.
 */

import { describe, expect, it } from "vitest";
import type { TenantAgent } from "../types.js";
import { toConfigAgentsList } from "./tenant-agent.js";

function makeAgent(overrides: Partial<TenantAgent> = {}): TenantAgent {
  const now = new Date("2026-04-20T00:00:00Z");
  return {
    id: "row-1",
    tenantId: "t-1",
    agentId: "my-first-agent",
    name: "Test Agent",
    config: {},
    modelConfig: [],
    tools: { deny: [] },
    skills: null,
    isActive: true,
    createdBy: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("toConfigAgentsList", () => {
  it("never exposes the denylist via cfg.agents.list[*].skills", () => {
    const agent = makeAgent({
      skills: ["apple-notes", "imsg", "spotify-player"],
    });

    const [entry] = toConfigAgentsList([agent]);

    expect(entry).not.toHaveProperty("skills");
  });

  it("omits skills even when the denylist is an empty array", () => {
    const agent = makeAgent({ skills: [] });

    const [entry] = toConfigAgentsList([agent]);

    expect(entry).not.toHaveProperty("skills");
  });

  it("omits skills when the DB field is null", () => {
    const agent = makeAgent({ skills: null });

    const [entry] = toConfigAgentsList([agent]);

    expect(entry).not.toHaveProperty("skills");
  });

  it("still exposes tools.deny when tools are configured", () => {
    const agent = makeAgent({
      skills: ["apple-notes"],
      tools: { deny: ["memory_search"] },
    });

    const [entry] = toConfigAgentsList([agent]);

    expect(entry).not.toHaveProperty("skills");
    expect(entry.tools).toEqual({ deny: ["memory_search"] });
  });
});
