"use strict";
/**
 * feishu-sheet: Feishu Spreadsheet (电子表格) operations using per-user OAuth token.
 *
 * Actions:
 *   info    - Get spreadsheet info and list all worksheets
 *   read    - Read cell values from a range
 *   write   - Overwrite cell values (HIGH RISK: replaces existing data)
 *   append  - Append rows after existing data
 *   find    - Search for cells matching a value/regex
 *   create  - Create a new spreadsheet (optionally with headers + data)
 *   export  - Export spreadsheet as xlsx or csv
 *
 * Usage:
 *   node sheet.js --open-id ou_xxx --action info --url "https://xxx.feishu.cn/sheets/TOKEN"
 *   node sheet.js --open-id ou_xxx --action read --url "https://..." [--sheet-id ID] [--range "ID!A1:D10"]
 *   node sheet.js --open-id ou_xxx --action write --url "https://..." --values '[["A","B"],["1","2"]]'
 *   node sheet.js --open-id ou_xxx --action append --url "https://..." --values '[["row1","row2"]]'
 *   node sheet.js --open-id ou_xxx --action find --url "https://..." --sheet-id ID --find "keyword"
 *   node sheet.js --open-id ou_xxx --action create --title "标题" [--headers '["A","B"]'] [--data '[["1","2"]]']
 *   node sheet.js --open-id ou_xxx --action export --url "https://..." --file-extension xlsx [--output-path out.xlsx]
 *
 * Output: single-line JSON
 *   Success: action-specific fields + "reply" for user-facing text
 *   Auth:    {"error":"auth_required","message":"..."}
 *   Error:   {"error":"api_error","message":"..."}
 */

