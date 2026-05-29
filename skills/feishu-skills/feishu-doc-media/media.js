"use strict";
/**
 * feishu-doc-media: 文档媒体管理（以用户身份）
 *
 * Actions:
 *   insert   - 在飞书文档末尾插入本地图片或文件（3 步流程）
 *   download - 下载文档素材或画板缩略图到本地
 *
 * Usage:
 *   node media.js --open-id ou_xxx --action insert \
 *     --doc-id "DOC_ID_OR_URL" --file-path "/path/to/image.png" \
 *     [--type image|file] [--align left|center|right] [--caption "描述"]
 *
 *   node media.js --open-id ou_xxx --action download \
 *     --resource-token "FILE_TOKEN" --resource-type media --output-path "/tmp/image.png"
 *
 *   node media.js --open-id ou_xxx --action download \
 *     --resource-token "WHITEBOARD_ID" --resource-type whiteboard --output-path "/tmp/board"
 *
 * Output: single-line JSON
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { getConfig, getValidToken } = require(path.join(__dirname, "../feishu-auth/token-utils.js"));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

// 允许读取（insert --file-path）的目录白名单
const ALLOWED_READ_DIRS = ["/tmp/", path.join(os.homedir(), ".enclaws", "tenants")];

// 允许写入（download --output-path）的目录白名单
const ALLOWED_WRITE_DIRS = ["/tmp/", path.join(os.homedir(), ".enclaws", "tenants")];

function checkPathAllowed(filePath, allowedDirs, paramName) {
  const resolved = path.resolve(filePath);
  const allowed = allowedDirs.some((dir) => resolved.startsWith(path.resolve(dir)));
  if (!allowed) {
    die({
      error: "path_not_allowed",
      message: `${paramName} 路径不在允许范围内: ${filePath}\n允许的目录: ${allowedDirs.join(", ")}`,
    });
  }
}

const ALIGN_MAP = { left: 1, center: 2, right: 3 };

const MIME_TO_EXT = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
  "image/svg+xml": ".svg",
  "video/mp4": ".mp4",
  "video/mpeg": ".mpeg",
  "video/quicktime": ".mov",
  "video/x-msvideo": ".avi",
  "video/webm": ".webm",
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/zip": ".zip",
  "text/plain": ".txt",
  "application/json": ".json",
};

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs() {
  const argv = process.argv.slice(2);
  const r = {
    openId: null,
    action: null,
    docId: null,
    filePath: null,
    type: "image",
    align: "center",
    caption: null,
    resourceToken: null,
    resourceType: null,
    outputPath: null,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--open-id":
        r.openId = argv[++i];
        break;
      case "--action":
        r.action = argv[++i];
        break;
      case "--doc-id":
        r.docId = argv[++i];
        break;
      case "--file-path":
        r.filePath = argv[++i];
        break;
      case "--type":
        r.type = argv[++i];
        break;
      case "--align":
        r.align = argv[++i];
        break;
      case "--caption":
        r.caption = argv[++i];
        break;
      case "--resource-token":
        r.resourceToken = argv[++i];
        break;
      case "--resource-type":
        r.resourceType = argv[++i];
        break;
      case "--output-path":
        r.outputPath = argv[++i];
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

function resolveDefaultOutputDir() {
  const envWorkspace = process.env.ENCLAWS_USER_WORKSPACE;
  if (envWorkspace) return path.join(envWorkspace, "download");
  return path.join(process.cwd(), "download");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractDocumentId(input) {
  const m = input.trim().match(/\/docx\/([A-Za-z0-9]+)/);
  return m ? m[1] : input.trim();
}

async function apiCallRaw(method, urlPath, accessToken, { body, query, isForm } = {}) {
  let url = `https://open.feishu.cn/open-apis${urlPath}`;
  if (query) {
    const entries = Object.entries(query).filter(([, v]) => v != null);
    if (entries.length) url += "?" + new URLSearchParams(Object.fromEntries(entries));
  }
  const headers = { Authorization: `Bearer ${accessToken}` };
  if (!isForm) headers["Content-Type"] = "application/json";
  return fetch(url, {
    method,
    headers,
    body: isForm ? body : body ? JSON.stringify(body) : undefined,
  });
}

async function apiCall(method, urlPath, accessToken, opts = {}) {
  const res = await apiCallRaw(method, urlPath, accessToken, opts);
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) throw new Error(`API 返回非 JSON (HTTP ${res.status})`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Action: insert
// ---------------------------------------------------------------------------

async function insertMedia(args, accessToken) {
  if (!args.docId) die({ error: "missing_param", message: "--doc-id 参数必填（文档 ID 或 URL）" });
  if (!args.filePath)
    die({ error: "missing_param", message: "--file-path 参数必填（本地文件绝对路径）" });

  const mediaType = args.type || "image";
  if (!["image", "file"].includes(mediaType)) {
    die({ error: "invalid_param", message: "--type 可选值：image / file" });
  }

  const documentId = extractDocumentId(args.docId);
  const filePath = path.resolve(args.filePath);

  // 校验路径白名单
  checkPathAllowed(filePath, ALLOWED_READ_DIRS, "--file-path");

  // 校验文件
  if (!fs.existsSync(filePath))
    die({ error: "file_not_found", message: `文件不存在：${filePath}` });
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_FILE_SIZE) {
    die({
      error: "file_too_large",
      message: `文件 ${(stat.size / 1024 / 1024).toFixed(1)}MB 超过 20MB 限制`,
    });
  }
  const fileName = path.basename(filePath);
  const fileSize = stat.size;

  // 步骤 1：创建空 Block 追加到文档末尾
  const blockType = mediaType === "image" ? 27 : 23;
  const blockData = mediaType === "image" ? { image: {} } : { file: { token: "" } };

  const createData = await apiCall(
    "POST",
    `/docx/v1/documents/${documentId}/blocks/${documentId}/children`,
    accessToken,
    {
      query: { document_revision_id: "-1" },
      body: { children: [{ block_type: blockType, ...blockData }] },
    },
  );
  if (createData.code !== 0)
    throw new Error(`创建 Block 失败: code=${createData.code} msg=${createData.msg}`);

  let blockId;
  if (mediaType === "file") {
    blockId = createData.data?.children?.[0]?.children?.[0];
  } else {
    blockId = createData.data?.children?.[0]?.block_id;
  }
  if (!blockId) throw new Error(`未返回 block_id，创建 Block 失败`);

  // 步骤 2：上传素材
  const parentType = mediaType === "image" ? "docx_image" : "docx_file";
  const form = new FormData();
  form.append("file_name", fileName);
  form.append("parent_type", parentType);
  form.append("parent_node", blockId);
  form.append("size", String(fileSize));
  form.append("extra", JSON.stringify({ drive_route_token: documentId }));
  form.append("file", new Blob([fs.readFileSync(filePath)]), fileName);

  const uploadRes = await apiCallRaw("POST", "/drive/v1/files/upload_all", accessToken, {
    body: form,
    isForm: true,
  });
  const uploadData = await uploadRes.json();
  if (uploadData.code !== 0)
    throw new Error(`上传素材失败: code=${uploadData.code} msg=${uploadData.msg}`);

  const fileToken = uploadData.data?.file_token;
  if (!fileToken) throw new Error("上传素材未返回 file_token");

  // 步骤 3：批量更新 Block，写入 token
  const patchRequest = { block_id: blockId };
  if (mediaType === "image") {
    const alignNum = ALIGN_MAP[args.align] || 2;
    patchRequest.replace_image = {
      token: fileToken,
      align: alignNum,
      ...(args.caption ? { caption: { content: args.caption } } : {}),
    };
  } else {
    patchRequest.replace_file = { token: fileToken };
  }

  const patchData = await apiCall(
    "PATCH",
    `/docx/v1/documents/${documentId}/blocks/batch_update`,
    accessToken,
    {
      query: { document_revision_id: "-1" },
      body: { requests: [patchRequest] },
    },
  );
  if (patchData.code !== 0)
    throw new Error(`更新 Block 失败: code=${patchData.code} msg=${patchData.msg}`);

  const docUrl = `https://www.feishu.cn/docx/${documentId}`;
  out({
    success: true,
    type: mediaType,
    document_id: documentId,
    block_id: blockId,
    file_token: fileToken,
    file_name: fileName,
    url: docUrl,
    reply: `已在文档末尾插入${mediaType === "image" ? "图片" : "文件"}「${fileName}」\n文档链接：${docUrl}`,
  });
}

// ---------------------------------------------------------------------------
// Action: download
// ---------------------------------------------------------------------------

async function downloadMedia(args, accessToken) {
  if (!args.resourceToken) die({ error: "missing_param", message: "--resource-token 参数必填" });
  if (!args.resourceType)
    die({ error: "missing_param", message: "--resource-type 参数必填（media / whiteboard）" });

  let urlPath;
  if (args.resourceType === "media") {
    urlPath = `/drive/v1/medias/${args.resourceToken}/download`;
  } else if (args.resourceType === "whiteboard") {
    urlPath = `/board/v1/whiteboards/${args.resourceToken}/download_as_image`;
  } else {
    die({ error: "invalid_param", message: "--resource-type 可选值：media / whiteboard" });
  }

  const res = await apiCallRaw("GET", urlPath, accessToken);
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);

  const contentType = res.headers.get("content-type") || "";
  const outputPath = args.outputPath || path.join(resolveDefaultOutputDir(), args.resourceToken);
  let finalPath = path.resolve(outputPath);

  // 校验写入路径白名单（在补扩展名之前，用目录部分校验）
  checkPathAllowed(path.dirname(finalPath), ALLOWED_WRITE_DIRS, "--output-path");

  // 自动补扩展名
  if (!path.extname(finalPath) && contentType) {
    const mimeType = contentType.split(";")[0].trim();
    const ext = MIME_TO_EXT[mimeType] || (args.resourceType === "whiteboard" ? ".png" : "");
    if (ext) finalPath += ext;
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  fs.writeFileSync(finalPath, buffer);

  out({
    resource_type: args.resourceType,
    resource_token: args.resourceToken,
    size_bytes: buffer.length,
    content_type: contentType,
    saved_path: finalPath,
    reply: `已下载到 ${finalPath}（${(buffer.length / 1024).toFixed(1)} KB）`,
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const ACTIONS = { insert: insertMedia, download: downloadMedia };

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
        required_scopes: ["drive:drive", "docx:document"],
        reply: "**权限不足，需要重新授权以获取文档媒体管理权限。**",
      });
    }
    die({ error: "api_error", message: msg });
  }
}

main();
