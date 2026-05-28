import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadSessionStore, resolveStorePath, type SessionEntry } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { getLogger } from "../../logging/logger.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import { isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import {
  logMessageProcessed,
  logMessageQueued,
  logSessionStateChange,
} from "../../logging/diagnostic.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { maybeApplyTtsToPayload, normalizeTtsAutoMode, resolveTtsConfig } from "../../tts/tts.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { getReplyFromConfig } from "../reply.js";
import type { FinalizedMsgContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { formatAbortReplyText, tryFastAbortFromMessage } from "./abort.js";
import { shouldBypassAcpDispatchForCommand, tryDispatchAcpReply } from "./dispatch-acp.js";
import { shouldSkipDuplicateInbound } from "./inbound-dedupe.js";
import type { ReplyDispatcher, ReplyDispatchKind } from "./reply-dispatcher.js";
import { shouldSuppressReasoningPayload } from "./reply-payloads.js";
import { isRoutableChannel, routeReply } from "./route-reply.js";
import { resolveRunTypingPolicy } from "./typing-policy.js";
import { enrichTenantContext } from "./tenant-enrich.js";
import { checkInputFilter } from "./input-filter.js";
import { coreAuthGate } from "../../infra/auth-gate.js";
// Side-effect import: registers feishu driver into the auth-gate registry.
// Future IM drivers (wecom, dingtalk, ...) should be imported here too.
import "../../infra/feishu-lite-auth.js";

const AUDIO_PLACEHOLDER_RE = /^<media:audio>(\s*\([^)]*\))?$/i;
const AUDIO_HEADER_RE = /^\[Audio\b/i;

/** Compute the effective session key for logging (appends tenant user ID for direct chats). */
function resolveEffectiveSessionKey(
  sessionKey: string | undefined,
  ctx: { TenantUserId?: string; ChatType?: string },
): string {
  if (!sessionKey) {return "unknown";}
  const key = sessionKey.toLowerCase();
  const tenantUser = ctx.TenantUserId?.trim();
  if (tenantUser && !key.includes(":group:") && !key.includes(":channel:")) {
    return `${key}:user:${tenantUser.toLowerCase()}`;
  }
  return key;
}
const normalizeMediaType = (value: string): string => value.split(";")[0]?.trim().toLowerCase();

const isInboundAudioContext = (ctx: FinalizedMsgContext): boolean => {
  const rawTypes = [
    typeof ctx.MediaType === "string" ? ctx.MediaType : undefined,
    ...(Array.isArray(ctx.MediaTypes) ? ctx.MediaTypes : []),
  ].filter(Boolean) as string[];
  const types = rawTypes.map((type) => normalizeMediaType(type));
  if (types.some((type) => type === "audio" || type.startsWith("audio/"))) {
    return true;
  }

  const body =
    typeof ctx.BodyForCommands === "string"
      ? ctx.BodyForCommands
      : typeof ctx.CommandBody === "string"
        ? ctx.CommandBody
        : typeof ctx.RawBody === "string"
          ? ctx.RawBody
          : typeof ctx.Body === "string"
            ? ctx.Body
            : "";
  const trimmed = body.trim();
  if (!trimmed) {
    return false;
  }
  if (AUDIO_PLACEHOLDER_RE.test(trimmed)) {
    return true;
  }
  return AUDIO_HEADER_RE.test(trimmed);
};

const resolveSessionStoreEntry = (
  ctx: FinalizedMsgContext,
  cfg: OpenClawConfig,
): {
  sessionKey?: string;
  entry?: SessionEntry;
} => {
  const targetSessionKey =
    ctx.CommandSource === "native" ? ctx.CommandTargetSessionKey?.trim() : undefined;
  const sessionKey = (targetSessionKey ?? ctx.SessionKey)?.trim();
  if (!sessionKey) {
    return {};
  }
  const agentId = resolveSessionAgentId({ sessionKey, config: cfg });
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  try {
    const store = loadSessionStore(storePath);
    return {
      sessionKey,
      entry: store[sessionKey.toLowerCase()] ?? store[sessionKey],
    };
  } catch {
    return {
      sessionKey,
    };
  }
};

export type DispatchFromConfigResult = {
  queuedFinal: boolean;
  counts: Record<ReplyDispatchKind, number>;
};

export async function dispatchReplyFromConfig(params: {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof getReplyFromConfig;
}): Promise<DispatchFromConfigResult> {
  const { ctx, cfg, dispatcher } = params;
  const diagnosticsEnabled = isDiagnosticsEnabled(cfg);
  const channel = String(ctx.Surface ?? ctx.Provider ?? "unknown").toLowerCase();
  const chatId = ctx.To ?? ctx.From;
  const messageId = ctx.MessageSid ?? ctx.MessageSidFirst ?? ctx.MessageSidLast;
  const sessionKey = ctx.SessionKey;
  const startTime = diagnosticsEnabled ? Date.now() : 0;
  const canTrackSession = diagnosticsEnabled && Boolean(sessionKey);

  const recordProcessed = (
    outcome: "completed" | "skipped" | "error",
    opts?: {
      reason?: string;
      error?: string;
    },
  ) => {
    if (!diagnosticsEnabled) {
      return;
    }
    logMessageProcessed({
      channel,
      chatId,
      messageId,
      sessionKey,
      durationMs: Date.now() - startTime,
      outcome,
      reason: opts?.reason,
      error: opts?.error,
    });
  };

  const markProcessing = () => {
    if (!canTrackSession || !sessionKey) {
      return;
    }
    logMessageQueued({ sessionKey, channel, source: "dispatch" });
    logSessionStateChange({
      sessionKey,
      state: "processing",
      reason: "message_start",
    });
  };

  const markIdle = (reason: string) => {
    if (!canTrackSession || !sessionKey) {
      return;
    }
    logSessionStateChange({
      sessionKey,
      state: "idle",
      reason,
    });
  };

  if (shouldSkipDuplicateInbound(ctx)) {
    recordProcessed("skipped", { reason: "duplicate" });
    return { queuedFinal: false, counts: dispatcher.getQueuedCounts() };
  }

  // ── Multi-tenant context enrichment ─────────────────────────────
  // When an external channel plugin (e.g. official @larksuite/openclaw-lark)
  // does not inject TenantId/TenantUserId, auto-provision the user from the
  // account-scoped channel config so the downstream reply engine resolves
  // tenant-scoped workspace/session paths.
  await enrichTenantContext(ctx, cfg);

  // ── Tenant suspension check ────────────────────────────────────
  // If the tenant has been suspended by platform admin, reply with a short
  // notice and skip LLM execution so no agent runs or token consumption.
  // Resolve tenantId from ctx (set by enrichTenantContext) OR from channel
  // config directly — the latter covers cases where auto-provision failed
  // (e.g. during suspension) and ctx.TenantId was never set.
  {
    let checkTenantId = ctx.TenantId;
    if (!checkTenantId) {
      const provider = (ctx.Provider ?? ctx.Surface ?? "").toLowerCase();
      const channelCfg = (cfg.channels as Record<string, Record<string, unknown> | undefined>)?.[provider];
      checkTenantId = channelCfg?.tenantId as string | undefined;
      if (!checkTenantId) {
        const accountId = (ctx as Record<string, unknown>).AccountId as string | undefined;
        if (accountId) {
          const accounts = channelCfg?.accounts as Record<string, Record<string, unknown> | undefined> | undefined;
          checkTenantId = accounts?.[accountId]?.tenantId as string | undefined;
        }
      }
    }
    if (checkTenantId) {
      try {
        const { getTenantById } = await import("../../db/models/tenant.js");
        const tenant = await getTenantById(checkTenantId);
        if (tenant && tenant.status === "suspended") {
          logVerbose(`[dispatch] tenant ${checkTenantId} is suspended, replying with notice`);
          const payload = { text: "该企业账号已被禁用，请联系平台管理员。" } satisfies ReplyPayload;
          const queuedFinal = dispatcher.sendFinalReply(payload);
          recordProcessed("completed", { reason: "tenant-suspended" });
          markIdle("tenant_suspended");
          return { queuedFinal, counts: dispatcher.getQueuedCounts() };
        }
      } catch {
        // Non-fatal: if DB check fails, allow the message through
      }
    }
  }

  // ── User suspended gate ──────────────────────────────────────
  if (ctx.TenantUserSuspended) {
    logVerbose(`[dispatch] user is suspended, replying with notice`);
    const payload = { text: "您的账号已被禁用，请联系管理员。" } satisfies ReplyPayload;
    const queuedFinal = dispatcher.sendFinalReply(payload);
    recordProcessed("completed", { reason: "user-suspended" });
    markIdle("user_suspended");
    return { queuedFinal, counts: dispatcher.getQueuedCounts() };
  }

  // ── Pre-LLM auth gate ────────────────────────────────────────
  // Shared across IM platforms: if a provider has a driver registered and the
  // current user's SenderName is still unresolved (no contact-API permission /
  // DB miss / no stored UAT):
  //   1. stash this inbound message into the pending queue
  //   2. have the driver send a lightweight auth card to the user (Feishu uses DM via open_id)
  //   3. short-circuit — the LLM does not run, no tokens spent
  //   4. after the user authorizes, the driver writes the name to DB and the
  //      pending queue replays this message (which now carries the name)
  // Providers with no registered driver (slack/discord/telegram, ...) are
  // passed through untouched.
  const gateResult = await coreAuthGate({
    ctx,
    cfg,
    dispatcher,
    replyOptions: params.replyOptions,
    replyResolver: params.replyResolver,
  });
  if (gateResult.skipDispatch) {
    recordProcessed("skipped", { reason: gateResult.reason ?? "auth-required" });
    markIdle("auth_gate");
    return { queuedFinal: false, counts: dispatcher.getQueuedCounts() };
  }

  // ── Inbound message log ───────────────────────────────────────
  {
    const source = ctx.OriginatingChannel ?? ctx.Surface ?? ctx.Provider ?? "unknown";
    const isWebChat = source === INTERNAL_MESSAGE_CHANNEL;
    const agentId = resolveSessionAgentId({ sessionKey: sessionKey ?? "", config: cfg });
    const bodyPreview = (ctx.RawBody ?? ctx.Body ?? "").replace(/\s+/g, " ").slice(0, 200);
    const parts: string[] = [
      `[inbound] channel=${isWebChat ? "webchat" : source}`,
      `chatType=${ctx.ChatType ?? "unknown"}`,
      `from=${ctx.From ?? "unknown"}`,
      `to=${ctx.To ?? "unknown"}`,
      `senderId=${ctx.SenderId ?? "unknown"}`,
      `senderName=${ctx.SenderName ?? "unknown"}`,
      `sessionKey=${resolveEffectiveSessionKey(sessionKey, ctx)}`,
      `agentId=${agentId}`,
      `accountId=${ctx.AccountId ?? "default"}`,
      `messageId=${messageId ?? "unknown"}`,
    ];
    if (ctx.TenantId) {
      parts.push(`tenantId=${ctx.TenantId}`);
    }
    if (ctx.TenantUserId) {
      parts.push(`tenantUserId=${ctx.TenantUserId}`);
    }
    if (ctx.GroupSubject) {
      parts.push(`group=${ctx.GroupSubject}`);
    }
    if (ctx.WasMentioned) {
      parts.push("mentioned=true");
    }
    if (ctx.MediaType) {
      parts.push(`media=${ctx.MediaType}`);
    }
    parts.push(`body="${bodyPreview}"`);
    const logLine = parts.join(" ");
    try {
      getLogger().info(logLine);
    } catch {
      // logger not available, console.log already printed above
    }
  }
  // ──────────────────────────────────────────────────────────────

  const sessionStoreEntry = resolveSessionStoreEntry(ctx, cfg);
  const inboundAudio = isInboundAudioContext(ctx);
  const sessionTtsAuto = normalizeTtsAutoMode(sessionStoreEntry.entry?.ttsAuto);
  const hookRunner = getGlobalHookRunner();

  // Extract message context for hooks (plugin and internal)
  const timestamp =
    typeof ctx.Timestamp === "number" && Number.isFinite(ctx.Timestamp) ? ctx.Timestamp : undefined;
  const messageIdForHook =
    ctx.MessageSidFull ?? ctx.MessageSid ?? ctx.MessageSidFirst ?? ctx.MessageSidLast;
  const content =
    typeof ctx.BodyForCommands === "string"
      ? ctx.BodyForCommands
      : typeof ctx.RawBody === "string"
        ? ctx.RawBody
        : typeof ctx.Body === "string"
          ? ctx.Body
          : "";
  const channelId = (ctx.OriginatingChannel ?? ctx.Surface ?? ctx.Provider ?? "").toLowerCase();
  const conversationId = ctx.OriginatingTo ?? ctx.To ?? ctx.From ?? undefined;

  // Trigger plugin hooks (fire-and-forget)
  if (hookRunner?.hasHooks("message_received")) {
    void hookRunner
      .runMessageReceived(
        {
          from: ctx.From ?? "",
          content,
          timestamp,
          metadata: {
            to: ctx.To,
            provider: ctx.Provider,
            surface: ctx.Surface,
            threadId: ctx.MessageThreadId,
            originatingChannel: ctx.OriginatingChannel,
            originatingTo: ctx.OriginatingTo,
            messageId: messageIdForHook,
            senderId: ctx.SenderId,
            senderName: ctx.SenderName,
            senderUsername: ctx.SenderUsername,
            senderE164: ctx.SenderE164,
            guildId: ctx.GroupSpace,
            channelName: ctx.GroupChannel,
          },
        },
        {
          channelId,
          accountId: ctx.AccountId,
          conversationId,
        },
      )
      .catch((err) => {
        logVerbose(`dispatch-from-config: message_received plugin hook failed: ${String(err)}`);
      });
  }

  // Bridge to internal hooks (HOOK.md discovery system) - refs #8807
  if (sessionKey) {
    void triggerInternalHook(
      createInternalHookEvent("message", "received", sessionKey, {
        from: ctx.From ?? "",
        content,
        timestamp,
        channelId,
        accountId: ctx.AccountId,
        conversationId,
        messageId: messageIdForHook,
        metadata: {
          to: ctx.To,
          provider: ctx.Provider,
          surface: ctx.Surface,
          threadId: ctx.MessageThreadId,
          senderId: ctx.SenderId,
          senderName: ctx.SenderName,
          senderUsername: ctx.SenderUsername,
          senderE164: ctx.SenderE164,
          guildId: ctx.GroupSpace,
          channelName: ctx.GroupChannel,
        },
      }),
    ).catch((err) => {
      logVerbose(`dispatch-from-config: message_received internal hook failed: ${String(err)}`);
    });
  }

  // Check if we should route replies to originating channel instead of dispatcher.
  // Only route when the originating channel is DIFFERENT from the current surface.
  // This handles cross-provider routing (e.g., message from Telegram being processed
  // by a shared session that's currently on Slack) while preserving normal dispatcher
  // flow when the provider handles its own messages.
  //
  // Debug: `pnpm test src/auto-reply/reply/dispatch-from-config.test.ts`
  const originatingChannel = ctx.OriginatingChannel;
  const originatingTo = ctx.OriginatingTo;
  const currentSurface = (ctx.Surface ?? ctx.Provider)?.toLowerCase();
  const shouldRouteToOriginating = Boolean(
    isRoutableChannel(originatingChannel) && originatingTo && originatingChannel !== currentSurface,
  );
  const shouldSuppressTyping =
    shouldRouteToOriginating || originatingChannel === INTERNAL_MESSAGE_CHANNEL;
  const ttsChannel = shouldRouteToOriginating ? originatingChannel : currentSurface;

  /**
   * Helper to send a payload via route-reply (async).
   * Only used when actually routing to a different provider.
   * Note: Only called when shouldRouteToOriginating is true, so
   * originatingChannel and originatingTo are guaranteed to be defined.
   */
  const sendPayloadAsync = async (
    payload: ReplyPayload,
    abortSignal?: AbortSignal,
    mirror?: boolean,
  ): Promise<void> => {
    // TypeScript doesn't narrow these from the shouldRouteToOriginating check,
    // but they're guaranteed non-null when this function is called.
    if (!originatingChannel || !originatingTo) {
      return;
    }
    if (abortSignal?.aborted) {
      return;
    }
    const result = await routeReply({
      payload,
      channel: originatingChannel,
      to: originatingTo,
      sessionKey: ctx.SessionKey,
      accountId: ctx.AccountId,
      threadId: ctx.MessageThreadId,
      cfg,
      abortSignal,
      mirror,
    });
    if (!result.ok) {
      logVerbose(`dispatch-from-config: route-reply failed: ${result.error ?? "unknown error"}`);
    }
  };

  markProcessing();

  // ── Early card creation ──────────────────────────────────────
  // Trigger eager streaming card creation BEFORE any LLM/agent work
  // begins, so the user gets instant visual feedback (loading indicator)
  // while the model and tools are still loading.
  // Calling onReasoningStream triggers ensureCardCreated() in the streaming
  // controller; the acknowledgment text is shown as a thinking indicator.
  const processingAckText = process.env.ENCLAWS_PROCESSING_ACK_TEXT?.trim() ?? "🫡 任务已接收，处理中";
  if (params.replyOptions?.onReasoningStream && processingAckText) {
    try {
      await params.replyOptions.onReasoningStream({ text: processingAckText });
    } catch (err) {
      logVerbose(`dispatch-from-config: early card creation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Input content filter ────────────────────────────────────
  const filterResult = checkInputFilter({
    text: content,
    channel: channelId,
    chatType: ctx.ChatType?.toLowerCase(),
  });
  if (filterResult.blocked) {
    const payload = { text: filterResult.replyText ?? "" } satisfies ReplyPayload;
    let queuedFinal = false;
    let routedFinalCount = 0;
    if (shouldRouteToOriginating && originatingChannel && originatingTo) {
      const result = await routeReply({
        payload,
        channel: originatingChannel,
        to: originatingTo,
        sessionKey: ctx.SessionKey,
        accountId: ctx.AccountId,
        threadId: ctx.MessageThreadId,
        cfg,
      });
      queuedFinal = result.ok;
      if (result.ok) {
        routedFinalCount += 1;
      }
    } else {
      queuedFinal = dispatcher.sendFinalReply(payload);
    }
    const counts = dispatcher.getQueuedCounts();
    counts.final += routedFinalCount;
    recordProcessed("completed", { reason: "input_filter_blocked" });
    markIdle("message_completed");
    return { queuedFinal, counts };
  }

  try {
    const fastAbort = await tryFastAbortFromMessage({ ctx, cfg });
    if (fastAbort.handled) {
      const payload = {
        text: formatAbortReplyText(fastAbort.stoppedSubagents),
      } satisfies ReplyPayload;
      let queuedFinal = false;
      let routedFinalCount = 0;
      if (shouldRouteToOriginating && originatingChannel && originatingTo) {
        const result = await routeReply({
          payload,
          channel: originatingChannel,
          to: originatingTo,
          sessionKey: ctx.SessionKey,
          accountId: ctx.AccountId,
          threadId: ctx.MessageThreadId,
          cfg,
        });
        queuedFinal = result.ok;
        if (result.ok) {
          routedFinalCount += 1;
        }
        if (!result.ok) {
          logVerbose(
            `dispatch-from-config: route-reply (abort) failed: ${result.error ?? "unknown error"}`,
          );
        }
      } else {
        queuedFinal = dispatcher.sendFinalReply(payload);
      }
      const counts = dispatcher.getQueuedCounts();
      counts.final += routedFinalCount;
      recordProcessed("completed", { reason: "fast_abort" });
      markIdle("message_completed");
      return { queuedFinal, counts };
    }

    const bypassAcpForCommand = shouldBypassAcpDispatchForCommand(ctx, cfg);

    const sendPolicy = resolveSendPolicy({
      cfg,
      entry: sessionStoreEntry.entry,
      sessionKey: sessionStoreEntry.sessionKey ?? sessionKey,
      channel:
        sessionStoreEntry.entry?.channel ??
        ctx.OriginatingChannel ??
        ctx.Surface ??
        ctx.Provider ??
        undefined,
      chatType: sessionStoreEntry.entry?.chatType,
    });
    if (sendPolicy === "deny" && !bypassAcpForCommand) {
      logVerbose(
        `Send blocked by policy for session ${sessionStoreEntry.sessionKey ?? sessionKey ?? "unknown"}`,
      );
      const counts = dispatcher.getQueuedCounts();
      recordProcessed("completed", { reason: "send_policy_deny" });
      markIdle("message_completed");
      return { queuedFinal: false, counts };
    }

    const shouldSendToolSummaries = ctx.ChatType !== "group" && ctx.CommandSource !== "native";
    const acpDispatch = await tryDispatchAcpReply({
      ctx,
      cfg,
      dispatcher,
      sessionKey,
      inboundAudio,
      sessionTtsAuto,
      ttsChannel,
      shouldRouteToOriginating,
      originatingChannel,
      originatingTo,
      shouldSendToolSummaries,
      bypassForCommand: bypassAcpForCommand,
      onReplyStart: params.replyOptions?.onReplyStart,
      recordProcessed,
      markIdle,
    });
    if (acpDispatch) {
      return acpDispatch;
    }

    // Track accumulated block text for TTS generation after streaming completes.
    // When block streaming succeeds, there's no final reply, so we need to generate
    // TTS audio separately from the accumulated block content.
    let accumulatedBlockText = "";
    let blockCount = 0;

    const resolveToolDeliveryPayload = (payload: ReplyPayload): ReplyPayload | null => {
      if (shouldSendToolSummaries) {
        return payload;
      }
      // Group/native flows intentionally suppress tool summary text, but media-only
      // tool results (for example TTS audio) must still be delivered.
      const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
      if (!hasMedia) {
        return null;
      }
      return { ...payload, text: undefined };
    };
    const typing = resolveRunTypingPolicy({
      requestedPolicy: params.replyOptions?.typingPolicy,
      suppressTyping: params.replyOptions?.suppressTyping === true || shouldSuppressTyping,
      originatingChannel,
      systemEvent: shouldRouteToOriginating,
    });

    const replyResult = await (params.replyResolver ?? getReplyFromConfig)(
      ctx,
      {
        ...params.replyOptions,
        typingPolicy: typing.typingPolicy,
        suppressTyping: typing.suppressTyping,
        onToolResult: (payload: ReplyPayload) => {
          const run = async () => {
            const ttsPayload = await maybeApplyTtsToPayload({
              payload,
              cfg,
              channel: ttsChannel,
              kind: "tool",
              inboundAudio,
              ttsAuto: sessionTtsAuto,
            });
            const deliveryPayload = resolveToolDeliveryPayload(ttsPayload);
            if (!deliveryPayload) {
              return;
            }
            if (shouldRouteToOriginating) {
              await sendPayloadAsync(deliveryPayload, undefined, false);
            } else {
              dispatcher.sendToolResult(deliveryPayload);
            }
          };
          return run();
        },
        onBlockReply: (payload: ReplyPayload, context) => {
          const run = async () => {
            // Suppress reasoning payloads — channels using this generic dispatch
            // path (WhatsApp, web, etc.) do not have a dedicated reasoning lane.
            // Telegram has its own dispatch path that handles reasoning splitting.
            if (shouldSuppressReasoningPayload(payload)) {
              return;
            }
            // Accumulate block text for TTS generation after streaming
            if (payload.text) {
              if (accumulatedBlockText.length > 0) {
                accumulatedBlockText += "\n";
              }
              accumulatedBlockText += payload.text;
              blockCount++;
            }
            const ttsPayload = await maybeApplyTtsToPayload({
              payload,
              cfg,
              channel: ttsChannel,
              kind: "block",
              inboundAudio,
              ttsAuto: sessionTtsAuto,
            });
            if (shouldRouteToOriginating) {
              await sendPayloadAsync(ttsPayload, context?.abortSignal, false);
            } else {
              dispatcher.sendBlockReply(ttsPayload);
            }
          };
          return run();
        },
      },
      cfg,
    );

    const replies = replyResult ? (Array.isArray(replyResult) ? replyResult : [replyResult]) : [];

    let queuedFinal = false;
    let routedFinalCount = 0;
    for (const reply of replies) {
      // Suppress reasoning payloads from channel delivery — channels using this
      // generic dispatch path do not have a dedicated reasoning lane.
      if (shouldSuppressReasoningPayload(reply)) {
        continue;
      }
      const ttsReply = await maybeApplyTtsToPayload({
        payload: reply,
        cfg,
        channel: ttsChannel,
        kind: "final",
        inboundAudio,
        ttsAuto: sessionTtsAuto,
      });
      if (shouldRouteToOriginating && originatingChannel && originatingTo) {
        // Route final reply to originating channel.
        const result = await routeReply({
          payload: ttsReply,
          channel: originatingChannel,
          to: originatingTo,
          sessionKey: ctx.SessionKey,
          accountId: ctx.AccountId,
          threadId: ctx.MessageThreadId,
          cfg,
        });
        if (!result.ok) {
          logVerbose(
            `dispatch-from-config: route-reply (final) failed: ${result.error ?? "unknown error"}`,
          );
        }
        queuedFinal = result.ok || queuedFinal;
        if (result.ok) {
          routedFinalCount += 1;
        }
      } else {
        queuedFinal = dispatcher.sendFinalReply(ttsReply) || queuedFinal;
      }
    }

    const ttsMode = resolveTtsConfig(cfg).mode ?? "final";
    // Generate TTS-only reply after block streaming completes (when there's no final reply).
    // This handles the case where block streaming succeeds and drops final payloads,
    // but we still want TTS audio to be generated from the accumulated block content.
    if (
      ttsMode === "final" &&
      replies.length === 0 &&
      blockCount > 0 &&
      accumulatedBlockText.trim()
    ) {
      try {
        const ttsSyntheticReply = await maybeApplyTtsToPayload({
          payload: { text: accumulatedBlockText },
          cfg,
          channel: ttsChannel,
          kind: "final",
          inboundAudio,
          ttsAuto: sessionTtsAuto,
        });
        // Only send if TTS was actually applied (mediaUrl exists)
        if (ttsSyntheticReply.mediaUrl) {
          // Send TTS-only payload (no text, just audio) so it doesn't duplicate the block content
          const ttsOnlyPayload: ReplyPayload = {
            mediaUrl: ttsSyntheticReply.mediaUrl,
            audioAsVoice: ttsSyntheticReply.audioAsVoice,
          };
          if (shouldRouteToOriginating && originatingChannel && originatingTo) {
            const result = await routeReply({
              payload: ttsOnlyPayload,
              channel: originatingChannel,
              to: originatingTo,
              sessionKey: ctx.SessionKey,
              accountId: ctx.AccountId,
              threadId: ctx.MessageThreadId,
              cfg,
            });
            queuedFinal = result.ok || queuedFinal;
            if (result.ok) {
              routedFinalCount += 1;
            }
            if (!result.ok) {
              logVerbose(
                `dispatch-from-config: route-reply (tts-only) failed: ${result.error ?? "unknown error"}`,
              );
            }
          } else {
            const didQueue = dispatcher.sendFinalReply(ttsOnlyPayload);
            queuedFinal = didQueue || queuedFinal;
          }
        }
      } catch (err) {
        logVerbose(
          `dispatch-from-config: accumulated block TTS failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const counts = dispatcher.getQueuedCounts();
    counts.final += routedFinalCount;
    recordProcessed("completed");
    markIdle("message_completed");
    return { queuedFinal, counts };
  } catch (err) {
    recordProcessed("error", { error: String(err) });
    markIdle("message_error");
    throw err;
  }
}
