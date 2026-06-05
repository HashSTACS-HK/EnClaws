import fs from "node:fs";

import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import { installSkill } from "../../agents/skills-install.js";
import { precheckSkill } from "../../agents/skills-precheck.js";
import { buildWorkspaceSkillStatus } from "../../agents/skills-status.js";
import { loadWorkspaceSkillEntries, type SkillEntry } from "../../agents/skills.js";
import { listAgentWorkspaceDirs } from "../../agents/workspace-dirs.js";
import type { TenantContext } from "../../auth/middleware.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig, writeConfigFile } from "../../config/config.js";
import { resolveTenantSkillsDir } from "../../config/sessions/tenant-paths.js";
import { loadTenantConfig } from "../../config/tenant-config.js";
import { isDbInitialized } from "../../db/index.js";
import { getRemoteSkillEligibility } from "../../infra/skills-remote.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateSkillsBinsParams,
  validateSkillsInstallParams,
  validateSkillsStatusParams,
  validateSkillsUpdateParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers, GatewayRequestHandlerOptions } from "./types.js";

const skillsStatusLog = createSubsystemLogger("gateway/skills-status");

/**
 * Resolve config for the current request. When a tenant context is present,
 * returns the tenant-scoped config merged with global defaults; otherwise
 * returns the plain global config.
 */
async function resolveRequestConfig(
  client: GatewayRequestHandlerOptions["client"],
): Promise<{ cfg: OpenClawConfig; tenant?: TenantContext }> {
  const tenant = (client as unknown as { tenant?: TenantContext })?.tenant;
  if (tenant && isDbInitialized()) {
    const cfg = await loadTenantConfig(tenant.tenantId, {
      userId: tenant.userId,
      userRole: tenant.role,
    });
    return { cfg, tenant };
  }
  return { cfg: loadConfig() };
}

function collectSkillBins(entries: SkillEntry[]): string[] {
  const bins = new Set<string>();
  for (const entry of entries) {
    const required = entry.metadata?.requires?.bins ?? [];
    const anyBins = entry.metadata?.requires?.anyBins ?? [];
    const install = entry.metadata?.install ?? [];
    for (const bin of required) {
      const trimmed = bin.trim();
      if (trimmed) {
        bins.add(trimmed);
      }
    }
    for (const bin of anyBins) {
      const trimmed = bin.trim();
      if (trimmed) {
        bins.add(trimmed);
      }
    }
    for (const spec of install) {
      const specBins = spec?.bins ?? [];
      for (const bin of specBins) {
        const trimmed = String(bin).trim();
        if (trimmed) {
          bins.add(trimmed);
        }
      }
    }
  }
  return [...bins].toSorted();
}

