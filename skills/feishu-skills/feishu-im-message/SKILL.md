---
name: feishu-im-message
description: |
  以用户身份发送/回复飞书 IM 消息。支持私聊、群聊，支持 text/post/image/file/interactive 等消息类型。
overrides: feishu_im_user_message
inline: true
---

# feishu-im-message

直接用 `exec` 执行，不要检查文件或环境。

> **重要**：此 skill 以**用户身份**发送消息，对方看到的发送者是用户本人。调用前必须确认发送对象和消息内容。

---

## 发送消息

```bash
# 发本地图片（自动上传后发送）
node ./message.js --open-id "ou_xxx" --action send \
  --receive-id-type open_id --receive-id "ou_yyy" \
  --image-path "/path/to/image.png"

# 发私信给某人（open_id）
node ./message.js --open-id "ou_xxx" --action send \
  --receive-id-type open_id --receive-id "ou_yyy" \
  --msg-type text --content '{"text":"你好"}'

# 发消息到群聊（chat_id）
node ./message.js --open-id "ou_xxx" --action send \
  --receive-id-type chat_id --receive-id "oc_xxx" \
  --msg-type text --content '{"text":"大家好"}'

# 发富文本（post）
node ./message.js --open-id "ou_xxx" --action send \
  --receive-id-type open_id --receive-id "ou_yyy" \
  --msg-type post --content '{"zh_cn":{"title":"标题","content":[[{"tag":"text","text":"正文内容"}]]}}'
```

返回字段：`message_id`、`chat_id`、`create_time`。

---

## 回复消息

```bash
# 回复消息
node ./message.js --open-id "ou_xxx" --action reply \
  --message-id "om_xxx" --msg-type text --content '{"text":"收到"}'

# 以话题形式回复
node ./message.js --open-id "ou_xxx" --action reply \
  --message-id "om_xxx" --msg-type text --content '{"text":"回复"}' \
  --reply-in-thread true
```

返回字段：`message_id`、`chat_id`、`create_time`。

---

## 参数说明

| 参数                | 必填       | 说明                                                                                                              |
| ------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------- |
| `--open-id`         | 是         | 当前用户 open_id                                                                                                  |
| `--action`          | 是         | `send` / `reply`                                                                                                  |
| **send 参数**       |            |                                                                                                                   |
| `--receive-id-type` | send 必填  | `open_id`（私聊）/ `chat_id`（群聊）                                                                              |
| `--receive-id`      | send 必填  | 接收者 ID，与 receive-id-type 对应                                                                                |
| `--msg-type`        | 是         | `text` / `post` / `image` / `file` / `interactive` 等                                                             |
| `--content`         | 是         | 消息内容（JSON 字符串）                                                                                           |
| `--uuid`            | 可选       | 幂等 ID，1 小时内相同 uuid 只发一条                                                                               |
| `--image-path`      | 可选       | 本地图片路径，自动上传后以 image 类型发送（不需同时传 --msg-type 和 --content）。路径必须在允许目录内，见下方说明 |
| **reply 参数**      |            |                                                                                                                   |
| `--message-id`      | reply 必填 | 被回复消息 ID（om_xxx）                                                                                           |
| `--reply-in-thread` | 可选       | `true`=话题回复，默认 false                                                                                       |

## content 格式示例

| msg_type | content                                                                 |
| -------- | ----------------------------------------------------------------------- |
| `text`   | `{"text":"消息内容"}`                                                   |
| `post`   | `{"zh_cn":{"title":"标题","content":[[{"tag":"text","text":"正文"}]]}}` |
| `image`  | `{"image_key":"img_xxx"}`                                               |
| `file`   | `{"file_key":"file_xxx"}`                                               |

---

## 图片路径限制

`--image-path` 只允许读取以下目录内的文件：

- `/tmp/`
- `~/.enclaws/media`
- `~/.enclaws/tenants/`（含所有租户的 workspace，如 `~/.enclaws/tenants/{tenant_id}/users/{user_id}/workspace/`）

其他路径会返回 `path_not_allowed` 错误。

---

## 典型场景

- 用户要求以自己身份发消息给某人 → `send --receive-id-type open_id`
- 用户要求以自己身份发消息到群 → `send --receive-id-type chat_id`（先用 feishu-chat 搜索群组获取 chat_id）
- 用户要求回复某条消息 → `reply --message-id`

## 授权

若返回 `{"error":"auth_required"}` 或 `{"error":"permission_required"}`，**不要询问用户是否授权，直接立即执行以下命令发送授权链接：**

- 若返回 JSON 中包含 `required_scopes` 字段，将其数组值用空格拼接后传入 `--scope` 参数：

```bash
node ../feishu-auth/auth.js --auth-and-poll --open-id "SENDER_OPEN_ID" --chat-id "CHAT_ID" --timeout 60 --scope "<required_scopes 用空格拼接>"
```

- 若返回中不包含 `required_scopes`，则不加 `--scope` 参数。

- `{"status":"authorized"}` → 重新执行原始命令
- `{"status":"polling_timeout"}` → **立即重新执行此 auth 命令**
- `CHAT_ID` 不知道可省略

## 权限不足时（应用级）

若返回中包含 `"auth_type":"tenant"`，说明需要管理员在飞书开放平台开通应用权限，**必须将 `reply` 字段内容原样发送给用户**。
