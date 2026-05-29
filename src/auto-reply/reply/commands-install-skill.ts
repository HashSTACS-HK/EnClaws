import { installSkill } from "../../agents/skills-install.js";
import { precheckSkill } from "../../agents/skills-precheck.js";
import { logVerbose } from "../../globals.js";
import type { CommandHandler } from "./commands-types.js";

export const handleInstallSkillCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  if (normalized !== "/install-skill" && !normalized.startsWith("/install-skill ")) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /install-skill from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const tenantRole = params.ctx.TenantUserRole;
  if (tenantRole && !["owner", "admin"].includes(tenantRole)) {
    logVerbose(
      `Blocking /install-skill: tenantRole=${tenantRole} sender=${params.command.senderId || "<unknown>"}`,
    );
    return {
      shouldContinue: false,
      reply: { text: "权限不足：仅管理员可安装技能" },
    };
  }

  const arg = normalized.slice("/install-skill".length).trim();
  if (!arg) {
    return {
      shouldContinue: false,
      reply: {
        text: "用法:\n  /install-skill <技能名称> — 检查依赖\n  /install-skill <技能名称> install — 自动安装缺失依赖",
      },
    };
  }

  // 解析参数：/install-skill <skillName> [install]
  const tokens = arg.split(/\s+/);
  const skillName = tokens[0];
  const action = tokens[1]?.toLowerCase();

  // 自动安装模式
  if (action === "install") {
    const lines: string[] = [];
    const result = await precheckSkill({
      workspaceDir: params.workspaceDir,
      skillName,
      config: params.cfg,
      notify: (msg) => {
        lines.push(msg);
      },
      confirm: async () => true,
      _installSkill: async (p) => installSkill({ ...p, installId: p.installId }),
    });

    if (result.ok) {
      return {
        shouldContinue: false,
        reply: { text: `技能 "${skillName}" 所有依赖已满足，无需安装。` },
      };
    }

    if (result.installed) {
      return {
        shouldContinue: false,
        reply: { text: lines.join("\n") + "\n\n依赖安装完成，请重新检查技能状态。" },
      };
    }

    const text = lines.join("\n");
    return { shouldContinue: false, reply: { text } };
  }

  // 默认模式：仅检查依赖
  const lines: string[] = [];
  const result = await precheckSkill({
    workspaceDir: params.workspaceDir,
    skillName,
    config: params.cfg,
    notify: (msg) => {
      lines.push(msg);
    },
  });

  if (result.ok) {
    return {
      shouldContinue: false,
      reply: { text: `技能 "${skillName}" 依赖检查通过，所有依赖已满足。` },
    };
  }

  // 有缺失依赖，提示用户可以自动安装
  const text = lines.join("\n");
  const hasInstallOptions = result.missing.bins.length > 0;
  const hint = hasInstallOptions
    ? `\n\n输入 /install-skill ${skillName} install 自动安装缺失依赖`
    : "";
  return { shouldContinue: false, reply: { text: text + hint } };
};
