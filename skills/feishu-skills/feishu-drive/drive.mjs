/**
 * feishu-drive: Minimal Feishu Drive helper using per-user OAuth token.
 *
 * Supported actions: list, create_folder, get_meta, copy, move, upload, download, delete
 *
 * Output: always a single-line JSON object.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendCard } from "../feishu-auth/send-card.mjs";
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
    folderToken: "",
    name: "",
    fileToken: null,
    type: null,
    requestDocs: "",
    filePath: null,
    fileBase64: null,
    fileName: null,
    outputPath: null,
    confirmDelete: false,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--open-id":
        r.openId = argv[++i];
        break;
      case "--action":
        r.action = argv[++i];
        break;
      case "--folder-token":
        r.folderToken = argv[++i];
        break;
      case "--name":
        r.name = argv[++i];
        break;
      case "--file-token":
        r.fileToken = argv[++i];
        break;
      case "--type":
        r.type = argv[++i];
        break;
      case "--request-docs":
        r.requestDocs = argv[++i] || "";
        break;
      case "--file-path":
        r.filePath = argv[++i];
        break;
      case "--file-base64":
        r.fileBase64 = argv[++i];
        break;
      case "--file-name":
        r.fileName = argv[++i];
        break;
      case "--output-path":
        r.outputPath = argv[++i];
        break;
      case "--confirm-delete":
        r.confirmDelete = true;
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
// URL builder
// ---------------------------------------------------------------------------

const DOC_TYPE_URL_PREFIX = {
  folder: "drive/folder",
  docx: "docx",
  doc: "docs",
  sheet: "sheets",
  bitable: "base",
  mindnote: "mindnotes",
  slides: "slides",
  file: "file",
};

function buildFeishuUrl(token, type) {
  if (!token) return "";
  const prefix = DOC_TYPE_URL_PREFIX[type];
  if (!prefix) return "";
  return `https://www.feishu.cn/${prefix}/${token}`;
}

// ---------------------------------------------------------------------------
// Feishu Drive API helpers
// ---------------------------------------------------------------------------

async function apiCall(method, urlPath, token, { body, query } = {}) {
  let url = `https://open.feishu.cn/open-apis${urlPath}`;
  if (query && Object.keys(query).length > 0) {
    const qs = new URLSearchParams(query).toString();
    url += (url.includes("?") ? "&" : "?") + qs;
  }

  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw new Error(`Feishu API parse error: ${res.status} ${res.statusText}`);
  }
  return data;
}

async function apiCallRaw(method, urlPath, token, { body, query, headers } = {}) {
  let url = `https://open.feishu.cn/open-apis${urlPath}`;
  if (query && Object.keys(query).length > 0) {
    const qs = new URLSearchParams(query).toString();
    url += (url.includes("?") ? "&" : "?") + qs;
  }
  return fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(headers || {}),
    },
    body,
  });
}

async function listFolder(accessToken, folderToken) {
  const items = [];
  let pageToken;

  do {
    const query = {
      page_size: "200",
    };
    if (folderToken) query.folder_token = folderToken;
    if (pageToken) query.page_token = pageToken;

    const data = await apiCall("GET", "/drive/v1/files", accessToken, { query });
    if (data.code !== 0) {
      throw new Error(`List folder failed: code=${data.code} msg=${data.msg}`);
    }

    const list = data.data?.files || data.data?.items || [];
    for (const it of list) {
      items.push({
        token: it.token,
        name: it.name,
        type: it.type,
        parent_token: it.parent_token,
        url: it.url,
      });
    }

    pageToken = data.data?.has_more ? data.data.page_token : undefined;
  } while (pageToken);

  return items;
}

async function createFolder(accessToken, name, parentFolderToken) {
  const body = {
    name,
    folder_token: parentFolderToken || "",
  };
  const data = await apiCall("POST", "/drive/v1/files/create_folder", accessToken, { body });
  if (data.code !== 0) {
    throw new Error(`Create folder failed: code=${data.code} msg=${data.msg}`);
  }
  return data.data;
}

const DOC_TYPES = new Set([
  "doc",
  "sheet",
  "file",
  "bitable",
  "docx",
  "folder",
  "mindnote",
  "slides",
]);

function parseRequestDocs(input) {
  if (!input || !input.trim()) {
    throw new Error("--request-docs 参数必填，格式如 token1:docx,token2:sheet");
  }
  const parts = input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) {
    throw new Error("--request-docs 不能为空");
  }
  if (parts.length > 50) {
    throw new Error("--request-docs 最多 50 条");
  }
  const requestDocs = parts.map((part) => {
    const [docToken, docType] = part.split(":").map((s) => (s || "").trim());
    if (!docToken || !docType) {
      throw new Error(`request-docs 项格式错误: ${part}，应为 token:type`);
    }
    if (!DOC_TYPES.has(docType)) {
      throw new Error(`不支持的 doc_type: ${docType}`);
    }
    return { doc_token: docToken, doc_type: docType };
  });
  return requestDocs;
}

async function getMeta(accessToken, requestDocs) {
  const data = await apiCall("POST", "/drive/v1/metas/batch_query", accessToken, {
    body: { request_docs: requestDocs },
  });
  if (data.code !== 0) {
    throw new Error(`Get meta failed: code=${data.code} msg=${data.msg}`);
  }
  return data.data?.metas || [];
}

function formatMetaSummaryLine(m, index) {
  const title = m.name ?? m.title ?? m.doc_token ?? `第${index + 1}条`;
  const docType = m.type ?? m.doc_type ?? "?";
  const tok = m.doc_token ?? m.token ?? "";
  const owner = m.owner_id ?? m.owner ?? "";
  const created = m.created_time ?? m.create_time ?? "";
  const modified = m.latest_modify_time ?? m.modified_time ?? m.edit_time ?? "";
  const size = m.size != null && m.size !== "" ? m.size : "";
  const parts = [`${index + 1}.「${title}」`, `类型:${docType}`, `token:${tok}`];
  if (owner) parts.push(`创建者/所有者:${owner}`);
  if (created) parts.push(`创建:${created}`);
  if (modified) parts.push(`修改:${modified}`);
  if (size !== "") parts.push(`大小:${size}`);
  return parts.join(" | ");
}

function buildGetMetaReply(metas) {
  if (!metas.length) return "未返回任何文件元信息。";
  const lines = metas.map((m, i) => formatMetaSummaryLine(m, i));
  return `共 ${metas.length} 条元信息：\n${lines.join("\n")}`;
}

async function copyFile(accessToken, fileToken, name, type, folderToken) {
  const data = await apiCall(
    "POST",
    `/drive/v1/files/${encodeURIComponent(fileToken)}/copy`,
    accessToken,
    {
      body: {
        name,
        type,
        folder_token: folderToken || "",
      },
    },
  );
  if (data.code !== 0) {
    throw new Error(`Copy file failed: code=${data.code} msg=${data.msg}`);
  }
  return data.data?.file;
}

async function moveFile(accessToken, fileToken, type, folderToken) {
  const data = await apiCall(
    "POST",
    `/drive/v1/files/${encodeURIComponent(fileToken)}/move`,
    accessToken,
    {
      body: {
        type,
        folder_token: folderToken,
      },
    },
  );
  if (data.code !== 0) {
    throw new Error(`Move file failed: code=${data.code} msg=${data.msg}`);
  }
  return data.data || {};
}

async function deleteFile(accessToken, fileToken, type) {
  const data = await apiCall(
    "DELETE",
    `/drive/v1/files/${encodeURIComponent(fileToken)}`,
    accessToken,
    {
      query: { type },
    },
  );
  if (data.code !== 0) {
    throw new Error(`Delete file failed: code=${data.code} msg=${data.msg}`);
  }
  return data.data || {};
}

const UPLOAD_ALL_LIMIT = 15 * 1024 * 1024;

function loadUploadInput(args) {
  if (args.filePath) {
    const resolved = path.resolve(args.filePath);
    if (!fs.existsSync(resolved)) {
      throw new Error(
        `文件不存在: ${resolved}。请确认当前工作目录正确，或使用绝对路径后再执行 upload。`,
      );
    }
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      throw new Error(`不是有效文件: ${resolved}`);
    }
    return {
      fileName: path.basename(resolved),
      buffer: fs.readFileSync(resolved),
      source: "file_path",
      sourcePath: resolved,
    };
  }
  if (args.fileBase64) {
    if (!args.fileName) {
      throw new Error("使用 --file-base64 时必须提供 --file-name");
    }
    return {
      fileName: args.fileName,
      buffer: Buffer.from(args.fileBase64, "base64"),
      source: "file_base64",
    };
  }
  throw new Error("上传必须提供 --file-path 或 --file-base64");
}

async function uploadAll(accessToken, fileName, buffer, folderToken) {
  const form = new FormData();
  form.append("file_name", fileName);
  form.append("parent_type", "explorer");
  form.append("parent_node", folderToken || "");
  form.append("size", String(buffer.length));
  form.append("file", new Blob([buffer]), fileName);

  const res = await apiCallRaw("POST", "/drive/v1/files/upload_all", accessToken, {
    body: form,
  });
  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`Upload all failed: code=${data.code} msg=${data.msg}`);
  }
  const d = data.data || {};
  const fileToken = d.file_token || d.file?.token || d.file?.file_token || null;
  return {
    file_token: fileToken,
    file_name: d.file?.name || fileName,
    size: buffer.length,
    data: d,
  };
}

async function uploadPrepare(accessToken, fileName, size, folderToken) {
  const data = await apiCall("POST", "/drive/v1/files/upload_prepare", accessToken, {
    body: {
      file_name: fileName,
      parent_type: "explorer",
      parent_node: folderToken || "",
      size,
    },
  });
  if (data.code !== 0) {
    throw new Error(`Upload prepare failed: code=${data.code} msg=${data.msg}`);
  }
  return data.data || {};
}

async function uploadPart(accessToken, uploadId, seq, chunkBuffer) {
  const form = new FormData();
  form.append("upload_id", uploadId);
  form.append("seq", String(seq));
  form.append("size", String(chunkBuffer.length));
  form.append("file", new Blob([chunkBuffer]), `part-${seq}`);

  const res = await apiCallRaw("POST", "/drive/v1/files/upload_part", accessToken, {
    body: form,
  });
  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`Upload part failed: seq=${seq} code=${data.code} msg=${data.msg}`);
  }
}

async function uploadFinish(accessToken, uploadId, blockNum) {
  const data = await apiCall("POST", "/drive/v1/files/upload_finish", accessToken, {
    body: {
      upload_id: uploadId,
      block_num: blockNum,
    },
  });
  if (data.code !== 0) {
    throw new Error(`Upload finish failed: code=${data.code} msg=${data.msg}`);
  }
  const d = data.data || {};
  const fileToken = d.file_token || d.file?.token || d.file?.file_token || null;
  return {
    file_token: fileToken,
    file_name: d.file?.name || null,
    data: d,
  };
}

async function uploadFile(accessToken, fileName, buffer, folderToken) {
  if (buffer.length <= UPLOAD_ALL_LIMIT) {
    const uploaded = await uploadAll(accessToken, fileName, buffer, folderToken);
    return { ...uploaded, mode: "upload_all" };
  }

  const prepared = await uploadPrepare(accessToken, fileName, buffer.length, folderToken);
  const uploadId = prepared.upload_id;
  const blockSize = prepared.block_size || UPLOAD_ALL_LIMIT;
  const blockNum = prepared.block_num || Math.ceil(buffer.length / blockSize);
  if (!uploadId) {
    throw new Error("Upload prepare 未返回 upload_id");
  }

  for (let seq = 0; seq < blockNum; seq++) {
    const start = seq * blockSize;
    const end = Math.min(start + blockSize, buffer.length);
    const chunk = buffer.subarray(start, end);
    await uploadPart(accessToken, uploadId, seq, chunk);
  }

  const finished = await uploadFinish(accessToken, uploadId, blockNum);
  return {
    ...finished,
    mode: "multipart",
    file_name: finished.file_name || fileName,
    size: buffer.length,
  };
}

async function downloadFileBuffer(accessToken, fileToken) {
  const res = await apiCallRaw(
    "GET",
    `/drive/v1/files/${encodeURIComponent(fileToken)}/download`,
    accessToken,
  );
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Download failed: status=${res.status} body=${txt.slice(0, 300)}`);
  }
  const reader = res.body?.getReader?.();
  if (!reader) {
    const arr = await res.arrayBuffer();
    return Buffer.from(arr);
  }
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    chunks.push(chunk);
    total += chunk.length;
  }
  return Buffer.concat(chunks, total);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs();

  if (!args.openId) {
    die({ error: "missing_param", message: "--open-id 参数必填" });
  }
  if (!args.action) {
    die({
      error: "missing_param",
      message: "--action 参数必填（list/create_folder/get_meta/copy/move/upload/download/delete）",
    });
  }

  if (args.folderToken && /^file_/.test(args.folderToken)) {
    die({
      error: "invalid_folder_token_im_file_key",
      message:
        "传入的是 IM 消息 file_key（以 file_ 开头），不是云盘 folder_token。" +
        "这是命名空间错误，不是格式问题——改前缀也不通。" +
        '若来源是 IM 文件夹附件 <folder key="file_v3_..."/>，当前飞书 open API ' +
        "未公开该附件的读取接口，不要调用本 skill。",
      hint: "引导用户：① 本地把文件夹压缩为 .zip 后发送；或 ② 上传云盘后分享 /drive/folder/<token> 链接。",
    });
  }
  if (args.fileToken && /^file_/.test(args.fileToken)) {
    die({
      error: "invalid_file_token_im_file_key",
      message: "传入的是 IM file_key，不是云盘 file_token。请使用 IM 资源下载接口下载附件。",
    });
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

  try {
    if (args.action === "list") {
      const items = await listFolder(accessToken, args.folderToken || "");
      const folderUrl = args.folderToken ? buildFeishuUrl(args.folderToken, "folder") : "";
      const lines = items
        .slice(0, 10)
        .map((it) => `- ${it.name}（${it.type}）`)
        .join("\n");
      const more = items.length > 10 ? `\n...等共 ${items.length} 个项目` : "";
      const bodyText =
        items.length > 0
          ? `文件夹下共 **${items.length}** 个项目：\n${lines}${more}`
          : "文件夹为空。";
      await sendCard({
        openId: args.openId,
        title: "📂 文件列表",
        body: bodyText,
        buttonText: folderUrl ? "打开文件夹" : undefined,
        buttonUrl: folderUrl || undefined,
        color: "blue",
      }).catch(() => {});
      const scope = args.folderToken
        ? { kind: "folder", folder_token: args.folderToken }
        : {
            kind: "root",
            warning:
              '⚠️ 当前为云盘根目录，不是任何具体文件夹。若用户本意查某个文件夹但未提供 folder_token，不要把此结果当作"该文件夹的内容"回复用户。',
          };
      out({
        action: "list",
        folder_token: args.folderToken || "",
        scope,
        count: items.length,
        items,
        reply: args.folderToken
          ? `当前文件夹下共有 ${items.length} 个项目。`
          : `云盘根目录下共有 ${items.length} 个项目（这是根目录，不是某个具体文件夹）。`,
      });
      return;
    }

    if (args.action === "create_folder") {
      if (!args.name) {
        die({ error: "missing_param", message: "--name 参数必填（新建文件夹名称）" });
      }
      const data = await createFolder(accessToken, args.name, args.folderToken || "");
      const token = data?.token;
      const url = data?.url || buildFeishuUrl(token, "folder");
      await sendCard({
        openId: args.openId,
        title: "📁 文件夹已创建",
        body: `文件夹「${args.name}」创建成功`,
        buttonText: url ? "打开文件夹" : undefined,
        buttonUrl: url || undefined,
        color: "green",
      }).catch(() => {});
      out({
        action: "create_folder",
        folder_token: token,
        url,
        name: args.name,
        parent_folder_token: args.folderToken || "",
        reply: url
          ? `已在目标目录下创建文件夹「${args.name}」。\n📁 链接：${url}`
          : `已在目标目录下创建文件夹「${args.name}」。`,
      });
      return;
    }

    if (args.action === "get_meta") {
      const requestDocs = parseRequestDocs(args.requestDocs);
      const metas = await getMeta(accessToken, requestDocs);
      const replyText = buildGetMetaReply(metas);
      const cardLines = metas.slice(0, 8).map((m, i) => formatMetaSummaryLine(m, i));
      const cardMore = metas.length > 8 ? `\n...共 ${metas.length} 条（见 reply）` : "";
      await sendCard({
        openId: args.openId,
        title: "📋 文件元信息",
        body:
          metas.length > 0
            ? `**${metas.length}** 条：\n${cardLines.join("\n")}${cardMore}`
            : "未获取到元信息。",
        color: "blue",
      }).catch(() => {});
      out({
        action: "get_meta",
        count: metas.length,
        metas,
        reply: replyText,
      });
      return;
    }

    if (args.action === "copy") {
      if (!args.fileToken) {
        die({ error: "missing_param", message: "--file-token 参数必填（待复制文件 token）" });
      }
      if (!args.name) {
        die({ error: "missing_param", message: "--name 参数必填（副本名称）" });
      }
      if (!args.type) {
        die({ error: "missing_param", message: "--type 参数必填（文档类型）" });
      }
      if (!DOC_TYPES.has(args.type)) {
        die({ error: "invalid_param", message: `--type 不支持：${args.type}` });
      }
      const file = await copyFile(
        accessToken,
        args.fileToken,
        args.name,
        args.type,
        args.folderToken || "",
      );
      const copyUrl = file?.url || buildFeishuUrl(file?.token, args.type);
      await sendCard({
        openId: args.openId,
        title: "📄 文件已复制",
        body: `文件「${file?.name || args.name}」复制成功`,
        buttonText: copyUrl ? "查看副本" : undefined,
        buttonUrl: copyUrl || undefined,
        color: "green",
      }).catch(() => {});
      const copyToken = file?.token ?? file?.file_token ?? "";
      const copySummary = `复制成功 | name=${file?.name || args.name} | token=${copyToken} | type=${args.type}${copyUrl ? ` | url=${copyUrl}` : ""}`;
      out({
        action: "copy",
        file,
        url: copyUrl,
        reply: copyUrl
          ? `${copySummary}\n副本链接：[${file?.name || args.name}](${copyUrl})`
          : copySummary,
      });
      return;
    }

    if (args.action === "move") {
      if (!args.fileToken) {
        die({ error: "missing_param", message: "--file-token 参数必填（待移动文件 token）" });
      }
      if (!args.type) {
        die({ error: "missing_param", message: "--type 参数必填（文档类型）" });
      }
      if (!DOC_TYPES.has(args.type)) {
        die({ error: "invalid_param", message: `--type 不支持：${args.type}` });
      }
      if (!args.folderToken) {
        die({ error: "missing_param", message: "--folder-token 参数必填（目标文件夹 token）" });
      }
      const data = await moveFile(accessToken, args.fileToken, args.type, args.folderToken);
      await sendCard({
        openId: args.openId,
        title: "📦 文件已移动",
        body: data.task_id
          ? `文件移动任务已提交（task_id: ${data.task_id}）`
          : "文件移动请求已提交",
        color: "green",
      }).catch(() => {});
      const moveSummary = `移动已提交 | file_token=${args.fileToken} | type=${args.type} | 目标folder_token=${args.folderToken}${data.task_id ? ` | task_id=${data.task_id}` : ""}`;
      out({
        action: "move",
        task_id: data.task_id || null,
        target_folder_token: args.folderToken,
        data,
        reply: data.task_id
          ? `${moveSummary}（异步任务，请稍后在目标文件夹中确认）`
          : `${moveSummary}`,
      });
      return;
    }

    if (args.action === "upload") {
      const input = loadUploadInput(args);
      const uploaded = await uploadFile(
        accessToken,
        input.fileName,
        input.buffer,
        args.folderToken || "",
      );
      const uploadUrl = buildFeishuUrl(uploaded.file_token, "file");
      const displayName = uploaded.file_name || input.fileName;
      const sizeKB = Math.round((uploaded.size || input.buffer.length) / 1024);
      await sendCard({
        openId: args.openId,
        title: "📎 文件已上传",
        body: `文件「${displayName}」上传成功（${sizeKB} KB）`,
        buttonText: uploadUrl ? "查看文件" : undefined,
        buttonUrl: uploadUrl || undefined,
        color: "green",
      }).catch(() => {});
      out({
        action: "upload",
        mode: uploaded.mode,
        file_token: uploaded.file_token,
        file_name: displayName,
        size: uploaded.size || input.buffer.length,
        source: input.source,
        source_path: input.sourcePath || undefined,
        url: uploadUrl,
        data: uploaded.data,
        reply: (() => {
          const sz = uploaded.size || input.buffer.length;
          const summary = `上传成功 | file=${displayName} | token=${uploaded.file_token || ""} | size=${sz} bytes | mode=${uploaded.mode}${uploadUrl ? ` | url=${uploadUrl}` : ""}`;
          return uploadUrl ? `${summary}\n文件链接：[${displayName}](${uploadUrl})` : summary;
        })(),
      });
      return;
    }

    if (args.action === "download") {
      if (!args.fileToken) {
        die({ error: "missing_param", message: "--file-token 参数必填（待下载文件 token）" });
      }
      const fileBuffer = await downloadFileBuffer(accessToken, args.fileToken);
      if (args.outputPath) {
        const savePath = path.resolve(args.outputPath);
        fs.mkdirSync(path.dirname(savePath), { recursive: true });
        fs.writeFileSync(savePath, fileBuffer);
        out({
          action: "download",
          saved_path: savePath,
          size: fileBuffer.length,
          reply: `文件已下载到：${savePath}`,
        });
      } else {
        out({
          action: "download",
          file_content_base64: fileBuffer.toString("base64"),
          size: fileBuffer.length,
          reply: `文件下载成功（base64，${fileBuffer.length} bytes）。大文件建议使用 --output-path。`,
        });
      }
      return;
    }

    if (args.action === "delete") {
      if (!args.fileToken) {
        die({ error: "missing_param", message: "--file-token 参数必填（待删除文件 token）" });
      }
      if (!args.type) {
        die({ error: "missing_param", message: "--type 参数必填（文档类型）" });
      }
      if (!DOC_TYPES.has(args.type)) {
        die({ error: "invalid_param", message: `--type 不支持：${args.type}` });
      }
      if (!args.confirmDelete) {
        die({
          error: "confirmation_required",
          message:
            "删除前必须先执行 get_meta，向用户展示文件名、类型与 token，待用户明确确认后再追加 --confirm-delete 执行删除。",
          hint: 'node ./drive.mjs --open-id "..." --action delete --file-token "..." --type "docx" --confirm-delete',
        });
      }
      const data = await deleteFile(accessToken, args.fileToken, args.type);
      const delSummary = `删除已提交 | file_token=${args.fileToken} | type=${args.type}${data.task_id ? ` | task_id=${data.task_id}` : ""}`;
      out({
        action: "delete",
        task_id: data.task_id || null,
        data,
        reply: data.task_id
          ? `${delSummary}（异步任务，删除完成后文件将不可恢复）`
          : `${delSummary}`,
      });
      return;
    }

    die({
      error: "unsupported_action",
      message: `暂未实现的 action: ${args.action}。当前仅支持 list、create_folder、get_meta、copy、move、upload、download、delete。`,
    });
  } catch (err) {
    const msg = err.message || "";
    if (msg.includes("99991663")) {
      die({
        error: "auth_required",
        message: "飞书 token 已失效，请重新授权（调用 feishu-auth）",
      });
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
        required_scopes: ["drive:drive", "drive:drive:readonly"],
        reply: "⚠️ **权限不足，需要重新授权以获取访问云盘的权限。**",
      });
    }
    die({ error: "api_error", message: err.message });
  }
}

main();
