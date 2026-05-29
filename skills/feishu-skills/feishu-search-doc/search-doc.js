"use strict";
/**
 * feishu-search-doc: Search Feishu cloud docs and wiki (knowledge base) metadata.
 *
 * Uses per-user OAuth (same as other feishu-* skills).
 *
 * Usage:
 *   node search-doc.js --open-id <open_id> --query "关键词" [--action all|docs|wiki_spaces|wiki_nodes|drive]
 *
 *   # Wiki nodes under a space (title filter); root level if --parent-node-token omitted
 *   node search-doc.js --open-id <open_id> --query "标题" --action wiki_nodes --wiki-space-id "SPACE_ID"
 *
 *   # Optional: shallow BFS under a wiki space (--deep)
 *   node search-doc.js ... --action wiki_nodes --wiki-space-id "SPACE_ID" --deep [--max-visits 80]
 *
 *   # Drive folder: list & filter by name (requires --folder-token, empty = root)
 *   node search-doc.js --open-id <open_id> --query "文件夹" --action drive --folder-token "PARENT_TOKEN"
 *
 * Output: single-line JSON with reply + structured hits.
 */

const path = require("path");
const { getConfig, getValidToken } = require(path.join(__dirname, "../feishu-auth/token-utils.js"));

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function parseArgs() {
  const argv = process.argv.slice(2);
  const r = {
    openId: null,
    query: "",
    action: "all",
    wikiSpaceId: null,
    parentNodeToken: null,
    folderToken: "",
    count: 20,
    offset: 0,
    deep: false,
    maxVisits: 80,
    includeDrive: false,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--open-id":
        r.openId = argv[++i];
        break;
      case "--query":
      case "--q":
        r.query = argv[++i] || "";
        break;
      case "--action":
        r.action = (argv[++i] || "all").toLowerCase();
        break;
      case "--wiki-space-id":
        r.wikiSpaceId = argv[++i];
        break;
      case "--parent-node-token":
        r.parentNodeToken = argv[++i];
        break;
      case "--folder-token":
        r.folderToken = argv[++i] ?? "";
        break;
      case "--count":
        r.count = Math.min(50, Math.max(1, parseInt(argv[++i], 10) || 20));
        break;
      case "--offset":
        r.offset = Math.max(0, parseInt(argv[++i], 10) || 0);
        break;
      case "--deep":
        r.deep = true;
        break;
      case "--max-visits":
        r.maxVisits = Math.min(500, Math.max(1, parseInt(argv[++i], 10) || 80));
        break;
      case "--include-drive":
        r.includeDrive = true;
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

function norm(s) {
  return (s || "").toLowerCase();
}

function titleMatches(query, title) {
  if (!query) return true;
  return norm(title).includes(norm(query));
}

// ---------------------------------------------------------------------------
// HTTP
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
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${token}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`Feishu API parse error: ${res.status}`);
  }
  return data;
}

function docTypeToUrl(docsType, token) {
  if (!token) return "";
  const t = (docsType || "").toLowerCase();
  if (t === "docx") return `https://www.feishu.cn/docx/${token}`;
  if (t === "doc") return `https://www.feishu.cn/docs/${token}`;
  if (t === "sheet") return `https://www.feishu.cn/sheets/${token}`;
  if (t === "slides") return `https://www.feishu.cn/slides/${token}`;
  if (t === "bitable") return `https://www.feishu.cn/base/${token}`;
  if (t === "mindnote") return `https://www.feishu.cn/mindnotes/${token}`;
  if (t === "file") return `https://www.feishu.cn/file/${token}`;
  return `https://www.feishu.cn/docx/${token}`;
}

// ---------------------------------------------------------------------------
// APIs
// ---------------------------------------------------------------------------

