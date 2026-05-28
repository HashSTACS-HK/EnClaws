/**
 * Multi-tenant context enrichment for inbound messages.
 *
 * When a channel plugin (e.g. the official Feishu plugin) dispatches a message
 * to the core without TenantId/TenantUserId, this module detects the tenant
 * configuration from the account-scoped config and auto-provisions the user,
 * injecting TenantId and TenantUserId into the message context.
 *
 * Also resolves sender display names when the channel plugin fails (e.g. due
 * to contact scope limitations). Uses DB cache first, then falls back to the
 * Feishu chat members API with tenant_access_token (no user OAuth needed).
 *
 * This allows external plugins to work unmodified in multi-tenant deployments.
 */

import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import type { FinalizedMsgContext } from "../templating.js";
import { logVerbose } from "../../globals.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const roleTraceLog = createSubsystemLogger("auto-reply/tenant-enrich");

/**
 * Enrich the inbound message context with multi-tenant fields if applicable.
 *
 * Checks whether the channel's account-scoped config carries a `tenantId`.
 * If so, and the context does not already have TenantId set, performs
 * auto-provisioning to resolve the tenant user and injects TenantId +
 * TenantUserId into `ctx` (mutates in place).
 *
 * No-op when:
 * - ctx.TenantId is already set (plugin already handled it)
 * - No tenantId found in channel config (single-tenant / personal mode)
 * - No SenderId available (cannot provision without sender identity)
 */
