/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Replay queue for the pre-LLM auth gate.
 *
 * When the gate blocks an inbound message because the user has not been
 * authorized, that message is stashed here. Once the user completes the
 * flow (the driver resolves the name and writes it to DB), the queue feeds
 * the message back into `dispatchReplyFromConfig` with its original params —
 * this time enrichTenantContext will read the name from DB, the gate no
 * longer fires, and the LLM handles the message normally.
 *
 * Design notes:
 *   - **Upsert**: only the last message per user is kept. If a user sends
 *     multiple messages during authorization, we reply only to the most
 *     recent once they authorize (avoids dredging up stale chatter).
 *   - **Cross-platform**: the key is `${provider}:${accountId}:${openId}`,
 *     so Feishu (and future WeCom / DingTalk / ...) share this one queue
 *     without stepping on each other.
 *   - **30-minute TTL**: device flow usually expires in ~4 minutes; 30 min
 *     leaves slack for every retry scenario.
 *   - **Precise dedupe-entry deletion on replay**: the original MessageSid
 *     still lives in `inboundDedupeCache`; without deleting it the second
 *     dispatch would be blocked by `shouldSkipDuplicateInbound`. We call
 *     `deleteInboundDedupeEntry(ctx)` to remove only this single key,
 *     leaving other users untouched.
 *     **Do not mutate ctx.MessageSid** — that would break tenant-enrich's
 *     messageId-based chatId fallback lookup.
 *   - **Avoiding circular imports**: `dispatchReplyFromConfig` is obtained
 *     via dynamic `import()`.
 */

import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("auth-gate-queue");

const PENDING_TTL_MS = 30 * 60 * 1000;

/**
 * Everything required to replay the dispatch. These are the parameters of
 * `dispatchReplyFromConfig` **stored and returned verbatim**. dispatcher /
 * replyOptions / replyResolver are typed as `unknown` to avoid a compile-time
 * circular dependency on the `auto-reply/reply` subtree (the real types are
 * recovered via dynamic `import()` at replay time).
 */
export interface QueuedDispatchParams {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcher: unknown;
  replyOptions?: unknown;
  replyResolver?: unknown;
}

interface Entry {
  params: QueuedDispatchParams;
  expiresAt: number;
}

/** Key: `${provider}:${accountId}:${openId}`. Only one entry per user is kept. */
const queue = new Map<string, Entry>();

function makeKey(provider: string, accountId: string, openId: string): string {
  return `${provider}:${accountId}:${openId}`;
}

/**
 * Enqueue (upsert): a new message from the same user replaces the previous one.
 */
export function enqueuePendingAuth(
  provider: string,
  accountId: string,
  openId: string,
  params: QueuedDispatchParams,
): void {
  const key = makeKey(provider, accountId, openId);
  const existed = queue.has(key);
  queue.set(key, { params, expiresAt: Date.now() + PENDING_TTL_MS });
  if (existed) {
    log.info(`replaced queued message for ${provider}:${openId} (only the latest is kept)`);
  } else {
    log.info(`queued message for replay after lite-auth, provider=${provider} user=${openId}`);
  }
}

/**
 * Pop and replay the last queued message for a given user.
 *
 * Called by the driver once authorization completes (and the name has been
 * written to DB). **The resolved name is injected directly into
 * ctx.SenderName**, bypassing tenant-enrich's short-circuit paths:
 *   - tenant-enrich Branch A requires `!ctx.TenantUserRole`, but the first
 *     dispatch already set TenantUserRole, so Branch A would not re-run the
 *     DB lookup.
 *   - tenant-enrich Branch B requires `!ctx.TenantId`; same story — it
 *     short-circuits.
 *   - Without pre-injecting the name, tenant-enrich would leave SenderName
 *     empty on replay and the gate would fire again.
 *
 * After the injection: tenant-enrich sees SenderName is filled and skips
 * `resolveFeishuSenderName`; the gate sees SenderName is filled and does
 * not fire; the dispatch proceeds into the LLM as normal.
 */