/** POST /suite/docs-api/search/object */
async function searchDocsObjects(token, searchKey, count, offset) {
  const data = await apiCall("POST", "/suite/docs-api/search/object", token, {
    body: {
      search_key: searchKey,
      count,
      offset,
    },
  });
  if (data.code !== 0) {
    throw new Error(`Docs search failed: code=${data.code} msg=${data.msg}`);
  }
  const entities = data.data?.docs_entities || [];
  return {
    items: entities.map((e) => ({
      kind: "doc",
      docs_token: e.docs_token,
      docs_type: e.docs_type,
      title: e.title,
      owner_id: e.owner_id,
      url: docTypeToUrl(e.docs_type, e.docs_token),
      /** For create-doc --folder-token use feishu-drive; doc tokens are not folder_token */
      hint: "云文档搜索结果：新建文档请用 folder_token（云盘文件夹）或 wiki 节点；此处为文档/表格等 token。",
    })),
    has_more: !!data.data?.has_more,
    total: data.data?.total ?? entities.length,
  };
}

/** Collect multiple pages of docs search (offset + count < 200 per Feishu rule). */
async function searchDocsAllPages(token, searchKey, maxTotal = 50) {
  const items = [];
  let offset = 0;
  let hasMore = true;
  while (hasMore && items.length < maxTotal) {
    const take = Math.min(50, maxTotal - items.length);
    const batch = await searchDocsObjects(token, searchKey, take, offset);
    items.push(...batch.items);
    hasMore = batch.has_more && offset + take < 200;
    offset += take;
    if (!batch.items.length) break;
  }
  return items;
}

/** GET /wiki/v2/spaces */
async function listAllWikiSpaces(token) {
  const spaces = [];
  let pageToken;
  do {
    const query = { page_size: "50" };
    if (pageToken) query.page_token = pageToken;
    const data = await apiCall("GET", "/wiki/v2/spaces", token, { query });
    if (data.code !== 0) {
      throw new Error(`Wiki spaces list failed: code=${data.code} msg=${data.msg}`);
    }
    const list = data.data?.items || [];
    for (const s of list) {
      spaces.push({
        kind: "wiki_space",
        space_id: s.space_id,
        name: s.name,
        description: s.description,
        space_type: s.space_type,
      });
    }
    pageToken = data.data?.has_more ? data.data.page_token : undefined;
  } while (pageToken);
  return spaces;
}

/** GET /wiki/v2/spaces/:space_id/nodes — one parent level, all pages */
async function listWikiNodesLevel(token, spaceId, parentNodeToken) {
  const items = [];
  let pageToken;
  const parent = parentNodeToken || undefined;
  do {
    const query = { page_size: "50" };
    if (parent) query.parent_node_token = parent;
    if (pageToken) query.page_token = pageToken;
    const data = await apiCall(
      "GET",
      `/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes`,
      token,
      { query },
    );
    if (data.code !== 0) {
      throw new Error(`Wiki nodes list failed: code=${data.code} msg=${data.msg}`);
    }
    const list = data.data?.items || [];
    for (const n of list) {
      items.push({
        kind: "wiki_node",
        space_id: n.space_id,
        node_token: n.node_token,
        obj_token: n.obj_token,
        obj_type: n.obj_type,
        title: n.title,
        parent_node_token: n.parent_node_token,
        has_child: n.has_child,
        wiki_url: n.node_token ? `https://www.feishu.cn/wiki/${n.node_token}` : "",
        /** create-doc --wiki-node 使用 node_token */
        create_doc_flag: "--wiki-node",
        create_doc_token: n.node_token,
      });
    }
    pageToken = data.data?.has_more ? data.data.page_token : undefined;
  } while (pageToken);
  return items;
}