export async function enrichTenantContext(
  ctx: FinalizedMsgContext,
  cfg: OpenClawConfig,
): Promise<void> {
  // If TenantId is already set but TenantUserRole is missing, resolve the role from DB.
  if (ctx.TenantId && ctx.TenantUserId && !ctx.TenantUserRole) {
    try {
      const { autoProvisionTenantUser } = await import("../../infra/channel-auto-provision.js");
      const { resolveChannelTenantContext } = await import("../../infra/channel-tenant-context.js");
      const senderId = ctx.SenderId;
      if (senderId) {
        // Resolve channelId from tenant context when available
        const ctxProvider = (ctx.Provider ?? ctx.Surface ?? "").toLowerCase();
        const ctxAccountId = (ctx as Record<string, unknown>).AccountId as string | undefined;
        const tenantCtx = ctxProvider && ctxAccountId
          ? await resolveChannelTenantContext(ctxProvider, ctxAccountId)
          : undefined;
        const provisioned = await autoProvisionTenantUser({
          tenantId: ctx.TenantId,
          openId: senderId,
          unionId: ctx.SenderUnionId ?? undefined,
          displayName: ctx.SenderName ?? undefined,
          channelId: tenantCtx?.channelId,
        });
        // This branch is taken when TenantUserId is already set, meaning the
        // user already exists in DB — we only need to resolve their role.
        // The quota-exceeded sentinel cannot occur here, but we narrow the
        // type defensively to keep the AutoProvisionResult fields accessible.
        if (provisioned && "userSuspended" in provisioned) {
          ctx.TenantUserSuspended = true;
        } else if (provisioned && !("quotaExceeded" in provisioned)) {
          ctx.TenantUserRole = provisioned.role;
          roleTraceLog.warn(
            `[role-trace] tenant-enrich.branchA tenantId=${ctx.TenantId} userId=${ctx.TenantUserId} role=${provisioned.role}`,
          );
          // Backfill sender name from DB if plugin didn't resolve it
          if (isMissingSenderName(ctx) && provisioned.displayName && !isPlaceholderName(provisioned.displayName)) {
            ctx.SenderName = provisioned.displayName;
            logVerbose(`[tenant-enrich] backfilled SenderName from DB: ${provisioned.displayName}`);
          }
        }
      }
    } catch {
      // Non-fatal: continue without role
    }
  }

  // If sender name is still missing, try resolving via Feishu chat members API
  if (ctx.TenantId && isMissingSenderName(ctx)) {
    await resolveFeishuSenderName(ctx, cfg);
  }

  // Skip if the plugin already injected tenant info (e.g. the old built-in feishu plugin)
  if (ctx.TenantId) {return;}

  const provider = (ctx.Provider ?? ctx.Surface ?? "").toLowerCase();
  if (!provider) {return;}

  // Read tenantId from the account-scoped channel config.
  // In multi-tenant mode, server-channels.ts merges DB tenant data into the
  // account config: cfg.channels[provider].accounts[accountId].tenantId = "<tenant-uuid>"
  const channelCfg = (cfg.channels as Record<string, Record<string, unknown> | undefined>)?.[provider];
  let tenantId = channelCfg?.tenantId as string | undefined;
  // Fall back to the per-account tenantId when the channel top-level doesn't carry one.
  if (!tenantId) {
    const accountId = (ctx as Record<string, unknown>).AccountId as string | undefined;
    if (accountId) {
      const accounts = channelCfg?.accounts as Record<string, Record<string, unknown> | undefined> | undefined;
      // Some channels (e.g. wecom) normalize accountId to lowercase on ctx while
      // the accounts map is keyed by the original-case credential id. Try exact
      // match first, then fall back to a case-insensitive scan.
      let accountEntry = accounts?.[accountId];
      if (!accountEntry && accounts) {
        const lowerAccountId = accountId.toLowerCase();
        for (const [key, entry] of Object.entries(accounts)) {
          if (key.toLowerCase() === lowerAccountId) {
            accountEntry = entry;
            break;
          }
        }
      }
      tenantId = accountEntry?.tenantId as string | undefined;
    }
  }
  if (!tenantId) {return;}

  const senderId = ctx.SenderId;
  if (!senderId) {return;}

  try {
    const { autoProvisionTenantUser } = await import("../../infra/channel-auto-provision.js");
    const { resolveChannelTenantContext } = await import("../../infra/channel-tenant-context.js");

    // Resolve channelId from the channel app lookup
    const accountId = (ctx as Record<string, unknown>).AccountId as string | undefined;
    const tenantCtx = accountId
      ? await resolveChannelTenantContext(provider, accountId)
      : undefined;

    // 某些渠道（如企业微信 AI Bot）回调里没有独立的 unionId 字段，
    // 但 senderId 已经是企业内稳定的跨会话标识——等价于 unionId 的角色。
    // 这里按 provider 做兜底，保证 DB 的 union_id 列能被填上，
    // 下游 autoProvisionTenantUser 的 union_id 优先查找也能命中。
    const unionIdFallbackProviders = new Set(["wecom", "dingtalk"]);
    const resolvedUnionId = ctx.SenderUnionId
      ?? (unionIdFallbackProviders.has(provider) ? senderId : undefined);

    const provisioned = await autoProvisionTenantUser({
      tenantId,
      openId: senderId,
      unionId: resolvedUnionId,
      displayName: ctx.SenderName ?? undefined,
      channelId: tenantCtx?.channelId,
    });

    if (provisioned && "userSuspended" in provisioned) {
      ctx.TenantId = tenantId;
      ctx.TenantUserSuspended = true;
      logVerbose(
        `[tenant-enrich] user ${provisioned.userId} is ${provisioned.status} for ${provider}/${senderId} — message blocked`,
      );
    } else if (provisioned && "quotaExceeded" in provisioned) {
      ctx.TenantId = tenantId;
      ctx.TenantUserQuotaExceeded = true;
      logVerbose(
        `[tenant-enrich] user quota exceeded for ${provider}/${senderId} ` +
        `(${provisioned.current}/${provisioned.max}) — sender will receive upgrade message`,
      );
    } else if (provisioned) {
      ctx.TenantId = tenantId;
      ctx.TenantUserId = provisioned.unionId;
      ctx.TenantUserRole = provisioned.role;
      roleTraceLog.warn(
        `[role-trace] tenant-enrich.branchB tenantId=${tenantId} userId=${provisioned.unionId} role=${provisioned.role} userCreated=${provisioned.userCreated}`,
      );
      // Backfill sender name from DB if plugin didn't resolve it
      if (isMissingSenderName(ctx) && provisioned.displayName && !isPlaceholderName(provisioned.displayName)) {
        ctx.SenderName = provisioned.displayName;
        logVerbose(`[tenant-enrich] backfilled SenderName from DB: ${provisioned.displayName}`);
      }
      logVerbose(
        `[tenant-enrich] auto-provisioned: provider=${provider} senderId=${senderId} ` +
        `userId=${provisioned.userId} unionId=${provisioned.unionId} role=${provisioned.role} created=${provisioned.userCreated}`,
      );
    }
  } catch (err) {
    // Non-fatal: log and continue without tenant context.
    // The message will be processed in single-tenant mode.
    logVerbose(`[tenant-enrich] auto-provision failed for ${provider}/${senderId}: ${String(err)}`);
  }

  // If sender name is still missing, try resolving via Feishu chat members API
  if (ctx.TenantId && isMissingSenderName(ctx)) {
    await resolveFeishuSenderName(ctx, cfg);
  }

  // Sync appId/appSecret from DB config into tenant _shared/config.json
  // so that SKILL.md scripts can read credentials without platform coupling.
  if (ctx.TenantId) {
    const ctxProvider2 = (ctx.Provider ?? ctx.Surface ?? "").toLowerCase();
    const ctxAccountId2 = (ctx as Record<string, unknown>).AccountId as string | undefined;
    if (ctxProvider2 === "feishu") {
      syncFeishuSkillConfig(ctx.TenantId, cfg, ctxProvider2, ctxAccountId2);
    }
  }
}

// ---------------------------------------------------------------------------
// Sender name resolution helpers
// ---------------------------------------------------------------------------

