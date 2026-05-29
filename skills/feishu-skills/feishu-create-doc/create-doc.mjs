/**
 * feishu-create-doc: Create a Feishu cloud document using per-user OAuth token.
 *
 * Usage:
 *   node create-doc.mjs \
 *     --open-id  <open_id>      User's Feishu open_id (required)
 *     --title    <title>        Document title (optional)
 *     --markdown <content>      Document body in Markdown (optional)
 *     --folder-token <token>    Parent folder token (optional)
 *     --wiki-node <token>       Wiki node token (optional, overrides folder-token)
 *
 * Output: single-line JSON
 *   Success: {"doc_id":"...","doc_url":"...","message":"文档创建成功"}
 *   Auth:    {"error":"auth_required","message":"..."}
 *   Error:   {"error":"...","message":"..."}
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendCard } from "../feishu-auth/send-card.mjs";
import { getConfig, getValidToken } from "../feishu-auth/token-utils.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const argv = process.argv.slice(2);
  const r = { openId: null, title: "", markdown: "", folderToken: null, wikiNode: null };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--open-id":
        r.openId = argv[++i];
        break;
      case "--title":
        r.title = argv[++i];
        break;
      case "--markdown":
        r.markdown = argv[++i];
        break;
      case "--folder-token":
        r.folderToken = argv[++i];
        break;
      case "--wiki-node":
        r.wikiNode = argv[++i];
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

/** User-visible reply with Markdown link (do not shorten or normalize title). */
function replyCreated(title, docUrl) {
  const t = title || "未命名文档";
  return `文档「${t}」已创建。链接：[${t}](${docUrl})`;
}

// ---------------------------------------------------------------------------
// Markdown → Feishu blocks (basic converter)
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

const LANG_MAP = {
  abap: 1,
  ada: 2,
  apache: 3,
  apex: 4,
  apiblueprint: 5,
  applescript: 6,
  bash: 27,
  sh: 27,
  shell: 27,
  c: 8,
  cpp: 9,
  "c++": 9,
  csharp: 10,
  "c#": 10,
  css: 11,
  coffeescript: 12,
  cmake: 13,
  d: 14,
  dart: 15,
  delphi: 16,
  dockerfile: 17,
  elixir: 18,
  elm: 19,
  erlang: 20,
  fortran: 21,
  fsharp: 22,
  "f#": 22,
  go: 23,
  groovy: 24,
  html: 25,
  http: 26,
  java: 28,
  javascript: 29,
  js: 29,
  json: 30,
  julia: 31,
  kotlin: 32,
  latex: 33,
  lua: 34,
  makefile: 35,
  markdown: 36,
  matlab: 37,
  mermaid: 38,
  nginx: 39,
  "objective-c": 40,
  objc: 40,
  ocaml: 41,
  pascal: 42,
  perl: 43,
  php: 44,
  powershell: 45,
  prolog: 46,
  protobuf: 47,
  python: 49,
  r: 50,
  ruby: 51,
  rust: 52,
  scala: 53,
  sql: 56,
  swift: 57,
  toml: 60,
  tsx: 61,
  typescript: 62,
  ts: 62,
  vb: 63,
  vbnet: 63,
  verilog: 64,
  xml: 65,
  yaml: 66,
  yml: 66,
};
const DEFAULT_LANG = 1;

function parseInline(text) {
  const elements = [];
  const re = /\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`|([^*`]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[1] !== undefined) {
      elements.push({ text_run: { content: m[1], text_element_style: { bold: true } } });
    } else if (m[2] !== undefined) {
      elements.push({ text_run: { content: m[2], text_element_style: { italic: true } } });
    } else if (m[3] !== undefined) {
      elements.push({ text_run: { content: m[3], text_element_style: { inline_code: true } } });
    } else if (m[4] !== undefined) {
      elements.push({ text_run: { content: m[4], text_element_style: {} } });
    }
  }
  if (elements.length === 0) {
    elements.push({ text_run: { content: text, text_element_style: {} } });
  }
  return elements;
}

function textBlock(type, keyName, elements) {
  return { block_type: type, [keyName]: { elements, style: {} } };
}

function paragraphBlock(elements) {
  return textBlock(BT.PARAGRAPH, "text", elements);
}

function headingBlock(level, text) {
  const type = BT.H1 + level - 1;
  const key = `heading${level}`;
  return textBlock(type, key, parseInline(text));
}

function bulletBlock(elements) {
  return textBlock(BT.BULLET, "bullet", elements);
}

function orderedBlock(elements) {
  return textBlock(BT.ORDERED, "ordered", elements);
}

function codeBlock(code, lang) {
  return {
    block_type: BT.CODE,
    code: {
      elements: [{ text_run: { content: code } }],
      style: { language: LANG_MAP[lang.toLowerCase()] ?? DEFAULT_LANG, wrap: true },
    },
  };
}

function dividerBlock() {
  return { block_type: BT.DIVIDER, divider: {} };
}

