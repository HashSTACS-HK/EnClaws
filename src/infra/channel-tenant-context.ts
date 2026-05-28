/**
 * Resolve tenant context for channel inbound messages.
 *
 * Provides a cached lookup from (channelType, appId/accountId) → TenantContext.
 * Used by channel handlers (Telegram, Slack, Discord, etc.) to scope
 * pairing, credentials, and allow-list data to the correct tenant.
 */

import { isDbInitialized } from "../db/index.js";
import { findTenantByChannelApp } from "../db/models/tenant-channel-app.js";
import type { TenantContext } from "../types/tenant-context.js";

/**
 * Simple TTL cache to avoid hitting the DB on every inbound message.
 * Cache key: `{channelType}:{appId}`
 */
const cache = new Map<string, { value: TenantContext | null; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function cacheKey(channelType: string, appId: string): string {
  return `${channelType}:${appId}`;
}

/**
 * Resolve tenant context for a channel app.
 *
 * Returns null when:
 * - Database is not initialized (single-tenant mode)
 * - No matching active channel app found
 * - The channel was created without a user (created_by is null)
 */
export async function resolveChannelTenantContext(
  channelType: string,
  appId: string,
): Promise<TenantContext | undefined> {
  if (!isDbInitialized()) {return undefined;}

  const key = cacheKey(channelType, appId);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value ?? undefined;
  }

  try {
    const result = await findTenantByChannelApp(channelType, appId);
    cache.set(key, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
    return result ?? undefined;
  } catch {
    // DB query failed — don't cache the error, just fall back to single-tenant
    return undefined;
  }
}

/**
 * Invalidate the cached tenant context for a channel app.
 * Call this when channel app configuration changes.
 */
export function invalidateChannelTenantCache(channelType: string, appId: string): void {
  cache.delete(cacheKey(channelType, appId));
}

/**
 * Clear the entire channel tenant cache.
 */
export function clearChannelTenantCache(): void {
  cache.clear();
}
