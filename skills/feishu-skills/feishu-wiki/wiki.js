"use strict";
/**
 * feishu-wiki: Feishu Wiki space and node management using per-user OAuth token.
 *
 * Resources & Actions:
 *   space: list, get, create
 *   node:  list, get, create, move, copy
 *
 * Usage:
 *   # Space actions
 *   node wiki.js --open-id ou_xxx --action space_list
 *   node wiki.js --open-id ou_xxx --action space_get  --space-id SPACE_ID
 *   node wiki.js --open-id ou_xxx --action space_create --name "知识库名称" [--description "描述"]
 *
 *   # Node actions
 *   node wiki.js --open-id ou_xxx --action node_list   --space-id SPACE_ID [--parent-node-token TOKEN]
 *   node wiki.js --open-id ou_xxx --action node_get    --token NODE_TOKEN [--obj-type wiki]
 *   node wiki.js --open-id ou_xxx --action node_create --space-id SPACE_ID --obj-type docx --node-type origin [--title "标题"] [--parent-node-token TOKEN]
 *   node wiki.js --open-id ou_xxx --action node_move   --space-id SPACE_ID --node-token TOKEN [--target-parent-token TOKEN]
 *   node wiki.js --open-id ou_xxx --action node_copy   --space-id SPACE_ID --node-token TOKEN [--target-space-id ID] [--target-parent-token TOKEN] [--title "新标题"]
 *
 * Output: single-line JSON
 */

const path = require("path");
const { getConfig, getValidToken } = require(path.join(__dirname, "../feishu-auth/token-utils.js"));

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs() {
  const argv = process.argv.slice(2);
  const r = {
    openId: null,
    action: null,
    spaceId: null,
    token: null,
    nodeToken: null,
    parentNodeToken: null,
    targetParentToken: null,
    targetSpaceId: null,
    objType: null,
    nodeType: null,
    originNodeToken: null,
    title: null,
    name: null,
    description: null,
    pageSize: null,
    pageToken: null,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--open-id":
        r.openId = argv[++i];
        break;
      case "--action":
        r.action = argv[++i];
        break;
      case "--space-id":
        r.spaceId = argv[++i];
        break;
      case "--token":
        r.token = argv[++i];
        break;
      case "--node-token":
        r.nodeToken = argv[++i];
        break;
      case "--parent-node-token":
        r.parentNodeToken = argv[++i];
        break;
      case "--target-parent-token":
        r.targetParentToken = argv[++i];
        break;
      case "--target-space-id":
        r.targetSpaceId = argv[++i];
        break;
      case "--obj-type":
        r.objType = argv[++i];
        break;
      case "--node-type":
        r.nodeType = argv[++i];
        break;
      case "--origin-node-token":
        r.originNodeToken = argv[++i];
        break;
      case "--title":
        r.title = argv[++i];
        break;
      case "--name":
        r.name = argv[++i];
        break;
      case "--description":
        r.description = argv[++i];
        break;
      case "--page-size":
        r.pageSize = parseInt(argv[++i], 10);
        break;
      case "--page-token":
        r.pageToken = argv[++i];
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
// API helper
// ---------------------------------------------------------------------------

async function apiCall(method, urlPath, accessToken, { body, query } = {}) {
  let url = `https://open.feishu.cn/open-apis${urlPath}`;
  if (query) {
    const entries = Object.entries(query).filter(([, v]) => v != null);
    if (entries.length > 0)
      url += "?" + new URLSearchParams(Object.fromEntries(entries)).toString();
  }
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) throw new Error(`API 返回非 JSON (HTTP ${res.status})`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Space actions
// ---------------------------------------------------------------------------

async function spaceList(args, accessToken) {
  const query = {};
  if (args.pageSize) query.page_size = String(args.pageSize);
  if (args.pageToken) query.page_token = args.pageToken;

  const data = await apiCall("GET", "/wiki/v2/spaces", accessToken, { query });
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);

  const spaces = data.data?.items || [];
  out({
    spaces,
    has_more: data.data?.has_more || false,
    page_token: data.data?.page_token || null,
    reply:
      spaces.length > 0
        ? `找到 ${spaces.length} 个知识空间：${spaces.map((s) => `${s.name}（${s.space_id}）`).join("、")}`
        : "未找到知识空间",
  });
}

async function spaceGet(args, accessToken) {
  if (!args.spaceId) die({ error: "missing_param", message: "--space-id 参数必填" });

  const data = await apiCall("GET", `/wiki/v2/spaces/${args.spaceId}`, accessToken);
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);

  const space = data.data?.space;
  out({ space, reply: `知识空间：${space?.name}（${space?.space_id}）` });
}

async function spaceCreate(args, accessToken) {
  if (!args.name) die({ error: "missing_param", message: "--name 参数必填" });

  const body = { name: args.name };
  if (args.description) body.description = args.description;

  const data = await apiCall("POST", "/wiki/v2/spaces", accessToken, { body });
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);

  const space = data.data?.space;
  out({ space, reply: `已创建知识空间「${space?.name}」（${space?.space_id}）` });
}

// ---------------------------------------------------------------------------
// Node actions
// ---------------------------------------------------------------------------