export async function replayPendingAuth(
  provider: string,
  accountId: string,
  openId: string,
  resolvedName?: string,
): Promise<void> {
  const key = makeKey(provider, accountId, openId);
  const entry = queue.get(key);
  queue.delete(key);

  if (!entry) {
    return;
  }
  if (entry.expiresAt <= Date.now()) {
    log.warn(`pending message for ${provider}:${openId} expired before replay, dropping`);
    return;
  }

  // Inject the resolved name directly into ctx — bypasses tenant-enrich's short-circuit paths.
  if (resolvedName) {
    const ctx = entry.params.ctx as FinalizedMsgContext & { SenderName?: string };
    ctx.SenderName = resolvedName;
    log.info(`injected resolved name "${resolvedName}" into ctx for ${provider}:${openId}`);
  }

  log.info(`replaying latest pending message for ${provider}:${openId}`);

  try {
    // Remove the dedupe entry left behind by the first dispatch; otherwise
    // shouldSkipDuplicateInbound would treat this as a duplicate and skip it.
    // We remove only this single key so other users are unaffected.
    const { deleteInboundDedupeEntry } = await import("../auto-reply/reply/inbound-dedupe.js");
    deleteInboundDedupeEntry(entry.params.ctx);

    // Dynamic import to avoid the circular dependency (auth-gate-queue ↔ dispatch-from-config).
    const mod = await import("../auto-reply/reply/dispatch-from-config.js");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (mod.dispatchReplyFromConfig as any)({
      ctx: entry.params.ctx,
      cfg: entry.params.cfg,
      dispatcher: entry.params.dispatcher,
      replyOptions: entry.params.replyOptions,
      replyResolver: entry.params.replyResolver,
    });

    // Important: drive the dispatcher all the way to its idle state so the
    // streaming card transitions to "complete" and the typing emoji is cleared.
    //
    // Background: the plugin's reply-dispatcher.ts uses a StreamingCardController
    // to run the state machine for the "thinking…" card. The final hop
    // thinking → streaming → complete is fired by the dispatcher's `onIdle`,
    // which in turn calls `controller.onIdle()` to finalize the card.
    //
    // When does the dispatcher's onIdle fire? Two paths:
    //   1. enqueue's `.finally()` notices pending===0
    //   2. the caller explicitly calls `markDispatchIdle()`
    //
    // The plugin's own dispatch.ts takes path 2 (it calls markFullyComplete +
    // markDispatchIdle right after dispatchReplyFromConfig). But
    // markDispatchIdle is a plugin-side wrapper — it is not part of the core
    // ReplyDispatcher interface, so we cannot reach it from core.
    //
    // Workaround: call `dispatcher.markComplete()`, which is part of the core
    // interface. It:
    //   - sets completeCalled=true
    //   - schedules a microtask that drops pending from reservation=1 to 0
    //   - pending===0 → the dispatcher's internal onIdle fires
    //   - internal onIdle → typingController.markDispatchIdle() (clears typing emoji)
    //                    → the plugin's resolvedOnIdle wrapper
    //                    → the wrapper checks dispatchFullyComplete (already set
    //                      to true by the plugin during the first dispatch)
    //                    → controller.onIdle()
    //                    → streaming card flips to complete
    //
    // Note: the plugin's normal path **never** calls dispatcher.markComplete()
    // itself, so calling it once here does not conflict with the plugin;
    // markComplete has an internal idempotent guard
    // (`if (completeCalled) return;`), so multiple calls are harmless.
    const dispatcher = entry.params.dispatcher as
      | {
          waitForIdle?: () => Promise<void>;
          markComplete?: () => void;
        }
      | undefined;

    if (dispatcher && typeof dispatcher.waitForIdle === "function") {
      try {
        await dispatcher.waitForIdle();
      } catch (err) {
        log.warn(`waitForIdle failed for ${provider}:${openId}: ${String(err)}`);
      }
    }

    if (dispatcher && typeof dispatcher.markComplete === "function") {
      try {
        dispatcher.markComplete();
        // markComplete schedules a microtask. Yield for a few microtask ticks
        // and await waitForIdle once more so the onIdle chain has a chance to
        // run (including the first few async steps of the plugin's finalizeCard).
        await Promise.resolve();
        await Promise.resolve();
        if (typeof dispatcher.waitForIdle === "function") {
          await dispatcher.waitForIdle();
        }
      } catch (err) {
        log.warn(`markComplete failed for ${provider}:${openId}: ${String(err)}`);
      }
    }

    log.info(`replay completed for ${provider}:${openId}`);
  } catch (err) {
    log.error(`replay failed for ${provider}:${openId}: ${String(err)}`);
  }
}

/** Clear every queued entry (teardown helper). */
export function clearPendingAuth(): void {
  queue.clear();
}
