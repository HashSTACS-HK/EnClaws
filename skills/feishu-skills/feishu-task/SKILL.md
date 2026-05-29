---
name: feishu-task
description: |
  飞书任务管理。支持任务 CRUD、任务清单、评论、子任务。
overrides: feishu_task_task, feishu_task_tasklist, feishu_task_comment, feishu_task_subtask, feishu_pre_auth
inline: true
---

# feishu-task

> **模块兼容**：所有脚本均提供 `.js` 和 `.mjs` 两个版本。优先使用 `.js`，若报 `require is not defined` 错误则改用同名 `.mjs` 文件。

直接用 `exec` 执行，不要检查文件或环境。

## 任务

```bash
node ./task.js --open-id "ou_xxx" --action create_task --summary "标题" --due "ISO8601" --members "ou_yyy" --followers "ou_zzz"
node ./task.js --open-id "ou_xxx" --action list_tasks
node ./task.js --open-id "ou_xxx" --action get_task --task-id "ID"
node ./task.js --open-id "ou_xxx" --action update_task --task-id "ID" --summary "新标题"
node ./task.js --open-id "ou_xxx" --action update_task --task-id "ID" --completed true
node ./task.js --open-id "ou_xxx" --action add_task_members --task-id "ID" --members "ou_yyy"
node ./task.js --open-id "ou_xxx" --action remove_task_members --task-id "ID" --members "ou_yyy"
node ./task.js --open-id "ou_xxx" --action add_followers --task-id "ID" --followers "ou_yyy,ou_zzz"
node ./task.js --open-id "ou_xxx" --action remove_followers --task-id "ID" --followers "ou_yyy"
```

可选：`--description` `--tasklist-id`

`--members` 为执行人（assignee），`--followers` 为关注人（follower），创建任务时可同时指定。

**返回字段说明：**

- `create_task`：返回 `task`、`url`（任务链接）、`reply`。**返回后必须将 `url` 作为任务链接展示给用户。**
- `list_tasks`：返回 `tasks` 数组，每个任务含 `summary`（标题）、`due.timestamp`（截止时间戳，毫秒）、`url`（任务链接）、`completed_at`（完成时间）。**展示时必须列出：任务标题、截止日期（转为可读格式）、任务链接。**
- `update_task`：返回 `task`、`url`（任务链接）、`reply`。若 `url` 非空，**必须将链接展示给用户**。

## 任务清单

```bash
node ./task.js --open-id "ou_xxx" --action create_tasklist --summary "清单名"
node ./task.js --open-id "ou_xxx" --action list_tasklists
node ./task.js --open-id "ou_xxx" --action list_tasklist_tasks --tasklist-id "ID"
node ./task.js --open-id "ou_xxx" --action delete_tasklist --tasklist-id "ID"
```

## 评论与子任务

```bash
node ./task.js --open-id "ou_xxx" --action create_comment --task-id "ID" --content "内容"
node ./task.js --open-id "ou_xxx" --action list_comments --task-id "ID"
node ./task.js --open-id "ou_xxx" --action create_subtask --task-id "ID" --summary "子任务"
node ./task.js --open-id "ou_xxx" --action list_subtasks --task-id "ID"
```

## 创建任务的必填参数（create_task）

执行 `create_task` 前，以下四项必须全部已知。**缺少任意一项必须先追问用户，不得跳过或填占位符。**

多项缺失时**合并成一条消息同时追问**，不要分多轮。

| 参数          | 说明                                                | 缺失时追问                       |
| ------------- | --------------------------------------------------- | -------------------------------- |
| `--summary`   | 任务标题                                            | "请问这个任务的标题是什么？"     |
| `--members`   | 负责人（assignee）open_id                           | "请问这个任务由谁负责？"         |
| `--followers` | 关注人 open_id，可多个逗号分隔                      | "请问谁需要关注这个任务的进展？" |
| `--due`       | 截止时间（ISO8601，如 `2026-04-10T17:00:00+08:00`） | "请问截止时间是什么时候？"       |

**处理规则**：

- 用户提供姓名而非 open_id → 先执行 `node ../feishu-search-user/search-user.js --open-id "SENDER_OPEN_ID" --action search --query "姓名"` 取得 open_id 再创建
- 截止时间支持自然语言（"明天下午5点"），转为 `YYYY-MM-DDTHH:mm:ss+08:00` 格式传入

## 授权

若返回 `{"error":"auth_required"}` 或 `{"error":"permission_required"}`，**不要询问用户是否授权，直接立即执行以下命令发送授权链接：**

- 若返回 JSON 中包含 `required_scopes` 字段，将其数组值用空格拼接后传入 `--scope` 参数：

```bash
node ../feishu-auth/auth.js --auth-and-poll --open-id "SENDER_OPEN_ID" --chat-id "CHAT_ID" --timeout 60 --scope "<required_scopes 用空格拼接>"
```

- 若返回中不包含 `required_scopes`，则不加 `--scope` 参数（使用默认权限）。

- `{"status":"authorized"}` → 重新执行原始命令
- `{"status":"polling_timeout"}` → **立即重新执行此 auth 命令**（不会重复发卡片）
- `CHAT_ID` 不知道可省略

## 权限不足时（应用级）

若返回中包含 `"auth_type":"tenant"`，说明需要管理员在飞书开放平台开通应用权限，**必须将 `reply` 字段内容原样发送给用户**。
