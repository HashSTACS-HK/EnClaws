"use strict";
/**
 * feishu-auth/send-card.js — Public card sending module for all Feishu skills.
 *
 * Provides:
 *   - buildCard()    — Build Card 1.0 JSON from title/body/button params
 *   - sendCard()     — Send card to user with 3-level fallback (card → text → reply)
 *   - updateCard()   — PATCH-update an existing card message
 *
 * Usage (require):
 *   const { sendCard, updateCard } = require('../feishu-auth/send-card.js');
 *   const result = await sendCard({ openId, body: '**Hello**', title: 'Title' });
 *
 * Usage (CLI):
 *   node send-card.js --open-id "ou_xxx" --body "**Hello**" [--title "Title"]
 *                     [--chat-id "oc_yyy"] [--button-text "Click"] [--button-url "https://..."]
 *                     [--color blue]
 *
 * All output is single-line JSON.
 */

const path = require("path");
const { getConfig } = require(path.join(__dirname, "./token-utils.js"));

// ---------------------------------------------------------------------------
// Low-level Feishu IM API
// ---------------------------------------------------------------------------

async function getTenantAccessToken(appId, appSecret) {
  const res = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const json = await res.json();
  if (json.code !== 0) {
    throw new Error(`Failed to get tenant_access_token: ${json.msg}`);
  }
  return json.tenant_access_token;
}

async function sendFeishuMessage(tenantToken, receiveIdType, receiveId, cardContent, rawOverride) {
  const payload = rawOverride
    ? { receive_id: receiveId, ...rawOverride }
    : { receive_id: receiveId, msg_type: "interactive", content: JSON.stringify(cardContent) };
  const res = await fetch(
    `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tenantToken}`,
      },
      body: JSON.stringify(payload),
    },
  );
  return res.json();
}

async function updateFeishuMessage(tenantToken, messageId, cardContent) {
  const res = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tenantToken}`,
    },
    body: JSON.stringify({ content: JSON.stringify(cardContent) }),
  });
  return res.json();
}

// ---------------------------------------------------------------------------
// Card builder (Card 1.0 format — compatible with PATCH updates)
// ---------------------------------------------------------------------------

function buildCard({ title, body, buttonText, buttonUrl, color }) {
  const elements = [];
  if (body) elements.push({ tag: "markdown", content: body });
  if (buttonUrl) {
    elements.push({
      tag: "action",
      actions: [
        {
          tag: "button",
          text: { tag: "plain_text", content: buttonText || "点击打开" },
          type: "primary",
          url: buttonUrl,
        },
      ],
    });
  }
  const card = { config: { wide_screen_mode: true }, elements };
  if (title) {
    card.header = {
      title: { tag: "plain_text", content: title },
      template: color || "blue",
    };
  }
  return card;
}

// ---------------------------------------------------------------------------
// High-level: sendCard (build → send → fallback)
// ---------------------------------------------------------------------------

async function sendCard({
  openId,
  chatId,
  title,
  body,
  buttonText,
  buttonUrl,
  color,
  fallbackText,
}) {
  if (!openId) throw new Error("sendCard: openId is required");
  if (!body) throw new Error("sendCard: body is required");

  const cfg = getConfig(__dirname);
  const resolvedChatId = chatId || process.env.ENCLAWS_CHAT_ID || null;
  const receiveIdType = resolvedChatId ? "chat_id" : "open_id";
  const receiveId = resolvedChatId || openId;

  let tenantToken;
  try {
    tenantToken = await getTenantAccessToken(cfg.appId, cfg.appSecret);
  } catch (err) {
    return {
      success: false,
      error: err.message,
      reply: body + (buttonUrl ? `\n${buttonUrl}` : ""),
    };
  }

  // Level 1: interactive card
  try {
    const card = buildCard({ title, body, buttonText, buttonUrl, color });
    const result = await sendFeishuMessage(tenantToken, receiveIdType, receiveId, card);
    if (result.code === 0) {
      return { success: true, message_id: result.data?.message_id };
    }
    process.stderr.write(`[send-card] card failed: code=${result.code} msg=${result.msg}\n`);
  } catch (err) {
    process.stderr.write(`[send-card] card error: ${err.message}\n`);
  }

  // Level 2: plain text fallback
  const text = fallbackText || body + (buttonUrl ? `\n${buttonUrl}` : "");
  try {
    const result = await sendFeishuMessage(tenantToken, receiveIdType, receiveId, null, {
      msg_type: "text",
      content: JSON.stringify({ text }),
    });
    if (result.code === 0) {
      return { success: true, message_id: result.data?.message_id, fallback: true };
    }
    process.stderr.write(
      `[send-card] text fallback failed: code=${result.code} msg=${result.msg}\n`,
    );
  } catch (err) {
    process.stderr.write(`[send-card] text fallback error: ${err.message}\n`);
  }

  // Level 3: return reply for Agent to display manually
  return { success: false, error: "all send methods failed", reply: text };
}

// ---------------------------------------------------------------------------
// High-level: updateCard (build → PATCH)
// ---------------------------------------------------------------------------

async function updateCard({ messageId, title, body, buttonText, buttonUrl, color }) {
  if (!messageId) throw new Error("updateCard: messageId is required");
  if (!body) throw new Error("updateCard: body is required");

  const cfg = getConfig(__dirname);
  try {
    const tenantToken = await getTenantAccessToken(cfg.appId, cfg.appSecret);
    const card = buildCard({ title, body, buttonText, buttonUrl, color });
    const result = await updateFeishuMessage(tenantToken, messageId, card);
    if (result.code === 0) {
      return { success: true };
    }
    return { success: false, error: `code=${result.code} msg=${result.msg}` };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

module.exports = {
  buildCard,
  sendCard,
  updateCard,
  getTenantAccessToken,
  sendFeishuMessage,
  updateFeishuMessage,
};

// ---------------------------------------------------------------------------
// CLI mode (only when run directly: node send-card.js --open-id ...)
// ---------------------------------------------------------------------------

if (require.main === module) {
  const argv = process.argv.slice(2);
  function getArg(name) {
    const i = argv.indexOf(name);
    return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : null;
  }

  const openId = getArg("--open-id");
  const body = getArg("--body");

  if (!openId || !body) {
    console.log(
      JSON.stringify({
        error: "usage",
        message:
          "Required: --open-id <id> --body <text>. Optional: --chat-id, --title, --button-text, --button-url, --color",
      }),
    );
    process.exit(1);
  }

  sendCard({
    openId,
    chatId: getArg("--chat-id"),
    title: getArg("--title"),
    body,
    buttonText: getArg("--button-text"),
    buttonUrl: getArg("--button-url"),
    color: getArg("--color"),
    fallbackText: getArg("--fallback-text"),
  })
    .then((result) => {
      console.log(JSON.stringify(result));
      process.exit(result.success ? 0 : 1);
    })
    .catch((err) => {
      console.log(JSON.stringify({ success: false, error: err.message }));
      process.exit(1);
    });
}
