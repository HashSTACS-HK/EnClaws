"use strict";
/**
 * feishu-search-user: Search or get Feishu user info.
 *
 * Actions:
 *   search   (default) Search users by keyword (name / phone / email)
 *   get_me   Get current user's own profile
 *   get      Get a specific user's profile by user_id
 *
 * Usage:
 *   node search-user.js --open-id <open_id> --query <keyword> [--page-size N] [--page-token TOKEN]
 *   node search-user.js --open-id <open_id> --action get_me
 *   node search-user.js --open-id <open_id> --action get --user-id <ou_xxx> [--user-id-type open_id|union_id|user_id]
 *
 * Output: single-line JSON
 *   search  : {"users":[...],"has_more":false,"page_token":null,"reply":"..."}
 *   get_me  : {"user":{...},"reply":"..."}
 *   get     : {"user":{...},"reply":"..."}
 *   Auth    : {"error":"auth_required","message":"..."}
 *   Error   : {"error":"api_error","message":"..."}
 */

const path = require("path");
const { getConfig, getValidToken } = require(path.join(__dirname, "../feishu-auth/token-utils.js"));

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const argv = process.argv.slice(2);
  const r = {
    openId: null,
    action: "search",
    query: null,
    pageSize: 20,
    pageToken: null,
    userId: null,
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
      case "--page-size":
        r.pageSize = parseInt(argv[++i], 10);
        break;
      case "--page-token":
        r.pageToken = argv[++i];
        break;
      case "--user-id":
        r.userId = argv[++i];
        break;
      case "--user-id-type":
        r.userIdType = argv[++i];
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
// Feishu API
// ---------------------------------------------------------------------------

async function apiCall(method, urlPath, token, body, query) {
  let url = `https://open.feishu.cn/open-apis${urlPath}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) params.set(k, String(v));
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

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function getMe(token) {
  const data = await apiCall("GET", "/authen/v1/user_info", token, null, null);
  if (data.code !== 0) {
    throw new Error(`code=${data.code} msg=${data.msg}`);
  }
  const u = data.data || {};
  const user = {
    open_id: u.open_id,
    union_id: u.union_id,
    name: u.name,
    en_name: u.en_name,
    email: u.email,
    mobile: u.mobile,
    avatar: u.avatar_url,
  };
  out({ user, reply: `当前用户：${user.name}（${user.open_id}）` });
}

async function getUser(args, token) {
  const data = await apiCall(
    "GET",
    `/contact/v3/users/${encodeURIComponent(args.userId)}`,
    token,
    null,
    { user_id_type: args.userIdType },
  );
  if (data.code !== 0) {
    if (data.code === 41050) {
      die({
        error: "permission_required",
        message: "无权限查询该用户信息。该用户不在当前用户的组织架构可见范围内。",
        auth_type: "tenant",
        reply: "**权限不足：该用户不在您的组织架构可见范围内，无法查询其信息。**",
      });
    }
    throw new Error(`code=${data.code} msg=${data.msg}`);
  }
  const u = data.data?.user || {};
  const user = {
    open_id: u.open_id,
    union_id: u.union_id,
    user_id: u.user_id,
    name: u.name,
    en_name: u.en_name,
    email: u.email,
    mobile: u.mobile,
    department_ids: u.department_ids,
    avatar: u.avatar?.avatar_72,
  };
  out({ user, reply: `用户信息：${user.name}（${user.open_id}）` });
}

async function searchUsers(args, token) {
  const query = {
    query: args.query,
    page_size: String(Math.min(Math.max(args.pageSize, 1), 200)),
  };
  if (args.pageToken) query.page_token = args.pageToken;

  const data = await apiCall("GET", "/search/v1/user", token, null, query);
  if (data.code !== 0) {
    throw new Error(`code=${data.code} msg=${data.msg}`);
  }

  const users = (data.data?.users || []).map((u) => ({
    open_id: u.open_id,
    name: u.name,
    en_name: u.en_name,
    department: u.department_ids,
    avatar: u.avatar?.avatar_72,
  }));

  out({
    users,
    has_more: data.data?.has_more || false,
    page_token: data.data?.page_token || null,
    reply:
      users.length > 0
        ? `找到 ${users.length} 位用户：${users.map((u) => u.name).join("、")}`
        : `未找到匹配「${args.query}」的用户`,
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs();
  if (!args.openId) die({ error: "missing_param", message: "--open-id 参数必填" });

  if (args.action === "search" && !args.query) {
    die({ error: "missing_param", message: "--query 参数必填（action=search）" });
  }
  if (args.action === "get" && !args.userId) {
    die({ error: "missing_param", message: "--user-id 参数必填（action=get）" });
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
      message:
        "用户未完成飞书授权或授权已过期。请调用 feishu-auth skill 完成授权后重试。\n" +
        `用户 open_id: ${args.openId}`,
    });
  }

  const scopesByAction = {
    search: ["search:user", "contact:user:search"],
    get_me: ["authen:user_info"],
    get: ["contact:user.base:readonly"],
  };

  try {
    if (args.action === "get_me") {
      await getMe(accessToken);
    } else if (args.action === "get") {
      await getUser(args, accessToken);
    } else {
      await searchUsers(args, accessToken);
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
        required_scopes: scopesByAction[args.action] || [],
        reply: "**权限不足，需要重新授权以获取所需权限。**",
      });
    }
    die({ error: "api_error", message: msg });
  }
}

main();
