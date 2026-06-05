import { describe, expect, it } from "vitest";
import { buildWorkspaceSkillStatus } from "./skills-status.js";
import type { SkillEntry } from "./skills/types.js";

describe("buildWorkspaceSkillStatus", () => {
  it("includes tenant skills in the status report", () => {
    const entry: SkillEntry = {
      skill: {
        name: "jiumi-customs-order-query",
        description: "Query Jiumi customs declaration status.",
        source: "enclaws-tenant",
        filePath: "/tmp/tenant/skills/jiumi-customs-order-query/SKILL.md",
        baseDir: "/tmp/tenant/skills/jiumi-customs-order-query",
        disableModelInvocation: false,
      },
      frontmatter: {},
    };

    const report = buildWorkspaceSkillStatus("/tmp/ws", { entries: [entry] });

    expect(report.skills).toMatchObject([
      {
        name: "jiumi-customs-order-query",
        source: "enclaws-tenant",
        eligible: true,
      },
    ]);
  });

  it("does not surface install options for OS-scoped skills on unsupported platforms", () => {
    if (process.platform === "win32") {
      // Keep this simple; win32 platform naming is already explicitly handled elsewhere.
      return;
    }

    const mismatchedOs = process.platform === "darwin" ? "linux" : "darwin";

    const entry: SkillEntry = {
      skill: {
        name: "os-scoped",
        description: "test",
        source: "test",
        filePath: "/tmp/os-scoped",
        baseDir: "/tmp",
        disableModelInvocation: false,
      },
      frontmatter: {},
      metadata: {
        os: [mismatchedOs],
        requires: { bins: ["fakebin"] },
        install: [
          {
            id: "brew",
            kind: "brew",
            formula: "fake",
            bins: ["fakebin"],
            label: "Install fake (brew)",
          },
        ],
      },
    };

    const report = buildWorkspaceSkillStatus("/tmp/ws", { entries: [entry] });
    expect(report.skills).toHaveLength(1);
    expect(report.skills[0]?.install).toEqual([]);
  });
});
