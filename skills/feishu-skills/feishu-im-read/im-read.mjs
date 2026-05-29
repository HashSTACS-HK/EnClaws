/**
 * feishu-im-read: Read Feishu IM messages.
 * - get_messages:    uses tenant_access_token (app-level, reads group/p2p history)
 * - search_messages: uses user_access_token  (user-level, searches across chats)
 *
 * Usage:
 *   node im-read.mjs --action <action> --open-id <open_id> [options]
 *
 * Output: single-line JSON
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { getTenantAccessToken } from "../feishu-auth/send-card.mjs";
import { getConfig, getValidToken } from "../feishu-auth/token-utils.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const argv = process.argv.slice(2);
  const r = {
    action: null,
    openId: null,
    chatId: null,
    targetOpenId: null,
    query: null,
    pageSize: 20,
    pageToken: null,
    sortRule: "create_time_desc",
    startTime: null,
    endTime: null,
    relativeTime: null,
    threadId: null,
    senderIds: null,
    mentionIds: null,
    messageType: null,
    senderType: null,
    chatType: null,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--action":
        r.action = argv[++i];
        break;
      case "--open-id":
        r.openId = argv[++i];
        break;
      case "--chat-id":
        r.chatId = argv[++i];
        break;
      case "--target-open-id":
        r.targetOpenId = argv[++i];
        break;
      case "--query":
        r.query = argv[++i];
        break;
      case "--page-size":
        r.pageSize = parseInt(argv[++i], 10);
        break;
      case "--page-token":
        r.pageToken = argv[++i];
        break;
      case "--sort-rule":
        r.sortRule = argv[++i];
        break;
      case "--start-time":
        r.startTime = argv[++i];
        break;
      case "--end-time":
        r.endTime = argv[++i];
        break;
      case "--relative-time":
        r.relativeTime = argv[++i];
        break;
      case "--thread-id":
        r.threadId = argv[++i];
        break;
      case "--sender-ids":
        r.senderIds = argv[++i];
        break;
      case "--mention-ids":
        r.mentionIds = argv[++i];
        break;
      case "--message-type":
        r.messageType = argv[++i];
        break;
      case "--sender-type":
        r.senderType = argv[++i];
        break;
      case "--chat-type":
        r.chatType = argv[++i];
        break;
    }
  }
  return r;
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
function die(obj) {
  out(obj);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

function parseRelativeTime(rel) {
  const now = Date.now();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const ms = todayStart.getTime();
  const DAY = 86400000;
  switch (rel) {
    case "today":
      return { start: ms, end: now };
    case "yesterday":
      return { start: ms - DAY, end: ms };
    case "last_3_days":
      return { start: ms - 3 * DAY, end: now };
    case "this_week": {
      const d = todayStart.getDay() || 7;
      return { start: ms - (d - 1) * DAY, end: now };
    }
    case "last_week": {
      const d = todayStart.getDay() || 7;
      const thisWeekStart = ms - (d - 1) * DAY;
      return { start: thisWeekStart - 7 * DAY, end: thisWeekStart };
    }
    case "last_month":
      return { start: ms - 30 * DAY, end: now };
    default:
      return { start: ms - 7 * DAY, end: now };
  }
}

function toSeconds(ms) {
  return String(Math.floor(ms / 1000));
}

function resolveTimeRange(args) {
  if (args.relativeTime) {
    const { start, end } = parseRelativeTime(args.relativeTime);
    return { start_time: toSeconds(start), end_time: toSeconds(end) };
  }
  if (args.startTime || args.endTime) {
    return {
      start_time: args.startTime ? toSeconds(new Date(args.startTime).getTime()) : undefined,
      end_time: args.endTime ? toSeconds(new Date(args.endTime).getTime()) : undefined,
    };
  }
  return {};
}

// ---------------------------------------------------------------------------
// Feishu API
// ---------------------------------------------------------------------------

async function apiCall(method, urlPath, token, body, query) {
  let url = `https://open.feishu.cn/open-apis${urlPath}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) {
        if (Array.isArray(v)) v.forEach((item) => params.append(k, item));
        else params.set(k, String(v));
      }
    }
    const qs = params.toString();
    if (qs) url += (url.includes("?") ? "&" : "?") + qs;
  }
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`API returned non-JSON (HTTP ${res.status}): ${text.substring(0, 200)}`);
  }
}

async function resolveP2PChatId(openId, token) {
  const data = await apiCall("POST", "/im/v1/chats/p2p", token, {
    id_type: "open_id",
    id: openId,
  });
  if (data.code !== 0) {
    const batchData = await apiCall(
      "POST",
      "/im/v1/chat_p2p/batch_query",
      token,
      {
        user_ids: [openId],
      },
      { user_id_type: "open_id" },
    );
    if (batchData.code === 0 && batchData.data?.items?.length > 0) {
      return batchData.data.items[0].chat_id;
    }
    return null;
  }
  return data.data?.chat_id;
}

function formatMessage(msg) {
  let content = "";
  try {
    const parsed = JSON.parse(msg.body?.content || "{}");
    content = parsed.text || parsed.content || msg.body?.content || "";
  } catch {
    content = msg.body?.content || "";
  }
  return {
    message_id: msg.message_id,
    msg_type: msg.msg_type,
    content,
    sender_id: msg.sender?.id,
    sender_type: msg.sender?.sender_type,
    create_time: msg.create_time,
    thread_id: msg.thread_id,
  };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function getMessages(args, token) {
  let chatId = args.chatId;

  if (!chatId && args.targetOpenId) {
    chatId = await resolveP2PChatId(args.targetOpenId, token);
    if (!chatId)
      die({ error: "resolve_failed", message: `无法解析用户 ${args.targetOpenId} 的会话 ID` });
  }
  if (!chatId) die({ error: "missing_param", message: "需要 --chat-id 或 --target-open-id 参数" });

  const timeRange = resolveTimeRange(args);
  const containerType = args.threadId ? "thread" : "chat";
  const containerId = args.threadId || chatId;

  const query = {
    container_id_type: containerType,
    container_id: containerId,
    sort_type: args.sortRule === "create_time_asc" ? "ByCreateTimeAsc" : "ByCreateTimeDesc",
    page_size: String(Math.min(args.pageSize, 50)),
  };
  if (timeRange.start_time) query.start_time = timeRange.start_time;
  if (timeRange.end_time) query.end_time = timeRange.end_time;
  if (args.pageToken) query.page_token = args.pageToken;

  const data = await apiCall("GET", "/im/v1/messages", token, null, query);
  if (data.code !== 0) throw new Error(`Get messages failed: code=${data.code} msg=${data.msg}`);

  const messages = (data.data?.items || []).map(formatMessage);
  out({
    messages,
    has_more: data.data?.has_more || false,
    page_token: data.data?.page_token || null,
    reply: `获取到 ${messages.length} 条消息`,
  });
}

async function searchMessages(args, token) {
  if (!args.query) die({ error: "missing_param", message: "--query 参数必填" });

  const timeRange = resolveTimeRange(args);
  const searchBody = { query: args.query };
  if (timeRange.start_time) searchBody.start_time = timeRange.start_time;
  if (timeRange.end_time) searchBody.end_time = timeRange.end_time;
  if (args.senderIds) searchBody.from_ids = args.senderIds.split(",").map((s) => s.trim());
  if (args.chatId) searchBody.chat_ids = [args.chatId];
  if (args.mentionIds) searchBody.at_chatter_ids = args.mentionIds.split(",").map((s) => s.trim());
  if (args.messageType) searchBody.message_type = args.messageType;
  if (args.senderType) searchBody.from_type = args.senderType;
  if (args.chatType) searchBody.chat_type = args.chatType === "group" ? "group_chat" : "p2p_chat";

  const query = {
    user_id_type: "open_id",
    page_size: String(Math.min(args.pageSize, 50)),
  };
  if (args.pageToken) query.page_token = args.pageToken;

  const data = await apiCall("POST", "/search/v2/message", token, searchBody, query);
  if (data.code !== 0) throw new Error(`Search messages failed: code=${data.code} msg=${data.msg}`);

  const messages = (data.data?.items || []).map(formatMessage);
  out({
    messages,
    has_more: data.data?.has_more || false,
    page_token: data.data?.page_token || null,
    reply: `搜索到 ${messages.length} 条消息`,
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs();
  if (!args.openId) die({ error: "missing_param", message: "--open-id 参数必填" });
  if (!args.action)
    die({ error: "missing_param", message: "--action 参数必填 (get_messages | search_messages)" });

  let cfg;
  try {
    cfg = getConfig(__dirname);
  } catch (err) {
    die({ error: "config_error", message: err.message });
  }

  try {
    if (args.action === "get_messages") {
      const tenantToken = await getTenantAccessToken(cfg.appId, cfg.appSecret);
      await getMessages(args, tenantToken);
    } else if (args.action === "search_messages") {
      const accessToken = await getValidToken(args.openId, cfg.appId, cfg.appSecret);
      if (!accessToken) {
        die({
          error: "auth_required",
          message:
            "用户未完成飞书授权或授权已过期。请调用 feishu-auth skill 完成授权后重试。\n" +
            `用户 open_id: ${args.openId}`,
        });
      }
      await searchMessages(args, accessToken);
    } else {
      die({ error: "invalid_action", message: `未知操作: ${args.action}` });
    }
  } catch (err) {
    const msg = err.message || "";
    if (msg.includes("99991663")) {
      die({ error: "auth_required", message: "飞书 token 已失效，请重新授权" });
    }
    if (msg.includes("99991400")) {
      die({ error: "rate_limited", message: msg || "请求频率超限，请稍后重试" });
    }
    if (
      msg.includes("99991672") ||
      msg.includes("99991679") ||
      /permission|scope|not support|tenant/i.test(msg)
    ) {
      die({
        error: "permission_required",
        message: msg,
        required_scopes: ["im:message", "im:message:readonly", "im:message.group_msg"],
        auth_type: "tenant",
        reply:
          "⚠️ **读取群消息需要应用级权限（需要管理员操作）**\n\n需要开通的权限：`im:message` 和 `im:message.group_msg`",
      });
    }
    die({ error: "api_error", message: msg });
  }
}

main();
