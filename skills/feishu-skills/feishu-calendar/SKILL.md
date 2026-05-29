---
name: feishu-calendar
description: |
  飞书日历与日程管理。支持日程 CRUD、参与者管理、忙闲查询。
overrides: feishu_calendar_calendar, feishu_calendar_event, feishu_calendar_event_attendee, feishu_calendar_freebusy, feishu_pre_auth
inline: true
---

# feishu-calendar

> **模块兼容**：所有脚本均提供 `.js` 和 `.mjs` 两个版本。优先使用 `.js`，若报 `require is not defined` 错误则改用同名 `.mjs` 文件。

直接用 `exec` 执行，不要检查文件或环境。

## 日历

```bash
node ./calendar.js --open-id "ou_xxx" --action list_calendars
node ./calendar.js --open-id "ou_xxx" --action get_primary
```

## 日程 CRUD

```bash
node ./calendar.js --open-id "ou_xxx" --action create_event --summary "标题" --start-time "ISO8601" --end-time "ISO8601" --attendees "ou_yyy,ou_zzz"
# 重复会议（早会/周会/月会等）— 默认自动创建会议群
node ./calendar.js --open-id "ou_xxx" --action create_event --summary "早会" --start-time "ISO8601" --end-time "ISO8601" --repeat daily --attendees "ou_xxx,ou_yyy"
node ./calendar.js --open-id "ou_xxx" --action create_event --summary "周会" --start-time "ISO8601" --end-time "ISO8601" --repeat weekly --attendees "ou_xxx,ou_yyy"
node ./calendar.js --open-id "ou_xxx" --action create_event --summary "月会" --start-time "ISO8601" --end-time "ISO8601" --repeat monthly --attendees "ou_xxx,ou_yyy"
# 重复会议但不创建会议群
node ./calendar.js --open-id "ou_xxx" --action create_event --summary "早会" --start-time "ISO8601" --end-time "ISO8601" --repeat daily --no-meeting-chat
# 开启自动录制
node ./calendar.js --open-id "ou_xxx" --action create_event --summary "标题" --start-time "ISO8601" --end-time "ISO8601" --auto-record
# 查询日程（不传时间范围则默认查今天，已取消的日程默认隐藏）
node ./calendar.js --open-id "ou_xxx" --action list_events
# 查询指定日期范围
node ./calendar.js --open-id "ou_xxx" --action list_events --start-min "ISO8601" --start-max "ISO8601"
# 显示已取消日程（用户说"显示已取消日程"时使用）
node ./calendar.js --open-id "ou_xxx" --action list_events --show-cancelled
node ./calendar.js --open-id "ou_xxx" --action get_event --event-id "ID" --need-attendee
node ./calendar.js --open-id "ou_xxx" --action update_event --event-id "ID" --summary "新标题"
node ./calendar.js --open-id "ou_xxx" --action delete_event --event-id "ID"
node ./calendar.js --open-id "ou_xxx" --action search_events --query "关键词"
```

可选：`--description` `--location` `--all-day`（全天时时间用日期格式） `--auto-record`（自动录制）

- `--auto-record`：开启后会议开始时自动录制
- 重复会议（`--repeat` 或 `--recurrence`）**默认自动创建会议群**，群内包含所有参与人。传 `--no-meeting-chat` 可跳过
- 创建会议群要求：日程至少 2 个参与人且不隐藏参与人列表。不满足条件时静默跳过
- `--chat-id` 仅用于忙闲查询按姓名匹配群成员

`--repeat` 可选值：`daily`（每天）、`weekly`（每周）、`monthly`（每月）、`workdays`（工作日）

也可用 `--recurrence` 传原始 RRULE，如 `FREQ=WEEKLY;BYDAY=MO,WE,FR`

## 参与者

```bash
node ./calendar.js --open-id "ou_xxx" --action add_attendees --event-id "ID" --attendees "ou_yyy"
node ./calendar.js --open-id "ou_xxx" --action list_attendees --event-id "ID"
node ./calendar.js --open-id "ou_xxx" --action remove_attendees --event-id "ID" --attendees "attendee_id"
```

## 忙闲

```bash
# 按 open_id 查询
node ./calendar.js --open-id "ou_xxx" --action check_freebusy --user-ids "ou_yyy,ou_zzz" --start-time "ISO8601" --end-time "ISO8601"

# 按姓名查询（从当前群成员中匹配，需要 --chat-id）
node ./calendar.js --open-id "ou_xxx" --action check_freebusy --names "张三,李四" --chat-id "oc_xxx" --start-time "ISO8601" --end-time "ISO8601"
```

`--names` 和 `--user-ids` 可混用。按名字查询时必须提供 `--chat-id`（当前群的 chat_id）。

## 创建日程的必填参数（create_event）

执行 `create_event` 前，以下三项必须全部已知。**缺少任意一项必须先追问用户，不得跳过或填占位符。**

多项缺失时**合并成一条消息同时追问**，不要分多轮。

| 参数                          | 说明                     | 缺失时追问                                           |
| ----------------------------- | ------------------------ | ---------------------------------------------------- |
| `--summary`                   | 会议主题                 | "请问这次会议的主题是什么？"                         |
| `--start-time` / `--end-time` | 会议时间                 | "请问会议的开始时间和结束时间（或时长）是什么时候？" |
| `--attendees`                 | 参会人 open_id，逗号分隔 | "请问哪些人需要参加这次会议？"                       |

**处理规则**：

- **创建者自动加入参会人**：`--attendees` 中必须包含 `SENDER_OPEN_ID`（当前用户），即使用户未提及自己也要自动添加
- 用户提供姓名而非 open_id → 先执行 `node ../feishu-search-user/search-user.js --open-id "SENDER_OPEN_ID" --action search --query "姓名"` 取得 open_id 再创建
- 时间支持自然语言（"明天下午3点到4点"、"今天16:00开始1小时"），转为 `YYYY-MM-DDTHH:mm:ss+08:00` 格式传入
- 未说明结束时间但说明了时长 → 自动计算 `--end-time`
- 未说明时长也未说明结束时间 → 追问"会议大概开多久？"

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
