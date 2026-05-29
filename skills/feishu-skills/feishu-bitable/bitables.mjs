/**
 * feishu-bitable: Feishu Bitable (multi-dimensional table) management via user OAuth.
 *
 * Usage:
 *   node bitables.mjs --action <action> --open-id <open_id> [options]
 *
 * App:    create_app, get_app, list_apps, copy_app, update_app
 * Table:  create_table, list_tables, delete_table, update_table, batch_create_tables, batch_delete_tables
 * Field:  create_field, list_fields, update_field, delete_field
 * Record: create_record, list_records, update_record, delete_record,
 *         batch_create_records, batch_update_records, batch_delete_records
 * View:   create_view, list_views, get_view, update_view, delete_view
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig, getValidToken } from "../feishu-auth/token-utils.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs() {
  const argv = process.argv.slice(2);
  const r = {
    action: null,
    openId: null,
    appToken: null,
    tableId: null,
    fieldId: null,
    recordId: null,
    viewId: null,
    name: null,
    fields: null,
    records: null,
    filter: null,
    sort: null,
    pageSize: 100,
    pageToken: null,
    folderToken: null,
    fieldType: null,
    property: null,
    viewType: null,
    recordIds: null,
    tableIds: null,
    tableNames: null,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--action":
        r.action = argv[++i];
        break;
      case "--open-id":
        r.openId = argv[++i];
        break;
      case "--app-token":
        r.appToken = argv[++i];
        break;
      case "--table-id":
        r.tableId = argv[++i];
        break;
      case "--field-id":
        r.fieldId = argv[++i];
        break;
      case "--record-id":
        r.recordId = argv[++i];
        break;
      case "--view-id":
        r.viewId = argv[++i];
        break;
      case "--name":
        r.name = argv[++i];
        break;
      case "--fields":
        r.fields = argv[++i];
        break;
      case "--records":
        r.records = argv[++i];
        break;
      case "--filter":
        r.filter = argv[++i];
        break;
      case "--sort":
        r.sort = argv[++i];
        break;
      case "--page-size":
        r.pageSize = parseInt(argv[++i], 10);
        break;
      case "--page-token":
        r.pageToken = argv[++i];
        break;
      case "--folder-token":
        r.folderToken = argv[++i];
        break;
      case "--field-type":
        r.fieldType = parseInt(argv[++i], 10);
        break;
      case "--property":
        r.property = argv[++i];
        break;
      case "--view-type":
        r.viewType = argv[++i];
        break;
      case "--record-ids":
        r.recordIds = argv[++i];
        break;
      case "--table-ids":
        r.tableIds = argv[++i];
        break;
      case "--table-names":
        r.tableNames = argv[++i];
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
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

function tryParseJSON(str) {
  if (!str) return null;
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function requireAppToken(args) {
  if (!args.appToken) die({ error: "missing_param", message: "--app-token 必填" });
}
function requireTableId(args) {
  requireAppToken(args);
  if (!args.tableId) die({ error: "missing_param", message: "--table-id 必填" });
}

// ---------------------------------------------------------------------------
// App actions
// ---------------------------------------------------------------------------

async function createApp(args, token) {
  const body = { name: args.name || "未命名多维表格" };
  if (args.folderToken) body.folder_token = args.folderToken;
  const data = await apiCall("POST", "/bitable/v1/apps", token, body);
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({ app: data.data?.app, reply: `多维表格「${args.name}」已创建` });
}

async function getApp(args, token) {
  requireAppToken(args);
  const data = await apiCall("GET", `/bitable/v1/apps/${args.appToken}`, token);
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({ app: data.data?.app });
}

async function updateApp(args, token) {
  requireAppToken(args);
  const body = {};
  if (args.name) body.name = args.name;
  const data = await apiCall("PUT", `/bitable/v1/apps/${args.appToken}`, token, body);
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({ app: data.data?.app, reply: "多维表格已更新" });
}

async function copyApp(args, token) {
  requireAppToken(args);
  const body = { name: args.name || "副本" };
  if (args.folderToken) body.folder_token = args.folderToken;
  const data = await apiCall("POST", `/bitable/v1/apps/${args.appToken}/copy`, token, body);
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({ app: data.data?.app, reply: "多维表格已复制" });
}

// ---------------------------------------------------------------------------
// Table actions
// ---------------------------------------------------------------------------

async function createTable(args, token) {
  requireAppToken(args);
  const body = { table: { name: args.name || "未命名表格" } };
  const fieldsJson = tryParseJSON(args.fields);
  if (fieldsJson) body.table.fields = fieldsJson;
  const data = await apiCall("POST", `/bitable/v1/apps/${args.appToken}/tables`, token, body);
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({ table_id: data.data?.table_id, reply: `表格「${args.name}」已创建` });
}

async function listTables(args, token) {
  requireAppToken(args);
  const query = { page_size: String(args.pageSize) };
  if (args.pageToken) query.page_token = args.pageToken;
  const data = await apiCall("GET", `/bitable/v1/apps/${args.appToken}/tables`, token, null, query);
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({
    tables: data.data?.items || [],
    has_more: data.data?.has_more,
    page_token: data.data?.page_token,
  });
}

async function deleteTable(args, token) {
  requireTableId(args);
  const data = await apiCall(
    "DELETE",
    `/bitable/v1/apps/${args.appToken}/tables/${args.tableId}`,
    token,
  );
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({ success: true, reply: "表格已删除" });
}

async function updateTable(args, token) {
  requireTableId(args);
  const body = {};
  if (args.name) body.name = args.name;
  const data = await apiCall(
    "PATCH",
    `/bitable/v1/apps/${args.appToken}/tables/${args.tableId}`,
    token,
    body,
  );
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({ success: true, reply: "表格已更新" });
}

async function batchCreateTables(args, token) {
  requireAppToken(args);
  const names = (args.tableNames || "").split(",").filter(Boolean);
  if (!names.length) die({ error: "missing_param", message: "--table-names 必填（逗号分隔）" });
  const body = { tables: names.map((n) => ({ name: n.trim() })) };
  const data = await apiCall(
    "POST",
    `/bitable/v1/apps/${args.appToken}/tables/batch_create`,
    token,
    body,
  );
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({ table_ids: data.data?.table_ids, reply: `${names.length} 个表格已创建` });
}

async function batchDeleteTables(args, token) {
  requireAppToken(args);
  const ids = (args.tableIds || "").split(",").filter(Boolean);
  if (!ids.length) die({ error: "missing_param", message: "--table-ids 必填（逗号分隔）" });
  const body = { table_ids: ids.map((id) => id.trim()) };
  const data = await apiCall(
    "POST",
    `/bitable/v1/apps/${args.appToken}/tables/batch_delete`,
    token,
    body,
  );
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({ success: true, reply: `${ids.length} 个表格已删除` });
}

// ---------------------------------------------------------------------------
// Field actions
// ---------------------------------------------------------------------------

async function createField(args, token) {
  requireTableId(args);
  const body = {
    field_name: args.name || "未命名字段",
    type: args.fieldType || 1,
  };
  const prop = tryParseJSON(args.property);
  if (prop) body.property = prop;
  const data = await apiCall(
    "POST",
    `/bitable/v1/apps/${args.appToken}/tables/${args.tableId}/fields`,
    token,
    body,
  );
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({ field: data.data?.field, reply: `字段「${args.name}」已创建` });
}

async function listFields(args, token) {
  requireTableId(args);
  const query = { page_size: String(args.pageSize) };
  if (args.pageToken) query.page_token = args.pageToken;
  const data = await apiCall(
    "GET",
    `/bitable/v1/apps/${args.appToken}/tables/${args.tableId}/fields`,
    token,
    null,
    query,
  );
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({
    fields: data.data?.items || [],
    has_more: data.data?.has_more,
    page_token: data.data?.page_token,
  });
}

async function updateField(args, token) {
  requireTableId(args);
  if (!args.fieldId) die({ error: "missing_param", message: "--field-id 必填" });
  const body = {};
  if (args.name) body.field_name = args.name;
  if (args.fieldType) body.type = args.fieldType;
  const prop = tryParseJSON(args.property);
  if (prop) body.property = prop;
  const data = await apiCall(
    "PUT",
    `/bitable/v1/apps/${args.appToken}/tables/${args.tableId}/fields/${args.fieldId}`,
    token,
    body,
  );
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({ field: data.data?.field, reply: "字段已更新" });
}

async function deleteField(args, token) {
  requireTableId(args);
  if (!args.fieldId) die({ error: "missing_param", message: "--field-id 必填" });
  const data = await apiCall(
    "DELETE",
    `/bitable/v1/apps/${args.appToken}/tables/${args.tableId}/fields/${args.fieldId}`,
    token,
  );
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({ success: true, reply: "字段已删除" });
}

// ---------------------------------------------------------------------------
// Record actions
// ---------------------------------------------------------------------------

async function createRecord(args, token) {
  requireTableId(args);
  const fieldsJson = tryParseJSON(args.fields);
  if (!fieldsJson) die({ error: "missing_param", message: "--fields 必填（JSON 格式）" });
  const body = { fields: fieldsJson };
  const data = await apiCall(
    "POST",
    `/bitable/v1/apps/${args.appToken}/tables/${args.tableId}/records`,
    token,
    body,
    { user_id_type: "open_id" },
  );
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({ record: data.data?.record, reply: "记录已创建" });
}

async function listRecords(args, token) {
  requireTableId(args);
  const query = { page_size: String(Math.min(args.pageSize, 500)), user_id_type: "open_id" };
  if (args.pageToken) query.page_token = args.pageToken;
  if (args.viewId) query.view_id = args.viewId;
  if (args.filter) query.filter = args.filter;
  if (args.sort) query.sort = args.sort;
  const data = await apiCall(
    "GET",
    `/bitable/v1/apps/${args.appToken}/tables/${args.tableId}/records`,
    token,
    null,
    query,
  );
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({
    records: data.data?.items || [],
    total: data.data?.total,
    has_more: data.data?.has_more,
    page_token: data.data?.page_token,
  });
}

async function updateRecord(args, token) {
  requireTableId(args);
  if (!args.recordId) die({ error: "missing_param", message: "--record-id 必填" });
  const fieldsJson = tryParseJSON(args.fields);
  if (!fieldsJson) die({ error: "missing_param", message: "--fields 必填（JSON 格式）" });
  const body = { fields: fieldsJson };
  const data = await apiCall(
    "PUT",
    `/bitable/v1/apps/${args.appToken}/tables/${args.tableId}/records/${args.recordId}`,
    token,
    body,
    { user_id_type: "open_id" },
  );
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({ record: data.data?.record, reply: "记录已更新" });
}

async function deleteRecord(args, token) {
  requireTableId(args);
  if (!args.recordId) die({ error: "missing_param", message: "--record-id 必填" });
  const data = await apiCall(
    "DELETE",
    `/bitable/v1/apps/${args.appToken}/tables/${args.tableId}/records/${args.recordId}`,
    token,
  );
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({ success: true, reply: "记录已删除" });
}

async function batchCreateRecords(args, token) {
  requireTableId(args);
  const recordsJson = tryParseJSON(args.records);
  if (!recordsJson || !Array.isArray(recordsJson))
    die({ error: "missing_param", message: "--records 必填（JSON 数组）" });
  const body = { records: recordsJson.map((r) => ({ fields: r })) };
  const data = await apiCall(
    "POST",
    `/bitable/v1/apps/${args.appToken}/tables/${args.tableId}/records/batch_create`,
    token,
    body,
    { user_id_type: "open_id" },
  );
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({ records: data.data?.records, reply: `${recordsJson.length} 条记录已创建` });
}

async function batchUpdateRecords(args, token) {
  requireTableId(args);
  const recordsJson = tryParseJSON(args.records);
  if (!recordsJson || !Array.isArray(recordsJson))
    die({ error: "missing_param", message: "--records 必填（JSON 数组，含 record_id 和 fields）" });
  const body = { records: recordsJson };
  const data = await apiCall(
    "POST",
    `/bitable/v1/apps/${args.appToken}/tables/${args.tableId}/records/batch_update`,
    token,
    body,
    { user_id_type: "open_id" },
  );
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({ records: data.data?.records, reply: `${recordsJson.length} 条记录已更新` });
}

async function batchDeleteRecords(args, token) {
  requireTableId(args);
  const ids = (args.recordIds || "").split(",").filter(Boolean);
  if (!ids.length) die({ error: "missing_param", message: "--record-ids 必填（逗号分隔）" });
  const body = { records: ids.map((id) => id.trim()) };
  const data = await apiCall(
    "POST",
    `/bitable/v1/apps/${args.appToken}/tables/${args.tableId}/records/batch_delete`,
    token,
    body,
  );
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({ success: true, reply: `${ids.length} 条记录已删除` });
}

// ---------------------------------------------------------------------------
// View actions
// ---------------------------------------------------------------------------

async function createView(args, token) {
  requireTableId(args);
  const body = {
    view_name: args.name || "未命名视图",
    view_type: args.viewType || "grid",
  };
  const data = await apiCall(
    "POST",
    `/bitable/v1/apps/${args.appToken}/tables/${args.tableId}/views`,
    token,
    body,
  );
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({ view: data.data?.view, reply: `视图「${args.name}」已创建` });
}

async function listViews(args, token) {
  requireTableId(args);
  const query = { page_size: String(args.pageSize) };
  if (args.pageToken) query.page_token = args.pageToken;
  const data = await apiCall(
    "GET",
    `/bitable/v1/apps/${args.appToken}/tables/${args.tableId}/views`,
    token,
    null,
    query,
  );
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({
    views: data.data?.items || [],
    has_more: data.data?.has_more,
    page_token: data.data?.page_token,
  });
}

async function getView(args, token) {
  requireTableId(args);
  if (!args.viewId) die({ error: "missing_param", message: "--view-id 必填" });
  const data = await apiCall(
    "GET",
    `/bitable/v1/apps/${args.appToken}/tables/${args.tableId}/views/${args.viewId}`,
    token,
  );
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({ view: data.data?.view });
}

async function updateView(args, token) {
  requireTableId(args);
  if (!args.viewId) die({ error: "missing_param", message: "--view-id 必填" });
  const body = {};
  if (args.name) body.view_name = args.name;
  const prop = tryParseJSON(args.property);
  if (prop) body.property = prop;
  const data = await apiCall(
    "PATCH",
    `/bitable/v1/apps/${args.appToken}/tables/${args.tableId}/views/${args.viewId}`,
    token,
    body,
  );
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({ view: data.data?.view, reply: "视图已更新" });
}

async function deleteView(args, token) {
  requireTableId(args);
  if (!args.viewId) die({ error: "missing_param", message: "--view-id 必填" });
  const data = await apiCall(
    "DELETE",
    `/bitable/v1/apps/${args.appToken}/tables/${args.tableId}/views/${args.viewId}`,
    token,
  );
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({ success: true, reply: "视图已删除" });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const ACTIONS = {
  // App
  create_app: createApp,
  get_app: getApp,
  update_app: updateApp,
  copy_app: copyApp,
  // Table
  create_table: createTable,
  list_tables: listTables,
  delete_table: deleteTable,
  update_table: updateTable,
  batch_create_tables: batchCreateTables,
  batch_delete_tables: batchDeleteTables,
  // Field
  create_field: createField,
  list_fields: listFields,
  update_field: updateField,
  delete_field: deleteField,
  // Record
  create_record: createRecord,
  list_records: listRecords,
  update_record: updateRecord,
  delete_record: deleteRecord,
  batch_create_records: batchCreateRecords,
  batch_update_records: batchUpdateRecords,
  batch_delete_records: batchDeleteRecords,
  // View
  create_view: createView,
  list_views: listViews,
  get_view: getView,
  update_view: updateView,
  delete_view: deleteView,
};

async function main() {
  const args = parseArgs();
  if (!args.openId) die({ error: "missing_param", message: "--open-id 参数必填" });
  if (!args.action)
    die({
      error: "missing_param",
      message: `--action 参数必填。可选: ${Object.keys(ACTIONS).join(", ")}`,
    });

  const handler = ACTIONS[args.action];
  if (!handler)
    die({
      error: "invalid_action",
      message: `未知操作: ${args.action}。可选: ${Object.keys(ACTIONS).join(", ")}`,
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
    die({ error: "auth_required", message: `用户未授权。open_id: ${args.openId}` });
  }

  try {
    await handler(args, accessToken);
  } catch (err) {
    if (err.message?.includes("99991663"))
      die({ error: "auth_required", message: "token 已失效，请重新授权" });
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
        required_scopes: ["bitable:app", "bitable:app:readonly"],
        reply: "⚠️ **权限不足，需要重新授权以获取所需权限。**",
      });
    }
    die({ error: "api_error", message: err.message });
  }
}

main();
