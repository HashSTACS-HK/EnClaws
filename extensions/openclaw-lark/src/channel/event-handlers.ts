/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Event handlers for the Feishu WebSocket monitor.
 *
 * Extracted from monitor.ts to improve testability and reduce
 * function size. Each handler receives a MonitorContext with all
 * dependencies needed to process the event.
 */

import { larkLogger } from "../core/lark-logger";
import { withTicket } from "../core/lark-ticket";
import { isMessageExpired } from "../messaging/inbound/dedup";
import { handleFeishuMessage } from "../messaging/inbound/handler";
import {
  handleFeishuReaction,
  resolveReactionContext,
} from "../messaging/inbound/reaction-handler";
import type {
  FeishuBotAddedEvent,
  FeishuMessageEvent,
  FeishuReactionCreatedEvent,
} from "../messaging/types";
import { handleAskUserAction } from "../tools/ask-user-question";
import { handleCardAction } from "../tools/auto-auth";
import { extractRawTextFromEvent, isLikelyAbortText } from "./abort-detect";
import {
  buildQueueKey,
  enqueueFeishuChatTask,
  getActiveDispatcher,
  getLastMentionedBot,
  hasActiveTask,
  setAbortedCardMessageId,
  setLastMentionedBot,
} from "./chat-queue";
import type { MonitorContext } from "./types";

const elog = larkLogger("channel/event-handlers");

// ---------------------------------------------------------------------------
// Event ownership validation
// ---------------------------------------------------------------------------

/**
 * Verify that the event's app_id matches the current account.
 *
 * Lark SDK EventDispatcher flattens the v2 envelope header (which
 * contains `app_id`) into the handler `data` object, so `app_id` is
 * available directly on `data`.
 *
 * Returns `false` (discard event) when the app_id does not match.
 */
