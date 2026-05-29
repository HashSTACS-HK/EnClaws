/**
 * feishu-task: Feishu task management via user OAuth.
 *
 * Usage:
 *   node task.mjs --action <action> --open-id <open_id> [options]
 *
 * Task actions:    create_task, get_task, list_tasks, update_task, add_task_members, remove_task_members
 * Tasklist actions: create_tasklist, get_tasklist, list_tasklists, update_tasklist, delete_tasklist,
 *                   list_tasklist_tasks, add_tasklist_members, remove_tasklist_members
 * Comment actions:  create_comment, list_comments, get_comment
 * Subtask actions:  create_subtask, list_subtasks
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendCard } from "../feishu-auth/send-card.mjs";
import { getConfig, getValidToken } from "../feishu-auth/token-utils.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs() {
  const argv = process.argv.slice(2);
  const r = {
    action: null,
    openId: null,
    taskId: null,
    tasklistId: null,
    commentId: null,
    summary: null,
    description: null,
    due: null,
    members: null,
    followers: null,
    pageSize: 50,
    pageToken: null,
    completed: null,
    priority: null,
    content: null,
    parentTaskId: null,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--action":
        r.action = argv[++i];
        break;
      case "--open-id":
        r.openId = argv[++i];
        break;
      case "--task-id":
        r.taskId = argv[++i];
        break;
      case "--tasklist-id":
        r.tasklistId = argv[++i];
        break;
      case "--comment-id":
        r.commentId = argv[++i];
        break;
      case "--summary":
        r.summary = argv[++i];
        break;
      case "--description":
        r.description = argv[++i];
        break;
      case "--due":
        r.due = argv[++i];
        break;
      case "--members":
        r.members = argv[++i];
        break;
      case "--followers":
        r.followers = argv[++i];
        break;
      case "--page-size":
        r.pageSize = parseInt(argv[++i], 10);
        break;
      case "--page-token":
        r.pageToken = argv[++i];
        break;
      case "--completed":
        r.completed = argv[++i];
        break;
      case "--priority":
        r.priority = argv[++i];
        break;
      case "--content":
        r.content = argv[++i];
        break;
      case "--parent-task-id":
        r.parentTaskId = argv[++i];
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

function toTimestamp(dateStr) {
  return String(new Date(dateStr).getTime());
}

function parseMemberIds(str) {
  return str
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

function calcReminderMinutes(dueStr) {
  const diffMs = new Date(dueStr).getTime() - Date.now();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  if (diffDays <= 1) return 15;
  if (diffDays <= 2) return 30;
  return 60;
}

// ---------------------------------------------------------------------------
// Task actions
// ---------------------------------------------------------------------------

async function createTask(args, token) {
  const body = { summary: args.summary || "未命名任务" };
  if (args.description) body.description = args.description;
  if (args.due) {
    body.due = { timestamp: toTimestamp(args.due), is_all_day: false };
    body.reminders = [{ relative_fire_minute: calcReminderMinutes(args.due) }];
  }
  const members = [];
  if (args.members) {
    for (const id of parseMemberIds(args.members))
      members.push({ id, type: "user", role: "assignee" });
  }
  if (args.followers) {
    for (const id of parseMemberIds(args.followers))
      members.push({ id, type: "user", role: "follower" });
  }
  if (members.length > 0) body.members = members;
  if (args.tasklistId) body.tasklists = [{ tasklist_id: args.tasklistId }];
  const data = await apiCall("POST", "/task/v2/tasks", token, body, { user_id_type: "open_id" });
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  const task = data.data?.task;
  const taskUrl = task?.url || null;
  const replyText = `任务「${args.summary || "未命名任务"}」已创建`;
  if (args.openId && taskUrl) {
    await sendCard({
      openId: args.openId,
      title: "✅ 任务已创建",
      body: replyText,
      buttonText: taskUrl ? "查看任务" : undefined,
      buttonUrl: taskUrl || undefined,
      color: "green",
    }).catch(() => {});
  }
  out({ task, url: taskUrl, reply: replyText });
}

async function getTask(args, token) {
  if (!args.taskId) die({ error: "missing_param", message: "--task-id 必填" });
  const data = await apiCall("GET", `/task/v2/tasks/${args.taskId}`, token, null, {
    user_id_type: "open_id",
  });
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({ task: data.data?.task });
}

async function listTasks(args, token) {
  const query = { page_size: String(args.pageSize), user_id_type: "open_id" };
  if (args.pageToken) query.page_token = args.pageToken;
  if (args.completed) query.completed = args.completed;
  const data = await apiCall("GET", "/task/v2/tasks", token, null, query);
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  const tasks = data.data?.items || [];
  const reply =
    tasks.length === 0
      ? "暂无任务"
      : tasks
          .map((t) => {
            const status = t.completed_at && t.completed_at !== "0" ? "✅" : "⬜";
            const line = `${status} ${t.summary || "(无标题)"}`;
            return t.url ? `${line}\n   ${t.url}` : line;
          })
          .join("\n");
  out({ tasks, has_more: data.data?.has_more, page_token: data.data?.page_token, reply });
}

async function updateTask(args, token) {
  if (!args.taskId) die({ error: "missing_param", message: "--task-id 必填" });
  const task = {};
  if (args.summary) task.summary = args.summary;
  if (args.description) task.description = args.description;
  if (args.due) task.due = { timestamp: toTimestamp(args.due), is_all_day: false };
  if (args.completed === "true") task.completed_at = String(Date.now());
  if (args.completed === "false") task.completed_at = "0";
  const update_fields = Object.keys(task);
  if (update_fields.length === 0)
    die({ error: "missing_param", message: "至少指定一个要更新的字段" });
  const body = { task, update_fields };
  const data = await apiCall("PATCH", `/task/v2/tasks/${args.taskId}`, token, body, {
    user_id_type: "open_id",
  });
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  const updatedTask = data.data?.task;
  const taskUrl = updatedTask?.url || null;
  const replyBase =
    args.completed === "true"
      ? "任务已完成"
      : args.completed === "false"
        ? "任务已恢复为未完成"
        : "任务已更新";
  const reply = taskUrl ? `${replyBase}\n任务链接：${taskUrl}` : replyBase;
  out({ task: updatedTask, url: taskUrl, reply });
}

async function addTaskMembers(args, token) {
  if (!args.taskId) die({ error: "missing_param", message: "--task-id 必填" });
  if (!args.members) die({ error: "missing_param", message: "--members 必填" });
  const body = {
    members: parseMemberIds(args.members).map((id) => ({ id, type: "user", role: "assignee" })),
  };
  const data = await apiCall("POST", `/task/v2/tasks/${args.taskId}/add_members`, token, body, {
    user_id_type: "open_id",
  });
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({ task: data.data?.task, reply: "成员已添加" });
}

async function removeTaskMembers(args, token) {
  if (!args.taskId) die({ error: "missing_param", message: "--task-id 必填" });
  if (!args.members) die({ error: "missing_param", message: "--members 必填" });
  const body = {
    members: parseMemberIds(args.members).map((id) => ({ id, type: "user", role: "assignee" })),
  };
  const data = await apiCall("POST", `/task/v2/tasks/${args.taskId}/remove_members`, token, body, {
    user_id_type: "open_id",
  });
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({ task: data.data?.task, reply: "成员已移除" });
}

async function addFollowers(args, token) {
  if (!args.taskId) die({ error: "missing_param", message: "--task-id 必填" });
  if (!args.followers) die({ error: "missing_param", message: "--followers 必填" });
  const body = {
    members: parseMemberIds(args.followers).map((id) => ({ id, type: "user", role: "follower" })),
  };
  const data = await apiCall("POST", `/task/v2/tasks/${args.taskId}/add_members`, token, body, {
    user_id_type: "open_id",
  });
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({ task: data.data?.task, reply: "关注人已添加" });
}

async function removeFollowers(args, token) {
  if (!args.taskId) die({ error: "missing_param", message: "--task-id 必填" });
  if (!args.followers) die({ error: "missing_param", message: "--followers 必填" });
  const body = {
    members: parseMemberIds(args.followers).map((id) => ({ id, type: "user", role: "follower" })),
  };
  const data = await apiCall("POST", `/task/v2/tasks/${args.taskId}/remove_members`, token, body, {
    user_id_type: "open_id",
  });
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({ task: data.data?.task, reply: "关注人已移除" });
}

// ---------------------------------------------------------------------------
// Tasklist actions
// ---------------------------------------------------------------------------

async function createTasklist(args, token) {
  const body = { name: args.summary || "未命名清单" };
  const data = await apiCall("POST", "/task/v2/tasklists", token, body, {
    user_id_type: "open_id",
  });
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({ tasklist: data.data?.tasklist, reply: `任务清单「${args.summary}」已创建` });
}

async function getTasklist(args, token) {
  if (!args.tasklistId) die({ error: "missing_param", message: "--tasklist-id 必填" });
  const data = await apiCall("GET", `/task/v2/tasklists/${args.tasklistId}`, token, null, {
    user_id_type: "open_id",
  });
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({ tasklist: data.data?.tasklist });
}

async function listTasklists(args, token) {
  const query = { page_size: String(args.pageSize), user_id_type: "open_id" };
  if (args.pageToken) query.page_token = args.pageToken;
  const data = await apiCall("GET", "/task/v2/tasklists", token, null, query);
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({
    tasklists: data.data?.items || [],
    has_more: data.data?.has_more,
    page_token: data.data?.page_token,
  });
}

async function updateTasklist(args, token) {
  if (!args.tasklistId) die({ error: "missing_param", message: "--tasklist-id 必填" });
  const body = {};
  if (args.summary) body.name = args.summary;
  const data = await apiCall("PATCH", `/task/v2/tasklists/${args.tasklistId}`, token, body, {
    user_id_type: "open_id",
  });
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({ tasklist: data.data?.tasklist, reply: "任务清单已更新" });
}

async function deleteTasklist(args, token) {
  if (!args.tasklistId) die({ error: "missing_param", message: "--tasklist-id 必填" });
  const data = await apiCall("DELETE", `/task/v2/tasklists/${args.tasklistId}`, token);
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({ success: true, reply: "任务清单已删除" });
}

async function listTasklistTasks(args, token) {
  if (!args.tasklistId) die({ error: "missing_param", message: "--tasklist-id 必填" });
  const query = { page_size: String(args.pageSize), user_id_type: "open_id" };
  if (args.pageToken) query.page_token = args.pageToken;
  if (args.completed) query.completed = args.completed;
  const data = await apiCall(
    "GET",
    `/task/v2/tasklists/${args.tasklistId}/tasks`,
    token,
    null,
    query,
  );
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({
    tasks: data.data?.items || [],
    has_more: data.data?.has_more,
    page_token: data.data?.page_token,
  });
}

async function addTasklistMembers(args, token) {
  if (!args.tasklistId) die({ error: "missing_param", message: "--tasklist-id 必填" });
  if (!args.members) die({ error: "missing_param", message: "--members 必填" });
  const body = {
    members: parseMemberIds(args.members).map((id) => ({ id, type: "user", role: "editor" })),
  };
  const data = await apiCall(
    "POST",
    `/task/v2/tasklists/${args.tasklistId}/add_members`,
    token,
    body,
    { user_id_type: "open_id" },
  );
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({ tasklist: data.data?.tasklist, reply: "清单成员已添加" });
}

async function removeTasklistMembers(args, token) {
  if (!args.tasklistId) die({ error: "missing_param", message: "--tasklist-id 必填" });
  if (!args.members) die({ error: "missing_param", message: "--members 必填" });
  const body = {
    members: parseMemberIds(args.members).map((id) => ({ id, type: "user", role: "editor" })),
  };
  const data = await apiCall(
    "POST",
    `/task/v2/tasklists/${args.tasklistId}/remove_members`,
    token,
    body,
    { user_id_type: "open_id" },
  );
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({ tasklist: data.data?.tasklist, reply: "清单成员已移除" });
}

// ---------------------------------------------------------------------------
// Comment & Subtask
// ---------------------------------------------------------------------------

async function createComment(args, token) {
  if (!args.taskId) die({ error: "missing_param", message: "--task-id 必填" });
  if (!args.content) die({ error: "missing_param", message: "--content 必填" });
  const body = { content: args.content };
  const data = await apiCall("POST", `/task/v2/tasks/${args.taskId}/comments`, token, body, {
    user_id_type: "open_id",
  });
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({ comment: data.data?.comment, reply: "评论已添加" });
}

async function listComments(args, token) {
  if (!args.taskId) die({ error: "missing_param", message: "--task-id 必填" });
  const query = { page_size: String(args.pageSize), user_id_type: "open_id" };
  if (args.pageToken) query.page_token = args.pageToken;
  const data = await apiCall("GET", `/task/v2/tasks/${args.taskId}/comments`, token, null, query);
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({
    comments: data.data?.items || [],
    has_more: data.data?.has_more,
    page_token: data.data?.page_token,
  });
}

async function getComment(args, token) {
  if (!args.taskId) die({ error: "missing_param", message: "--task-id 必填" });
  if (!args.commentId) die({ error: "missing_param", message: "--comment-id 必填" });
  const data = await apiCall(
    "GET",
    `/task/v2/tasks/${args.taskId}/comments/${args.commentId}`,
    token,
    null,
    { user_id_type: "open_id" },
  );
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({ comment: data.data?.comment });
}

async function createSubtask(args, token) {
  if (!args.taskId) die({ error: "missing_param", message: "--task-id 必填" });
  const body = { summary: args.summary || "未命名子任务" };
  if (args.description) body.description = args.description;
  if (args.due) body.due = { timestamp: toTimestamp(args.due), is_all_day: false };
  const data = await apiCall("POST", `/task/v2/tasks/${args.taskId}/subtasks`, token, body, {
    user_id_type: "open_id",
  });
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({ task: data.data?.task, reply: `子任务「${args.summary}」已创建` });
}

async function listSubtasks(args, token) {
  if (!args.taskId) die({ error: "missing_param", message: "--task-id 必填" });
  const query = { page_size: String(args.pageSize), user_id_type: "open_id" };
  if (args.pageToken) query.page_token = args.pageToken;
  const data = await apiCall("GET", `/task/v2/tasks/${args.taskId}/subtasks`, token, null, query);
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({
    tasks: data.data?.items || [],
    has_more: data.data?.has_more,
    page_token: data.data?.page_token,
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const ACTIONS = {
  create_task: createTask,
  get_task: getTask,
  list_tasks: listTasks,
  update_task: updateTask,
  add_task_members: addTaskMembers,
  remove_task_members: removeTaskMembers,
  add_followers: addFollowers,
  remove_followers: removeFollowers,
  create_tasklist: createTasklist,
  get_tasklist: getTasklist,
  list_tasklists: listTasklists,
  update_tasklist: updateTasklist,
  delete_tasklist: deleteTasklist,
  list_tasklist_tasks: listTasklistTasks,
  add_tasklist_members: addTasklistMembers,
  remove_tasklist_members: removeTasklistMembers,
  create_comment: createComment,
  list_comments: listComments,
  get_comment: getComment,
  create_subtask: createSubtask,
  list_subtasks: listSubtasks,
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
        required_scopes: [
          "task:task:read",
          "task:task:write",
          "task:tasklist:read",
          "task:tasklist:write",
          "task:comment:read",
          "task:comment:write",
        ],
        reply: "⚠️ **权限不足，需要重新授权以获取所需权限。**",
      });
    }
    die({ error: "api_error", message: err.message });
  }
}

main();
