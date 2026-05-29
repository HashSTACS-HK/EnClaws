"use strict";
/**
 * feishu-chat: Search Feishu group chats, get chat details, list members (user OAuth).
 *
 * Usage:
 *   node chat.js --open-id <open_id> --action search --query "关键词"
 *   node chat.js --open-id <open_id> --action get --chat-id "oc_xxx"
 *   node chat.js --open-id <open_id> --action list_members --chat-id "oc_xxx"
 */

const path = require("path");
const { getConfig, getValidToken } = require(path.join(__dirname, "../feishu-auth/token-utils.js"));

const CHAT_SECURITY_HEADER = { "X-Chat-Custom-Header": "enable_chat_list_security_check" };

function parseArgs() {
  const argv = process.argv.slice(2);
  const r = {
    openId: null,
    action: null,
    query: null,
    chatId: null,
    pageSize: 20,
    pageToken: null,
    userIdType: "open_id",
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--open-id":
        r.openId = argv[++i];
        break;
      case "--action":
        r.action = argv[++i];
        break;
      case "--query":
        r.query = argv[++i];
        break;
      case "--chat-id":
        r.chatId = argv[++i];
        break;
      case "--page-size":
        r.pageSize = parseInt(argv[++i], 10) || 20;
        break;
      case "--page-token":
        r.pageToken = argv[++i];
        break;
      case "--user-id-type":
        r.userIdType = argv[++i] || "open_id";
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

function buildQuery(params) {
  const q = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") q[k] = v;
  }
  return q;
}

async function apiCall(method, urlPath, token, { query, headers } = {}) {
  let url = `https://open.feishu.cn/open-apis${urlPath}`;
  if (query && Object.keys(query).length > 0) {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])),
    ).toString();
    url += (url.includes("?") ? "&" : "?") + qs;
  }
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(headers || {}),
    },
  });
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`Feishu API parse error: ${res.status}`);
  }
  return data;
}

function isBotMember(m) {
  if (!m || typeof m !== "object") return false;
  if (m.is_bot === true || m.is_bot === "true") return true;
  const idType = String(m.member_id_type || m.member_type || m.type || "").toLowerCase();
  if (idType.includes("bot") || idType === "app_id" || idType === "open_app_id") return true;
  if (m.sender_type === "app" || m.member_type === "app") return true;
  return false;
}

function throwApiError(label, data) {
  const err = new Error(`${label}: code=${data.code} msg=${data.msg}`);
  err.apiData = data;
  throw err;
}

async function actionSearch(args, token) {
  if (!args.query || !args.query.trim()) {
    die({ error: "missing_param", message: "--query 参数必填" });
  }
  const pageSize = Math.min(Math.max(1, args.pageSize), 100);
  const query = buildQuery({
    query: args.query.trim(),
    page_size: pageSize,
    page_token: args.pageToken,
    user_id_type: args.userIdType,
  });
  const data = await apiCall("GET", "/im/v1/chats/search", token, { query });
  if (data.code !== 0) {
    throwApiError("Chat search failed", data);
  }
  const items = data.data?.items || [];
  out({
    action: "search",
    items,
    has_more: data.data?.has_more || false,
    page_token: data.data?.page_token || null,
    reply: `找到 ${items.length} 个相关群组。`,
  });
}

async function actionGet(args, token) {
  if (!args.chatId) {
    die({ error: "missing_param", message: "--chat-id 参数必填" });
  }
  const query = buildQuery({ user_id_type: args.userIdType });
  const data = await apiCall("GET", `/im/v1/chats/${encodeURIComponent(args.chatId)}`, token, {
    query,
    headers: CHAT_SECURITY_HEADER,
  });
  if (data.code !== 0) {
    throwApiError("Get chat failed", data);
  }
  const chat = data.data || {};
  out({
    action: "get",
    chat,
    reply: chat.name ? `群组：${chat.name}` : "已获取群组详情。",
  });
}

