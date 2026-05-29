import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  resolveSkillNameFromPath,
  formatPrecheckMessage,
  precheckSkill,
} from "./skills-precheck.js";
import type { SkillStatusEntry } from "./skills-status.js";
import type { SkillEntry } from "./skills/types.js";

function makeEntry(name: string, baseDir: string): SkillEntry {
  return {
    skill: {
      name,
      description: "test",
      source: "test",
      filePath: path.join(baseDir, "SKILL.md"),
      baseDir,
      disableModelInvocation: false,
    },
    frontmatter: {},
  };
}

describe("resolveSkillNameFromPath", () => {
  const entries: SkillEntry[] = [
    makeEntry("github", "/home/user/.enclaws/skills/github"),
    makeEntry("create-doc", "/workspace/skills/feishu/create-doc"),
    makeEntry("tenant-skill", "/data/tenants/t1/skills/my-skill"),
  ];

  it("从 managed 技能路径解析技能名", () => {
    const result = resolveSkillNameFromPath("/home/user/.enclaws/skills/github/SKILL.md", entries);
    expect(result).toBe("github");
  });

  it("从二级分类目录路径解析技能名", () => {
    const result = resolveSkillNameFromPath(
      "/workspace/skills/feishu/create-doc/SKILL.md",
      entries,
    );
    expect(result).toBe("create-doc");
  });

  it("从租户目录路径解析技能名", () => {
    const result = resolveSkillNameFromPath("/data/tenants/t1/skills/my-skill/SKILL.md", entries);
    expect(result).toBe("tenant-skill");
  });

  it("非 SKILL.md 路径返回 null", () => {
    const result = resolveSkillNameFromPath("/home/user/.enclaws/skills/github/README.md", entries);
    expect(result).toBeNull();
  });

  it("无匹配条目时返回 null", () => {
    const result = resolveSkillNameFromPath("/unknown/path/SKILL.md", entries);
    expect(result).toBeNull();
  });
});

describe("formatPrecheckMessage", () => {
  it("无缺失依赖时返回 null", () => {
    const status: Pick<SkillStatusEntry, "name" | "missing" | "install"> = {
      name: "github",
      missing: { bins: [], anyBins: [], env: [], config: [], os: [] },
      install: [],
    };
    expect(formatPrecheckMessage(status)).toBeNull();
  });

  it("格式化缺失的二进制工具", () => {
    const status: Pick<SkillStatusEntry, "name" | "missing" | "install"> = {
      name: "media-tool",
      missing: { bins: ["ffmpeg", "yt-dlp"], anyBins: [], env: [], config: [], os: [] },
      install: [{ id: "brew-0", kind: "brew", label: "Install ffmpeg (brew)", bins: ["ffmpeg"] }],
    };
    const msg = formatPrecheckMessage(status)!;
    expect(msg).toContain("media-tool");
    expect(msg).toContain("ffmpeg");
    expect(msg).toContain("yt-dlp");
    expect(msg).toContain("Install ffmpeg (brew)");
  });

  it("格式化缺失的环境变量", () => {
    const status: Pick<SkillStatusEntry, "name" | "missing" | "install"> = {
      name: "github",
      missing: { bins: [], anyBins: [], env: ["GITHUB_TOKEN"], config: [], os: [] },
      install: [],
    };
    const msg = formatPrecheckMessage(status)!;
    expect(msg).toContain("GITHUB_TOKEN");
  });

  it("格式化不支持的操作系统", () => {
    const status: Pick<SkillStatusEntry, "name" | "missing" | "install"> = {
      name: "macos-only",
      missing: { bins: [], anyBins: [], env: [], config: [], os: ["darwin"] },
      install: [],
    };
    const msg = formatPrecheckMessage(status)!;
    expect(msg).toContain("darwin");
  });

  it("格式化缺失的配置项", () => {
    const status: Pick<SkillStatusEntry, "name" | "missing" | "install"> = {
      name: "browser-skill",
      missing: { bins: [], anyBins: [], env: [], config: ["browser.enabled"], os: [] },
      install: [],
    };
    const msg = formatPrecheckMessage(status)!;
    expect(msg).toContain("browser.enabled");
  });
});

describe("precheckSkill", () => {
  it("依赖全满足时返回 ok:true", async () => {
    const entry = makeEntry("healthy", "/tmp/skills/healthy");
    entry.metadata = { requires: {} };

    const notify = vi.fn();
    const result = await precheckSkill({
      workspaceDir: "/tmp",
      skillName: "healthy",
      notify,
      _entries: [entry],
    });

    expect(result.ok).toBe(true);
    expect(result.installed).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it("缺失二进制工具时通知并返回 ok:false", async () => {
    const entry = makeEntry("needs-bin", "/tmp/skills/needs-bin");
    entry.metadata = {
      requires: { bins: ["nonexistent-binary-xyz"] },
      install: [
        {
          id: "brew-0",
          kind: "brew",
          formula: "nonexistent-binary-xyz",
          bins: ["nonexistent-binary-xyz"],
        },
      ],
    };

    const notify = vi.fn();
    const result = await precheckSkill({
      workspaceDir: "/tmp",
      skillName: "needs-bin",
      notify,
      _entries: [entry],
    });

    expect(result.ok).toBe(false);
    expect(result.missing.bins).toContain("nonexistent-binary-xyz");
    expect(notify).toHaveBeenCalled();
    expect(notify.mock.calls[0][0]).toContain("nonexistent-binary-xyz");
  });

  it("技能未找到时通知", async () => {
    const notify = vi.fn();
    const result = await precheckSkill({
      workspaceDir: "/tmp",
      skillName: "no-such-skill",
      notify,
      _entries: [],
    });

    expect(result.ok).toBe(false);
    expect(notify).toHaveBeenCalled();
    expect(notify.mock.calls[0][0]).toContain("no-such-skill");
  });

  it("用户确认后调用自动安装", async () => {
    const entry = makeEntry("installable", "/tmp/skills/installable");
    entry.metadata = {
      requires: { bins: ["nonexistent-binary-xyz"] },
      install: [
        {
          id: "brew-0",
          kind: "brew",
          formula: "nonexistent-binary-xyz",
          bins: ["nonexistent-binary-xyz"],
        },
      ],
    };

    const notify = vi.fn();
    const confirm = vi.fn().mockResolvedValue(true);
    const result = await precheckSkill({
      workspaceDir: "/tmp",
      skillName: "installable",
      notify,
      confirm,
      _entries: [entry],
      _installSkill: async () => ({
        ok: true,
        message: "Installed",
        stdout: "",
        stderr: "",
        code: 0,
      }),
    });

    expect(confirm).toHaveBeenCalled();
    expect(result.installed).toBe(true);
  });

  it("用户拒绝时跳过安装", async () => {
    const entry = makeEntry("declinable", "/tmp/skills/declinable");
    entry.metadata = {
      requires: { bins: ["nonexistent-binary-xyz"] },
      install: [
        {
          id: "brew-0",
          kind: "brew",
          formula: "nonexistent-binary-xyz",
          bins: ["nonexistent-binary-xyz"],
        },
      ],
    };

    const notify = vi.fn();
    const confirm = vi.fn().mockResolvedValue(false);
    const result = await precheckSkill({
      workspaceDir: "/tmp",
      skillName: "declinable",
      notify,
      confirm,
      _entries: [entry],
    });

    expect(confirm).toHaveBeenCalled();
    expect(result.installed).toBe(false);
  });
});
