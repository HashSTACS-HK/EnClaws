import {
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveSessionAgentId,
  resolveAgentSkillsFilter,
} from "../../agents/agent-scope.js";
import { resolveModelRefFromString } from "../../agents/model-selection.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import {
  DEFAULT_AGENT_WORKSPACE_DIR,
  ensureAgentWorkspace,
  ensureTenantBootstrapFiles,
  registerTenantBootstrapContext,
  type TenantBootstrapContext,
} from "../../agents/workspace.js";
import { resolveChannelModelOverride } from "../../channels/model-overrides.js";
import { type OpenClawConfig, loadConfig } from "../../config/config.js";
import {
  resolveTenantAgentWorkspaceDir,
  resolveTenantAgentDir,
  resolveTenantDir,
  resolveTenantUserDir,
} from "../../config/sessions/tenant-paths.js";
import { isDbInitialized } from "../../db/index.js";
import { getTenantAgent } from "../../db/models/tenant-agent.js";
import { getTenantById } from "../../db/models/tenant.js";
import { checkTokenQuota } from "../../db/models/usage.js";
import { applyLinkUnderstanding } from "../../link-understanding/apply.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { applyMediaUnderstanding } from "../../media-understanding/apply.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import type { MsgContext } from "../templating.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { emitResetCommandHooks, type ResetCommandAction } from "./commands-core.js";
import { resolveDefaultModel } from "./directive-handling.js";
import { resolveReplyDirectives } from "./get-reply-directives.js";
import { handleInlineActions } from "./get-reply-inline-actions.js";
import { runPreparedReply } from "./get-reply-run.js";
const skillsLog = createSubsystemLogger("skills");
import { finalizeInboundContext } from "./inbound-context.js";
import { applyResetModelOverride } from "./session-reset-model.js";
import { initSessionState } from "./session.js";
import { stageSandboxMedia } from "./stage-sandbox-media.js";
import { createTypingController } from "./typing.js";

function mergeSkillFilters(channelFilter?: string[], agentFilter?: string[]): string[] | undefined {
  const normalize = (list?: string[]) => {
    if (!Array.isArray(list)) {
      return undefined;
    }
    return list.map((entry) => String(entry).trim()).filter(Boolean);
  };
  const channel = normalize(channelFilter);
  const agent = normalize(agentFilter);
  if (!channel && !agent) {
    return undefined;
  }
  if (!channel) {
    return agent;
  }
  if (!agent) {
    return channel;
  }
  if (channel.length === 0 || agent.length === 0) {
    return [];
  }
  const agentSet = new Set(agent);
  return channel.filter((name) => agentSet.has(name));
}

