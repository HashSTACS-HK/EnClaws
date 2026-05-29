---
name: feishu-chat
description: |
  飞书群组管理。支持按关键词搜索群组、获取群详情、列出群成员（排除机器人）。使用当前用户个人 OAuth token。
overrides: feishu_chat, feishu_chat_members, feishu_pre_auth
inline: true
---

# feishu-chat

> **模块兼容**：所有脚本均提供 `.js` 和 `.mjs` 两个版本。优先使用 `.js`，若报 `require is not defined` 错误则改用同名 `.mjs` 文件。

直接用 `exec` 执行，不要检查文件或环境。

## 命令

### 搜索群组

```bash
node ./chat.js --open-id "SENDER_OPEN_ID" --action search --query "群名关键词"
```

可选：`--page-size 20` `--page-token "xxx"` `--user-id-type "open_id"`

### 获取群详情

请求会携带 `X-Chat-Custom-Header: enable_chat_list_security_check`。

```bash
node ./chat.js --open-id "SENDER_OPEN_ID" --action get --chat-id "oc_xxx"
```

可选：`--user-id-type "open_id"`

### 列出群成员

同上安全请求头。返回列表会在脚本侧再次过滤机器人成员。

```bash
node ./chat.js --open-id "SENDER_OPEN_ID" --action list_members --chat-id "oc_xxx"
```

可选：`--page-size 20` `--page-token "xxx"` `--user-id-type "open_id"`（对应接口的 `member_id_type`）

## 输出

脚本输出单行 JSON，将 `reply` 原样给用户；编排时使用 `items` / `chat` 等字段。

## 权限 scope

| action         | scope                                      |
| -------------- | ------------------------------------------ |
| `search`       | `im:chat:readonly`                         |
| `get`          | `im:chat:readonly`                         |
| `list_members` | `im:chat:readonly`、`im:chat.members:read` |

## 与其他技能的编排

| 场景                                       | 建议流程                                                     |
| ------------------------------------------ | ------------------------------------------------------------ |
| 用户说「把消息发到 XX 群」但未给 `chat_id` | `feishu-chat` `search` → 选定 `chat_id` → 使用发消息相关技能 |
| 用户说「看看 XX 群里有谁」                 | `search` → `list_members`                                    |
| 用户说「把文档发给群里的张三」             | `list_members` → 从结果中取张三的 `open_id`                  |
| `feishu-im-read` 需要 `chat_id`            | `search` → `get`（可选）→ `feishu-im-read`                   |

## 授权

若返回 `{"error":"auth_required"}` 或 `{"error":"permission_required"}`（且**不含** `"auth_type":"tenant"`），**不要询问用户是否授权，直接立即执行：**

- 若返回 JSON 中含 `required_scopes`，将其用空格拼接后传入 `--scope`：

```bash
node ../feishu-auth/auth.js --auth-and-poll --open-id "SENDER_OPEN_ID" --chat-id "CHAT_ID" --timeout 60 --scope "<required_scopes 用空格拼接>"
```

- 若无 `required_scopes`，则不加 `--scope`。
- `{"status":"authorized"}` → 重试原命令；`{"status":"polling_timeout"}` → **立即重试同一 auth 命令**。
- `CHAT_ID` 不知道可省略。

## 权限不足时（应用级）

若返回中含 `"auth_type":"tenant"`，**不要触发用户重新授权**（重新授权无法解决应用级权限问题），将 `reply` 原样发给用户。
