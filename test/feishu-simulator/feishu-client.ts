/**
 * FeishuTestClient — self-contained Feishu API client for test simulation.
 *
 * No dependencies on src/ or extensions/ — all Feishu API calls are direct HTTP.
 * Token is cached locally in a JSON file to avoid re-authorization between runs.
 */

import fs from "node:fs";
import path from "node:path";

const FEISHU_BASE = "https://open.feishu.cn/open-apis";
const FEISHU_ACCOUNTS = "https://accounts.feishu.cn";

export type FeishuTestClientOptions = {
  appId: string;
  appSecret: string;
  userOpenId: string;
  /** Token cache directory (default: test/feishu-simulator/.token-cache) */
  tokenCacheDir?: string;
  replyTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Group chat ID — when set, messages are sent to this group instead of P2P */
  chatId?: string;
};

export type FeishuReplyMeta = {
  msgType: string;
  fileKey?: string;
  fileName?: string;
  imageKey?: string;
};

export type FeishuSendResult = {
  text: string;
  messageId: string;
  durationMs: number;
  reply: FeishuReplyMeta;
};

type StoredToken = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshExpiresAt: number;
  scope: string;
};

export class FeishuTestClient {
  private opts: FeishuTestClientOptions;
  private tenantToken: string | null = null;
  private userToken: string | null = null;
  private botOpenId: string | null = null;
  private botName: string | null = null;
  private p2pChatId: string | null = null;
  private groupChatId: string | null = null;
  private cacheDir: string;

  constructor(opts: FeishuTestClientOptions) {
    this.opts = opts;
    this.cacheDir =
      opts.tokenCacheDir ??
      path.resolve(
        new URL(".", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"),
        ".token-cache",
      );
  }

  async init(): Promise<void> {
    // 1. Get tenant access token (bot identity)
    this.tenantToken = await this.getTenantToken();

    // 2. Get bot info
    const botInfo = await this.feishu("GET", "/bot/v3/info", null, this.tenantToken);
    this.botOpenId = botInfo.bot?.open_id;
    if (!this.botOpenId) {
      throw new Error("Failed to get bot open_id");
    }
    this.botName = botInfo.bot?.app_name ?? "Bot";
    console.log(`  Bot: ${this.botName} (${this.botOpenId})`);

    // 3. Get or obtain user access token
    this.userToken = await this.loadOrAuthorize();

    // 4. Set up chat mode
    if (this.opts.chatId) {
      this.groupChatId = this.opts.chatId;
      console.log(`  Mode: Group chat (${this.groupChatId})`);
    } else {
      console.log(`  Mode: P2P (chat will be resolved on first send)`);
    }
  }

  async send(message: string, opts?: { mentionBot?: boolean }): Promise<FeishuSendResult> {
    if (!this.userToken || !this.botOpenId) {
      throw new Error("Client not initialized. Call init() first.");
    }

    // Proactively refresh token if it's about to expire within the next 5 minutes
    await this.ensureFreshUserToken();

    const isGroupMode = !!this.groupChatId;
    const activeChatId = isGroupMode ? this.groupChatId : this.p2pChatId;
    const startedAt = Date.now();

    // Get latest message before sending (if we already know the chat)
    const beforeMsgId = activeChatId ? await this.getLatestMessageId() : null;

    // Build message content — prepend @bot mention in group mode
    let content: string;
    if (isGroupMode && (opts?.mentionBot ?? true)) {
      content = JSON.stringify({
        text: `<at user_id="${this.botOpenId}">${this.botName}</at> ${message}`,
      });
    } else {
      content = JSON.stringify({ text: message });
    }

    // Send message — group mode uses chat_id, P2P uses bot's open_id
    const receiveIdType = isGroupMode ? "chat_id" : "open_id";
    const receiveId = isGroupMode ? this.groupChatId! : this.botOpenId;

    const sendRes = await this.withUserTokenRetry(() =>
      this.feishu(
        "POST",
        `/im/v1/messages?receive_id_type=${receiveIdType}`,
        {
          receive_id: receiveId,
          msg_type: "text",
          content,
        },
        this.userToken!,
      ),
    );

    const userMsgId = sendRes.message_id;
    if (!userMsgId) {
      throw new Error(`Send failed: ${JSON.stringify(sendRes)}`);
    }

    // Extract chat_id from send response (for P2P mode — group mode already has it)
    if (!isGroupMode && !this.p2pChatId && sendRes.chat_id) {
      this.p2pChatId = sendRes.chat_id;
      console.log(`  P2P chat: ${this.p2pChatId}`);
    }

    const chatIdForPoll = isGroupMode ? this.groupChatId! : this.p2pChatId;
    if (!chatIdForPoll) {
      throw new Error("Could not determine chat_id from send response");
    }

    // Poll for bot reply
    const timeoutMs = this.opts.replyTimeoutMs ?? 60_000;
    const pollMs = this.opts.pollIntervalMs ?? 1000;

    // When mentionBot is explicitly false in group mode, the bot is not expected to reply.
    // Use a shorter timeout and treat timeout as success (empty reply).
    const expectNoReply = isGroupMode && opts?.mentionBot === false;
    const effectiveTimeout = expectNoReply ? Math.min(timeoutMs, 15_000) : timeoutMs;

    try {
      const replyData = await this.waitForBotReply(
        userMsgId,
        beforeMsgId,
        effectiveTimeout,
        pollMs,
        chatIdForPoll,
      );
      return {
        text: replyData.text,
        messageId: userMsgId,
        durationMs: Date.now() - startedAt,
        reply: replyData.meta,
      };
    } catch (e) {
      if (expectNoReply && (e as Error).message.includes("Timeout")) {
        return {
          text: "",
          messageId: userMsgId,
          durationMs: Date.now() - startedAt,
          reply: { msgType: "none" },
        };
      }
      throw e;
    }
  }

  // ---------------------------------------------------------------------------
  // Feishu API helpers
  // ---------------------------------------------------------------------------

  private async feishu(
    method: string,
    endpoint: string,
    body: unknown,
    token: string,
  ): Promise<Record<string, any>> {
    const url = `${FEISHU_BASE}${endpoint}`;
    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json()) as Record<string, any>;
    if (json.code && json.code !== 0) {
      throw new Error(`Feishu API error [${endpoint}]: code=${json.code} msg=${json.msg}`);
    }
    return json.data ?? json;
  }