function isEventOwnershipValid(ctx: MonitorContext, data: unknown): boolean {
  const expectedAppId = ctx.lark.account.appId;
  if (!expectedAppId) return true; // appId not configured — skip check

  const eventAppId = (data as Record<string, unknown>).app_id;
  if (eventAppId == null) return true; // SDK did not provide app_id — defensive skip

  if (eventAppId !== expectedAppId) {
    elog.warn("event app_id mismatch, discarding", {
      accountId: ctx.accountId,
      expected: expectedAppId,
      received: String(eventAppId),
    });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

export async function handleMessageEvent(ctx: MonitorContext, data: unknown): Promise<void> {
  if (!isEventOwnershipValid(ctx, data)) return;
  const { accountId, log, error } = ctx;
  try {
    const event = data as FeishuMessageEvent;
    const msgId = event.message?.message_id ?? "unknown";
    const chatId = event.message?.chat_id ?? "";
    // In topic groups, reply events carry root_id but not thread_id.
    // Use root_id as fallback so different topics get separate queue keys
    // and can be processed in parallel.
    const threadId = event.message?.thread_id || event.message?.root_id || undefined;
    const senderOpenId = event.sender?.sender_id?.open_id || "";
    const senderUnionId = event.sender?.sender_id?.union_id || "";
    const isGroup = (event.message?.chat_type as string) === "group";
    const senderQueueId = isGroup && senderOpenId ? senderOpenId : undefined;

    // Dedup — skip duplicate messages (e.g. from WebSocket reconnects).
    if (!ctx.messageDedup.tryRecord(msgId, accountId)) {
      log(`feishu[${accountId}]: duplicate message ${msgId}, skipping`);
      return;
    }

    // Expiry — discard stale messages from reconnect replay.
    if (isMessageExpired(event.message?.create_time)) {
      log(`feishu[${accountId}]: message ${msgId} expired, discarding`);
      return;
    }

    // ---- Abort fast-path ----
    // If the message looks like an abort trigger and there is an active
    // reply dispatcher for this chat, fire abortCard() immediately
    // (before the message enters the serial queue) so the streaming
    // card is terminated without waiting for the current task.
    const abortText = extractRawTextFromEvent(event);
    const botMentionedHere = (event.message?.mentions ?? []).some(
      (m) => m.id?.open_id && m.id.open_id === ctx.lark.botOpenId,
    );

    // Track which bot was most recently @-mentioned by this sender.
    // Only set when the message explicitly @-mentions THIS bot, so
    // requireMention:false bots don't overwrite each other.
    if (isGroup && botMentionedHere && senderUnionId) {
      setLastMentionedBot(chatId, senderUnionId, threadId, accountId);
    }

    let abortFired = false;
    if (abortText && isLikelyAbortText(abortText)) {
      const queueKey = buildQueueKey(accountId, chatId, threadId, senderQueueId);
      if (hasActiveTask(queueKey)) {
        const active = getActiveDispatcher(queueKey);
        // When the /stop @-mentions a specific bot, only that bot aborts.
        // When bare /stop (no @-mentions), only the bot most recently
        // @-mentioned by this sender aborts.
        const stopHasMentions = (event.message?.mentions ?? []).length > 0;
        const isLastMentioned = getLastMentionedBot(chatId, senderUnionId, threadId) === accountId;
        if (active && (!isGroup || botMentionedHere || (!stopHasMentions && isLastMentioned))) {
          // Capture card message ID before aborting for reply targeting
          const cardMsgId = active.getCardMessageId?.();
          if (cardMsgId) {
            setAbortedCardMessageId(queueKey, cardMsgId);
          }
          log(
            `feishu[${accountId}]: abort fast-path triggered for chat ${chatId} (text="${abortText}")`,
          );
          active.abortController?.abort();
          active.abortCard().catch((err) => {
            error(`feishu[${accountId}]: abort fast-path abortCard failed: ${String(err)}`);
          });
          abortFired = true;
        }
      }

      // ---- Bare /stop in groups: skip enqueue for non-target bots ----
      // If the fast-path didn't fire for this bot, the /stop is not
      // intended for us — skip enqueueing so the SDK doesn't process it.
      // If the fast-path DID fire, enqueue normally so the SDK sends a
      // reply that quotes the aborted card.
      if (isGroup && !botMentionedHere && !abortFired) {
        log(`feishu[${accountId}]: bare /stop in group, not our task, skipping`);
        return;
      }
    }

    // ---- /btw steer fast-path ----
    if (abortText && /^\/btw\s+/i.test(abortText)) {
      const queueKey = buildQueueKey(accountId, chatId, threadId, senderQueueId);
      const active = getActiveDispatcher(queueKey);
      if (active?.steer) {
        const steerText = abortText.replace(/^\/btw\s+/i, "");
        if (active.steer(steerText)) {
          log(`feishu[${accountId}]: /btw steer injected for chat ${chatId}`);
          return; // consumed — do not enqueue
        }
      }
    }

    const { status } = enqueueFeishuChatTask({
      accountId,
      chatId,
      threadId,
      senderId: senderQueueId,
      task: async () => {
        try {
          await withTicket(
            {
              messageId: msgId,
              chatId,
              accountId,
              startTime: Date.now(),
              senderOpenId: event.sender?.sender_id?.open_id || "",
              chatType: (event.message?.chat_type as "p2p" | "group") || undefined,
              threadId,
            },
            () =>
              handleFeishuMessage({
                cfg: ctx.cfg,
                event,
                botOpenId: ctx.lark.botOpenId,
                runtime: ctx.runtime,
                chatHistories: ctx.chatHistories,
                accountId,
              }),
          );
        } catch (err) {
          error(`feishu[${accountId}]: error handling message: ${String(err)}`);
        }
      },
    });
    log(
      `feishu[${accountId}]: message ${msgId} in chat ${chatId}${threadId ? ` thread ${threadId}` : ""} — ${status}`,
    );
  } catch (err) {
    error(`feishu[${accountId}]: error handling message: ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Reaction handler
// ---------------------------------------------------------------------------

export async function handleReactionEvent(ctx: MonitorContext, data: unknown): Promise<void> {
  if (!isEventOwnershipValid(ctx, data)) return;
  const { accountId, log, error } = ctx;
  try {
    const event = data as FeishuReactionCreatedEvent;
    const msgId = event.message_id ?? "unknown";

    log(`feishu[${accountId}]: reaction event on message ${msgId}`);

    // ---- Dedup: deterministic key based on message + emoji + operator ----
    const emojiType = event.reaction_type?.emoji_type ?? "";
    const operatorOpenId = event.user_id?.open_id ?? "";
    const dedupKey = `${msgId}:reaction:${emojiType}:${operatorOpenId}`;
    if (!ctx.messageDedup.tryRecord(dedupKey, accountId)) {
      log(`feishu[${accountId}]: duplicate reaction ${dedupKey}, skipping`);
      return;
    }

    // ---- Expiry: discard stale reaction events ----
    if (isMessageExpired(event.action_time)) {
      log(`feishu[${accountId}]: reaction on ${msgId} expired, discarding`);
      return;
    }

    // ---- Pre-resolve real chatId before enqueuing ----
    // The API call (3s timeout) runs outside the queue so it doesn't
    // block the serial chain, and is read-only so ordering is irrelevant.
    const preResolved = await resolveReactionContext({
      cfg: ctx.cfg,
      event,
      botOpenId: ctx.lark.botOpenId,
      runtime: ctx.runtime,
      accountId,
    });
    if (!preResolved) return;

    // ---- Enqueue with the real chatId (matches normal message queue key) ----
    const { status } = enqueueFeishuChatTask({
      accountId,
      chatId: preResolved.chatId,
      threadId: preResolved.threadId,
      task: async () => {
        try {
          await withTicket(
            {
              messageId: msgId,
              chatId: preResolved.chatId,
              accountId,
              startTime: Date.now(),
              senderOpenId: operatorOpenId,
              chatType: preResolved.chatType,
              threadId: preResolved.threadId,
            },
            () =>
              handleFeishuReaction({
                cfg: ctx.cfg,
                event,
                botOpenId: ctx.lark.botOpenId,
                runtime: ctx.runtime,
                chatHistories: ctx.chatHistories,
                accountId,
                preResolved,
              }),
          );
        } catch (err) {
          error(`feishu[${accountId}]: error handling reaction: ${String(err)}`);
        }
      },
    });
    log(`feishu[${accountId}]: reaction on ${msgId} (chatId=${preResolved.chatId}) — ${status}`);
  } catch (err) {
    error(`feishu[${accountId}]: error handling reaction event: ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Bot membership handler
// ---------------------------------------------------------------------------

export async function handleBotMembershipEvent(
  ctx: MonitorContext,
  data: unknown,
  action: "added" | "removed",
): Promise<void> {
  if (!isEventOwnershipValid(ctx, data)) return;
  const { accountId, log, error } = ctx;
  try {
    const event = data as FeishuBotAddedEvent;
    log(
      `feishu[${accountId}]: bot ${action} ${action === "removed" ? "from" : "to"} chat ${event.chat_id}`,
    );
  } catch (err) {
    error(`feishu[${accountId}]: error handling bot ${action} event: ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Card action handler
// ---------------------------------------------------------------------------

export async function handleCardActionEvent(ctx: MonitorContext, data: unknown): Promise<unknown> {
  try {
    // AskUserQuestion card interactions — injects synthetic message
    // carrying user answers for the AI to receive in a new turn.
    const askResult = handleAskUserAction(data, ctx.cfg, ctx.accountId);
    if (askResult !== undefined) return askResult;

    // Auto-auth card actions (OAuth device flow, app scope confirmation)
    return await handleCardAction(data, ctx.cfg, ctx.accountId);
  } catch (err) {
    elog.warn(`card.action.trigger handler error: ${err}`);
  }
}
