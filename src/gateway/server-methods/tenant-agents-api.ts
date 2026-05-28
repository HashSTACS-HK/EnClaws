/**
 * Gateway RPC handlers for tenant-scoped agent management.
 *
 * Methods:
 *   tenant.agents.list    - List agents for the current tenant
 *   tenant.agents.create  - Create a new agent for the tenant
 *   tenant.agents.update  - Update an agent config
 *   tenant.agents.delete  - Delete an agent
 *
 * Agent isolation:
 *   - owner/admin: can see and manage all agents in the tenant
 *   - member: can only see and manage their own agents (created_by = userId)
 *   - viewer: can only list agents they created (read-only)
 */

import type { GatewayRequestHandlers, GatewayRequestHandlerOptions } from "./types.js";
import { ErrorCodes, errorShape, getPlanUpgradeLink } from "../protocol/index.js";
import { isDbInitialized } from "../../db/index.js";
import { checkTenantQuota } from "../../db/models/tenant.js";
import {
  createTenantAgent,
  listTenantAgents,
  getTenantAgent,
  updateTenantAgent,
  deleteTenantAgent,
} from "../../db/models/tenant-agent.js";
import { listAllTenantChannelApps } from "../../db/models/tenant-channel-app.js";
import { createAuditLog } from "../../db/models/audit-log.js";
import { assertPermission, RbacError } from "../../auth/rbac.js";
import { invalidateTenantConfigCache } from "../../config/tenant-config.js";
import { bumpSkillsSnapshotVersion } from "../../agents/skills/refresh.js";
import type { TenantContext } from "../../auth/middleware.js";
import type { ModelConfigEntry } from "../../db/types.js";
import { resolveTenantAgentDir } from "../../config/sessions/tenant-paths.js";
import { seedAgentWorkspaceFiles } from "../../agents/workspace.js";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_IDENTITY_FILENAME = "IDENTITY.md";

/** Sync config.systemPrompt to the agent's IDENTITY.md file on disk. */
export async function syncIdentityFile(tenantId: string, agentId: string, config?: Record<string, unknown>): Promise<void> {
  const systemPrompt = typeof config?.systemPrompt === "string" ? config.systemPrompt.trim() : "";
  if (!systemPrompt) {return;}
  const agentDir = resolveTenantAgentDir(tenantId, agentId);
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(path.join(agentDir, DEFAULT_IDENTITY_FILENAME), systemPrompt, "utf-8");
}

function getTenantCtx(
  client: GatewayRequestHandlerOptions["client"],
  respond: GatewayRequestHandlerOptions["respond"],
): TenantContext | null {
  if (!isDbInitialized()) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Multi-tenant mode not enabled"));
    return null;
  }
  const tenant = (client as unknown as { tenant?: TenantContext })?.tenant;
  if (!tenant) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Authentication required"));
    return null;
  }
  return tenant;
}

/** owner/admin can manage all agents; member/viewer only their own. */
function isAdminRole(role: string): boolean {
  return role === "owner" || role === "admin";
}

