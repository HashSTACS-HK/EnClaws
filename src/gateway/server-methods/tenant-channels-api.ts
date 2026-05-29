/**
 * Gateway RPC handlers for tenant-scoped channel management.
 *
 * Methods:
 *   tenant.channels.list       - List channels for the current tenant
 *   tenant.channels.create     - Add a channel
 *   tenant.channels.update     - Update channel
 *   tenant.channels.delete     - Remove a channel
 *   tenant.channels.apps.list  - List apps in a channel
 *   tenant.channels.apps.add   - Add an app to a channel
 *   tenant.channels.apps.update - Update a channel app
 *   tenant.channels.apps.delete - Remove an app from a channel
 */

import fs from "node:fs/promises";
import path from "node:path";
import { ensureTenantBootstrapFiles } from "../../agents/workspace.js";
import type { TenantContext } from "../../auth/middleware.js";
import { assertPermission, RbacError } from "../../auth/rbac.js";
import type { ChannelId } from "../../channels/plugins/types.js";
import { resolveTenantDir, resolveTenantAgentDir } from "../../config/sessions/tenant-paths.js";
import { invalidateTenantConfigCache } from "../../config/tenant-config.js";
import { isDbInitialized } from "../../db/index.js";
import { createAuditLog } from "../../db/models/audit-log.js";
import {
  createTenantAgent,
  listTenantAgents,
  updateTenantAgent,
  deleteTenantAgent,
} from "../../db/models/tenant-agent.js";
import {
  createChannelApp,
  listChannelApps,
  updateChannelApp,
  deleteChannelApp,
} from "../../db/models/tenant-channel-app.js";
import {
  createTenantChannel,
  listTenantChannels,
  getTenantChannelById,
  updateTenantChannel,
  deleteTenantChannel,
} from "../../db/models/tenant-channel.js";
import { checkTenantQuota } from "../../db/models/tenant.js";
import type { ChannelPolicy, TenantChannelConfig, ModelConfigEntry } from "../../db/types.js";
import { ErrorCodes, errorShape, getPlanUpgradeLink } from "../protocol/index.js";
import type { GatewayRequestHandlers, GatewayRequestHandlerOptions } from "./types.js";

function getTenantCtx(
  client: GatewayRequestHandlerOptions["client"],
  respond: GatewayRequestHandlerOptions["respond"],
): TenantContext | null {
  if (!isDbInitialized()) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "Multi-tenant mode not enabled"),
    );
    return null;
  }
  const tenant = (client as unknown as { tenant?: TenantContext })?.tenant;
  if (!tenant) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Authentication required"));
    return null;
  }
  return tenant;
}

const VALID_POLICIES: ChannelPolicy[] = new Set(["open", "allowlist", "disabled"]);

function isValidPolicy(v: unknown): v is ChannelPolicy {
  return typeof v === "string" && VALID_POLICIES.has(v as ChannelPolicy);
}

// Tenant-scoped duplicate detection across channels of the same type.
// Case-insensitive because some plugins (e.g. WeCom) normalize appId casing at runtime,
// so "ww123" and "WW123" must collide even though Postgres UNIQUE(channel_id, app_id) would not.
async function findConflictingAppId(
  tenantId: string,
  channelType: string,
  appId: string,
  excludeAppDbId?: string,
): Promise<{ channelId: string; channelName: string | null; appId: string } | null> {
  const target = appId.trim().toLowerCase();
  if (!target) {
    return null;
  }
  const sameTypeChannels = await listTenantChannels(tenantId, { activeOnly: false, channelType });
  for (const ch of sameTypeChannels) {
    const apps = await listChannelApps(ch.id);
    for (const a of apps) {
      if (excludeAppDbId && a.id === excludeAppDbId) {
        continue;
      }
      if (a.appId.trim().toLowerCase() === target) {
        return { channelId: ch.id, channelName: ch.channelName, appId: a.appId };
      }
    }
  }
  return null;
}

// Stable text — UI's tr() pattern-matches this string to translate into the active locale.
// Keep the substring "已在其他频道中注册" stable if you change wording.
const DUPLICATE_APP_ID_ACROSS_CHANNELS = "该 App ID 已在其他频道中注册，请勿重复添加";
const DUPLICATE_APP_ID_IN_PAYLOAD = "存在重复的 App ID，请去重后再试";

type ConnectionState = "online" | "offline" | "connecting";

// Three-state status derived from the plugin's runtime snapshot:
// - plugin not running                     → offline
// - plugin explicitly reported connected   → online / offline
// - plugin running but never reported      → connecting (state unknown)
// This avoids falsely showing a misconfigured bot as "online" while its
// plugin is still retrying WS auth in the background.
function resolveConnectionState(snapshot: {
  running?: boolean;
  connected?: boolean;
}): ConnectionState {
  if (snapshot.running !== true) {
    return "offline";
  }
  if (snapshot.connected === true) {
    return "online";
  }
  if (snapshot.connected === false) {
    return "offline";
  }
  return "connecting";
}