function isPlaceholderName(name: string): boolean {
  return !name || name.startsWith("ou_") || name.startsWith("on_");
}

function isMissingSenderName(ctx: FinalizedMsgContext): boolean {
  return !ctx.SenderName || isPlaceholderName(ctx.SenderName);
}

// ---------------------------------------------------------------------------
// Feishu skill config sync
// ---------------------------------------------------------------------------

/**
 * In-memory cache of (tenantId + appId) pairs already written, to avoid
 * redundant file I/O on every message.
 */
const skillConfigSynced = new Set<string>();

/**
 * Write appId/appSecret from the runtime config into the tenant's
 * _shared/config.json so that SKILL.md scripts can read credentials
 * without needing platform-specific env vars.
 *
 * Writes are idempotent: no-op when the file already matches, and the
 * in-memory cache prevents repeated disk reads after the first sync.
 */
function syncFeishuSkillConfig(
  tenantId: string,
  cfg: OpenClawConfig,
  provider: string,
  accountId: string | undefined,
): void {
  try {
    const { extractFeishuCredentials } = require("../../infra/feishu-user-resolve.js");
    const creds = extractFeishuCredentials(
      cfg as unknown as Record<string, unknown>,
      provider,
      accountId,
    ) as { appId: string; appSecret: string } | null;
    if (!creds?.appId || !creds?.appSecret) {return;}

    const cacheKey = `${tenantId}:${creds.appId}`;
    if (skillConfigSynced.has(cacheKey)) {return;}

    const { resolveTenantSkillsDir } = require("../../config/sessions/tenant-paths.js");
    const sharedDir = path.join(resolveTenantSkillsDir(tenantId), "feishu-auth");

    // Only sync when feishu-auth skill is installed — don't create the directory
    if (!fs.existsSync(sharedDir)) {
      skillConfigSynced.add(cacheKey);
      return;
    }

    const cfgPath = path.join(sharedDir, "config.json");

    // Check if already up-to-date
    try {
      const existing = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      if (existing.appId === creds.appId && existing.appSecret === creds.appSecret) {
        skillConfigSynced.add(cacheKey);
        return;
      }
    } catch {
      // File missing or unparseable — will write below
    }
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ appId: creds.appId, appSecret: creds.appSecret, brand: "feishu" }, null, 2),
      "utf8",
    );
    skillConfigSynced.add(cacheKey);
    logVerbose(`[tenant-enrich] synced feishu skill config for tenant ${tenantId}`);
  } catch (err) {
    // Non-fatal — scripts will fall back to manually-configured file
    logVerbose(`[tenant-enrich] failed to sync feishu skill config: ${String(err)}`);
  }
}

/**
 * Extract chatId from ctx.To (Feishu format: "chat:{chatId}" or "user:{openId}").
 * Returns undefined for p2p chats — the API layer will resolve via openId instead.
 */
function extractChatId(ctx: FinalizedMsgContext): string | undefined {
  const to = (ctx as Record<string, unknown>).To as string | undefined;
  if (!to) {return undefined;}
  if (to.startsWith("chat:")) {return to.slice(5);}
  return undefined;
}

/**
 * Resolve sender name via Feishu chat members API (tenant_access_token).
 * On success, updates ctx.SenderName and persists to DB.
 */
async function resolveFeishuSenderName(
  ctx: FinalizedMsgContext,
  cfg: OpenClawConfig,
): Promise<void> {
  const provider = (ctx.Provider ?? ctx.Surface ?? "").toLowerCase();
  if (provider !== "feishu") {return;}

  const senderId = ctx.SenderId;
  if (!senderId) {return;}

  const chatId = extractChatId(ctx);

  try {
    const { resolveFeishuUserName, extractFeishuCredentials } = await import("../../infra/feishu-user-resolve.js");

    const accountId = (ctx as Record<string, unknown>).AccountId as string | undefined;
    const creds = extractFeishuCredentials(cfg as unknown as Record<string, unknown>, provider, accountId);
    if (!creds) {return;}

    const messageId = (ctx as Record<string, unknown>).MessageSid as string | undefined;
    const name = await resolveFeishuUserName({
      appId: creds.appId,
      appSecret: creds.appSecret,
      chatId: chatId ?? undefined,
      messageId: messageId ?? undefined,
      openId: senderId,
    });

    if (name && !isPlaceholderName(name)) {
      ctx.SenderName = name;
      logVerbose(`[tenant-enrich] resolved SenderName via Feishu API: ${name}`);

      // Persist to DB so future messages don't need API calls
      if (ctx.TenantId) {
        try {
          const { updateDisplayNameByOpenId } = await import("../../db/models/user.js");
          await updateDisplayNameByOpenId(senderId, name);
        } catch {
          // Non-fatal
        }
      }
    }
  } catch (err) {
    logVerbose(`[tenant-enrich] Feishu name resolve failed: ${String(err)}`);
  }
}