  /**
   * Proactively refresh the user token if it expires within the next 5 minutes.
   * Avoids mid-run failures from token expiration during long test runs.
   */
  private async ensureFreshUserToken(): Promise<void> {
    const cached = this.loadCachedToken();
    if (!cached) {
      return;
    }
    const refreshThresholdMs = 5 * 60 * 1000;
    if (cached.expiresAt > Date.now() + refreshThresholdMs) {
      return;
    }
    if (cached.refreshToken && (cached.refreshExpiresAt ?? 0) > Date.now()) {
      console.log(`  Token expiring soon, proactively refreshing...`);
      this.userToken = await this.refreshAccessToken(cached.refreshToken);
    }
  }

  /**
   * Wraps a user-token API call with auto-refresh on token expiration (code=99991677).
   * Refreshes the user token mid-run and retries once.
   */
  private async withUserTokenRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const msg = (e as Error).message;
      if (
        msg.includes("99991677") ||
        msg.includes("token expired") ||
        msg.includes("Authentication token expired")
      ) {
        console.log(`  User token expired mid-run, refreshing...`);
        const cached = this.loadCachedToken();
        if (cached?.refreshToken && (cached.refreshExpiresAt ?? 0) > Date.now()) {
          this.userToken = await this.refreshAccessToken(cached.refreshToken);
        } else {
          this.userToken = await this.authorize();
        }
        return await fn();
      }
      throw e;
    }
  }

  private async getTenantToken(): Promise<string> {
    const res = await fetch(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: this.opts.appId, app_secret: this.opts.appSecret }),
    });
    const json = (await res.json()) as Record<string, any>;
    if (json.code !== 0 || !json.tenant_access_token) {
      throw new Error(`Failed to get tenant token: ${json.msg ?? JSON.stringify(json)}`);
    }
    return json.tenant_access_token;
  }

  // ---------------------------------------------------------------------------
  // Token management
  // ---------------------------------------------------------------------------

  private get tokenCachePath(): string {
    return path.join(this.cacheDir, `${this.opts.appId}_${this.opts.userOpenId}.json`);
  }

  private loadCachedToken(): StoredToken | null {
    try {
      if (!fs.existsSync(this.tokenCachePath)) {
        return null;
      }
      return JSON.parse(fs.readFileSync(this.tokenCachePath, "utf-8")) as StoredToken;
    } catch {
      return null;
    }
  }

  private saveCachedToken(token: StoredToken): void {
    fs.mkdirSync(this.cacheDir, { recursive: true });
    fs.writeFileSync(this.tokenCachePath, JSON.stringify(token, null, 2), "utf-8");
  }

  private async loadOrAuthorize(): Promise<string> {
    const cached = this.loadCachedToken();
    if (cached) {
      // Access token still valid
      if (cached.expiresAt > Date.now()) {
        console.log(
          `  Using cached user token (expires: ${new Date(cached.expiresAt).toISOString()})`,
        );
        return cached.accessToken;
      }
      // Access token expired but refresh token still valid — auto refresh
      if (cached.refreshToken && (cached.refreshExpiresAt ?? 0) > Date.now()) {
        console.log(`  Access token expired, refreshing...`);
        return await this.refreshAccessToken(cached.refreshToken);
      }
    }

    console.log(`  No valid token found, initiating Device Flow authorization...`);
    return await this.authorize();
  }

  private async refreshAccessToken(refreshToken: string): Promise<string> {
    const res = await fetch(`${FEISHU_BASE}/authen/v2/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: this.opts.appId,
        client_secret: this.opts.appSecret,
      }).toString(),
    });
    const data = (await res.json()) as Record<string, any>;
    if (data.error || !data.access_token) {
      console.log(
        `  Refresh failed: ${data.error_description ?? data.error ?? data.msg}, falling back to Device Flow...`,
      );
      return await this.authorize();
    }
    const stored: StoredToken = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: Date.now() + (data.expires_in ?? 7200) * 1000,
      refreshExpiresAt: Date.now() + (data.refresh_token_expires_in ?? 604800) * 1000,
      scope: data.scope ?? "",
    };
    this.saveCachedToken(stored);
    console.log(`  Token refreshed (expires: ${new Date(stored.expiresAt).toISOString()})`);
    return stored.accessToken;
  }

  private async authorize(): Promise<string> {
    // Step 1: Request device code
    const basicAuth = Buffer.from(`${this.opts.appId}:${this.opts.appSecret}`).toString("base64");
    const authRes = await fetch(`${FEISHU_ACCOUNTS}/oauth/v1/device_authorization`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basicAuth}`,
      },
      body: new URLSearchParams({
        client_id: this.opts.appId,
        scope: "im:message im:message.send_as_user offline_access",
      }).toString(),
    });
    const authData = (await authRes.json()) as Record<string, any>;
    if (authData.error) {
      throw new Error(`Device auth failed: ${authData.error_description ?? authData.error}`);
    }

    const deviceCode = authData.device_code as string;
    const userCode = authData.user_code as string;
    const verifyUrl = authData.verification_uri_complete ?? authData.verification_uri;
    const expiresIn = (authData.expires_in as number) ?? 240;
    let interval = (authData.interval as number) ?? 5;

    console.log(`\n  ========================================`);
    console.log(`  Please authorize in your browser:`);
    console.log(`  ${verifyUrl}`);
    console.log(`  User code: ${userCode}`);
    console.log(`  Expires in: ${expiresIn}s`);
    console.log(`  ========================================\n`);

    // Step 2: Poll for token
    const deadline = Date.now() + expiresIn * 1000;
    while (Date.now() < deadline) {
      await sleep(interval * 1000);

      const tokenRes = await fetch(`${FEISHU_BASE}/authen/v2/oauth/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: deviceCode,
          client_id: this.opts.appId,
          client_secret: this.opts.appSecret,
        }).toString(),
      });
      const tokenData = (await tokenRes.json()) as Record<string, any>;
      console.log(`  Poll response: ${JSON.stringify(tokenData).slice(0, 500)}`);

      // Feishu v2 may wrap in { code, data: { access_token, ... } } or return flat
      const flat = tokenData.access_token ? tokenData : tokenData.data;
      const error =
        tokenData.error ?? (tokenData.code && tokenData.code !== 0 ? "api_error" : undefined);

      if (!error && flat?.access_token) {
        const now = Date.now();
        const stored: StoredToken = {
          accessToken: flat.access_token,
          refreshToken: flat.refresh_token ?? "",
          expiresAt: now + (flat.expires_in ?? 7200) * 1000,
          refreshExpiresAt: now + (flat.refresh_token_expires_in ?? 604800) * 1000,
          scope: flat.scope ?? "",
        };
        this.saveCachedToken(stored);
        console.log(`  Authorization successful! Token cached.`);
        return stored.accessToken;
      }

      const errCode = error ?? tokenData.msg ?? "";
      if (errCode === "authorization_pending" || String(tokenData.code) === "20018") {
        continue;
      }
      if (errCode === "slow_down") {
        interval += 5;
        continue;
      }
      if (errCode === "access_denied") {
        throw new Error("User denied authorization");
      }
      if (errCode === "expired_token") {
        throw new Error("Device code expired");
      }
      // Unknown but non-terminal — keep polling
      if (tokenData.code && tokenData.code !== 0) {
        continue;
      }
    }

    throw new Error("Authorization timed out");
  }

  // ---------------------------------------------------------------------------
  // Chat helpers
  // ---------------------------------------------------------------------------

  private async getLatestMessageId(): Promise<string | null> {
    const chatId = this.groupChatId ?? this.p2pChatId;
    if (!chatId) {
      return null;
    }
    try {
      const data = await this.feishu(
        "GET",
        `/im/v1/messages?container_id_type=chat&container_id=${chatId}&page_size=1&sort_type=ByCreateTimeDesc`,
        null,
        this.tenantToken!,
      );
      return data.items?.[0]?.message_id ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Wait for the bot's FINAL reply, not just the first interim message.
   *
   * Multi-step skills (e.g. orchestration) often produce several messages with the same
   * parent_id: an initial "正在处理…" message, then the final result. The naive approach
   * (return the first match) captures the interim message and misses the URL/confirmation
   * in the final one.
   *
   * Strategy:
   *   1. Poll until at least one matching reply (sender=app, parent_id=userMsgId) is found.
   *   2. After finding a candidate, enter a "quiet period": keep polling for `quietPeriodMs`
   *      additional time. If a NEWER matching reply appears, update the candidate and reset
   *      the quiet timer.
   *   3. If no new reply arrives within `quietPeriodMs`, return the latest candidate.
   *   4. Bound by overall `timeoutMs`. On hard timeout, return the latest candidate (if any)
   *      or throw.
   */
  private async waitForBotReply(
    userMsgId: string,
    beforeMsgId: string | null,
    timeoutMs: number,
    pollMs: number,
    chatId?: string,
  ): Promise<{ text: string; meta: FeishuReplyMeta }> {
    const pollChatId = chatId ?? this.groupChatId ?? this.p2pChatId;
    const deadline = Date.now() + timeoutMs;
    // Quiet period: how long to wait after the latest reply for any follow-up messages
    const quietPeriodMs = 3_000;

    let latestMsg: any = null;
    let latestSeenAt = 0;

    while (Date.now() < deadline) {
      await sleep(pollMs);

      try {
        const data = await this.feishu(
          "GET",
          `/im/v1/messages?container_id_type=chat&container_id=${pollChatId}&page_size=10&sort_type=ByCreateTimeDesc&card_msg_content_type=raw_card_content`,
          null,
          this.tenantToken!,
        );

        // Items are sorted desc (newest first). First match = newest bot reply for our msg.
        let foundThisRound: any = null;
        for (const msg of data.items ?? []) {
          if (msg.message_id === userMsgId) {
            continue;
          }
          if (beforeMsgId && msg.message_id === beforeMsgId) {
            break;
          }
          if (msg.sender?.sender_type === "app" && msg.parent_id === userMsgId) {
            foundThisRound = msg;
            break;
          }
        }

        if (foundThisRound) {
          // Streaming card — keep polling, don't enter quiet period yet
          if (foundThisRound.msg_type === "interactive" && this.isCardStreaming(foundThisRound)) {
            continue;
          }

          // New (or first) candidate — update and reset quiet timer
          if (!latestMsg || latestMsg.message_id !== foundThisRound.message_id) {
            latestMsg = foundThisRound;
            latestSeenAt = Date.now();
            continue;
          }

          // Same as last seen — check whether quiet period has elapsed
          if (Date.now() - latestSeenAt >= quietPeriodMs) {
            return this.extractReply(latestMsg);
          }
        }
      } catch {
        // keep polling
      }
    }

    // Hard timeout — if we have a candidate, return it; else throw
    if (latestMsg) {
      return this.extractReply(latestMsg);
    }
    throw new Error(`Timeout (${timeoutMs}ms) waiting for bot reply`);
  }

  private isCardStreaming(msg: any): boolean {
    try {
      const content = JSON.parse(msg.body?.content ?? "{}");
      if (content.json_card) {
        const card =
          typeof content.json_card === "string" ? JSON.parse(content.json_card) : content.json_card;
        return card.config?.streamingMode === true;
      }
    } catch {
      /* not streaming */
    }
    return false;
  }

  private extractCardText(card: any): string {
    // CardKit v2 raw_card_content: json_card contains the card JSON string
    if (card.json_card) {
      try {
        const parsed =
          typeof card.json_card === "string" ? JSON.parse(card.json_card) : card.json_card;
        // Prefer summary — it's the plain-text digest the card builder already computed
        const summary = parsed.config?.summary?.content;
        if (summary) {
          return summary;
        }
        // Fallback: walk plain_text elements
        return this.walkCardElements(parsed);
      } catch {
        /* fall through */
      }
    }
    // Legacy card format
    return this.walkCardElements(card);
  }

  private walkCardElements(node: any): string {
    const parts: string[] = [];
    const walk = (n: any) => {
      if (!n) {
        return;
      }
      if (typeof n === "string") {
        return;
      }
      if (n.tag === "plain_text" && n.property?.content) {
        parts.push(n.property.content);
      }
      if (n.tag === "markdown" && n.content) {
        parts.push(n.content);
      }
      if (n.tag === "div" && n.text?.content) {
        parts.push(n.text.content);
      }
      if (Array.isArray(n.property?.elements)) {
        n.property.elements.forEach(walk);
      }
      if (Array.isArray(n.elements)) {
        n.elements.forEach(walk);
      }
      if (Array.isArray(n)) {
        n.forEach(walk);
      }
    };
    walk(node.body ?? node);
    return parts.join("").trim();
  }

  private extractReply(msg: { msg_type?: string; body?: { content?: string } }): {
    text: string;
    meta: FeishuReplyMeta;
  } {
    const msgType = msg.msg_type ?? "unknown";
    const meta: FeishuReplyMeta = { msgType };

    if (!msg.body?.content) {
      return { text: "", meta };
    }
    try {
      const content = JSON.parse(msg.body.content);

      if (msgType === "text") {
        return { text: content.text ?? "", meta };
      }

      if (msgType === "post") {
        const locale = content.zh_cn ?? content.en_us ?? Object.values(content)[0];
        if (!locale?.content) {
          return { text: msg.body.content, meta };
        }
        const parts: string[] = [];
        for (const para of locale.content) {
          for (const el of para) {
            if (el.text) {
              parts.push(el.text);
            }
          }
        }
        return { text: parts.join("\n").trim(), meta };
      }

      if (msgType === "interactive") {
        return { text: this.extractCardText(content), meta };
      }

      if (msgType === "file") {
        meta.fileKey = content.file_key ?? "";
        meta.fileName = content.file_name ?? "";
        return { text: content.file_name ?? "", meta };
      }

      if (msgType === "image") {
        meta.imageKey = content.image_key ?? "";
        return { text: "", meta };
      }

      if (msgType === "audio") {
        return { text: "", meta };
      }

      if (msgType === "media") {
        meta.fileKey = content.file_key ?? "";
        meta.fileName = content.file_name ?? "";
        meta.imageKey = content.image_key ?? "";
        return { text: content.file_name ?? "", meta };
      }

      return { text: msg.body.content, meta };
    } catch {
      return { text: msg.body.content ?? "", meta };
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
