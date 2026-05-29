/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Process-level chat task queue.
 *
 * Although located in channel/, this module is intentionally shared
 * across channel, messaging, tools, and card layers as a process-level
 * singleton. Consumers: monitor.ts, dispatch.ts, oauth.ts, auto-auth.ts.
 *
 * Ensures tasks targeting the same account+chat are executed serially.
 * Used by both websocket inbound messages and synthetic message paths.
 */

type QueueStatus = "queued" | "immediate";

export interface ActiveDispatcherEntry {
  abortCard: () => Promise<void>;
  abortController?: AbortController;
  steer?: (text: string) => boolean;
  getCardMessageId?: () => string | undefined;
  /** Whether the message that started this task @-mentioned this bot. */
  wasMentioned?: boolean;
}

const chatQueues = new Map<string, Promise<void>>();
const activeDispatchers = new Map<string, ActiveDispatcherEntry>();

/**
 * Append `:thread:{threadId}` suffix when threadId is present.
 * Consistent with the SDK's `:thread:` separator convention.
 */
export function threadScopedKey(base: string, threadId?: string): string {
  return threadId ? `${base}:thread:${threadId}` : base;
}

export function buildQueueKey(
  accountId: string,
  chatId: string,
  threadId?: string,
  senderId?: string,
): string {
  const base = senderId ? `${accountId}:${chatId}:sender:${senderId}` : `${accountId}:${chatId}`;
  return threadScopedKey(base, threadId);
}

export function registerActiveDispatcher(key: string, entry: ActiveDispatcherEntry): void {
  activeDispatchers.set(key, entry);
}

export function unregisterActiveDispatcher(key: string): void {
  activeDispatchers.delete(key);
}

export function getActiveDispatcher(key: string): ActiveDispatcherEntry | undefined {
  return activeDispatchers.get(key);
}

/** Check whether the queue has an active task for the given key. */
export function hasActiveTask(key: string): boolean {
  return chatQueues.has(key);
}

export function enqueueFeishuChatTask(params: {
  accountId: string;
  chatId: string;
  threadId?: string;
  senderId?: string;
  task: () => Promise<void>;
}): { status: QueueStatus; promise: Promise<void> } {
  const { accountId, chatId, threadId, senderId, task } = params;
  const key = buildQueueKey(accountId, chatId, threadId, senderId);
  const prev = chatQueues.get(key) ?? Promise.resolve();
  const status: QueueStatus = chatQueues.has(key) ? "queued" : "immediate";

  const taskPromise = prev.then(task, task);
  chatQueues.set(key, taskPromise);

  const cleanup = (): void => {
    if (chatQueues.get(key) === taskPromise) {
      chatQueues.delete(key);
    }
  };

  taskPromise.then(cleanup, cleanup);

  return { status, promise: taskPromise };
}

// ---- Last @-mentioned bot tracking ----
// Tracks which bot (accountId) was most recently @-mentioned by a sender
// in a given chat.  Only updated when a message explicitly @-mentions
// the bot, so requireMention:false bots processing other bots' messages
// do not overwrite this.  Used by bare /stop to target the right bot.
// Key: chatId:senderId[:thread:threadId]
const lastMentionedBotMap = new Map<string, string>();

function lastMentionedBotKey(chatId: string, senderId: string, threadId?: string): string {
  return threadId ? `${chatId}:${senderId}:thread:${threadId}` : `${chatId}:${senderId}`;
}

export function setLastMentionedBot(
  chatId: string,
  senderId: string,
  threadId: string | undefined,
  accountId: string,
): void {
  lastMentionedBotMap.set(lastMentionedBotKey(chatId, senderId, threadId), accountId);
}

export function getLastMentionedBot(
  chatId: string,
  senderId: string,
  threadId?: string,
): string | undefined {
  return lastMentionedBotMap.get(lastMentionedBotKey(chatId, senderId, threadId));
}

// ---- Aborted card message ID tracking ----
const abortedCardMessageIds = new Map<string, string>();

export function setAbortedCardMessageId(queueKey: string, messageId: string): void {
  abortedCardMessageIds.set(queueKey, messageId);
}

export function consumeAbortedCardMessageId(queueKey: string): string | undefined {
  const id = abortedCardMessageIds.get(queueKey);
  if (id) abortedCardMessageIds.delete(queueKey);
  return id;
}

/** @internal Test-only: reset all queue and dispatcher state. */
export function _resetChatQueueState(): void {
  chatQueues.clear();
  activeDispatchers.clear();
  abortedCardMessageIds.clear();
  lastMentionedBotMap.clear();
}
