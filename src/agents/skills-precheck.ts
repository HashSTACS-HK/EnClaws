import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import type { Requirements } from "../shared/requirements.js";
import { installSkill, type SkillInstallResult } from "./skills-install.js";
import { buildWorkspaceSkillStatus, type SkillStatusEntry } from "./skills-status.js";
import { loadWorkspaceSkillEntries } from "./skills.js";
import type { SkillEntry } from "./skills/types.js";

export type PrecheckNotify = (message: string) => void | Promise<void>;
export type PrecheckConfirm = (message: string) => Promise<boolean>;

export type PrecheckParams = {
  workspaceDir: string;
  skillName: string;
  config?: OpenClawConfig;
  notify: PrecheckNotify;
  confirm?: PrecheckConfirm;
  /** @internal 测试覆盖 — 直接提供技能条目而非从磁盘加载 */
  _entries?: SkillEntry[];
  /** @internal 测试覆盖 — 替换 installSkill 用于测试 */
  _installSkill?: (params: {
    workspaceDir: string;
    skillName: string;
    installId: string;
    config?: OpenClawConfig;
  }) => Promise<SkillInstallResult>;
};

export type PrecheckResult = {
  ok: boolean;
  skillName: string;
  missing: Requirements;
  installed: boolean;
};

export function resolveSkillNameFromPath(
  changedPath: string,
  entries: SkillEntry[],
): string | null {
  if (!changedPath.endsWith("SKILL.md")) {return null;}
  const changedDir = path.normalize(path.resolve(changedPath, ".."));
  const match = entries.find(
    (e) => path.normalize(path.resolve(e.skill.baseDir)) === changedDir,
  );
  return match?.skill.name ?? null;
}

export function formatPrecheckMessage(
  status: Pick<SkillStatusEntry, "name" | "missing" | "install">,
): string | null {
  const { name, missing, install } = status;
  const lines: string[] = [];

  if (missing.bins.length > 0) {
    lines.push(`  - 二进制工具: ${missing.bins.join(", ")}`);
  }
  if (missing.anyBins.length > 0) {
    lines.push(`  - 需要其中之一: ${missing.anyBins.join(", ")}`);
  }
  if (missing.env.length > 0) {
    lines.push(`  - 环境变量: ${missing.env.join(", ")}`);
  }
  if (missing.config.length > 0) {
    lines.push(`  - 配置项: ${missing.config.join(", ")}`);
  }
  if (missing.os.length > 0) {
    lines.push(`  - 操作系统: ${missing.os.join(", ")}`);
  }

  if (lines.length === 0) {return null;}

  const parts = [`技能 "${name}" 缺少以下依赖:`, ...lines];

  if (install.length > 0) {
    parts.push("");
    parts.push("安装选项:");
    for (const opt of install) {
      parts.push(`  → ${opt.label}`);
    }
  }

  return parts.join("\n");
}

const EMPTY_MISSING: Requirements = { bins: [], anyBins: [], env: [], config: [], os: [] };

export async function precheckSkill(params: PrecheckParams): Promise<PrecheckResult> {
  const { workspaceDir, skillName, config, notify, confirm } = params;

  const entries = params._entries ?? loadWorkspaceSkillEntries(workspaceDir, { config });
  const entry = entries.find((e) => e.skill.name === skillName);
  if (!entry) {
    await notify(`技能 "${skillName}" 未找到。`);
    return { ok: false, skillName, missing: EMPTY_MISSING, installed: false };
  }

  const report = buildWorkspaceSkillStatus(workspaceDir, { config, entries: [entry] });
  const status = report.skills[0];
  if (!status) {
    await notify(`技能 "${skillName}" 未找到。`);
    return { ok: false, skillName, missing: EMPTY_MISSING, installed: false };
  }

  const message = formatPrecheckMessage(status);
  if (!message) {
    return { ok: true, skillName, missing: EMPTY_MISSING, installed: false };
  }

  await notify(message);

  let installed = false;
  if (confirm && status.install.length > 0) {
    const agreed = await confirm("是否自动安装缺失的依赖？");
    if (agreed) {
      const installId = status.install[0].id;
      const doInstall =
        params._installSkill ??
        ((p: { workspaceDir: string; skillName: string; installId: string; config?: OpenClawConfig }) =>
          installSkill({ ...p, installId: p.installId }));
      const result = await doInstall({ workspaceDir, skillName, installId, config });
      if (result.ok) {
        await notify("安装成功。");
        installed = true;
      } else {
        await notify(`安装失败: ${result.message}`);
      }
    } else {
      await notify("已跳过自动安装。");
    }
  }

  return { ok: false, skillName, missing: status.missing, installed };
}
