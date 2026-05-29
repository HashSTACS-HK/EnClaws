"use strict";
/**
 * feishu-update-doc: Update Feishu cloud document content.
 *
 * Usage:
 *   node update-doc.js \
 *     --open-id   <open_id>       User's Feishu open_id (required)
 *     --doc-id    <doc_id>        Document token (required)
 *     --mode      <mode>          Update mode (required)
 *     --markdown  <content>       New content in Markdown
 *     --selection <text>          Selection for replace/insert/delete modes
 *     --new-title <title>         New document title (optional)
 *
 * Modes:
 *   append         - Add content to end of document
 *   overwrite      - Replace entire document content (destructive!)
 *   replace_range  - Replace content matching selection
 *   replace_all    - Replace all matches of selection
 *   insert_before  - Insert before selection
 *   insert_after   - Insert after selection
 *   delete_range   - Delete content matching selection
 *
 * Output: single-line JSON
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
    docId: null,
    mode: "append",
    markdown: "",
    selection: null,
    newTitle: null,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--open-id":
        r.openId = argv[++i];
        break;
      case "--doc-id":
        r.docId = argv[++i];
        break;
      case "--mode":
        r.mode = argv[++i];
        break;
      case "--markdown":
        r.markdown = argv[++i];
        break;
      case "--selection":
        r.selection = argv[++i];
        break;
      case "--new-title":
        r.newTitle = argv[++i];
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
  return res.json();
}

// ---------------------------------------------------------------------------
// Markdown → Feishu blocks (reuse logic from create-doc)
// ---------------------------------------------------------------------------

const BT = {
  PARAGRAPH: 2,
  H1: 3,
  H2: 4,
  H3: 5,
  H4: 6,
  H5: 7,
  H6: 8,
  BULLET: 12,
  ORDERED: 13,
  CODE: 14,
  DIVIDER: 22,
};

function parseInline(text) {
  const elements = [];
  const re = /\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`|([^*`]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[1] !== undefined)
      elements.push({ text_run: { content: m[1], text_element_style: { bold: true } } });
    else if (m[2] !== undefined)
      elements.push({ text_run: { content: m[2], text_element_style: { italic: true } } });
    else if (m[3] !== undefined)
      elements.push({ text_run: { content: m[3], text_element_style: { inline_code: true } } });
    else if (m[4] !== undefined)
      elements.push({ text_run: { content: m[4], text_element_style: {} } });
  }
  if (elements.length === 0) elements.push({ text_run: { content: text, text_element_style: {} } });
  return elements;
}

function textBlock(type, keyName, elements) {
  return { block_type: type, [keyName]: { elements, style: {} } };
}

const LANG_MAP = {
  bash: 27,
  sh: 27,
  shell: 27,
  c: 8,
  cpp: 9,
  css: 11,
  go: 23,
  html: 25,
  java: 28,
  javascript: 29,
  js: 29,
  json: 30,
  kotlin: 32,
  python: 49,
  ruby: 51,
  rust: 52,
  sql: 56,
  swift: 57,
  typescript: 62,
  ts: 62,
  yaml: 66,
  yml: 66,
};

function markdownToBlocks(md) {
  if (!md || !md.trim()) return [];
  const blocks = [];
  const lines = md.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const codeFence = line.match(/^```(\w*)/);
    if (codeFence) {
      const lang = codeFence[1] || "";
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      blocks.push({
        block_type: BT.CODE,
        code: {
          elements: [{ text_run: { content: codeLines.join("\n") } }],
          style: { language: LANG_MAP[lang.toLowerCase()] ?? 1, wrap: true },
        },
      });
      continue;
    }
    if (/^---+$/.test(line.trim())) {
      blocks.push({ block_type: BT.DIVIDER, divider: {} });
      i++;
      continue;
    }
    const hMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (hMatch) {
      const level = Math.min(hMatch[1].length, 6);
      blocks.push(textBlock(BT.H1 + level - 1, `heading${level}`, parseInline(hMatch[2].trim())));
      i++;
      continue;
    }
    const ulMatch = line.match(/^[-*+]\s+(.+)/);
    if (ulMatch) {
      blocks.push(textBlock(BT.BULLET, "bullet", parseInline(ulMatch[1].trim())));
      i++;
      continue;
    }
    const olMatch = line.match(/^\d+\.\s+(.+)/);
    if (olMatch) {
      blocks.push(textBlock(BT.ORDERED, "ordered", parseInline(olMatch[1].trim())));
      i++;
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const paraLines = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].match(/^```/) &&
      !lines[i].match(/^#{1,6}\s/) &&
      !lines[i].match(/^[-*+]\s/) &&
      !lines[i].match(/^\d+\.\s/) &&
      !lines[i].match(/^---+$/)
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0)
      blocks.push(textBlock(BT.PARAGRAPH, "text", parseInline(paraLines.join("\n"))));
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Document operations
// ---------------------------------------------------------------------------

/** Get all block IDs (children of root block) */
async function getDocChildBlockIds(docId, token) {
  const blocks = [];
  let pageToken = undefined;
  do {
    const query = { document_id: docId, page_size: "500" };
    if (pageToken) query.page_token = pageToken;
    const data = await apiCall("GET", `/docx/v1/documents/${docId}/blocks`, token, null, query);
    if (data.code !== 0) throw new Error(`Fetch blocks failed: code=${data.code} msg=${data.msg}`);
    if (data.data?.items) blocks.push(...data.data.items);
    pageToken = data.data?.has_more ? data.data.page_token : undefined;
  } while (pageToken);
  // Return child block IDs of the root (page) block — skip the root itself
  return blocks.filter((b) => b.parent_id === docId && b.block_id !== docId).map((b) => b.block_id);
}