export async function getReplyFromConfig(
  ctx: MsgContext,
  opts?: GetReplyOptions,
  configOverride?: OpenClawConfig,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const isFastTestEnv = process.env.ENCLAWS_TEST_FAST === "1";
  const cfg = configOverride ?? loadConfig();
  const targetSessionKey =
    ctx.CommandSource === "native" ? ctx.CommandTargetSessionKey?.trim() : undefined;
  const agentSessionKey = targetSessionKey || ctx.SessionKey;
  const agentId = resolveSessionAgentId({
    sessionKey: agentSessionKey,
    config: cfg,
  });
  const agentSkillFilter = resolveAgentSkillsFilter(cfg, agentId);
  // Multi-tenant: tenant_agents.skills is a denylist of bundled skills.
  // Fetch it and pass as disabledBundledSkills so the skill prompt builder
  // can exclude them without affecting enterprise/workspace skills.
  let disabledBundledSkills: string[] | undefined;
  if (ctx.TenantId && isDbInitialized()) {
    try {
      const tenantAgentRecord = await getTenantAgent(ctx.TenantId, agentId);
      if (tenantAgentRecord?.skills && tenantAgentRecord.skills.length > 0) {
        disabledBundledSkills = tenantAgentRecord.skills;
      }
    } catch (err) {
      skillsLog.warn(
        `[skills-chain] failed to fetch tenant agent skill list: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  // Channel-level skillFilter (allowlist) — only merge with file-config agent filter, not DB denylist
  const mergedSkillFilter = mergeSkillFilters(opts?.skillFilter, agentSkillFilter);
  skillsLog.info(
    `[skills-chain] get-reply: agentId=${agentId}, agentSkillFilter=${JSON.stringify(agentSkillFilter ?? null)}, disabledBundledSkills=${JSON.stringify(disabledBundledSkills ?? null)}, channelFilter=${JSON.stringify(opts?.skillFilter ?? null)}, merged=${JSON.stringify(mergedSkillFilter ?? null)}`,
  );
  const resolvedOpts = {
    ...opts,
    ...(mergedSkillFilter !== undefined ? { skillFilter: mergedSkillFilter } : {}),
    ...(disabledBundledSkills !== undefined ? { disabledBundledSkills } : {}),
  };
  const agentCfg = cfg.agents?.defaults;
  const sessionCfg = cfg.session;
  const { defaultProvider, defaultModel, aliasIndex } = resolveDefaultModel({
    cfg,
    agentId,
  });
  let provider = defaultProvider;
  let model = defaultModel;
  let hasResolvedHeartbeatModelOverride = false;
  if (opts?.isHeartbeat) {
    // Prefer the resolved per-agent heartbeat model passed from the heartbeat runner,
    // fall back to the global defaults heartbeat model for backward compatibility.
    const heartbeatRaw =
      opts.heartbeatModelOverride?.trim() ?? agentCfg?.heartbeat?.model?.trim() ?? "";
    const heartbeatRef = heartbeatRaw
      ? resolveModelRefFromString({
          raw: heartbeatRaw,
          defaultProvider,
          aliasIndex,
        })
      : null;
    if (heartbeatRef) {
      provider = heartbeatRef.ref.provider;
      model = heartbeatRef.ref.model;
      hasResolvedHeartbeatModelOverride = true;
    }
  }

  // Multi-tenant: detect maxUsers quota exhaustion. tenant-enrich sets this
  // flag when it tried to auto-provision a NEW IM sender but the tenant has
  // no remaining user slots. Existing users are unaffected.
  //
  // Uses standard markdown link `[text](url)` which Feishu/Lark cards
  // (the format the lark plugin renders agent replies as), Telegram, and
  // Discord all render as clickable text. Channels without markdown
  // support will show the literal `[联系管理员](url)` — still readable.
  if (ctx.TenantUserQuotaExceeded) {
    const link = process.env.ENCLAWS_PLAN_UPGRADE_LINK?.trim();
    const contactPhrase = link ? `[联系管理员](${link})` : "联系管理员";
    return { text: `用户数量已达套餐上限，新成员暂时无法使用，请${contactPhrase}升级套餐。` };
  }

  // In multi-tenant mode, every message must be associated with a tenant user.
  // Reject if we cannot resolve the owner — do not fall back to _shared.
  if (ctx.TenantId && !ctx.TenantUserId) {
    return {
      text: `Agent '${agentId}' has no associated tenant user. Please configure the agent properly.`,
    };
  }

  // Multi-tenant token quota enforcement: short-circuit before invoking LLM
  // when the tenant has exceeded their monthly token allowance. The reply is
  // delivered through the same path as a normal agent reply, so the user sees
  // it in their channel as if the agent itself had answered.
  //
  // Quota semantics: -1 = unlimited (handled inside checkTokenQuota), >= 0
  // = enforced limit (0 effectively blocks every call, used by accounts that
  // should not call LLMs at all, e.g. the platform admin tenant).
  if (ctx.TenantId && isDbInitialized()) {
    try {
      const tenant = await getTenantById(ctx.TenantId);
      const max = tenant?.quotas?.maxTokensPerMonth;
      if (typeof max === "number") {
        const quota = await checkTokenQuota(ctx.TenantId, max);
        if (!quota.allowed) {
          const link = process.env.ENCLAWS_PLAN_UPGRADE_LINK?.trim();
          const contactPhrase = link ? `[联系管理员](${link})` : "联系管理员";
          return { text: `本月 token 用量已达上限，请${contactPhrase}升级套餐后再继续使用。` };
        }
      }
    } catch (err) {
      // Quota check is best-effort: if it fails, log and let the message proceed
      // rather than block the user on infrastructure issues.
      console.warn(`[tenant-quota] check failed for tenant ${ctx.TenantId}: ${String(err)}`);
    }
  }

  let tenantBootstrapContext: TenantBootstrapContext | undefined;
  const workspaceDirRaw = ctx.TenantId
    ? resolveTenantAgentWorkspaceDir(ctx.TenantId, agentId, ctx.TenantUserId)
    : (resolveAgentWorkspaceDir(cfg, agentId) ?? DEFAULT_AGENT_WORKSPACE_DIR);

  if (ctx.TenantId && !agentCfg?.skipBootstrap && !isFastTestEnv) {
    // Multi-tenant: initialize files across tenant/agent/user directories
    tenantBootstrapContext = {
      tenantId: ctx.TenantId,
      tenantDir: resolveTenantDir(ctx.TenantId),
      agentDir: resolveTenantAgentDir(ctx.TenantId, agentId),
      userDir: resolveTenantUserDir(ctx.TenantId, ctx.TenantUserId),
      workspaceDir: workspaceDirRaw,
    };
    await ensureTenantBootstrapFiles(tenantBootstrapContext);
  }

  const workspace = await ensureAgentWorkspace({
    dir: workspaceDirRaw,
    // In multi-tenant mode, bootstrap files are already seeded by ensureTenantBootstrapFiles
    ensureBootstrapFiles: !ctx.TenantId && !agentCfg?.skipBootstrap && !isFastTestEnv,
  });
  const workspaceDir = workspace.dir;

  // Register tenant context AFTER ensureAgentWorkspace so the key uses
  // the same resolved path that downstream callers (buildWorkspaceSkillSnapshot,
  // loadWorkspaceSkillEntries) will use for lookup.
  if (tenantBootstrapContext) {
    registerTenantBootstrapContext(workspaceDir, {
      ...tenantBootstrapContext,
      workspaceDir,
    });
  }
  const agentDir = ctx.TenantId
    ? resolveTenantAgentDir(ctx.TenantId, agentId)
    : resolveAgentDir(cfg, agentId);
  const perAgentTimeoutSeconds = resolveAgentConfig(cfg, agentId)?.timeoutSeconds;
  const timeoutMs = resolveAgentTimeoutMs({
    cfg,
    agentTimeoutSeconds: perAgentTimeoutSeconds,
    overrideSeconds: opts?.timeoutOverrideSeconds,
  });
  const configuredTypingSeconds =
    agentCfg?.typingIntervalSeconds ?? sessionCfg?.typingIntervalSeconds;
  const typingIntervalSeconds =
    typeof configuredTypingSeconds === "number" ? configuredTypingSeconds : 6;
  const typing = createTypingController({
    onReplyStart: opts?.onReplyStart,
    onCleanup: opts?.onTypingCleanup,
    typingIntervalSeconds,
    silentToken: SILENT_REPLY_TOKEN,
    log: defaultRuntime.log,
  });
  opts?.onTypingController?.(typing);

  const finalized = finalizeInboundContext(ctx);

  if (!isFastTestEnv) {
    await applyMediaUnderstanding({
      ctx: finalized,
      cfg,
      agentDir,
      activeModel: { provider, model },
    });
    await applyLinkUnderstanding({
      ctx: finalized,
      cfg,
    });
  }

  const commandAuthorized = finalized.CommandAuthorized;
  resolveCommandAuthorization({
    ctx: finalized,
    cfg,
    commandAuthorized,
  });
  const sessionState = await initSessionState({
    ctx: finalized,
    cfg,
    commandAuthorized,
  });
  let {
    sessionCtx,
    sessionEntry,
    previousSessionEntry,
    sessionStore,
    sessionKey,
    sessionId,
    isNewSession,
    resetTriggered,
    systemSent,
    abortedLastRun,
    storePath,
    sessionScope,
    groupResolution,
    isGroup,
    triggerBodyNormalized,
    bodyStripped,
  } = sessionState;

  await applyResetModelOverride({
    cfg,
    resetTriggered,
    bodyStripped,
    sessionCtx,
    ctx: finalized,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    defaultProvider,
    defaultModel,
    aliasIndex,
  });

  const channelModelOverride = resolveChannelModelOverride({
    cfg,
    channel:
      groupResolution?.channel ??
      sessionEntry.channel ??
      sessionEntry.origin?.provider ??
      (typeof finalized.OriginatingChannel === "string"
        ? finalized.OriginatingChannel
        : undefined) ??
      finalized.Provider,
    groupId: groupResolution?.id ?? sessionEntry.groupId,
    groupChannel: sessionEntry.groupChannel ?? sessionCtx.GroupChannel ?? finalized.GroupChannel,
    groupSubject: sessionEntry.subject ?? sessionCtx.GroupSubject ?? finalized.GroupSubject,
    parentSessionKey: sessionCtx.ParentSessionKey,
  });
  const hasSessionModelOverride = Boolean(
    sessionEntry.modelOverride?.trim() || sessionEntry.providerOverride?.trim(),
  );
  if (!hasResolvedHeartbeatModelOverride && !hasSessionModelOverride && channelModelOverride) {
    const resolved = resolveModelRefFromString({
      raw: channelModelOverride.model,
      defaultProvider,
      aliasIndex,
    });
    if (resolved) {
      provider = resolved.ref.provider;
      model = resolved.ref.model;
    }
  }

  const directiveResult = await resolveReplyDirectives({
    ctx: finalized,
    cfg,
    agentId,
    agentDir,
    workspaceDir,
    agentCfg,
    sessionCtx,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    sessionScope,
    groupResolution,
    isGroup,
    triggerBodyNormalized,
    commandAuthorized,
    defaultProvider,
    defaultModel,
    aliasIndex,
    provider,
    model,
    hasResolvedHeartbeatModelOverride,
    typing,
    opts: resolvedOpts,
    skillFilter: mergedSkillFilter,
    disabledBundledSkills: resolvedOpts?.disabledBundledSkills,
  });
  if (directiveResult.kind === "reply") {
    return directiveResult.reply;
  }

  let {
    commandSource,
    command,
    allowTextCommands,
    skillCommands,
    directives,
    cleanedBody,
    elevatedEnabled,
    elevatedAllowed,
    elevatedFailures,
    defaultActivation,
    resolvedThinkLevel,
    resolvedVerboseLevel,
    resolvedReasoningLevel,
    resolvedElevatedLevel,
    execOverrides,
    blockStreamingEnabled,
    blockReplyChunking,
    resolvedBlockStreamingBreak,
    provider: resolvedProvider,
    model: resolvedModel,
    modelState,
    contextTokens,
    inlineStatusRequested,
    directiveAck,
    perMessageQueueMode,
    perMessageQueueOptions,
  } = directiveResult.result;
  provider = resolvedProvider;
  model = resolvedModel;

  const maybeEmitMissingResetHooks = async () => {
    if (!resetTriggered || !command.isAuthorizedSender || command.resetHookTriggered) {
      return;
    }
    const resetMatch = command.commandBodyNormalized.match(/^\/(new|reset)(?:\s|$)/);
    if (!resetMatch) {
      return;
    }
    const action: ResetCommandAction = resetMatch[1] === "reset" ? "reset" : "new";
    await emitResetCommandHooks({
      action,
      ctx,
      cfg,
      command,
      sessionKey,
      sessionEntry,
      previousSessionEntry,
      workspaceDir,
    });
  };

  const inlineActionResult = await handleInlineActions({
    ctx,
    sessionCtx,
    cfg,
    agentId,
    agentDir,
    sessionEntry,
    previousSessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    sessionScope,
    workspaceDir,
    isGroup,
    opts: resolvedOpts,
    typing,
    allowTextCommands,
    inlineStatusRequested,
    command,
    skillCommands,
    directives,
    cleanedBody,
    elevatedEnabled,
    elevatedAllowed,
    elevatedFailures,
    defaultActivation: () => defaultActivation,
    resolvedThinkLevel,
    resolvedVerboseLevel,
    resolvedReasoningLevel,
    resolvedElevatedLevel,
    resolveDefaultThinkingLevel: modelState.resolveDefaultThinkingLevel,
    provider,
    model,
    contextTokens,
    directiveAck,
    abortedLastRun,
    skillFilter: mergedSkillFilter,
    disabledBundledSkills: resolvedOpts?.disabledBundledSkills,
  });
  if (inlineActionResult.kind === "reply") {
    await maybeEmitMissingResetHooks();
    return inlineActionResult.reply;
  }
  await maybeEmitMissingResetHooks();
  directives = inlineActionResult.directives;
  abortedLastRun = inlineActionResult.abortedLastRun ?? abortedLastRun;

  await stageSandboxMedia({
    ctx,
    sessionCtx,
    cfg,
    sessionKey,
    workspaceDir,
  });

  return runPreparedReply({
    ctx,
    sessionCtx,
    cfg,
    agentId,
    agentDir,
    agentCfg,
    sessionCfg,
    commandAuthorized,
    command,
    commandSource,
    allowTextCommands,
    directives,
    defaultActivation,
    resolvedThinkLevel,
    resolvedVerboseLevel,
    resolvedReasoningLevel,
    resolvedElevatedLevel,
    execOverrides,
    elevatedEnabled,
    elevatedAllowed,
    blockStreamingEnabled,
    blockReplyChunking,
    resolvedBlockStreamingBreak,
    modelState,
    provider,
    model,
    perMessageQueueMode,
    perMessageQueueOptions,
    typing,
    opts: resolvedOpts,
    defaultProvider,
    defaultModel,
    timeoutMs,
    isNewSession,
    resetTriggered,
    systemSent,
    sessionEntry,
    sessionStore,
    sessionKey,
    sessionId,
    storePath,
    workspaceDir,
    abortedLastRun,
  });
}