const path = require("path");
const fs = require("fs");
const { getConfig, getValidToken } = require(path.join(__dirname, "../feishu-auth/token-utils.js"));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_READ_ROWS = 200;
const MAX_WRITE_ROWS = 5000;
const MAX_WRITE_COLS = 100;
const EXPORT_POLL_INTERVAL = 1500;
const EXPORT_POLL_MAX_TRIES = 20;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs() {
  const argv = process.argv.slice(2);
  const r = {
    openId: null,
    action: null,
    url: null,
    spreadsheetToken: null,
    range: null,
    sheetId: null,
    values: null,
    valueRenderOption: "ToString",
    find: null,
    matchCase: undefined,
    matchEntireCell: undefined,
    searchByRegex: undefined,
    includeFormulas: undefined,
    title: null,
    folderToken: null,
    headers: null,
    data: null,
    fileExtension: null,
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
      case "--url":
        r.url = argv[++i];
        break;
      case "--spreadsheet-token":
        r.spreadsheetToken = argv[++i];
        break;
      case "--range":
        r.range = argv[++i];
        break;
      case "--sheet-id":
        r.sheetId = argv[++i];
        break;
      case "--values":
        r.values = JSON.parse(argv[++i]);
        break;
      case "--value-render-option":
        r.valueRenderOption = argv[++i];
        break;
      case "--find":
        r.find = argv[++i];
        break;
      case "--match-case":
        r.matchCase = argv[++i] !== "false";
        break;
      case "--match-entire-cell":
        r.matchEntireCell = argv[++i] !== "false";
        break;
      case "--search-by-regex":
        r.searchByRegex = argv[++i] !== "false";
        break;
      case "--include-formulas":
        r.includeFormulas = argv[++i] !== "false";
        break;
      case "--title":
        r.title = argv[++i];
        break;
      case "--folder-token":
        r.folderToken = argv[++i];
        break;
      case "--headers":
        r.headers = JSON.parse(argv[++i]);
        break;
      case "--data":
        r.data = JSON.parse(argv[++i]);
        break;
      case "--file-extension":
        r.fileExtension = argv[++i];
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
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------------

async function apiCall(method, urlPath, accessToken, { body, query } = {}) {
  let url = `https://open.feishu.cn/open-apis${urlPath}`;
  if (query) {
    const entries = Object.entries(query).filter(([, v]) => v != null);
    if (entries.length > 0) {
      url += "?" + new URLSearchParams(Object.fromEntries(entries)).toString();
    }
  }
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    throw new Error(`API 返回非 JSON 响应 (HTTP ${res.status})`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Token / range helpers
// ---------------------------------------------------------------------------

function parseSheetUrl(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/(?:sheets|wiki)\/([^/?#]+)/);
    if (!m) return null;
    return { token: m[1], sheetId: u.searchParams.get("sheet") || null };
  } catch {
    return null;
  }
}

function isWikiToken(token) {
  if (token.length >= 15 && token[4] + token[9] + token[14] === "wik") return true;
  return token.startsWith("wik");
}

async function resolveSpreadsheetToken(args, accessToken) {
  let token,
    urlSheetId = null;

  if (args.spreadsheetToken) {
    token = args.spreadsheetToken;
  } else if (args.url) {
    const parsed = parseSheetUrl(args.url);
    if (!parsed) throw new Error(`无法从 URL 解析 spreadsheet_token: ${args.url}`);
    token = parsed.token;
    urlSheetId = parsed.sheetId;
  } else {
    throw new Error("--url 或 --spreadsheet-token 参数必填");
  }

  if (isWikiToken(token)) {
    const data = await apiCall("GET", "/wiki/v2/spaces/get_node", accessToken, {
      query: { token, obj_type: "wiki" },
    });
    if (data.code !== 0) throw new Error(`Wiki 节点解析失败: code=${data.code} msg=${data.msg}`);
    const node = data.data?.node;
    const obj = node?.obj_token;
    if (!obj) throw new Error(`无法从 wiki token 解析 spreadsheet_token: ${token}`);
    const objType = node.obj_type;
    if (objType && objType !== "sheet") {
      const typeHints = {
        bitable: "这是一个多维表格（Bitable），请改用 feishu-bitable 技能操作。",
        docx: "这是一个文档（Docx），请改用 feishu-fetch-doc 技能读取。",
        doc: "这是一个文档（Doc），请改用 feishu-fetch-doc 技能读取。",
        file: "这是一个文件附件，请改用 feishu-docx-download 技能下载。",
        mindnote: "这是一个思维笔记，feishu-sheet 不支持此类型。",
        slides: "这是一个幻灯片，feishu-sheet 不支持此类型。",
      };
      const hint = typeHints[objType] || `该知识库节点类型为 ${objType}，不是电子表格（sheet）。`;
      throw new Error(`类型不匹配：${hint}（节点标题：${node.title || ""}）`);
    }
    token = obj;
  }

  return { token, urlSheetId };
}

async function getFirstSheetId(spreadsheetToken, accessToken) {
  const data = await apiCall(
    "GET",
    `/sheets/v3/spreadsheets/${spreadsheetToken}/sheets/query`,
    accessToken,
  );
  if (data.code !== 0) throw new Error(`获取工作表列表失败: code=${data.code} msg=${data.msg}`);
  const first = (data.data?.sheets ?? [])[0];
  if (!first?.sheet_id) throw new Error("该电子表格没有工作表");
  return first.sheet_id;
}

async function resolveRange(spreadsheetToken, range, sheetId, accessToken) {
  if (range) return range;
  if (sheetId) return sheetId;
  return getFirstSheetId(spreadsheetToken, accessToken);
}

function colLetter(n) {
  let r = "";
  while (n > 0) {
    n--;
    r = String.fromCharCode(65 + (n % 26)) + r;
    n = Math.floor(n / 26);
  }
  return r;
}

function flattenCellValue(cell) {
  if (!Array.isArray(cell)) return cell;
  if (cell.length > 0 && cell.every((s) => s != null && typeof s === "object" && "text" in s)) {
    return cell.map((s) => s.text).join("");
  }
  return cell;
}

function flattenValues(values) {
  return values ? values.map((row) => row.map(flattenCellValue)) : values;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function actionInfo(args, accessToken) {
  const { token } = await resolveSpreadsheetToken(args, accessToken);

  const [ssRes, shRes] = await Promise.all([
    apiCall("GET", `/sheets/v3/spreadsheets/${token}`, accessToken),
    apiCall("GET", `/sheets/v3/spreadsheets/${token}/sheets/query`, accessToken),
  ]);

  if (ssRes.code !== 0) throw new Error(`code=${ssRes.code} msg=${ssRes.msg}`);
  if (shRes.code !== 0) throw new Error(`code=${shRes.code} msg=${shRes.msg}`);

  const ss = ssRes.data?.spreadsheet;
  const sheets = (shRes.data?.sheets ?? []).map((s) => ({
    sheet_id: s.sheet_id,
    title: s.title,
    index: s.index,
    row_count: s.grid_properties?.row_count,
    column_count: s.grid_properties?.column_count,
  }));

  out({
    title: ss?.title,
    spreadsheet_token: token,
    url: `https://www.feishu.cn/sheets/${token}`,
    sheets,
    reply: `电子表格「${ss?.title}」，共 ${sheets.length} 个工作表：${sheets.map((s) => `${s.title}（${s.sheet_id}）`).join("、")}`,
  });
}

async function actionRead(args, accessToken) {
  const { token, urlSheetId } = await resolveSpreadsheetToken(args, accessToken);
  const range = await resolveRange(token, args.range, args.sheetId || urlSheetId, accessToken);

  const data = await apiCall(
    "GET",
    `/sheets/v2/spreadsheets/${token}/values/${encodeURIComponent(range)}`,
    accessToken,
    {
      query: { valueRenderOption: args.valueRenderOption, dateTimeRenderOption: "FormattedString" },
    },
  );
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);

  const vr = data.data?.valueRange;
  let values = flattenValues(vr?.values);
  const totalRows = values ? values.length : 0;
  let truncated = false;
  if (values && values.length > MAX_READ_ROWS) {
    values = values.slice(0, MAX_READ_ROWS);
    truncated = true;
  }

  out({
    range: vr?.range,
    values,
    ...(truncated
      ? {
          truncated: true,
          total_rows: totalRows,
          hint: `数据超过 ${MAX_READ_ROWS} 行已截断，请缩小 range 后重新读取`,
        }
      : {}),
    reply: `读取到 ${totalRows} 行数据${truncated ? `（已截断至 ${MAX_READ_ROWS} 行）` : ""}`,
  });
}

async function actionWrite(args, accessToken) {
  if (!args.values) die({ error: "missing_param", message: "--values 参数必填（JSON 二维数组）" });
  if (args.values.length > MAX_WRITE_ROWS)
    die({ error: "param_error", message: `行数 ${args.values.length} 超过上限 ${MAX_WRITE_ROWS}` });
  if (args.values.some((r) => r.length > MAX_WRITE_COLS))
    die({ error: "param_error", message: `列数超过上限 ${MAX_WRITE_COLS}` });

  const { token, urlSheetId } = await resolveSpreadsheetToken(args, accessToken);
  const range = await resolveRange(token, args.range, args.sheetId || urlSheetId, accessToken);

  const data = await apiCall("PUT", `/sheets/v2/spreadsheets/${token}/values`, accessToken, {
    body: { valueRange: { range, values: args.values } },
  });
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);

  const d = data.data || {};
  out({
    updated_range: d.updatedRange,
    updated_rows: d.updatedRows,
    updated_columns: d.updatedColumns,
    updated_cells: d.updatedCells,
    reply: `已写入 ${d.updatedCells ?? 0} 个单元格（${d.updatedRows ?? 0} 行 × ${d.updatedColumns ?? 0} 列）`,
  });
}

async function actionAppend(args, accessToken) {
  if (!args.values) die({ error: "missing_param", message: "--values 参数必填（JSON 二维数组）" });
  if (args.values.length > MAX_WRITE_ROWS)
    die({ error: "param_error", message: `行数 ${args.values.length} 超过上限 ${MAX_WRITE_ROWS}` });

  const { token, urlSheetId } = await resolveSpreadsheetToken(args, accessToken);
  const range = await resolveRange(token, args.range, args.sheetId || urlSheetId, accessToken);

  const data = await apiCall(
    "POST",
    `/sheets/v2/spreadsheets/${token}/values_append`,
    accessToken,
    {
      body: { valueRange: { range, values: args.values } },
    },
  );
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);

  const u = data.data?.updates || {};
  out({
    table_range: data.data?.tableRange,
    updated_range: u.updatedRange,
    updated_rows: u.updatedRows,
    updated_columns: u.updatedColumns,
    updated_cells: u.updatedCells,
    reply: `已追加 ${u.updatedRows ?? 0} 行（${u.updatedCells ?? 0} 个单元格）`,
  });
}

async function actionFind(args, accessToken) {
  if (!args.sheetId)
    die({ error: "missing_param", message: "--sheet-id 参数必填（可通过 info action 获取）" });
  if (!args.find) die({ error: "missing_param", message: "--find 参数必填（搜索内容）" });

  const { token } = await resolveSpreadsheetToken(args, accessToken);

  const findCondition = {
    range: args.range ? `${args.sheetId}!${args.range}` : args.sheetId,
  };
  // Note: Feishu API match_case is inverted (true = case-insensitive, false = case-sensitive)
  if (args.matchCase !== undefined) findCondition.match_case = !args.matchCase;
  if (args.matchEntireCell !== undefined) findCondition.match_entire_cell = args.matchEntireCell;
  if (args.searchByRegex !== undefined) findCondition.search_by_regex = args.searchByRegex;
  if (args.includeFormulas !== undefined) findCondition.include_formulas = args.includeFormulas;

  const data = await apiCall(
    "POST",
    `/sheets/v2/spreadsheets/${token}/sheets/${args.sheetId}/find`,
    accessToken,
    { body: { find_condition: findCondition, find: args.find } },
  );
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);

  const fr = data.data?.find_result || {};
  const matched = fr.matched_cells || [];
  out({
    matched_cells: matched,
    matched_formula_cells: fr.matched_formula_cells,
    rows_count: fr.rows_count,
    reply: `找到 ${matched.length} 个匹配单元格`,
  });
}

async function actionCreate(args, accessToken) {
  if (!args.title) die({ error: "missing_param", message: "--title 参数必填" });

  const createData = await apiCall("POST", "/sheets/v1/spreadsheets", accessToken, {
    body: { title: args.title, ...(args.folderToken ? { folder_token: args.folderToken } : {}) },
  });
  if (createData.code !== 0) throw new Error(`code=${createData.code} msg=${createData.msg}`);

  const ss = createData.data?.spreadsheet;
  const token = ss?.spreadsheet_token;
  if (!token) throw new Error("创建表格失败：未返回 spreadsheet_token");

  const url = `https://www.feishu.cn/sheets/${token}`;

  if (args.headers || args.data) {
    const allRows = [...(args.headers ? [args.headers] : []), ...(args.data || [])];
    if (allRows.length > 0) {
      const sheetsData = await apiCall(
        "GET",
        `/sheets/v3/spreadsheets/${token}/sheets/query`,
        accessToken,
      );
      const firstSheet = (sheetsData.data?.sheets ?? [])[0];
      if (firstSheet?.sheet_id) {
        const numCols = Math.max(...allRows.map((r) => r.length));
        const range = `${firstSheet.sheet_id}!A1:${colLetter(numCols)}${allRows.length}`;
        const writeData = await apiCall(
          "PUT",
          `/sheets/v2/spreadsheets/${token}/values`,
          accessToken,
          {
            body: { valueRange: { range, values: allRows } },
          },
        );
        if (writeData.code !== 0) {
          out({
            spreadsheet_token: token,
            url,
            title: args.title,
            warning: `表格已创建，但写入初始数据失败: ${writeData.msg}`,
          });
          return;
        }
      }
    }
  }

  out({
    spreadsheet_token: token,
    title: args.title,
    url,
    reply: `已创建电子表格「${args.title}」：${url}`,
  });
}

async function actionExport(args, accessToken) {
  if (!args.fileExtension)
    die({ error: "missing_param", message: "--file-extension 参数必填（xlsx 或 csv）" });
  if (args.fileExtension === "csv" && !args.sheetId) {
    die({
      error: "missing_param",
      message: "CSV 导出时 --sheet-id 必填（CSV 一次只能导出一个工作表）",
    });
  }

  const { token } = await resolveSpreadsheetToken(args, accessToken);

  const createData = await apiCall("POST", "/drive/v1/export_tasks", accessToken, {
    body: {
      file_extension: args.fileExtension,
      token,
      type: "sheet",
      ...(args.sheetId ? { sub_id: args.sheetId } : {}),
    },
  });
  if (createData.code !== 0)
    throw new Error(`创建导出任务失败: code=${createData.code} msg=${createData.msg}`);

  const ticket = createData.data?.ticket;
  if (!ticket) throw new Error("创建导出任务失败：未返回 ticket");

  let fileToken, fileName, fileSize;
  for (let i = 0; i < EXPORT_POLL_MAX_TRIES; i++) {
    await sleep(EXPORT_POLL_INTERVAL);
    const pollData = await apiCall("GET", `/drive/v1/export_tasks/${ticket}`, accessToken, {
      query: { token },
    });
    if (pollData.code !== 0)
      throw new Error(`轮询导出状态失败: code=${pollData.code} msg=${pollData.msg}`);
    const result = pollData.data?.result;
    if (result?.job_status === 0) {
      fileToken = result.file_token;
      fileName = result.file_name;
      fileSize = result.file_size;
      break;
    }
    if (result?.job_status >= 3)
      throw new Error(`导出失败: ${result.job_error_msg || `status=${result.job_status}`}`);
  }
  if (!fileToken) throw new Error("导出超时：任务在 30 秒内未完成");

  if (args.outputPath) {
    const dlRes = await fetch(
      `https://open.feishu.cn/open-apis/drive/v1/export_tasks/file/${fileToken}/download`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!dlRes.ok) throw new Error(`下载失败: HTTP ${dlRes.status}`);
    const buffer = Buffer.from(await dlRes.arrayBuffer());
    const dir = path.dirname(args.outputPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(args.outputPath, buffer);
    out({
      file_path: args.outputPath,
      file_name: fileName,
      file_size: fileSize,
      reply: `已导出并保存到 ${args.outputPath}（${fileName}，${fileSize} 字节）`,
    });
    return;
  }

  out({
    file_token: fileToken,
    file_name: fileName,
    file_size: fileSize,
    hint: "如需下载到本地，请提供 --output-path 参数",
    reply: `导出完成：${fileName}（${fileSize} 字节）`,
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs();
  if (!args.openId) die({ error: "missing_param", message: "--open-id 参数必填" });
  if (!args.action)
    die({
      error: "missing_param",
      message: "--action 参数必填（info/read/write/append/find/create/export）",
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
    switch (args.action) {
      case "info":
        await actionInfo(args, accessToken);
        break;
      case "read":
        await actionRead(args, accessToken);
        break;
      case "write":
        await actionWrite(args, accessToken);
        break;
      case "append":
        await actionAppend(args, accessToken);
        break;
      case "find":
        await actionFind(args, accessToken);
        break;
      case "create":
        await actionCreate(args, accessToken);
        break;
      case "export":
        await actionExport(args, accessToken);
        break;
      default:
        die({
          error: "unsupported_action",
          message: `不支持的 action: ${args.action}。支持：info/read/write/append/find/create/export`,
        });
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
        required_scopes: ["sheets:spreadsheet", "drive:drive"],
        reply: "**权限不足，需要重新授权以获取访问电子表格的权限。**",
      });
    }
    die({ error: "api_error", message: msg });
  }
}

main();
