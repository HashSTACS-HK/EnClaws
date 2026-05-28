/**
 * Lightweight Feishu user name resolution using tenant_access_token.
 *
 * Resolves display names via im.v1.chatMembers.get (requires im:chat:readonly,
 * no user OAuth needed). Results are cached in memory to minimize API calls.
 *
 * This module uses plain fetch — no dependency on the Feishu SDK — so the
 * core can resolve names independently of the openclaw-lark plugin.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("feishu-user-resolve");

// ---------------------------------------------------------------------------
// Tenant access token cache
// ---------------------------------------------------------------------------

type TokenEntry = { token: string; expiresAt: number };
const tokenCache = new Map<string, TokenEntry>();

export async function getTenantAccessToken(appId: string, appSecret: string): Promise<string | null> {
  const key = appId;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  try {
    const res = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
    const data = await res.json() as {
      code?: number;
      tenant_access_token?: string;
      expire?: number;
    };
    if (data.code !== 0 || !data.tenant_access_token) {
      log.warn(`failed to get tenant_access_token for ${appId}: code=${data.code}`);
      return null;
    }
    // Cache with 30s margin before expiry
    const expiresAt = Date.now() + ((data.expire ?? 7200) - 30) * 1000;
    tokenCache.set(key, { token: data.tenant_access_token, expiresAt });
    return data.tenant_access_token;
  } catch (err) {
    log.warn(`tenant_access_token request failed for ${appId}: ${String(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Chat members name cache
// ---------------------------------------------------------------------------

/** Cache: chatId → Map<openId, displayName> */
const memberNameCache = new Map<string, { members: Map<string, string>; expiresAt: number }>();
const MEMBER_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_MEMBER_CACHE_ENTRIES = 500;

async function fetchChatMembers(
  token: string,
  chatId: string,
): Promise<Map<string, string> | null> {
  const cached = memberNameCache.get(chatId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.members;
  }

  try {
    const url = `https://open.feishu.cn/open-apis/im/v1/chats/${chatId}/members?member_id_type=open_id&page_size=100`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json() as {
      code?: number;
      data?: { items?: Array<{ member_id?: string; name?: string }> };
    };
    if (data.code !== 0) {
      log.warn(`chat members request failed for ${chatId}: code=${data.code}`);
      return null;
    }
    const members = new Map<string, string>();
    for (const item of data.data?.items ?? []) {
      if (item.member_id && item.name) {
        members.set(item.member_id, item.name);
      }
    }
    if (memberNameCache.size >= MAX_MEMBER_CACHE_ENTRIES) {
      const oldest = memberNameCache.keys().next().value;
      if (oldest !== undefined) {memberNameCache.delete(oldest);}
    }
    memberNameCache.set(chatId, { members, expiresAt: Date.now() + MEMBER_CACHE_TTL_MS });
    return members;
  } catch (err) {
    log.warn(`chat members fetch failed for ${chatId}: ${String(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// chat_id resolution via message_id (works for both group and p2p)
// ---------------------------------------------------------------------------

/**
 * Get chat_id from a message_id via `GET /im/v1/messages/{message_id}`.
 * This is the most direct way to resolve chat_id for p2p chats without
 * enumerating all bot conversations.
 */
async function getChatIdFromMessage(
  token: string,
  messageId: string,
): Promise<string | undefined> {
  try {
    const res = await fetch(
      `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const data = await res.json() as {
      code?: number;
      data?: { items?: Array<{ chat_id?: string }> };
    };
    if (data.code !== 0) {
      log.warn(`get message failed for ${messageId}: code=${data.code}`);
      return undefined;
    }
    return data.data?.items?.[0]?.chat_id ?? undefined;
  } catch (err) {
    log.warn(`get message request failed for ${messageId}: ${String(err)}`);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a Feishu user's display name from the chat members API.
 *
 * @param appId - Feishu app ID (from channel config)
 * @param appSecret - Feishu app secret
 * @param chatId - Chat ID (group or p2p). If undefined, falls back to messageId resolution.
 * @param messageId - Message ID from the inbound event. Used to resolve chat_id for p2p chats.
 * @param openId - User's open_id
 * @returns Display name or undefined if resolution fails
 */
export async function resolveFeishuUserName(params: {
  appId: string;
  appSecret: string;
  chatId?: string;
  messageId?: string;
  openId: string;
}): Promise<string | undefined> {
  const { appId, appSecret, openId } = params;
  let chatId = params.chatId;

  // Check member cache first (no API call)
  if (chatId) {
    const cached = memberNameCache.get(chatId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.members.get(openId);
    }
  }

  const token = await getTenantAccessToken(appId, appSecret);
  if (!token) {return undefined;}

  // For p2p chats, resolve chat_id from the message_id directly
  if (!chatId && params.messageId) {
    chatId = await getChatIdFromMessage(token, params.messageId);
  }
  if (!chatId) {return undefined;}

  const members = await fetchChatMembers(token, chatId);
  return members?.get(openId);
}

/**
 * Extract Feishu app credentials from the channel config for a given provider/account.
 */
export function extractFeishuCredentials(
  cfg: Record<string, unknown>,
  provider: string,
  accountId?: string,
): { appId: string; appSecret: string } | null {
  const channels = cfg.channels as Record<string, Record<string, unknown>> | undefined;
  const channelCfg = channels?.[provider];
  if (!channelCfg) {return null;}

  // Try account-scoped config first
  if (accountId) {
    const accounts = channelCfg.accounts as Record<string, Record<string, unknown>> | undefined;
    const account = accounts?.[accountId];
    if (account?.appId && account?.appSecret) {
      return { appId: String(account.appId), appSecret: String(account.appSecret) };
    }
  }

  // Fallback to top-level
  if (channelCfg.appId && channelCfg.appSecret) {
    return { appId: String(channelCfg.appId), appSecret: String(channelCfg.appSecret) };
  }

  return null;
}