async function actionListMembers(args, token) {
  if (!args.chatId) {
    die({ error: "missing_param", message: "--chat-id 参数必填" });
  }
  const pageSize = Math.min(Math.max(1, args.pageSize), 100);
  const query = buildQuery({
    page_size: pageSize,
    page_token: args.pageToken,
    member_id_type: args.userIdType,
  });
  const data = await apiCall(
    "GET",
    `/im/v1/chats/${encodeURIComponent(args.chatId)}/members`,
    token,
    { query, headers: CHAT_SECURITY_HEADER },
  );
  if (data.code !== 0) {
    throwApiError("List members failed", data);
  }
  const raw = data.data?.items || [];
  const items = raw.filter((m) => !isBotMember(m));
  const botFiltered = raw.length - items.length;
  const reply =
    botFiltered > 0
      ? `本页共 ${items.length} 名成员（已排除机器人 ${botFiltered} 个）。`
      : `本页共 ${items.length} 名成员。`;
  out({
    action: "list_members",
    items,
    member_total: data.data?.member_total,
    has_more: data.data?.has_more || false,
    page_token: data.data?.page_token || null,
    filtered_bot_count: botFiltered,
    reply,
  });
}

function requiredScopesForAction(action) {
  if (action === "list_members") {
    return ["im:chat:readonly", "im:chat.members:read"];
  }
  return ["im:chat:readonly"];
}

async function main() {
  const args = parseArgs();
  if (!args.openId) die({ error: "missing_param", message: "--open-id 参数必填" });
  if (!args.action) {
    die({ error: "missing_param", message: "--action 参数必填（search | get | list_members）" });
  }

  let cfg;
  try {
    cfg = getConfig(__dirname);
  } catch (err) {
    die({ error: "config_error", message: err.message });
  }

  let accessToken;
  try {
    accessToken = await getValidToken(args.openId, cfg.appId, cfg.appSecret);
  } catch (err) {
    die({ error: "token_error", message: err.message });
  }
  if (!accessToken) {
    die({
      error: "auth_required",
      required_scopes: requiredScopesForAction(args.action),
      message:
        "用户未完成飞书授权或授权已过期。请调用 feishu-auth skill 完成授权后重试。\n" +
        `用户 open_id: ${args.openId}`,
    });
  }

  try {
    switch (args.action) {
      case "search":
        await actionSearch(args, accessToken);
        break;
      case "get":
        await actionGet(args, accessToken);
        break;
      case "list_members":
        await actionListMembers(args, accessToken);
        break;
      default:
        die({
          error: "unsupported_action",
          message: `未知 action: ${args.action}。支持: search, get, list_members`,
        });
    }
  } catch (err) {
    const msg = err.message || "";
    if (msg.includes("99991663")) {
      die({ error: "auth_required", message: "飞书 token 已失效，请重新授权（调用 feishu-auth）" });
    }
    if (msg.includes("99991400")) {
      die({ error: "rate_limited", message: msg || "请求频率超限，请稍后重试" });
    }
    if (
      msg.includes("99991672") ||
      msg.includes("99991679") ||
      /permission|scope|not support|tenant/i.test(msg)
    ) {
      const apiData = err.apiData || {};
      const isTenant =
        apiData.auth_type === "tenant" || (apiData.data && apiData.data.auth_type === "tenant");
      if (isTenant) {
        die({
          error: "permission_required",
          auth_type: "tenant",
          message: msg,
          reply: `⚠️ **应用权限不足，需要管理员在飞书开发者后台为应用开通以下权限：** ${requiredScopesForAction(args.action).join("、")}`,
        });
      }
      die({
        error: "permission_required",
        message: msg,
        required_scopes: requiredScopesForAction(args.action),
        reply: "⚠️ **权限不足，需要重新授权以获取 IM 群组相关权限。**",
      });
    }
    die({ error: "api_error", message: msg });
  }
}

main();