/** Append blocks as children of root block */
async function appendBlocks(docId, blocks, token) {
  if (!blocks.length) return;
  const BATCH = 50;
  for (let i = 0; i < blocks.length; i += BATCH) {
    const batch = blocks.slice(i, i + BATCH);
    const data = await apiCall(
      "POST",
      `/docx/v1/documents/${docId}/blocks/${docId}/children`,
      token,
      {
        children: batch,
        index: -1,
      },
    );
    if (data.code !== 0) throw new Error(`Append blocks failed: code=${data.code} msg=${data.msg}`);
  }
}

/** Delete blocks by IDs */
async function deleteBlocks(docId, blockIds, token) {
  if (!blockIds.length) return;
  const BATCH = 50;
  for (let i = 0; i < blockIds.length; i += BATCH) {
    const batch = blockIds.slice(i, i + BATCH);
    const data = await apiCall(
      "DELETE",
      `/docx/v1/documents/${docId}/blocks/${docId}/children/batch_delete`,
      token,
      {
        start_index: 0,
        end_index: batch.length,
      },
    );
    // Re-fetch IDs after each batch since indices shift
    if (data.code !== 0 && data.code !== 300010) {
      throw new Error(`Delete blocks failed: code=${data.code} msg=${data.msg}`);
    }
  }
}

/** Update document title */
async function updateTitle(docId, title, token) {
  // Feishu uses PATCH on document to update title
  // Actually title is the first heading block or document property
  // Use the document patch API
  const data = await apiCall("PATCH", `/docx/v1/documents/${docId}`, token, {
    title,
  });
  // title update may not be supported via this endpoint for all doc types
  // non-fatal if it fails
  return data;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs();
  if (!args.openId) die({ error: "missing_param", message: "--open-id 参数必填" });
  if (!args.docId) die({ error: "missing_param", message: "--doc-id 参数必填" });

  const validModes = [
    "append",
    "overwrite",
    "replace_range",
    "replace_all",
    "insert_before",
    "insert_after",
    "delete_range",
  ];
  if (!validModes.includes(args.mode)) {
    die({
      error: "invalid_mode",
      message: `无效模式: ${args.mode}。可选: ${validModes.join(", ")}`,
    });
  }

  // Selection required for replace/insert/delete modes
  const needsSelection = [
    "replace_range",
    "replace_all",
    "insert_before",
    "insert_after",
    "delete_range",
  ];
  if (needsSelection.includes(args.mode) && !args.selection) {
    die({ error: "missing_param", message: `${args.mode} 模式需要 --selection 参数` });
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
    // Parse doc token from URL if needed
    const docId = args.docId.match(/\/docx\/([A-Za-z0-9]+)/)
      ? args.docId.match(/\/docx\/([A-Za-z0-9]+)/)[1]
      : args.docId.replace(/[?#].*$/, "");

    // Update title if requested
    if (args.newTitle) {
      await updateTitle(docId, args.newTitle, accessToken);
    }

    switch (args.mode) {
      case "append": {
        const blocks = markdownToBlocks(args.markdown);
        await appendBlocks(docId, blocks, accessToken);
        out({
          success: true,
          doc_id: docId,
          doc_url: `https://www.feishu.cn/docx/${docId}`,
          mode: "append",
          reply: `已将内容追加到文档末尾。链接：https://www.feishu.cn/docx/${docId}`,
        });
        break;
      }
      case "overwrite": {
        // Delete all existing blocks, then add new ones
        const childIds = await getDocChildBlockIds(docId, accessToken);
        if (childIds.length > 0) {
          // Use batch delete with start/end index on root block
          const data = await apiCall(
            "DELETE",
            `/docx/v1/documents/${docId}/blocks/${docId}/children/batch_delete`,
            accessToken,
            {
              start_index: 0,
              end_index: childIds.length,
            },
          );
          if (data.code !== 0)
            throw new Error(`Delete blocks failed: code=${data.code} msg=${data.msg}`);
        }
        const blocks = markdownToBlocks(args.markdown);
        await appendBlocks(docId, blocks, accessToken);
        out({
          success: true,
          doc_id: docId,
          doc_url: `https://www.feishu.cn/docx/${docId}`,
          mode: "overwrite",
          reply: `文档内容已覆盖更新。链接：https://www.feishu.cn/docx/${docId}`,
        });
        break;
      }
      default: {
        // For selection-based modes, we need a more complex approach
        // Currently delegate to a simplified text-based approach
        die({
          error: "mode_not_implemented",
          message: `${args.mode} 模式暂未实现。目前支持 append 和 overwrite 模式。`,
        });
      }
    }
  } catch (err) {
    if (err.message && err.message.includes("99991663")) {
      die({ error: "auth_required", message: "飞书 token 已失效，请重新授权" });
    }
    const msg = err.message || "";
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
        required_scopes: ["docx:document", "docx:document:write_only", "docs:doc", "drive:drive"],
        reply: "⚠️ **权限不足，需要重新授权以获取所需权限。**",
      });
    }
    die({ error: "api_error", message: err.message });
  }
}

main();