export const tenantAgentsHandlers: GatewayRequestHandlers = {
  "tenant.agents.list": async ({ client, respond }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {return;}

    try {
      assertPermission(ctx.role, "agent.list");
    } catch (err) {
      if (err instanceof RbacError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
        return;
      }
      throw err;
    }

    // Admin/owner see all agents; member/viewer see only their own
    const agents = await listTenantAgents(ctx.tenantId, {
      createdBy: isAdminRole(ctx.role) ? undefined : ctx.userId,
    });
    respond(true, {
      agents: agents.map((a) => ({
        id: a.id,
        agentId: a.agentId,
        name: a.name,
        config: a.config,
        modelConfig: a.modelConfig,
        tools: a.tools,
        skills: a.skills,
        isActive: a.isActive,
        createdBy: a.createdBy,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      })),
    });
  },

  "tenant.agents.create": async ({ params, client, respond, context }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {return;}

    try {
      assertPermission(ctx.role, "agent.create");
    } catch (err) {
      if (err instanceof RbacError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
        return;
      }
      throw err;
    }

    const { agentId, name, config, modelConfig, tools, skills, locale } = params as {
      agentId: string;
      name: string;
      config?: Record<string, unknown>;
      modelConfig?: ModelConfigEntry[];
      tools?: { deny: string[] };
      skills?: string[];
      locale?: string;
    };

    if (!agentId || !name) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_PARAMS, "Missing agentId or name"));
      return;
    }

    if (!modelConfig || modelConfig.length === 0) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_PARAMS, "modelConfig is required and must not be empty"));
      return;
    }

    if (!modelConfig.some((e) => e.isDefault)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_PARAMS, "Exactly one model must be set as default"));
      return;
    }

    if (!/^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/.test(agentId)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_PARAMS, "tenantAgents.agentIdPattern"));
      return;
    }

    const quota = await checkTenantQuota(ctx.tenantId, "agents");
    if (!quota.allowed) {
      respond(false, undefined, errorShape(
        ErrorCodes.QUOTA_EXCEEDED,
        `Agent quota reached (${quota.current}/${quota.max}). Upgrade your plan.`,
        { details: { resource: "agents", current: quota.current, max: quota.max, contactLink: getPlanUpgradeLink() } },
      ));
      return;
    }

    const existing = await getTenantAgent(ctx.tenantId, agentId);
    if (existing) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, `Agent '${agentId}' already exists`));
      return;
    }

    // Extract tools/skills deny lists from config if sent inline (UI sends config.tools = { deny: [...] })
    let resolvedTools = tools;
    let resolvedSkills = skills;
    let cleanConfig = config;
    if (config) {
      if (resolvedTools === undefined && config.tools != null) {
        const toolsCfg = config.tools as Record<string, unknown>;
        if (Array.isArray(toolsCfg.deny)) {
          resolvedTools = { deny: toolsCfg.deny as string[] };
        }
        const { tools: _t, ...rest } = config;
        cleanConfig = rest;
      }
      if (resolvedSkills === undefined && config.skills != null) {
        const skillsCfg = config.skills;
        if (Array.isArray(skillsCfg)) {
          resolvedSkills = skillsCfg as string[];
        } else if (typeof skillsCfg === "object" && Array.isArray((skillsCfg as Record<string, unknown>).deny)) {
          resolvedSkills = (skillsCfg as { deny: string[] }).deny;
        }
        const { skills: _s, ...rest } = cleanConfig!;
        cleanConfig = rest;
      }
    }

    const agent = await createTenantAgent({
      tenantId: ctx.tenantId,
      agentId,
      name,
      config: cleanConfig,
      modelConfig,
      tools: resolvedTools,
      skills: resolvedSkills,
      createdBy: ctx.userId,
    });

    await seedAgentWorkspaceFiles(resolveTenantAgentDir(ctx.tenantId, agentId), {
      locale,
      systemPrompt: typeof config?.systemPrompt === "string" ? config.systemPrompt : undefined,
    });
    invalidateTenantConfigCache(ctx.tenantId);
    await context.reloadDbChannels();

    await createAuditLog({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: "agent.create",
      resource: `agent:${agentId}`,
      detail: { name },
    });

    respond(true, {
      id: agent.id,
      agentId: agent.agentId,
      name: agent.name,
      config: agent.config,
      modelConfig: agent.modelConfig,
      tools: agent.tools,
      skills: agent.skills,
    });
  },

  "tenant.agents.update": async ({ params, client, respond, context }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {return;}

    try {
      assertPermission(ctx.role, "agent.update");
    } catch (err) {
      if (err instanceof RbacError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
        return;
      }
      throw err;
    }

    const { agentId, name, config, modelConfig, tools, skills, isActive } = params as {
      agentId: string;
      name?: string;
      config?: Record<string, unknown>;
      modelConfig?: ModelConfigEntry[];
      tools?: { deny: string[] };
      skills?: string[];
      isActive?: boolean;
    };

    if (modelConfig !== undefined) {
      if (modelConfig.length === 0) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_PARAMS, "modelConfig must not be empty"));
        return;
      }
      if (!modelConfig.some((e) => e.isDefault)) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_PARAMS, "Exactly one model must be set as default"));
        return;
      }
    }

    if (!agentId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_PARAMS, "Missing agentId"));
      return;
    }

    // Member can only update their own agents
    if (!isAdminRole(ctx.role)) {
      const existing = await getTenantAgent(ctx.tenantId, agentId);
      if (!existing || existing.createdBy !== ctx.userId) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Agent not found"));
        return;
      }
    }

    // Extract tools/skills deny lists from config if sent inline (UI sends config.tools = { deny: [...] })
    let resolvedTools = tools;
    let resolvedSkills = skills;
    let cleanConfig = config;
    if (config) {
      if (resolvedTools === undefined && config.tools != null) {
        const toolsCfg = config.tools as Record<string, unknown>;
        if (Array.isArray(toolsCfg.deny)) {
          resolvedTools = { deny: toolsCfg.deny as string[] };
        }
        // Remove tools from config — it's stored in its own column
        const { tools: _t, ...rest } = config;
        cleanConfig = rest;
      }
      if (resolvedSkills === undefined && config.skills != null) {
        const skillsCfg = config.skills;
        if (Array.isArray(skillsCfg)) {
          resolvedSkills = skillsCfg as string[];
        } else if (typeof skillsCfg === "object" && Array.isArray((skillsCfg as Record<string, unknown>).deny)) {
          resolvedSkills = (skillsCfg as { deny: string[] }).deny;
        }
        const { skills: _s, ...rest } = cleanConfig!;
        cleanConfig = rest;
      }
    }

    const updated = await updateTenantAgent(ctx.tenantId, agentId, {
      name,
      config: cleanConfig,
      modelConfig,
      tools: resolvedTools,
      skills: resolvedSkills,
      isActive,
    });
    if (!updated) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Agent not found"));
      return;
    }

    if (config?.systemPrompt !== undefined) {
      await syncIdentityFile(ctx.tenantId, agentId, config);
    }
    invalidateTenantConfigCache(ctx.tenantId);
    // When skills or tools denylist changes via UI, cached skillsSnapshot in
    // sessionStore becomes stale (watcher-based invalidation only fires on
    // file changes, not config writes). Bump the global snapshot version so
    // the next turn of any session rebuilds from fresh DB state.
    if (resolvedSkills !== undefined || resolvedTools !== undefined) {
      bumpSkillsSnapshotVersion({
        reason: "manual",
        changedPath: `tenant:${ctx.tenantId}/agent:${agentId}`,
      });
    }
    await context.reloadDbChannels();

    await createAuditLog({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: "agent.update",
      resource: `agent:${agentId}`,
      detail: { name, isActive },
    });

    respond(true, {
      id: updated.id,
      agentId: updated.agentId,
      name: updated.name,
      config: updated.config,
      tools: updated.tools,
      skills: updated.skills,
      isActive: updated.isActive,
    });
  },

  "tenant.agents.delete": async ({ params, client, respond, context }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {return;}

    try {
      assertPermission(ctx.role, "agent.delete");
    } catch (err) {
      if (err instanceof RbacError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
        return;
      }
      throw err;
    }

    const { agentId } = params as { agentId: string };
    if (!agentId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_PARAMS, "Missing agentId"));
      return;
    }

    // Member can only delete their own agents
    if (!isAdminRole(ctx.role)) {
      const existing = await getTenantAgent(ctx.tenantId, agentId);
      if (!existing || existing.createdBy !== ctx.userId) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Agent not found"));
        return;
      }
    }

    // Check if any channel app is bound to this agent
    const apps = await listAllTenantChannelApps(ctx.tenantId);
    const boundApps = apps.filter((a) => a.agentId === agentId);
    if (boundApps.length > 0) {
      const channels = boundApps.map((a) => `${a.channelName || a.channelType}/${a.appId}`).join(", ");
      respond(false, undefined, errorShape(
        ErrorCodes.INVALID_REQUEST,
        "tenantAgents.deleteInUse",
        { details: { channels } },
      ));
      return;
    }

    const deleted = await deleteTenantAgent(ctx.tenantId, agentId);

    // Remove the agent directory on disk
    try {
      const agentDir = resolveTenantAgentDir(ctx.tenantId, agentId);
      await fs.rm(agentDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup — don't fail the delete if directory removal fails
    }

    invalidateTenantConfigCache(ctx.tenantId);
    await context.reloadDbChannels();

    await createAuditLog({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: "agent.delete",
      resource: `agent:${agentId}`,
    });

    respond(true, { deleted });
  },

  /** List all active channel apps for the tenant (used by agent form dropdown). */
  "tenant.agents.channel_apps.list": async ({ client, respond }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {return;}
    try { assertPermission(ctx.role, "agent.list"); } catch (err) {
      if (err instanceof RbacError) { respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message)); return; }
      throw err;
    }
    const apps = await listAllTenantChannelApps(ctx.tenantId);
    respond(true, { channelApps: apps });
  },
};
