---
name: feishu-doc-comment
description: |
  飞书云文档评论管理。支持获取评论列表（含完整回复）、创建全文评论、解决/恢复评论。
  支持 wiki token 自动转换为实际文档 token。
overrides: feishu_doc_comments, feishu_pre_auth
inline: true
---

# feishu-doc-comment

> **模块兼容**：所有脚本均提供 `.js` 和 `.mjs` 两个版本。优先使用 `.js`，若报 `require is not defined` 错误则改用同名 `.mjs` 文件。

直接用 `exec` 执行，不要检查文件或环境。

---

## 获取评论列表

```bash
# 获取所有评论（含完整回复）
node ./comment.js --open-id "ou_xxx" --action list --file-token "TOKEN" --file-type docx

# wiki 节点（自动转换为实际 token）
node ./comment.js --open-id "ou_xxx" --action list --file-token "NODE_TOKEN" --file-type wiki

# 只看未解决的评论
node ./comment.js --open-id "ou_xxx" --action list --file-token "TOKEN" --file-type docx --is-solved false

# 只看全文评论
node ./comment.js --open-id "ou_xxx" --action list --file-token "TOKEN" --file-type docx --is-whole true
```

返回字段：`items`（评论数组，每条含完整 `reply_list.replies`）、`has_more`、`page_token`、`url`（文档链接）。

**返回后必须将 `url` 字段作为文档链接展示给用户。**

## 创建评论

```bash
node ./comment.js --open-id "ou_xxx" --action create \
  --file-token "TOKEN" --file-type docx --content "这里需要修改一下"
```

返回字段：`comment_id`、`url`（文档链接）。

**返回后必须将 `url` 字段作为文档链接展示给用户。**

## 解决 / 恢复评论

```bash
# 解决评论
node ./comment.js --open-id "ou_xxx" --action patch \
  --file-token "TOKEN" --file-type docx --comment-id "COMMENT_ID" --is-solved-value true

# 恢复评论
node ./comment.js --open-id "ou_xxx" --action patch \
  --file-token "TOKEN" --file-type docx --comment-id "COMMENT_ID" --is-solved-value false
```

返回字段：`success`、`url`（文档链接）。

**返回后必须将 `url` 字段作为文档链接展示给用户。**

---

## 参数说明

| 参数                | 必填        | 说明                                              |
| ------------------- | ----------- | ------------------------------------------------- |
| `--open-id`         | 是          | 当前用户 open_id                                  |
| `--action`          | 是          | `list` / `create` / `patch`                       |
| `--file-token`      | 是          | 文档 token 或 wiki node_token                     |
| `--file-type`       | 是          | `docx` / `sheet` / `file` / `slides` / `wiki`     |
| `--is-whole`        | 可选        | `true`=只看全文评论（list 用）                    |
| `--is-solved`       | 可选        | `true`=只看已解决 / `false`=只看未解决（list 用） |
| `--page-size`       | 可选        | 分页大小（默认 50）                               |
| `--page-token`      | 可选        | 翻页 token                                        |
| `--content`         | create 必填 | 评论文本内容                                      |
| `--comment-id`      | patch 必填  | 评论 ID                                           |
| `--is-solved-value` | patch 必填  | `true`=解决 / `false`=恢复                        |

> **wiki token**：传 `--file-type wiki` 时自动调用 wiki API 将 node_token 转换为实际文档的 obj_token，无需手动转换。

---

## 典型场景

- 查看文档所有待处理评论 → `list --is-solved false`
- 在文档中留下评论 → `create --content "内容"`
- 标记评论已处理 → `patch --is-solved-value true`

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
