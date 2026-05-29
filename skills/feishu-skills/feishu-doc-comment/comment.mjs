/**
 * feishu-doc-comment: 云文档评论管理（以用户身份）
 *
 * Actions:
 *   list   - 获取评论列表（含完整回复）
 *   create - 创建全文评论（支持文本、@用户、超链接）
 *   patch  - 解决/恢复评论
 *
 * Usage:
 *   node comment.mjs --open-id ou_xxx --action list --file-token TOKEN --file-type docx
 *   node comment.mjs --open-id ou_xxx --action create --file-token TOKEN --file-type docx --content "评论内容"
 *   node comment.mjs --open-id ou_xxx --action patch --file-token TOKEN --file-type docx --comment-id COMMENT_ID --is-solved true
 *
 * Output: single-line JSON
 */

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
    fileToken: null,
    fileType: null,
    isWhole: null,
    isSolved: null,
    pageSize: null,
    pageToken: null,
    content: null,
    commentId: null,
    isSolvedValue: null,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--open-id":
        r.openId = argv[++i];
        break;
      case "--action":
        r.action = argv[++i];
        break;
      case "--file-token":
        r.fileToken = argv[++i];
        break;
      case "--file-type":
        r.fileType = argv[++i];
        break;
      case "--is-whole":
        r.isWhole = argv[++i];
        break;
      case "--is-solved":
        r.isSolved = argv[++i];
        break;
      case "--page-size":
        r.pageSize = parseInt(argv[++i], 10);
        break;
      case "--page-token":
        r.pageToken = argv[++i];
        break;
      case "--content":
        r.content = argv[++i];
        break;
      case "--comment-id":
        r.commentId = argv[++i];
        break;
      case "--is-solved-value":
        r.isSolvedValue = argv[++i];
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
// Wiki token 转换
// ---------------------------------------------------------------------------

const DOC_TYPE_URL = {
  docx: (token) => `https://www.feishu.cn/docx/${token}`,
  doc: (token) => `https://www.feishu.cn/docs/${token}`,
  sheet: (token) => `https://www.feishu.cn/sheets/${token}`,
  bitable: (token) => `https://www.feishu.cn/base/${token}`,
};

async function resolveFileToken(fileToken, fileType, accessToken) {
  if (fileType !== "wiki") {
    const urlFn = DOC_TYPE_URL[fileType];
    const docUrl = urlFn ? urlFn(fileToken) : null;
    return { fileToken, fileType, docUrl };
  }

  const data = await apiCall("GET", "/wiki/v2/spaces/get_node", accessToken, {
    query: { token: fileToken, obj_type: "wiki" },
  });
  if (data.code !== 0) throw new Error(`wiki token 转换失败: code=${data.code} msg=${data.msg}`);

  const node = data.data?.node;
  if (!node?.obj_token || !node?.obj_type) {
    throw new Error(`wiki token "${fileToken}" 无法解析为文档（可能是文件夹节点）`);
  }
  const docUrl = `https://www.feishu.cn/wiki/${fileToken}`;
  return { fileToken: node.obj_token, fileType: node.obj_type, docUrl };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function listComments(args, accessToken) {
  if (!args.fileToken) die({ error: "missing_param", message: "--file-token 参数必填" });
  if (!args.fileType)
    die({ error: "missing_param", message: "--file-type 参数必填（docx/sheet/file/slides/wiki）" });

  const { fileToken, fileType, docUrl } = await resolveFileToken(
    args.fileToken,
    args.fileType,
    accessToken,
  );

  const query = {
    file_type: fileType,
    user_id_type: "open_id",
    page_size: String(args.pageSize || 50),
  };
  if (args.pageToken) query.page_token = args.pageToken;
  if (args.isWhole != null) query.is_whole = args.isWhole;
  if (args.isSolved != null) query.is_solved = args.isSolved;

  const data = await apiCall("GET", `/drive/v1/files/${fileToken}/comments`, accessToken, {
    query,
  });
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);

  const items = data.data?.items || [];

  for (const comment of items) {
    if (comment.reply_list?.replies?.length > 0) {
      try {
        const replies = [];
        let pageToken;
        do {
          const replyQuery = { file_type: fileType, user_id_type: "open_id", page_size: "50" };
          if (pageToken) replyQuery.page_token = pageToken;
          const replyData = await apiCall(
            "GET",
            `/drive/v1/files/${fileToken}/comments/${comment.comment_id}/replies`,
            accessToken,
            { query: replyQuery },
          );
          if (replyData.code !== 0) break;
          replies.push(...(replyData.data?.items || []));
          pageToken = replyData.data?.has_more ? replyData.data.page_token : null;
        } while (pageToken);
        comment.reply_list = { replies };
      } catch (_) {
        /* 保留原始回复 */
      }
    }
  }

  out({
    items,
    has_more: data.data?.has_more || false,
    page_token: data.data?.page_token || null,
    url: docUrl,
    reply: `找到 ${items.length} 条评论${docUrl ? `\n文档链接：${docUrl}` : ""}`,
  });
}

