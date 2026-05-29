/**
 * feishu-im-message: 以用户身份发送/回复 IM 消息
 *
 * Actions:
 *   send  - 发送消息到私聊或群聊
 *   reply - 回复指定消息
 *
 * Usage:
 *   node message.mjs --open-id ou_xxx --action send \
 *     --receive-id-type open_id --receive-id ou_yyy --msg-type text --content '{"text":"你好"}'
 *
 *   node message.mjs --open-id ou_xxx --action send \
 *     --receive-id-type chat_id --receive-id oc_xxx --msg-type text --content '{"text":"群发消息"}'
 *
 *   node message.mjs --open-id ou_xxx --action reply \
 *     --message-id om_xxx --msg-type text --content '{"text":"回复内容"}'
 *
 * Output: single-line JSON
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig, getValidToken } from "../feishu-auth/token-utils.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs() {
  const argv = process.argv.slice(2);
  const r = {
    openId: null,
    action: null,
    receiveIdType: null,
    receiveId: null,
    msgType: null,
    content: null,
    messageId: null,
    replyInThread: null,
    uuid: null,
    imagePath: null,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--open-id":
        r.openId = argv[++i];
        break;
      case "--action":
        r.action = argv[++i];
        break;
      case "--receive-id-type":
        r.receiveIdType = argv[++i];
        break;
      case "--receive-id":
        r.receiveId = argv[++i];
        break;
      case "--msg-type":
        r.msgType = argv[++i];
        break;
      case "--content":
        r.content = argv[++i];
        break;
      case "--message-id":
        r.messageId = argv[++i];
        break;
      case "--reply-in-thread":
        r.replyInThread = argv[++i];
        break;
      case "--uuid":
        r.uuid = argv[++i];
        break;
      case "--image-path":
        r.imagePath = argv[++i];
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
// Actions
// ---------------------------------------------------------------------------

async function getTenantAccessToken(appId, appSecret) {
  const res = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const data = await res.json();
  if (data.code !== 0)
    throw new Error(`获取 tenant_access_token 失败: code=${data.code} msg=${data.msg}`);
  return data.tenant_access_token;
}

const ALLOWED_IMAGE_DIRS = [
  "/tmp/",
  path.join(os.homedir(), ".enclaws", "media"),
  path.join(os.homedir(), ".enclaws", "tenants"),
];

function checkImagePathAllowed(imagePath) {
  const resolved = path.resolve(imagePath);
  const allowed = ALLOWED_IMAGE_DIRS.some((dir) => resolved.startsWith(path.resolve(dir)));
  if (!allowed) {
    die({
      error: "path_not_allowed",
      message: `图片路径不在允许范围内: ${imagePath}\n允许的目录: ${ALLOWED_IMAGE_DIRS.join(", ")}`,
    });
  }
}

async function uploadImage(imagePath, appId, appSecret) {
  checkImagePathAllowed(imagePath);
  if (!fs.existsSync(imagePath))
    die({ error: "file_not_found", message: `图片文件不存在: ${imagePath}` });
  const tenantToken = await getTenantAccessToken(appId, appSecret);
  const fileBuffer = fs.readFileSync(imagePath);
  const fileName = path.basename(imagePath);
  const formData = new FormData();
  formData.append("image_type", "message");
  formData.append("image", new Blob([fileBuffer]), fileName);
  const res = await fetch("https://open.feishu.cn/open-apis/im/v1/images", {
    method: "POST",
    headers: { Authorization: `Bearer ${tenantToken}` },
    body: formData,
  });
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) throw new Error(`上传图片返回非 JSON (HTTP ${res.status})`);
  const data = await res.json();
  if (data.code !== 0) throw new Error(`上传图片失败: code=${data.code} msg=${data.msg}`);
  return data.data.image_key;
}

async function sendMessage(args, accessToken, cfg) {
  if (args.imagePath) {
    const imageKey = await uploadImage(args.imagePath, cfg.appId, cfg.appSecret);
    args.msgType = "image";
    args.content = JSON.stringify({ image_key: imageKey });
  }

  if (!args.receiveIdType)
    die({ error: "missing_param", message: "--receive-id-type 参数必填（open_id / chat_id）" });
  if (!args.receiveId) die({ error: "missing_param", message: "--receive-id 参数必填" });
  if (!args.msgType)
    die({
      error: "missing_param",
      message: "--msg-type 参数必填（text / post / image / file / interactive 等）",
    });
  if (!args.content) die({ error: "missing_param", message: "--content 参数必填（JSON 字符串）" });

  const body = {
    receive_id: args.receiveId,
    msg_type: args.msgType,
    content: args.content,
  };
  if (args.uuid) body.uuid = args.uuid;

  const data = await apiCall("POST", "/im/v1/messages", accessToken, {
    query: { receive_id_type: args.receiveIdType },
    body,
  });
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);

  const msg = data.data;
  out({
    message_id: msg?.message_id,
    chat_id: msg?.chat_id,
    create_time: msg?.create_time,
    reply: `消息已发送（message_id=${msg?.message_id}）`,
  });
}

async function replyMessage(args, accessToken) {
  if (!args.messageId) die({ error: "missing_param", message: "--message-id 参数必填（om_xxx）" });
  if (!args.msgType) die({ error: "missing_param", message: "--msg-type 参数必填" });
  if (!args.content) die({ error: "missing_param", message: "--content 参数必填（JSON 字符串）" });

  const body = {
    content: args.content,
    msg_type: args.msgType,
  };
  if (args.replyInThread != null) body.reply_in_thread = args.replyInThread === "true";
  if (args.uuid) body.uuid = args.uuid;

  const data = await apiCall("POST", `/im/v1/messages/${args.messageId}/reply`, accessToken, {
    body,
  });
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);

  const msg = data.data;
  out({
    message_id: msg?.message_id,
    chat_id: msg?.chat_id,
    create_time: msg?.create_time,
    reply: `回复已发送（message_id=${msg?.message_id}）`,
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const ACTIONS = { send: sendMessage, reply: replyMessage };

async function main() {
  const args = parseArgs();
  if (!args.openId) die({ error: "missing_param", message: "--open-id 参数必填" });
  if (!args.action)
    die({
      error: "missing_param",
      message: `--action 参数必填（${Object.keys(ACTIONS).join(" / ")}）`,
    });

  const handler = ACTIONS[args.action];
  if (!handler) die({ error: "unsupported_action", message: `不支持的 action: ${args.action}` });

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
      message: `用户未完成飞书授权或授权已过期。用户 open_id: ${args.openId}`,
    });
  }

  try {
    await handler(args, accessToken, cfg);
  } catch (err) {
    const msg = err.message || "";
    if (msg.includes("99991663"))
      die({ error: "auth_required", message: "飞书 token 已失效，请重新授权" });
    if (msg.includes("99991672") || msg.includes("99991679") || /permission|scope/i.test(msg)) {
      die({
        error: "permission_required",
        message: msg,
        required_scopes: ["im:message"],
        reply: "**权限不足，需要重新授权以获取发送消息权限。**",
      });
    }
    die({ error: "api_error", message: msg });
  }
}

main();