async function nodeList(args, accessToken) {
  if (!args.spaceId) die({ error: "missing_param", message: "--space-id 参数必填" });

  const query = {};
  if (args.parentNodeToken) query.parent_node_token = args.parentNodeToken;
  if (args.pageSize) query.page_size = String(args.pageSize);
  if (args.pageToken) query.page_token = args.pageToken;

  const data = await apiCall("GET", `/wiki/v2/spaces/${args.spaceId}/nodes`, accessToken, {
    query,
  });
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);

  const nodes = data.data?.items || [];
  out({
    nodes,
    has_more: data.data?.has_more || false,
    page_token: data.data?.page_token || null,
    reply: `找到 ${nodes.length} 个节点${args.parentNodeToken ? "（子节点）" : "（根节点）"}`,
  });
}

async function nodeGet(args, accessToken) {
  if (!args.token)
    die({ error: "missing_param", message: "--token 参数必填（节点 token 或文档 token）" });

  const query = { token: args.token };
  if (args.objType) query.obj_type = args.objType;

  const data = await apiCall("GET", "/wiki/v2/spaces/get_node", accessToken, { query });
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);

  const node = data.data?.node;
  const wiki_url = node?.node_token ? `https://www.feishu.cn/wiki/${node.node_token}` : null;
  out({
    node,
    url: wiki_url,
    reply: node
      ? `节点：${node.title}（node_token=${node.node_token}，obj_token=${node.obj_token}，类型=${node.obj_type}）${wiki_url ? `\n链接：${wiki_url}` : ""}`
      : "未找到节点",
  });
}

async function nodeCreate(args, accessToken) {
  if (!args.spaceId) die({ error: "missing_param", message: "--space-id 参数必填" });
  if (!args.objType)
    die({
      error: "missing_param",
      message: "--obj-type 参数必填（docx/sheet/bitable/mindnote/file/slides）",
    });
  if (!args.nodeType)
    die({ error: "missing_param", message: "--node-type 参数必填（origin 或 shortcut）" });

  const body = { obj_type: args.objType, node_type: args.nodeType };
  if (args.parentNodeToken) body.parent_node_token = args.parentNodeToken;
  if (args.originNodeToken) body.origin_node_token = args.originNodeToken;
  if (args.title) body.title = args.title;

  const data = await apiCall("POST", `/wiki/v2/spaces/${args.spaceId}/nodes`, accessToken, {
    body,
  });
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);

  const node = data.data?.node;
  const wiki_url = node?.node_token ? `https://www.feishu.cn/wiki/${node.node_token}` : null;
  out({
    node,
    url: wiki_url,
    reply: `已创建节点「${node?.title ?? args.title ?? "（无标题）"}」${wiki_url ? `：${wiki_url}` : `（node_token=${node?.node_token}）`}`,
  });
}

async function nodeMove(args, accessToken) {
  if (!args.spaceId) die({ error: "missing_param", message: "--space-id 参数必填" });
  if (!args.nodeToken) die({ error: "missing_param", message: "--node-token 参数必填" });

  const body = {};
  if (args.targetParentToken) body.target_parent_token = args.targetParentToken;

  const data = await apiCall(
    "POST",
    `/wiki/v2/spaces/${args.spaceId}/nodes/${args.nodeToken}/move`,
    accessToken,
    { body },
  );
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);

  const node = data.data?.node;
  const wiki_url = node?.node_token ? `https://www.feishu.cn/wiki/${node.node_token}` : null;
  out({
    node,
    url: wiki_url,
    reply: `已移动节点 ${args.nodeToken} 到 ${args.targetParentToken ?? "根目录"}${wiki_url ? `，链接：${wiki_url}` : ""}`,
  });
}

async function nodeCopy(args, accessToken) {
  if (!args.spaceId) die({ error: "missing_param", message: "--space-id 参数必填" });
  if (!args.nodeToken) die({ error: "missing_param", message: "--node-token 参数必填" });

  const body = {};
  if (args.targetSpaceId) body.target_space_id = args.targetSpaceId;
  if (args.targetParentToken) body.target_parent_token = args.targetParentToken;
  if (args.title) body.title = args.title;

  const data = await apiCall(
    "POST",
    `/wiki/v2/spaces/${args.spaceId}/nodes/${args.nodeToken}/copy`,
    accessToken,
    { body },
  );
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);

  const node = data.data?.node;
  const wiki_url = node?.node_token ? `https://www.feishu.cn/wiki/${node.node_token}` : null;
  out({
    node,
    url: wiki_url,
    reply: `已复制节点「${node?.title ?? args.title ?? "（无标题）"}」${wiki_url ? `：${wiki_url}` : `（node_token=${node?.node_token}）`}`,
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const ACTIONS = {
  space_list: spaceList,
  space_get: spaceGet,
  space_create: spaceCreate,
  node_list: nodeList,
  node_get: nodeGet,
  node_create: nodeCreate,
  node_move: nodeMove,
  node_copy: nodeCopy,
};

async function main() {
  const args = parseArgs();
  if (!args.openId) die({ error: "missing_param", message: "--open-id 参数必填" });
  if (!args.action)
    die({
      error: "missing_param",
      message: `--action 参数必填（${Object.keys(ACTIONS).join(" / ")}）`,
    });

  const handler = ACTIONS[args.action];
  if (!handler)
    die({
      error: "unsupported_action",
      message: `不支持的 action: ${args.action}。支持：${Object.keys(ACTIONS).join(" / ")}`,
    });

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

  try {
    await handler(args, accessToken);
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
        required_scopes: ["wiki:wiki", "wiki:wiki:readonly"],
        reply: "**权限不足，需要重新授权以获取访问知识库的权限。**",
      });
    }
    die({ error: "api_error", message: msg });
  }
}

main();