function markdownToBlocks(md) {
  if (!md || !md.trim()) return [];

  const blocks = [];
  const lines = md.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const codeFenceMatch = line.match(/^```(\w*)/);
    if (codeFenceMatch) {
      const lang = codeFenceMatch[1] || "";
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      blocks.push(codeBlock(codeLines.join("\n"), lang));
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      blocks.push(dividerBlock());
      i++;
      continue;
    }

    const hMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (hMatch) {
      const level = Math.min(hMatch[1].length, 6);
      blocks.push(headingBlock(level, hMatch[2].trim()));
      i++;
      continue;
    }

    const ulMatch = line.match(/^[-*+]\s+(.+)/);
    if (ulMatch) {
      blocks.push(bulletBlock(parseInline(ulMatch[1].trim())));
      i++;
      continue;
    }

    const olMatch = line.match(/^\d+\.\s+(.+)/);
    if (olMatch) {
      blocks.push(orderedBlock(parseInline(olMatch[1].trim())));
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
    if (paraLines.length > 0) {
      blocks.push(paragraphBlock(parseInline(paraLines.join("\n"))));
    }
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Feishu API
// ---------------------------------------------------------------------------

async function apiCall(method, urlPath, token, body) {
  const res = await fetch(`https://open.feishu.cn/open-apis${urlPath}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function createDocument(token, title, folderToken) {
  const body = {};
  if (title) body.title = title;
  if (folderToken) body.folder_token = folderToken;
  const data = await apiCall("POST", "/docx/v1/documents", token, body);
  if (data.code !== 0) {
    throw new Error(`Create document failed: code=${data.code} msg=${data.msg}`);
  }
  return data.data.document;
}

async function appendBlocks(token, documentId, blocks) {
  if (!blocks || blocks.length === 0) return;
  const BATCH = 50;
  for (let i = 0; i < blocks.length; i += BATCH) {
    const batch = blocks.slice(i, i + BATCH);
    const data = await apiCall(
      "POST",
      `/docx/v1/documents/${documentId}/blocks/${documentId}/children`,
      token,
      { children: batch, index: -1 },
    );
    if (data.code !== 0) {
      throw new Error(`Append blocks failed: code=${data.code} msg=${data.msg}`);
    }
  }
}

async function moveToWikiNode(token, documentId, wikiNode) {
  const nodeToken = wikiNode.includes("/") ? wikiNode.split("/").pop().split("?")[0] : wikiNode;

  const data = await apiCall("POST", "/wiki/v2/spaces/move_docs_to_wiki", token, {
    parent_wiki_token: nodeToken,
    obj_type: "docx",
    obj_token: documentId,
  });
  if (data.code !== 0) {
    throw new Error(`Move to wiki failed: code=${data.code} msg=${data.msg}`);
  }
  return data.data;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs();

  if (!args.openId) {
    die({ error: "missing_param", message: "--open-id 参数必填" });
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
    const doc = await createDocument(accessToken, args.title || "未命名文档", args.folderToken);
    const documentId = doc.document_id;
    const docUrl = `https://www.feishu.cn/docx/${documentId}`;

    if (args.markdown && args.markdown.trim()) {
      const blocks = markdownToBlocks(args.markdown);
      if (blocks.length > 0) {
        await appendBlocks(accessToken, documentId, blocks);
      }
    }

    if (args.wikiNode) {
      try {
        await moveToWikiNode(accessToken, documentId, args.wikiNode);
      } catch (wikiErr) {
        const warnTitle = args.title || doc.title || "未命名文档";
        await sendCard({
          openId: args.openId,
          title: "📄 文档已创建",
          body: `文档「${warnTitle}」已创建（移动到知识库失败：${wikiErr.message}）`,
          buttonText: "点击查看文档",
          buttonUrl: docUrl,
          color: "orange",
        }).catch(() => {});
        out({
          doc_id: documentId,
          doc_url: docUrl,
          title: warnTitle,
          wiki_move_failed: true,
          reply: `${replyCreated(warnTitle, docUrl)}（注意：移入知识库失败：${wikiErr.message}）`,
        });
        return;
      }
    }

    const finalTitle = args.title || doc.title || "未命名文档";
    await sendCard({
      openId: args.openId,
      title: "📄 文档已创建",
      body: `文档「${finalTitle}」创建成功`,
      buttonText: "点击查看文档",
      buttonUrl: docUrl,
      color: "green",
    }).catch(() => {});
    out({
      doc_id: documentId,
      doc_url: docUrl,
      title: finalTitle,
      reply: replyCreated(finalTitle, docUrl),
    });
  } catch (err) {
    if (err.message && err.message.includes("99991663")) {
      die({
        error: "auth_required",
        message: "飞书 token 已失效，请重新授权（调用 feishu-auth --init）",
      });
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
        required_scopes: ["docx:document", "docx:document:create", "docs:doc", "drive:drive"],
        reply: "⚠️ **权限不足，需要重新授权以获取所需权限。**",
      });
    }
    die({ error: "api_error", message: err.message });
  }
}

main();
