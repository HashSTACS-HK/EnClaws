---
name: feishu-update-doc
description: |
  更新飞书云文档内容。支持追加(append)和覆盖(overwrite)两种模式。
overrides: feishu_update_doc, feishu_pre_auth
inline: true
---

# feishu-update-doc

> **模块兼容**：所有脚本均提供 `.js` 和 `.mjs` 两个版本。优先使用 `.js`，若报 `require is not defined` 错误则改用同名 `.mjs` 文件。

直接用 `exec` 执行，不要检查文件或环境。

## 已实现的模式

| 模式            | 说明                                 | 状态       |
| --------------- | ------------------------------------ | ---------- |
| `append`        | 在文档末尾追加内容                   | **已实现** |
| `overwrite`     | 清除原内容后写入新内容（破坏性操作） | **已实现** |
| `replace_range` | 替换匹配 selection 的第一处内容      | 暂未实现   |
| `replace_all`   | 替换匹配 selection 的所有内容        | 暂未实现   |
| `insert_before` | 在匹配 selection 之前插入内容        | 暂未实现   |
| `insert_after`  | 在匹配 selection 之后插入内容        | 暂未实现   |
| `delete_range`  | 删除匹配 selection 的内容            | 暂未实现   |

> 暂未实现的模式会返回 `{"error":"mode_not_implemented"}`。当前请只使用 `append` 或 `overwrite`。

## 命令

```bash
# 追加内容
node ./update-doc.js --open-id "SENDER_OPEN_ID" --doc-id "TOKEN" --mode "append" --markdown "内容"

# 覆盖全文（会清除原内容）
node ./update-doc.js --open-id "SENDER_OPEN_ID" --doc-id "TOKEN" --mode "overwrite" --markdown "内容"
```

可选：`--new-title "新标题"`

## 输出

脚本返回 JSON，包含 `doc_url` 字段（文档链接）和 `reply` 字段。**务必将文档链接展示给用户。**

## 必须确认的参数

| 参数         | 何时询问                                                               |
| ------------ | ---------------------------------------------------------------------- |
| `--doc-id`   | 用户未提供文档链接或 token                                             |
| `--mode`     | 用户未说明"追加"还是"覆盖"，必须询问。**只能选择 append 或 overwrite** |
| `--markdown` | 用户未提供内容                                                         |

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
