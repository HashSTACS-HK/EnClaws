/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Pre-LLM user-authorization gate (shared across IM platforms).
 *
 * Invocation site: `src/auto-reply/reply/dispatch-from-config.ts` calls
 * `coreAuthGate` right after `enrichTenantContext`. All IM plugins (Feishu /
 * WeCom / DingTalk / Slack / ...) route inbound messages through
 * `dispatchReplyFromConfig`, so **one hook here covers every platform**.
 *
 * How it works:
 *   1. Check whether ctx.SenderName is empty / a placeholder (name not resolved).
 *   2. Pick the driver registered for ctx.Provider; pass through if none is
 *      registered (other platforms are unaffected).
 *   3. Check cooldown (5 minutes) to avoid spamming the same user with cards.
 *   4. Enqueue (upsert — only the latest message per user is kept).
 *   5. Asynchronously call driver.triggerAuth (send card + background polling;
 *      on success, write the name to DB and replay the queued message).
 *   6. Return skipDispatch=true so dispatch-from-config bails out — **LLM does not run**.
 *
 * When the driver fails (e.g. Feishu "stranger DM blocked" 230013): clear the
 * cooldown so the next message retries, but still return skipDispatch=true
 * (do not let the LLM run against a nameless message).
 *
 * Adding a new platform: implement the `AuthGateDriver` interface in core and
 * call `registerAuthDriver(driver)`. **No plugin-side changes required.**
 */

import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { enqueuePendingAuth, type QueuedDispatchParams } from "./auth-gate-queue.js";

const log = createSubsystemLogger("auth-gate");

// ---------------------------------------------------------------------------
// Driver registry
// ---------------------------------------------------------------------------

/**
 * Platform-specific "lightweight auth" driver. Each IM platform implements one
 * and attaches it to its `ctx.Provider` value.
 *
 * For example the Feishu driver implements the device flow and DMs the card
 * to strangers via receive_id_type='open_id'. The WeCom driver follows its
 * own OAuth flow. **The two do not interfere.**
 */
export interface AuthGateDriver {
  /** Unique provider id, e.g. "feishu" / "wecom" / "dingtalk" — matches `ctx.Provider`. */
  provider: string;

  /**
   * Kicks off the authorization flow.
   *
   * The driver should:
   *   1. Build an auth card for ctx.SenderId (request only the minimal scope
   *      needed to fetch the user's name).
   *   2. **DM** the card to the user (Feishu uses receive_id_type='open_id').
   *   3. Start the OAuth poll asynchronously.
   *   4. On completion call `onComplete(name)` — the gate persists the name
   *      and replays the queued message.
   *
   * Returning `delivered=false` means the card never left the building (user
   * blocked us / API error). The gate clears the cooldown so the next
   * inbound message will retry.
   */
  triggerAuth(params: {
    ctx: FinalizedMsgContext;
    cfg: OpenClawConfig;
    /** Called by the driver once the name has been obtained. The gate persists + replays. */
    onComplete: (name: string) => Promise<void>;
  }): Promise<{ delivered: boolean; reason?: string }>;
}

const drivers = new Map<string, AuthGateDriver>();

/** A driver calls this once at module load time to register itself. */
export function registerAuthDriver(driver: AuthGateDriver): void {
  drivers.set(driver.provider.toLowerCase(), driver);
  log.info(`auth driver registered: ${driver.provider}`);
}

function getDriver(provider: string | undefined): AuthGateDriver | undefined {
  if (!provider) {
    return undefined;
  }
  return drivers.get(provider.toLowerCase());
}

// ---------------------------------------------------------------------------
// Cooldown
// ---------------------------------------------------------------------------

/**
 * Cooldown between two auth attempts for the same user. Rationale for 5 min:
 *   - Slightly longer than Feishu's default device-code TTL (4 min) so a card
 *     that just arrived is not immediately replaced by a new one.
 *   - Short enough that users feel a change quickly once the admin grants
 *     the bot additional permissions (they wait at most 5 minutes).
 *   - Stays well under Feishu IM API's per-target rate limit.
 */
const COOLDOWN_MS = 5 * 60 * 1000;
const cooldownMap = new Map<string, number>();

function cooldownKey(provider: string, accountId: string, openId: string): string {
  return `${provider}:${accountId}:${openId}`;
}

function isInCooldown(key: string): boolean {
  const expireAt = cooldownMap.get(key);
  if (expireAt === undefined) {
    return false;
  }
  if (expireAt <= Date.now()) {
    cooldownMap.delete(key);
    return false;
  }
  return true;
}

function setCooldown(key: string): void {
  cooldownMap.set(key, Date.now() + COOLDOWN_MS);
}

function clearCooldown(key: string): void {
  cooldownMap.delete(key);
}

// ---------------------------------------------------------------------------
// Helper: do we already have a readable name?
// ---------------------------------------------------------------------------

/**
 * Whether the name is still in an "unresolved" state.
 *
 * - empty / undefined → unresolved
 * - starts with `ou_` / `on_` → Feishu openId / unionId placeholder (legacy
 *   paths write these values)
 *
 * Other IM platforms can extend this helper to recognize their own
 * placeholder patterns; for now we only cover Feishu.
 */