/** BFS wiki nodes, filter by title; bounded by maxVisits list calls */
async function searchWikiNodesDeep(token, spaceId, queryText, rootParentToken, maxVisits) {
  const matches = [];
  const queue = [];
  queue.push(rootParentToken || "");
  let visits = 0;

  while (queue.length > 0 && visits < maxVisits) {
    const parent = queue.shift();
    let pageToken;
    do {
      if (visits >= maxVisits) break;
      const q = { page_size: "50" };
      if (parent) q.parent_node_token = parent;
      if (pageToken) q.page_token = pageToken;
      const data = await apiCall(
        "GET",
        `/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes`,
        token,
        { query: q },
      );
      visits++;
      if (data.code !== 0) {
        throw new Error(`Wiki nodes list failed: code=${data.code} msg=${data.msg}`);
      }
      const list = data.data?.items || [];
      for (const n of list) {
        if (titleMatches(queryText, n.title)) {
          matches.push({
            kind: "wiki_node",
            space_id: n.space_id,
            node_token: n.node_token,
            obj_token: n.obj_token,
            obj_type: n.obj_type,
            title: n.title,
            parent_node_token: n.parent_node_token,
            has_child: n.has_child,
            wiki_url: n.node_token ? `https://www.feishu.cn/wiki/${n.node_token}` : "",
            create_doc_flag: "--wiki-node",
            create_doc_token: n.node_token,
          });
        }
        if (n.has_child && n.node_token) queue.push(n.node_token);
      }
      pageToken = data.data?.has_more ? data.data.page_token : undefined;
    } while (pageToken);
  }
  return { matches, visits };
}

/** GET /drive/v1/files — list folder, filter names */
async function listDriveFolderAll(token, folderToken) {
  const items = [];
  let pageToken;
  do {
    const query = { page_size: "200" };
    if (folderToken) query.folder_token = folderToken;
    if (pageToken) query.page_token = pageToken;
    const data = await apiCall("GET", "/drive/v1/files", token, { query });
    if (data.code !== 0) {
      throw new Error(`Drive list failed: code=${data.code} msg=${data.msg}`);
    }
    const list = data.data?.files || data.data?.items || [];
    items.push(...list);
    pageToken = data.data?.has_more ? data.data.page_token : undefined;
  } while (pageToken);
  return items;
}