export const tenantChannelsHandlers: GatewayRequestHandlers = {
  "tenant.channels.list": async ({
    params,
    client,
    respond,
    context,
  }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {
      return;
    }

    try {
      assertPermission(ctx.role, "channel.list");
    } catch (err) {
      if (err instanceof RbacError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
        return;
      }
      throw err;
    }

    const { channelType } = params as { channelType?: string };
    const channels = await listTenantChannels(ctx.tenantId, { channelType });

    // Grab runtime snapshot to resolve per-app connection status
    const runtimeSnapshot = context.getRuntimeSnapshot();

    // Load apps and associated agents for each channel
    const allAgents = await listTenantAgents(ctx.tenantId, { activeOnly: false });
    const channelsWithApps = await Promise.all(
      channels.map(async (ch) => {
        const apps = await listChannelApps(ch.id);
        return {
          id: ch.id,
          channelType: ch.channelType,
          channelName: ch.channelName,
          channelPolicy: ch.channelPolicy,
          config: ch.config,
          isActive: ch.isActive,
          createdAt: ch.createdAt,
          updatedAt: ch.updatedAt,
          apps: apps.map((a) => {
            // Find the agent linked to this app via app.agentId
            const linkedAgent = a.agentId ? allAgents.find((ag) => ag.agentId === a.agentId) : null;
            // Resolve connection status from runtime snapshot.
            // Some plugins (e.g. WeCom) normalize account keys to lowercase in
            // their snapshot while DB stores the original-case appId — try the
            // exact key first, then fall back to a case-insensitive scan.
            const accountsForChannel = runtimeSnapshot.channelAccounts[ch.channelType as ChannelId];
            let accountSnapshot = accountsForChannel?.[a.appId];
            if (!accountSnapshot && accountsForChannel) {
              const lowerAppId = a.appId.toLowerCase();
              for (const [key, snap] of Object.entries(accountsForChannel)) {
                if (key.toLowerCase() === lowerAppId) {
                  accountSnapshot = snap;
                  break;
                }
              }
            }
            return {
              id: a.id,
              appId: a.appId,
              appSecret: a.appSecret,
              botName: a.botName,
              groupPolicy: a.groupPolicy,
              isActive: a.isActive,
              connectionStatus: accountSnapshot
                ? {
                    state: resolveConnectionState(accountSnapshot),
                    connected: accountSnapshot.connected === true,
                    lastConnectedAt: accountSnapshot.lastStartAt ?? null,
                    lastDisconnectedAt: accountSnapshot.lastStopAt ?? null,
                    lastError: accountSnapshot.lastError ?? null,
                  }
                : null,
              agent: linkedAgent
                ? {
                    agentId: linkedAgent.agentId,
                    name: linkedAgent.name,
                    config: linkedAgent.config,
                    modelConfig: linkedAgent.modelConfig,
                    isActive: linkedAgent.isActive,
                  }
                : null,
            };
          }),
        };
      }),
    );

    respond(true, { channels: channelsWithApps });
  },

  /**
   * Create a new channel.
   *
   * Params:
   *   channelType: string
   *   channelName: string
   *   channelPolicy?: "open" | "allowlist" | "disabled"
   *   apps?: Array<{ appId, appSecret?, groupPolicy? }>
   */
  "tenant.channels.create": async ({
    params,
    client,
    respond,
    context,
  }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {
      return;
    }

    try {
      assertPermission(ctx.role, "channel.create");
    } catch (err) {
      if (err instanceof RbacError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
        return;
      }
      throw err;
    }

    const { channelType, channelName, channelPolicy, config, apps } = params as {
      channelType: string;
      channelName?: string;
      channelPolicy?: string;
      config?: Partial<TenantChannelConfig>;
      apps?: Array<{
        appId: string;
        appSecret?: string;
        botName?: string;
        groupPolicy?: string;
        agentId?: string;
        agentConfig?: {
          agentId?: string;
          displayName?: string;
          modelConfig?: ModelConfigEntry[];
          systemPrompt?: string;
          feishuOpenId?: string;
          tools?: { deny?: string[] };
        };
      }>;
    };

    if (!channelType) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_PARAMS, "Missing channelType"));
      return;
    }

    if (channelPolicy && !isValidPolicy(channelPolicy)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_PARAMS,
          "channelPolicy must be one of: open, allowlist, disabled",
        ),
      );
      return;
    }

    // Validate apps
    if (apps) {
      for (const app of apps) {
        if (!app.appId) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_PARAMS, "Each app must have an appId"),
          );
          return;
        }
        if (app.groupPolicy && !isValidPolicy(app.groupPolicy)) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_PARAMS,
              "App groupPolicy must be one of: open, allowlist, disabled",
            ),
          );
          return;
        }
      }

      // Reject duplicates within the request payload itself.
      const seen = new Map<string, string>();
      for (const app of apps) {
        const key = app.appId.trim().toLowerCase();
        if (seen.has(key)) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, DUPLICATE_APP_ID_IN_PAYLOAD, {
              details: { appId: app.appId },
            }),
          );
          return;
        }
        seen.set(key, app.appId);
      }

      // Reject duplicates against existing channels of the same type in this tenant.
      for (const app of apps) {
        const conflict = await findConflictingAppId(ctx.tenantId, channelType, app.appId);
        if (conflict) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, DUPLICATE_APP_ID_ACROSS_CHANNELS, {
              details: { appId: app.appId, channelName: conflict.channelName },
            }),
          );
          return;
        }
      }
    }

    // Check quota
    const quota = await checkTenantQuota(ctx.tenantId, "channels");
    if (!quota.allowed) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.QUOTA_EXCEEDED,
          `Channel quota reached (${quota.current}/${quota.max}). Upgrade your plan.`,
          {
            details: {
              resource: "channels",
              current: quota.current,
              max: quota.max,
              contactLink: getPlanUpgradeLink(),
            },
          },
        ),
      );
      return;
    }

    try {
      // Build default config, merging user-provided overrides
      const firstApp = apps?.[0];
      const defaultConfig: Partial<TenantChannelConfig> = {
        enabled: true,
        appId: firstApp?.appId ?? "",
        appSecret: firstApp?.appSecret ?? "",
        domain: channelType,
        connectionMode: "websocket",
        requireMention: true,
        dmPolicy: "open",
        groupPolicy: "open",
        allowFrom: ["*"],
        groupAllowFrom: [],
        replyMode: { group: "streaming", direct: "streaming", default: "auto" },
        uat: { ownerOnly: false, appRoleAuth: true, accessLevel: 1, autoOnboarding: true },
        streaming: true,
        ...config,
      };

      const channel = await createTenantChannel({
        tenantId: ctx.tenantId,
        channelType,
        channelName,
        channelPolicy: (channelPolicy as ChannelPolicy) ?? "open",
        config: defaultConfig,
        createdBy: ctx.userId,
      });

      // Create apps if provided
      const createdApps = [];
      if (apps && apps.length > 0) {
        for (const app of apps) {
          const created = await createChannelApp({
            channelId: channel.id,
            tenantId: ctx.tenantId,
            appId: app.appId,
            appSecret: app.appSecret,
            botName: app.botName,
            groupPolicy: (app.groupPolicy as ChannelPolicy) ?? "open",
          });
          createdApps.push({
            id: created.id,
            appId: created.appId,
            appSecret: created.appSecret,
            botName: created.botName,
            groupPolicy: created.groupPolicy,
            isActive: created.isActive,
          });
        }
      }

      // Bind or auto-create an agent for each app
      const createdAgents = [];
      for (let appIdx = 0; appIdx < createdApps.length; appIdx++) {
        const app = createdApps[appIdx];
        const appInput = apps![appIdx];
        const agentConfig = appInput.agentConfig;

        // If agentId is provided, bind existing agent
        if (appInput.agentId) {
          try {
            await updateChannelApp(app.id, ctx.tenantId, { agentId: appInput.agentId });
            createdAgents.push({ agentId: appInput.agentId, name: null });
          } catch (bindErr: unknown) {
            console.warn(
              `[tenant.channels.create] Bind agent ${appInput.agentId} failed: ${bindErr instanceof Error ? bindErr.message : "unknown"}`,
            );
          }
          continue;
        }

        // Legacy: Build agentId from agentConfig or auto-generate
        let finalAgentId: string;
        if (agentConfig?.agentId) {
          finalAgentId = agentConfig.agentId;
        } else {
          const rawName = (app.botName || app.appId || "agent")
            .toLowerCase()
            .replace(/[^a-z0-9]/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-+|-+$/g, "");
          const suffix = rawName || `app${appIdx + 1}`;
          finalAgentId = `${channelType}-${suffix}`.slice(0, 64);
        }

        const displayName = agentConfig?.displayName || app.botName || app.appId;

        try {
          const agent = await createTenantAgent({
            tenantId: ctx.tenantId,
            agentId: finalAgentId,
            name: displayName,
            config: {
              displayName,
              ...(agentConfig?.systemPrompt ? { systemPrompt: agentConfig.systemPrompt } : {}),
              ...(agentConfig?.feishuOpenId ? { feishuOpenId: agentConfig.feishuOpenId } : {}),
              ...(agentConfig?.tools ? { tools: agentConfig.tools } : {}),
            },
            modelConfig: agentConfig?.modelConfig ?? [],
            createdBy: ctx.userId,
          });
          createdAgents.push({
            agentId: agent.agentId,
            name: agent.name,
          });

          // Initialize tenant + agent directory and bootstrap files on disk
          // (skip user-level dirs — they are created on-demand when a user starts a session)
          try {
            const tenantDir = resolveTenantDir(ctx.tenantId);
            const agentDir = resolveTenantAgentDir(ctx.tenantId, agent.agentId);
            const bootstrapCtx = { tenantDir, agentDir };
            await ensureTenantBootstrapFiles(bootstrapCtx);
            // Sync systemPrompt to IDENTITY.md
            if (agentConfig?.systemPrompt) {
              const identityPath = path.join(agentDir, "IDENTITY.md");
              await fs.writeFile(identityPath, String(agentConfig.systemPrompt).trim(), "utf-8");
            }
          } catch (dirErr: unknown) {
            const dirMsg = dirErr instanceof Error ? dirErr.message : "unknown";
            console.warn(
              `[tenant.channels.create] Bootstrap dir failed for agent ${agent.agentId}: ${dirMsg}`,
            );
          }
        } catch (agentErr: unknown) {
          // Agent creation failure should not block channel creation
          const agentMsg = agentErr instanceof Error ? agentErr.message : "unknown";
          console.warn(
            `[tenant.channels.create] Auto-create agent failed for app ${app.appId}: ${agentMsg}`,
          );
        }
      }

      invalidateTenantConfigCache(ctx.tenantId);

      // Reload DB channels and start connections for newly created apps
      if (channel.isActive && channel.channelPolicy !== "disabled" && createdApps.length > 0) {
        await context.reloadDbChannels();
        for (const app of createdApps) {
          if (app.isActive && app.groupPolicy !== "disabled") {
            await context.startChannel(channelType as ChannelId, app.appId);
          }
        }
      }

      await createAuditLog({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        action: "channel.create",
        resource: `channel:${channelType}`,
        detail: { channelName, channelPolicy, appCount: createdApps.length },
      });

      // Attach live connectionStatus so the UI doesn't flicker "offline" before
      // the first list refresh picks up the started runtime.
      const snapshotAfterStart = context.getRuntimeSnapshot();
      const appsWithStatus = createdApps.map((app) => {
        const accountsForChannel = snapshotAfterStart.channelAccounts[channelType as ChannelId];
        let accountSnapshot = accountsForChannel?.[app.appId];
        if (!accountSnapshot && accountsForChannel) {
          const lowerAppId = app.appId.toLowerCase();
          for (const [key, snap] of Object.entries(accountsForChannel)) {
            if (key.toLowerCase() === lowerAppId) {
              accountSnapshot = snap;
              break;
            }
          }
        }
        return {
          ...app,
          connectionStatus: accountSnapshot
            ? {
                state: resolveConnectionState(accountSnapshot),
                connected: accountSnapshot.connected === true,
                lastConnectedAt: accountSnapshot.lastStartAt ?? null,
                lastDisconnectedAt: accountSnapshot.lastStopAt ?? null,
                lastError: accountSnapshot.lastError ?? null,
              }
            : null,
        };
      });

      respond(true, {
        id: channel.id,
        channelType: channel.channelType,
        channelName: channel.channelName,
        channelPolicy: channel.channelPolicy,
        config: channel.config,
        isActive: channel.isActive,
        apps: appsWithStatus,
        agents: createdAgents,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to create channel";
      const msgLower = msg.toLowerCase();
      const errCode = (err as { code?: string })?.code;
      if (
        msgLower.includes("duplicate key") ||
        msgLower.includes("unique constraint") ||
        msgLower.includes("重复键") ||
        msgLower.includes("唯一约束") ||
        errCode === "23505"
      ) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "频道名称已存在，请更换名称"),
        );
      } else {
        respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, msg));
      }
    }
  },

  /**
   * Update a channel.
   *
   * Params:
   *   channelId: string
   *   channelName?: string
   *   channelPolicy?: "open" | "allowlist" | "disabled"
   *   isActive?: boolean
   */
  "tenant.channels.update": async ({
    params,
    client,
    respond,
    context,
  }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {
      return;
    }

    try {
      assertPermission(ctx.role, "channel.update");
    } catch (err) {
      if (err instanceof RbacError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
        return;
      }
      throw err;
    }

    const { channelId, channelName, channelPolicy, isActive, config, agentUpdates } = params as {
      channelId: string;
      channelName?: string;
      channelPolicy?: string;
      isActive?: boolean;
      config?: TenantChannelConfig;
      agentUpdates?: Array<{
        agentId: string;
        name?: string;
        config?: Record<string, unknown>;
      }>;
    };

    if (!channelId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_PARAMS, "Missing channelId"));
      return;
    }

    if (channelPolicy !== undefined && !isValidPolicy(channelPolicy)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_PARAMS,
          "channelPolicy must be one of: open, allowlist, disabled",
        ),
      );
      return;
    }

    // Fetch the old channel to detect state changes
    const oldChannel = await getTenantChannelById(ctx.tenantId, channelId);

    const updated = await updateTenantChannel(ctx.tenantId, channelId, {
      isActive,
      channelName,
      channelPolicy: channelPolicy,
      config,
    });
    if (!updated) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Channel not found"));
      return;
    }

    invalidateTenantConfigCache(ctx.tenantId);

    // Determine if connections need to be stopped or started
    const wasEffectivelyActive = oldChannel?.isActive && oldChannel.channelPolicy !== "disabled";
    const isEffectivelyActive = updated.isActive && updated.channelPolicy !== "disabled";

    if (wasEffectivelyActive && !isEffectivelyActive) {
      // Channel became disabled/inactive — stop all connections under this channel
      const apps = await listChannelApps(channelId);
      for (const app of apps) {
        await context.stopChannel(updated.channelType as ChannelId, app.appId);
      }
      await context.reloadDbChannels();
    } else if (!wasEffectivelyActive && isEffectivelyActive) {
      // Channel became enabled/active — start all effectively active connections
      await context.reloadDbChannels();
      const apps = await listChannelApps(channelId);
      for (const app of apps) {
        if (app.isActive && app.groupPolicy !== "disabled") {
          await context.startChannel(updated.channelType as ChannelId, app.appId);
        }
      }
    } else if (isEffectivelyActive) {
      // Channel remained active but config may have changed (e.g. name) — reload
      await context.reloadDbChannels();
    }

    // Update linked agents if provided
    if (agentUpdates && agentUpdates.length > 0) {
      for (const au of agentUpdates) {
        if (!au.agentId) {
          continue;
        }
        try {
          await updateTenantAgent(ctx.tenantId, au.agentId, {
            name: au.name,
            config: au.config,
          });
          if (au.config?.systemPrompt !== undefined) {
            const agentDir = resolveTenantAgentDir(ctx.tenantId, au.agentId);
            await fs.mkdir(agentDir, { recursive: true });
            await fs.writeFile(
              path.join(agentDir, "IDENTITY.md"),
              String(au.config.systemPrompt).trim(),
              "utf-8",
            );
          }
        } catch (agentErr: unknown) {
          const msg = agentErr instanceof Error ? agentErr.message : "unknown";
          console.warn(`[tenant.channels.update] Agent update failed for ${au.agentId}: ${msg}`);
        }
      }
      invalidateTenantConfigCache(ctx.tenantId);
      await context.reloadDbChannels();
    }

    await createAuditLog({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: "channel.update",
      resource: `channel:${updated.channelType}`,
    });

    respond(true, {
      id: updated.id,
      channelType: updated.channelType,
      channelName: updated.channelName,
      channelPolicy: updated.channelPolicy,
      config: updated.config,
      isActive: updated.isActive,
    });
  },

  /**
   * Delete a channel (and cascade-delete its apps).
   */
  "tenant.channels.delete": async ({
    params,
    client,
    respond,
    context,
  }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {
      return;
    }

    try {
      assertPermission(ctx.role, "channel.delete");
    } catch (err) {
      if (err instanceof RbacError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
        return;
      }
      throw err;
    }

    const { channelId } = params as { channelId: string };
    if (!channelId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_PARAMS, "Missing channelId"));
      return;
    }

    // Stop all running connections before deleting
    const channel = await getTenantChannelById(ctx.tenantId, channelId);
    if (channel) {
      const apps = await listChannelApps(channelId);
      for (const app of apps) {
        await context.stopChannel(channel.channelType as ChannelId, app.appId);
      }

      // Agent bindings are on the app side (agent_id column) and will be
      // cleaned up automatically when apps are cascade-deleted with the channel.
    }

    const deleted = await deleteTenantChannel(ctx.tenantId, channelId);

    invalidateTenantConfigCache(ctx.tenantId);
    await context.reloadDbChannels();

    await createAuditLog({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: "channel.delete",
      resource: `channel:${channelId}`,
    });

    respond(true, { deleted });
  },

  // ============================================================
  // Channel App sub-resources
  // ============================================================

  /**
   * List apps for a channel.
   * Params: { channelId: string }
   */
  "tenant.channels.apps.list": async ({
    params,
    client,
    respond,
  }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {
      return;
    }

    try {
      assertPermission(ctx.role, "channel.list");
    } catch (err) {
      if (err instanceof RbacError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
        return;
      }
      throw err;
    }

    const { channelId } = params as { channelId: string };
    if (!channelId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_PARAMS, "Missing channelId"));
      return;
    }

    // Verify channel belongs to tenant
    const channel = await getTenantChannelById(ctx.tenantId, channelId);
    if (!channel) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Channel not found"));
      return;
    }

    const apps = await listChannelApps(channelId);
    respond(true, {
      apps: apps.map((a) => ({
        id: a.id,
        appId: a.appId,
        appSecret: a.appSecret,
        botName: a.botName,
        groupPolicy: a.groupPolicy,
        isActive: a.isActive,
        createdAt: a.createdAt,
      })),
    });
  },

  /**
   * Add an app to a channel.
   * Params: { channelId, appId, appSecret?, groupPolicy? }
   */
  "tenant.channels.apps.add": async ({
    params,
    client,
    respond,
    context,
  }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {
      return;
    }

    try {
      assertPermission(ctx.role, "channel.create");
    } catch (err) {
      if (err instanceof RbacError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
        return;
      }
      throw err;
    }

    const {
      channelId,
      appId,
      appSecret,
      botName,
      groupPolicy,
      agentConfig,
      agentId: bindAgentId,
    } = params as {
      channelId: string;
      appId: string;
      appSecret?: string;
      botName?: string;
      groupPolicy?: string;
      agentId?: string;
      agentConfig?: {
        agentId?: string;
        displayName?: string;
        modelConfig?: ModelConfigEntry[];
        systemPrompt?: string;
        feishuOpenId?: string;
        tools?: { deny?: string[] };
      };
    };

    if (!channelId || !appId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_PARAMS, "Missing channelId or appId"),
      );
      return;
    }

    if (groupPolicy && !isValidPolicy(groupPolicy)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_PARAMS,
          "groupPolicy must be one of: open, allowlist, disabled",
        ),
      );
      return;
    }

    // Verify channel belongs to tenant
    const channel = await getTenantChannelById(ctx.tenantId, channelId);
    if (!channel) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Channel not found"));
      return;
    }

    // Reject duplicate appId across all channels of the same type under this tenant.
    const conflict = await findConflictingAppId(ctx.tenantId, channel.channelType, appId);
    if (conflict) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, DUPLICATE_APP_ID_ACROSS_CHANNELS, {
          details: { appId, channelName: conflict.channelName },
        }),
      );
      return;
    }

    try {
      const app = await createChannelApp({
        channelId,
        tenantId: ctx.tenantId,
        appId,
        appSecret,
        botName,
        groupPolicy: (groupPolicy as ChannelPolicy) ?? "open",
      });

      // Bind existing agent if agentId provided
      let createdAgent: { agentId: string; name: string | null } | null = null;
      if (bindAgentId) {
        try {
          await updateChannelApp(app.id, ctx.tenantId, { agentId: bindAgentId });
          createdAgent = { agentId: bindAgentId, name: null };
        } catch (bindErr: unknown) {
          console.warn(
            `[apps.add] Bind agent ${bindAgentId} failed: ${bindErr instanceof Error ? bindErr.message : "unknown"}`,
          );
        }
      } else if (agentConfig) {
        let finalAgentId: string;
        if (agentConfig.agentId) {
          finalAgentId = agentConfig.agentId;
        } else {
          const rawName = (app.botName || appId || "agent")
            .toLowerCase()
            .replace(/[^a-z0-9]/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-+|-+$/g, "");
          finalAgentId = `${channel.channelType}-${rawName || "agent"}`.slice(0, 64);
        }
        const displayName = agentConfig.displayName || app.botName || appId;
        try {
          const agent = await createTenantAgent({
            tenantId: ctx.tenantId,
            agentId: finalAgentId,
            name: displayName,
            config: {
              displayName,
              ...(agentConfig.systemPrompt ? { systemPrompt: agentConfig.systemPrompt } : {}),
              ...(agentConfig.feishuOpenId ? { feishuOpenId: agentConfig.feishuOpenId } : {}),
              ...(agentConfig.tools ? { tools: agentConfig.tools } : {}),
            },
            modelConfig: agentConfig.modelConfig ?? [],
            createdBy: ctx.userId,
          });
          createdAgent = { agentId: agent.agentId, name: agent.name };

          try {
            const tenantDir = resolveTenantDir(ctx.tenantId);
            const agentDir = resolveTenantAgentDir(ctx.tenantId, agent.agentId);
            const bootstrapCtx = { tenantDir, agentDir };
            await ensureTenantBootstrapFiles(bootstrapCtx);
            if (agentConfig.systemPrompt) {
              await fs.writeFile(
                path.join(agentDir, "IDENTITY.md"),
                String(agentConfig.systemPrompt).trim(),
                "utf-8",
              );
            }
          } catch (dirErr: unknown) {
            console.warn(
              `[apps.add] Bootstrap dir failed for agent ${agent.agentId}: ${dirErr instanceof Error ? dirErr.message : "unknown"}`,
            );
          }
        } catch (agentErr: unknown) {
          console.warn(
            `[apps.add] Auto-create agent failed: ${agentErr instanceof Error ? agentErr.message : "unknown"}`,
          );
        }
      }

      invalidateTenantConfigCache(ctx.tenantId);

      // Start connection for the new app if channel and app are both effectively active
      if (
        channel.isActive &&
        channel.channelPolicy !== "disabled" &&
        app.isActive &&
        app.groupPolicy !== "disabled"
      ) {
        await context.reloadDbChannels();
        await context.startChannel(channel.channelType as ChannelId, app.appId);
      }

      await createAuditLog({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        action: "channel.app.add",
        resource: `channel:${channelId}`,
        detail: { appId, botName: app.botName },
      });

      respond(true, {
        id: app.id,
        appId: app.appId,
        appSecret: app.appSecret,
        botName: app.botName,
        groupPolicy: app.groupPolicy,
        isActive: app.isActive,
        agent: createdAgent,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to add app";
      const msgLower = msg.toLowerCase();
      const errCode = (err as { code?: string })?.code;
      if (
        msgLower.includes("duplicate key") ||
        msgLower.includes("unique constraint") ||
        msgLower.includes("重复键") ||
        msgLower.includes("唯一约束") ||
        errCode === "23505"
      ) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "该频道下已存在相同 App ID 的应用"),
        );
      } else {
        respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, msg));
      }
    }
  },

  /**
   * Update a channel app.
   * Params: { appDbId, appId?, appSecret?, groupPolicy?, isActive? }
   */
  "tenant.channels.apps.update": async ({
    params,
    client,
    respond,
    context,
  }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {
      return;
    }

    try {
      assertPermission(ctx.role, "channel.update");
    } catch (err) {
      if (err instanceof RbacError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
        return;
      }
      throw err;
    }

    const {
      appDbId,
      appId,
      appSecret,
      botName,
      groupPolicy,
      isActive,
      agentConfig,
      agentId: bindAgentId,
    } = params as {
      appDbId: string;
      appId?: string;
      appSecret?: string;
      botName?: string;
      groupPolicy?: string;
      isActive?: boolean;
      agentId?: string;
      agentConfig?: {
        agentId?: string;
        displayName?: string;
        modelConfig?: ModelConfigEntry[];
        systemPrompt?: string;
        feishuOpenId?: string;
        tools?: { deny?: string[] };
      };
    };

    if (!appDbId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_PARAMS, "Missing appDbId"));
      return;
    }

    if (groupPolicy !== undefined && !isValidPolicy(groupPolicy)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_PARAMS,
          "groupPolicy must be one of: open, allowlist, disabled",
        ),
      );
      return;
    }

    // Find old app info to track changes for connection lifecycle
    let oldApp:
      | { appId: string; appSecret: string; isActive: boolean; groupPolicy: string }
      | undefined;
    let channelForApp: Awaited<ReturnType<typeof getTenantChannelById>> = null;
    {
      const allChannels = await listTenantChannels(ctx.tenantId);
      for (const ch of allChannels) {
        const apps = await listChannelApps(ch.id);
        const found = apps.find((a) => a.id === appDbId);
        if (found) {
          oldApp = {
            appId: found.appId,
            appSecret: found.appSecret,
            isActive: found.isActive,
            groupPolicy: found.groupPolicy,
          };
          channelForApp = ch;
          break;
        }
      }
    }

    // Reject duplicate appId across all channels of the same type under this tenant,
    // but allow keeping the current app's own appId (exclude by appDbId).
    if (appId !== undefined && appId !== oldApp?.appId && channelForApp) {
      const conflict = await findConflictingAppId(
        ctx.tenantId,
        channelForApp.channelType,
        appId,
        appDbId,
      );
      if (conflict) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, DUPLICATE_APP_ID_ACROSS_CHANNELS, {
            details: { appId, channelName: conflict.channelName },
          }),
        );
        return;
      }
    }

    const updated = await updateChannelApp(appDbId, ctx.tenantId, {
      appId,
      appSecret,
      botName,
      groupPolicy: groupPolicy,
      isActive,
      ...(bindAgentId !== undefined ? { agentId: bindAgentId || null } : {}),
    });

    if (!updated) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "App not found"));
      return;
    }

    invalidateTenantConfigCache(ctx.tenantId);

    // Manage connection lifecycle — only if connection-relevant fields changed
    if (channelForApp && oldApp) {
      const appIdChanged = oldApp.appId !== updated.appId;
      const secretChanged = oldApp.appSecret !== updated.appSecret;
      const activeChanged = oldApp.isActive !== updated.isActive;
      const policyChanged = oldApp.groupPolicy !== updated.groupPolicy;
      const agentChanged = bindAgentId !== undefined;
      // Agent change only needs config reload (no reconnect) — current sessions finish with old agent,
      // new messages pick up the new agent via fresh route resolution.
      const needsReconnect = appIdChanged || secretChanged || activeChanged || policyChanged;
      const needsConfigReload = agentChanged;

      if (!needsReconnect) {
        // Nothing connection-relevant changed — just reload config
        await context.reloadDbChannels();
      } else {
        const channelEffectivelyActive =
          channelForApp.isActive && channelForApp.channelPolicy !== "disabled";
        // App is effectively enabled when active and groupPolicy is not "disabled"
        const appEffectivelyActive = updated.isActive && updated.groupPolicy !== "disabled";

        if (!appEffectivelyActive || !channelEffectivelyActive) {
          // App or channel became disabled — stop its connection
          if (appIdChanged) {
            await context.stopChannel(channelForApp.channelType as ChannelId, oldApp.appId);
          }
          await context.stopChannel(channelForApp.channelType as ChannelId, updated.appId);
          await context.reloadDbChannels();
        } else {
          // App and channel are both active — restart connection
          if (appIdChanged) {
            await context.stopChannel(channelForApp.channelType as ChannelId, oldApp.appId);
          } else {
            await context.stopChannel(channelForApp.channelType as ChannelId, updated.appId);
          }
          await context.reloadDbChannels();
          await context.startChannel(channelForApp.channelType as ChannelId, updated.appId);
        }
      }
    }

    // Agent binding was already written in the unified updateChannelApp call above,
    // and connection restart is handled by the needsReconnect logic when agentChanged=true.
    if (!bindAgentId && agentConfig) {
      // Legacy: Update linked agent if agentConfig provided (backward compat)
      const currentApp = (await listChannelApps(channelForApp.id)).find((a) => a.id === appDbId);
      const allAgents = await listTenantAgents(ctx.tenantId, { activeOnly: false });
      const linkedAgent = currentApp?.agentId
        ? allAgents.find((ag) => ag.agentId === currentApp.agentId)
        : null;
      if (linkedAgent) {
        try {
          await updateTenantAgent(ctx.tenantId, linkedAgent.agentId, {
            name: agentConfig.displayName || linkedAgent.name,
            config: {
              ...linkedAgent.config,
              ...(agentConfig.displayName ? { displayName: agentConfig.displayName } : {}),
              ...(agentConfig.systemPrompt ? { systemPrompt: agentConfig.systemPrompt } : {}),
              ...(agentConfig.feishuOpenId ? { feishuOpenId: agentConfig.feishuOpenId } : {}),
              ...(agentConfig.tools !== undefined ? { tools: agentConfig.tools } : {}),
            },
            ...(agentConfig.modelConfig !== undefined
              ? { modelConfig: agentConfig.modelConfig }
              : {}),
          });
          if (agentConfig.systemPrompt !== undefined) {
            const agentDir = resolveTenantAgentDir(ctx.tenantId, linkedAgent.agentId);
            await fs.mkdir(agentDir, { recursive: true });
            await fs.writeFile(
              path.join(agentDir, "IDENTITY.md"),
              String(agentConfig.systemPrompt).trim(),
              "utf-8",
            );
          }
        } catch (agentErr: unknown) {
          console.warn(
            `[apps.update] Agent update failed: ${agentErr instanceof Error ? agentErr.message : "unknown"}`,
          );
        }
      }
      invalidateTenantConfigCache(ctx.tenantId);
      await context.reloadDbChannels();
    }

    await createAuditLog({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: "channel.app.update",
      resource: `app:${appDbId}`,
    });

    respond(true, {
      id: updated.id,
      appId: updated.appId,
      appSecret: updated.appSecret,
      botName: updated.botName,
      groupPolicy: updated.groupPolicy,
      isActive: updated.isActive,
    });
  },

  /**
   * Delete a channel app.
   * Params: { appDbId: string }
   */
  "tenant.channels.apps.delete": async ({
    params,
    client,
    respond,
    context,
  }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {
      return;
    }

    try {
      assertPermission(ctx.role, "channel.delete");
    } catch (err) {
      if (err instanceof RbacError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
        return;
      }
      throw err;
    }

    const { appDbId } = params as { appDbId: string };
    if (!appDbId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_PARAMS, "Missing appDbId"));
      return;
    }

    // Look up the app to get its appId and channel info before deleting
    const allChannels = await listTenantChannels(ctx.tenantId);
    let appToDelete: { appId: string; channelType: string } | null = null;
    for (const ch of allChannels) {
      const apps = await listChannelApps(ch.id);
      const found = apps.find((a) => a.id === appDbId);
      if (found) {
        appToDelete = { appId: found.appId, channelType: ch.channelType };
        break;
      }
    }

    // Stop the connection before deleting
    if (appToDelete) {
      await context.stopChannel(appToDelete.channelType as ChannelId, appToDelete.appId);
    }

    // Agent binding is on the app side — deleting the app clears the binding automatically.
    const deleted = await deleteChannelApp(appDbId, ctx.tenantId);

    invalidateTenantConfigCache(ctx.tenantId);
    await context.reloadDbChannels();

    await createAuditLog({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: "channel.app.delete",
      resource: `app:${appDbId}`,
    });

    respond(true, { deleted });
  },
};