function isMissingName(name: string | undefined | null): boolean {
  if (!name) {
    return true;
  }
  if (name.startsWith("ou_") || name.startsWith("on_")) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public: gate
// ---------------------------------------------------------------------------

export interface AuthGateResult {
  /** When true the caller should return early and must not invoke the LLM. */
  skipDispatch: boolean;
  /** Reason for the skip (debug aid). */
  reason?: string;
}

/**
 * Called from dispatch-from-config, right after enrichTenantContext.
 *
 * Does not block the caller: the driver's real auth work (sending the card,
 * polling for the token) runs asynchronously inside setImmediate. This
 * function only decides "should we skipDispatch?" and returns immediately.
 */
export async function coreAuthGate(params: {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
  /** Original dispatcher from dispatchReplyFromConfig (reused when replaying). */
  dispatcher: unknown;
  replyOptions?: unknown;
  replyResolver?: unknown;
}): Promise<AuthGateResult> {
  const { ctx, cfg } = params;

  // 1. Name already resolved (contact-API hit / DB hit / previously authorized UAT) → pass through
  if (!isMissingName(ctx.SenderName)) {
    return { skipDispatch: false };
  }

  // 2. Pick the driver; providers with no registered driver pass through (does not affect other platforms)
  const provider = (ctx.Provider ?? ctx.Surface ?? "").toLowerCase();
  const driver = getDriver(provider);
  if (!driver) {
    return { skipDispatch: false, reason: "no-driver" };
  }

  // 3. We need a SenderId — the driver cannot work without it
  const senderId = ctx.SenderId;
  if (!senderId) {
    return { skipDispatch: false, reason: "no-sender-id" };
  }

  const accountId = ctx.AccountId ?? "default";
  const key = cooldownKey(provider, accountId, senderId);

  // 4. Enqueue (store regardless of cooldown so we can replay once auth completes)
  const queueParams: QueuedDispatchParams = {
    ctx,
    cfg,
    dispatcher: params.dispatcher,
    replyOptions: params.replyOptions,
    replyResolver: params.replyResolver,
  };
  enqueuePendingAuth(provider, accountId, senderId, queueParams);

  // 5. In cooldown → do not send another card, but the message is queued and
  //    will still be replayed when the user eventually authorizes.
  if (isInCooldown(key)) {
    log.info(`skip dispatch (cooldown) — ${provider}:${senderId}`);
    return { skipDispatch: true, reason: "in-cooldown" };
  }

  // 6. Mark cooldown and trigger the driver asynchronously
  setCooldown(key);
  setImmediate(async () => {
    try {
      const result = await driver.triggerAuth({
        ctx,
        cfg,
        onComplete: async (name: string) => {
          // ---------- Name obtained: persist to DB + clear caches + replay ----------
          try {
            // Persist via the existing user-profiles DB path (tenant-enrich.ts uses the same one).
            const { updateDisplayNameByOpenId } = await import("../db/models/user.js");
            await updateDisplayNameByOpenId(senderId, name);
            log.info(`persisted display name "${name}" for ${provider}:${senderId}`);
          } catch (err) {
            log.warn(`failed to persist display name for ${provider}:${senderId}: ${String(err)}`);
          }
          // Invalidate the autoProvision in-memory cache so future OTHER-path
          // lookups for this user return the fresh displayName rather than the
          // `undefined` that was cached at first dispatch.
          //
          // Note: this replay does not depend on the cache clear — we inject
          // `name` directly into ctx below and bypass the entire
          // tenant-enrich + autoProvisionTenantUser DB lookup path.
          try {
            const { clearAutoProvisionCache } = await import("./channel-auto-provision.js");
            clearAutoProvisionCache();
          } catch (err) {
            log.warn(`failed to clear auto-provision cache: ${String(err)}`);
          }
          try {
            const { replayPendingAuth } = await import("./auth-gate-queue.js");
            // Pass the resolved name to replay so it is injected directly into
            // ctx.SenderName; otherwise tenant-enrich's short-circuit logic
            // would leave ctx.SenderName empty.
            await replayPendingAuth(provider, accountId, senderId, name);
          } catch (err) {
            log.error(`replay failed for ${provider}:${senderId}: ${String(err)}`);
          }
        },
      });

      if (!result.delivered) {
        // Card never left the building (API rejected / network error) →
        // clear the cooldown so the next message retries.
        clearCooldown(key);
        log.warn(
          `auth card not delivered for ${provider}:${senderId}: ${result.reason ?? "unknown"} (cooldown cleared, will retry on next message)`,
        );
      } else {
        log.info(`auth card delivered for ${provider}:${senderId}, awaiting user action`);
      }
    } catch (err) {
      clearCooldown(key);
      log.error(`driver.triggerAuth threw for ${provider}:${senderId}: ${String(err)}`);
    }
  });

  return { skipDispatch: true, reason: "auth-required" };
}