async function createComment(args, accessToken) {
  if (!args.fileToken) die({ error: "missing_param", message: "--file-token 参数必填" });
  if (!args.fileType) die({ error: "missing_param", message: "--file-type 参数必填" });
  if (!args.content) die({ error: "missing_param", message: "--content 参数必填（评论内容）" });

  const { fileToken, fileType, docUrl } = await resolveFileToken(
    args.fileToken,
    args.fileType,
    accessToken,
  );

  const data = await apiCall("POST", `/drive/v1/files/${fileToken}/comments`, accessToken, {
    query: { file_type: fileType, user_id_type: "open_id" },
    body: {
      reply_list: {
        replies: [
          { content: { elements: [{ type: "text_run", text_run: { text: args.content } }] } },
        ],
      },
    },
  });
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);

  const comment = data.data;
  out({
    comment,
    comment_id: comment?.comment_id,
    url: docUrl,
    reply: `评论已创建（comment_id=${comment?.comment_id}）${docUrl ? `\n文档链接：${docUrl}` : ""}`,
  });
}

async function patchComment(args, accessToken) {
  if (!args.fileToken) die({ error: "missing_param", message: "--file-token 参数必填" });
  if (!args.fileType) die({ error: "missing_param", message: "--file-type 参数必填" });
  if (!args.commentId) die({ error: "missing_param", message: "--comment-id 参数必填" });
  if (args.isSolvedValue == null)
    die({
      error: "missing_param",
      message: "--is-solved-value 参数必填（true=解决 / false=恢复）",
    });

  const { fileToken, fileType, docUrl } = await resolveFileToken(
    args.fileToken,
    args.fileType,
    accessToken,
  );
  const isSolved = args.isSolvedValue === "true";

  const data = await apiCall(
    "PATCH",
    `/drive/v1/files/${fileToken}/comments/${args.commentId}`,
    accessToken,
    {
      query: { file_type: fileType },
      body: { is_solved: isSolved },
    },
  );
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);

  out({
    success: true,
    url: docUrl,
    reply: `评论已${isSolved ? "解决" : "恢复"}（comment_id=${args.commentId}）${docUrl ? `\n文档链接：${docUrl}` : ""}`,
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const ACTIONS = { list: listComments, create: createComment, patch: patchComment };

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
    await handler(args, accessToken);
  } catch (err) {
    const msg = err.message || "";
    if (msg.includes("99991663"))
      die({ error: "auth_required", message: "飞书 token 已失效，请重新授权" });
    if (msg.includes("99991672") || msg.includes("99991679") || /permission|scope/i.test(msg)) {
      die({
        error: "permission_required",
        message: msg,
        required_scopes: ["drive:drive", "drive:drive.readonly"],
        reply: "**权限不足，需要重新授权以获取云文档评论权限。**",
      });
    }
    die({ error: "api_error", message: msg });
  }
}

main();