export const skillsHandlers: GatewayRequestHandlers = {
  "skills.status": async ({ params, client, respond }) => {
    if (!validateSkillsStatusParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.status params: ${formatValidationErrors(validateSkillsStatusParams.errors)}`,
        ),
      );
      return;
    }
    const { cfg, tenant } = await resolveRequestConfig(client);
    const agentIdRaw = typeof params?.agentId === "string" ? params.agentId.trim() : "";
    const agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : resolveDefaultAgentId(cfg);
    if (agentIdRaw) {
      const knownAgents = listAgentIds(cfg);
      if (!knownAgents.includes(agentId)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `unknown agent id "${agentIdRaw}"`),
        );
        return;
      }
    }
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const tenantSkillsDir = tenant ? resolveTenantSkillsDir(tenant.tenantId) : undefined;
    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      config: cfg,
      tenantSkillsDir,
    });
    const jiumiSkills = entries
      .filter((entry) => /jiumi/i.test(entry.skill.name))
      .map((entry) => `${entry.skill.name}:${entry.skill.source}`);
    const tenantSkillsDirExists = tenantSkillsDir ? fs.existsSync(tenantSkillsDir) : false;
    skillsStatusLog.info("skills.status resolved workspace skills", {
      agentId,
      tenantId: tenant?.tenantId ?? null,
      userId: tenant?.userId ?? null,
      tenantSkillsDir: tenantSkillsDir ?? null,
      tenantSkillsDirExists,
      workspaceDir,
      skillCount: entries.length,
      jiumiSkills,
      consoleMessage: `skills.status agent=${agentId} tenant=${tenant?.tenantId ?? "(none)"} skillCount=${entries.length} tenantSkillsDir=${tenantSkillsDir ?? "(none)"} tenantSkillsDirExists=${tenantSkillsDirExists} jiumiSkills=${jiumiSkills.length > 0 ? jiumiSkills.join(",") : "(none)"}`,
    });
    const report = buildWorkspaceSkillStatus(workspaceDir, {
      config: cfg,
      entries,
      eligibility: { remote: getRemoteSkillEligibility() },
    });
    respond(true, report, undefined);
  },
  "skills.bins": async ({ params, client, respond }) => {
    if (!validateSkillsBinsParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.bins params: ${formatValidationErrors(validateSkillsBinsParams.errors)}`,
        ),
      );
      return;
    }
    const { cfg, tenant } = await resolveRequestConfig(client);
    const tenantSkillsDir = tenant ? resolveTenantSkillsDir(tenant.tenantId) : undefined;
    const workspaceDirs = listAgentWorkspaceDirs(cfg);
    const bins = new Set<string>();
    for (const workspaceDir of workspaceDirs) {
      const entries = loadWorkspaceSkillEntries(workspaceDir, { config: cfg, tenantSkillsDir });
      for (const bin of collectSkillBins(entries)) {
        bins.add(bin);
      }
    }
    respond(true, { bins: [...bins].toSorted() }, undefined);
  },
  "skills.install": async ({ params, client, respond }) => {
    if (!validateSkillsInstallParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.install params: ${formatValidationErrors(validateSkillsInstallParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      name: string;
      installId: string;
      timeoutMs?: number;
    };
    const { cfg, tenant } = await resolveRequestConfig(client);
    const workspaceDirRaw = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
    const tenantSkillsDir = tenant ? resolveTenantSkillsDir(tenant.tenantId) : undefined;

    // 加载技能条目（含租户技能目录）用于查找和安装
    const entries = loadWorkspaceSkillEntries(workspaceDirRaw, {
      config: cfg,
      tenantSkillsDir,
    });
    const entry = entries.find((e) => e.skill.name === p.name);
    if (!entry) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, `Skill not found: ${p.name}`));
      return;
    }

    const result = await installSkill({
      workspaceDir: workspaceDirRaw,
      skillName: p.name,
      installId: p.installId,
      timeoutMs: p.timeoutMs,
      config: cfg,
      tenantSkillsDir,
    });

    // 安装后运行依赖预检查
    const precheckWarnings: string[] = [];
    if (result.ok) {
      const precheck = await precheckSkill({
        workspaceDir: workspaceDirRaw,
        skillName: p.name,
        config: cfg,
        notify: (msg) => {
          precheckWarnings.push(msg);
        },
        _entries: entries,
      });
      if (!precheck.ok && precheckWarnings.length > 0) {
        result.warnings = [...(result.warnings ?? []), ...precheckWarnings];
      }
    }

    respond(
      result.ok,
      result,
      result.ok ? undefined : errorShape(ErrorCodes.UNAVAILABLE, result.message),
    );
  },
  "skills.update": async ({ params, client, respond }) => {
    if (!validateSkillsUpdateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.update params: ${formatValidationErrors(validateSkillsUpdateParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      skillKey: string;
      enabled?: boolean;
      apiKey?: string;
      env?: Record<string, string>;
    };
    const cfg = loadConfig();
    const skills = cfg.skills ? { ...cfg.skills } : {};
    const entries = skills.entries ? { ...skills.entries } : {};
    const current = entries[p.skillKey] ? { ...entries[p.skillKey] } : {};
    if (typeof p.enabled === "boolean") {
      current.enabled = p.enabled;
    }
    if (typeof p.apiKey === "string") {
      const trimmed = normalizeSecretInput(p.apiKey);
      if (trimmed) {
        current.apiKey = trimmed;
      } else {
        delete current.apiKey;
      }
    }
    if (p.env && typeof p.env === "object") {
      const nextEnv = current.env ? { ...current.env } : {};
      for (const [key, value] of Object.entries(p.env)) {
        const trimmedKey = key.trim();
        if (!trimmedKey) {
          continue;
        }
        const trimmedVal = value.trim();
        if (!trimmedVal) {
          delete nextEnv[trimmedKey];
        } else {
          nextEnv[trimmedKey] = trimmedVal;
        }
      }
      current.env = nextEnv;
    }
    entries[p.skillKey] = current;
    skills.entries = entries;
    const nextConfig: OpenClawConfig = {
      ...cfg,
      skills,
    };
    await writeConfigFile(nextConfig);
    respond(true, { ok: true, skillKey: p.skillKey, config: current }, undefined);
  },
};
