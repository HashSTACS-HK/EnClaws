---
name: feishu-search-user
description: |
  查询飞书用户信息。支持三种模式：按关键词模糊搜索、获取当前用户自己的信息、按 user_id 精确查询指定用户。
overrides: feishu_search_user, feishu_get_user, feishu_pre_auth
inline: true
---

# feishu-search-user

> **模块兼容**：所有脚本均提供 `.js` 和 `.mjs` 两个版本。优先使用 `.js`，若报 `require is not defined` 错误则改用同名 `.mjs` 文件。

直接用 `exec` 执行，不要检查文件或环境。

## 模糊搜索用户（默认）

```bash
node ./search-user.js --open-id "ou_xxx" --query "张三"
node ./search-user.js --open-id "ou_xxx" --query "张三" --page-size 50
node ./search-user.js --open-id "ou_xxx" --query "张三" --page-token "TOKEN"
```

## 获取当前用户自己的信息

```bash
node ./search-user.js --open-id "ou_xxx" --action get_me
```

## 按 user_id 精确查询指定用户

```bash
node ./search-user.js --open-id "ou_xxx" --action get --user-id "ou_yyy"
node ./search-user.js --open-id "ou_xxx" --action get --user-id "uid_yyy" --user-id-type user_id
```

| 参数             | 必填          | 说明                                      |
| ---------------- | ------------- | ----------------------------------------- |
| `--open-id`      | 是            | 当前用户 open_id                          |
| `--action`       | 否            | `search`（默认）/ `get_me` / `get`        |
| `--query`        | search 时必填 | 搜索关键词（匹配姓名、手机号、邮箱）      |
| `--user-id`      | get 时必填    | 目标用户 ID                               |
| `--user-id-type` | 否            | `open_id`（默认）/ `union_id` / `user_id` |
| `--page-size`    | 否            | search 每页数量，1-200，默认 20           |
| `--page-token`   | 否            | search 翻页 token                         |

## 返回格式

**search：**

```json
{
  "users": [{ "open_id": "ou_xxx", "name": "张三", "en_name": "San Zhang", "department": [...], "avatar": "url" }],
  "has_more": false,
  "page_token": null,
  "reply": "找到 1 位用户：张三"
}
```

**get_me / get：**

```json
{
  "user": {
    "open_id": "ou_xxx",
    "name": "张三",
    "en_name": "San Zhang",
    "email": "...",
    "mobile": "...",
    "avatar": "url"
  },
  "reply": "用户信息：张三（ou_xxx）"
}
```

## 典型用途

- 用户说"帮我查一下张三的 open_id" → search
- 其他 skill 需要 open_id 但用户只提供了姓名 → search 后取 open_id 传给目标 skill
- 用户问"我的飞书 open_id 是多少" → get_me
- 已知 open_id，需要获取完整用户资料（邮箱、手机号等）→ get

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