function driveItemToHit(it) {
  const t = (it.type || "").toLowerCase();
  const token = it.token;
  let url = it.url || "";
  if (!url && token) {
    if (t === "folder") url = `https://www.feishu.cn/drive/folder/${token}`;
    else url = `https://www.feishu.cn/file/${token}`;
  }
  return {
    kind: "drive",
    type: it.type,
    token,
    name: it.name,
    parent_token: it.parent_token,
    url,
    /** create-doc --folder-token 使用云盘文件夹 token */
    create_doc_flag: t === "folder" ? "--folder-token" : null,
    create_doc_token: t === "folder" ? token : null,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function buildReply(payload) {
  const parts = [];
  if (payload.docs?.length) parts.push(`云文档 ${payload.docs.length} 条`);
  if (payload.wiki_spaces?.length) parts.push(`知识库空间 ${payload.wiki_spaces.length} 个`);
  if (payload.wiki_nodes?.length) parts.push(`知识库节点 ${payload.wiki_nodes.length} 个`);
  if (payload.drive?.length) parts.push(`云盘 ${payload.drive.length} 项`);
  const head = parts.length
    ? `搜索「${payload.query}」：` + parts.join("；")
    : `未找到与「${payload.query}」匹配的结果。`;
  return head + " 详见 JSON 各字段。";
}

async function main() {
  const args = parseArgs();

  if (!args.openId) die({ error: "missing_param", message: "--open-id 参数必填" });

  const needQuery = ["all", "docs", "wiki_spaces", "wiki_nodes", "drive"].includes(args.action);
  if (needQuery && !args.query.trim()) {
    die({ error: "missing_param", message: "--query（或 -q）参数必填" });
  }

  if (args.action === "wiki_nodes" && !args.wikiSpaceId) {
    die({
      error: "missing_param",
      message:
        "--action wiki_nodes 时必须提供 --wiki-space-id（可用 list_wiki_spaces 或 action all 先查空间）",
    });
  }

  // Namespace guard: IM file_key (file_* prefix) is NOT a drive folder_token.
  // Reject here to prevent misrouted IM folder attachments from silently
  // falling back to root-directory listing and hallucinating results.
  if (args.folderToken && /^file_/.test(args.folderToken)) {
    die({
      error: "invalid_folder_token_im_file_key",
      message:
        "传入的是 IM 消息 file_key（以 file_ 开头），不是云盘 folder_token。" +
        '若来源是 IM 文件夹附件 <folder key="file_v3_..."/>，当前飞书 open API 未公开该附件的读取接口，不要调用本 skill。',
      hint: "引导用户：① 本地把文件夹压缩为 .zip 后发送；或 ② 上传云盘后分享 /drive/folder/<token> 链接。",
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

  const payload = {
    query: args.query,
    action: args.action,
    docs: [],
    wiki_spaces: [],
    wiki_nodes: [],
    drive: [],
  };

  try {
    if (args.action === "docs") {
      const batch = await searchDocsObjects(accessToken, args.query, args.count, args.offset);
      payload.docs = batch.items;
      payload.docs_meta = { has_more: batch.has_more, total: batch.total };
    } else if (args.action === "wiki_spaces") {
      const all = await listAllWikiSpaces(accessToken);
      payload.wiki_spaces = all.filter((s) => titleMatches(args.query, s.name));
    } else if (args.action === "wiki_nodes") {
      if (args.deep) {
        const { matches, visits } = await searchWikiNodesDeep(
          accessToken,
          args.wikiSpaceId,
          args.query,
          args.parentNodeToken,
          args.maxVisits,
        );
        payload.wiki_nodes = matches;
        payload.wiki_search_meta = { visits, max_visits: args.maxVisits, deep: true };
      } else {
        const level = await listWikiNodesLevel(accessToken, args.wikiSpaceId, args.parentNodeToken);
        payload.wiki_nodes = level.filter((n) => titleMatches(args.query, n.title));
      }
    } else if (args.action === "drive") {
      const raw = await listDriveFolderAll(accessToken, args.folderToken || "");
      payload.drive = raw.filter((it) => titleMatches(args.query, it.name)).map(driveItemToHit);
      payload.drive_scope = args.folderToken
        ? { kind: "folder", folder_token: args.folderToken }
        : {
            kind: "root",
            warning:
              '⚠️ 当前为云盘根目录，不是任何具体文件夹。若用户本意查某个文件夹但未提供 folder_token，不要把此结果当作"该文件夹的内容"回复用户。',
          };
    } else if (args.action === "list_wiki_spaces") {
      payload.wiki_spaces = await listAllWikiSpaces(accessToken);
      payload.query = args.query || "";
      payload.reply = `共 ${payload.wiki_spaces.length} 个知识库空间，详见 wiki_spaces。`;
    } else if (args.action === "all") {
      const [docs, spaces] = await Promise.all([
        searchDocsAllPages(accessToken, args.query, 50),
        listAllWikiSpaces(accessToken),
      ]);
      payload.docs = docs;
      payload.wiki_spaces = spaces.filter((s) => titleMatches(args.query, s.name));
      if (args.includeDrive) {
        const raw = await listDriveFolderAll(accessToken, args.folderToken || "");
        payload.drive = raw.filter((it) => titleMatches(args.query, it.name)).map(driveItemToHit);
      }
    } else {
      die({
        error: "unsupported_action",
        message: `未知 action: ${args.action}。支持: all, docs, wiki_spaces, list_wiki_spaces, wiki_nodes, drive`,
      });
    }

    if (!payload.reply) payload.reply = buildReply(payload);
    out(payload);
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
      die({
        error: "permission_required",
        message: msg,
        required_scopes: [
          "drive:drive",
          "drive:drive:readonly",
          "search:docs:read",
          "wiki:wiki",
          "wiki:wiki:readonly",
          "wiki:space:retrieve",
          "wiki:node:retrieve",
        ],
        reply: "⚠️ **权限不足，需要重新授权或管理员开通云文档搜索 / 知识库相关权限。**",
      });
    }
    die({ error: "api_error", message: err.message });
  }
}

main();
