/**
 * Customer Service Feishu notification — send card to boss chat via raw API.
 *
 * 客服飞书通知 — 通过原生 API 发送卡片到指定群聊。
 * Uses plain fetch (no dependency on openclaw-lark plugin).
 * 使用原生 fetch（不依赖 openclaw-lark 插件）。
 *
 * S1: one-way notification only. S3 adds interactive cards.
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("cs-feishu-notify");

// -- Token cache (shared with feishu-user-resolve.ts pattern) --
type TokenEntry = { token: string; expiresAt: number };
const tokenCache = new Map<string, TokenEntry>();

async function getTenantAccessToken(appId: string, appSecret: string): Promise<string | null> {
  const key = appId;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  try {
    const res = await fetch(
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      },
    );
    const data = (await res.json()) as {
      code?: number;
      tenant_access_token?: string;
      expire?: number;
    };
    if (data.code !== 0 || !data.tenant_access_token) {
      log.warn(`failed to get tenant_access_token: code=${data.code}`);
      return null;
    }
    const expiresAt = Date.now() + ((data.expire ?? 7200) - 30) * 1000;
    tokenCache.set(key, { token: data.tenant_access_token, expiresAt });
    return data.tenant_access_token;
  } catch (err) {
    log.warn(`tenant_access_token request failed: ${String(err)}`);
    return null;
  }
}

/**
 * Build a simple Markdown interactive card (CardKit v2 format).
 *
 * 构建简单的 Markdown 交互卡片。
 */
function buildNotificationCard(params: {
  customerMessage: string;
  aiReply: string;
  sessionId: string;
  visitorName?: string;
  channel?: string;
}): Record<string, unknown> {
  const { customerMessage, aiReply, sessionId, visitorName, channel } = params;

  const visitorLabel = visitorName ?? "匿名访客";
  const truncMsg =
    customerMessage.length > 200 ? customerMessage.slice(0, 200) + "..." : customerMessage;
  const truncReply = aiReply.length > 300 ? aiReply.slice(0, 300) + "..." : aiReply;
  const channelLabel = channel && channel !== "web_widget" ? ` · 渠道: ${channel}` : "";

  const cardText = [
    `**🔔 新客服消息**`,
    ``,
    `**客户** (${visitorLabel}${channelLabel}):`,
    truncMsg,
    ``,
    `**AI 回复**:`,
    truncReply,
    ``,
    `---`,
    `会话 ID: \`${sessionId.slice(0, 8)}...\``,
  ].join("\n");

  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "🤖 AI 客服通知" },
      template: "blue",
    },
    body: {
      elements: [{ tag: "markdown", content: cardText }],
    },
  };
}

/**
 * Send a CS notification card to the configured Feishu group chat.
 *
 * 向配置的飞书群聊发送客服通知卡片。
 */
export async function sendCSNotification(params: {
  appId: string;
  appSecret: string;
  chatId: string;
  customerMessage: string;
  aiReply: string;
  sessionId: string;
  visitorName?: string;
  channel?: string;
}): Promise<void> {
  const { appId, appSecret, chatId, customerMessage, aiReply, sessionId, visitorName, channel } =
    params;

  const token = await getTenantAccessToken(appId, appSecret);
  if (!token) {
    log.error("cannot send cs notification: no tenant_access_token");
    return;
  }

  const card = buildNotificationCard({ customerMessage, aiReply, sessionId, visitorName, channel });

  try {
    const res = await fetch(
      "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          receive_id: chatId,
          msg_type: "interactive",
          content: JSON.stringify(card),
        }),
      },
    );
    const data = (await res.json()) as { code?: number; msg?: string };
    if (data.code !== 0) {
      log.error(`feishu send card failed: code=${data.code} msg=${data.msg}`);
      return;
    }
    log.info(`sent cs notification to chat ${chatId} for session ${sessionId}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`failed to send cs notification: ${message}`);
    throw err;
  }
}
