---
name: feishu-doc-media
description: |
  飞书文档媒体管理。支持在文档末尾插入本地图片或文件附件，以及下载文档素材或画板缩略图。
overrides: feishu_doc_media, feishu_pre_auth
inline: true
---

# feishu-doc-media

直接用 `exec` 执行，不要检查文件或环境。

> **重要**：`insert` 仅支持本地文件路径（最大 20MB）。URL 图片请使用 `feishu-update-doc` 的 `<image url="..."/>` 语法。

---

## 插入图片 / 文件到文档末尾

```bash
# 插入图片（默认居中）
node ./media.js --open-id "ou_xxx" --action insert \
  --doc-id "DOC_ID_OR_URL" --file-path "$ENCLAWS_USER_WORKSPACE/upload/image.png"

# 插入图片（指定对齐和描述）
node ./media.js --open-id "ou_xxx" --action insert \
  --doc-id "DOC_ID_OR_URL" --file-path "$ENCLAWS_USER_WORKSPACE/upload/photo.jpg" \
  --type image --align left --caption "图片说明"

# 插入文件附件
node ./media.js --open-id "ou_xxx" --action insert \
  --doc-id "DOC_ID_OR_URL" --file-path "$ENCLAWS_USER_WORKSPACE/upload/report.pdf" --type file
```

`--doc-id` 支持文档 ID 或完整 URL（自动提取 document_id）。

`--align` 可选值：`left`（居左）、`center`（居中，默认）、`right`（居右），仅图片生效。

返回字段：`block_id`、`file_token`、`file_name`、`url`（文档链接）。

**返回后必须将 `url` 字段作为文档链接展示给用户。**

---

## 下载文档素材

```bash
# 下载文档中的图片/视频等素材（file_token 从文档块获取，不传 --output-path 则自动存到默认目录）
node ./media.js --open-id "ou_xxx" --action download \
  --resource-token "FILE_TOKEN" --resource-type media

# 指定保存路径
node ./media.js --open-id "ou_xxx" --action download \
  --resource-token "FILE_TOKEN" --resource-type media \
  --output-path "/path/to/image"

# 下载画板缩略图
node ./media.js --open-id "ou_xxx" --action download \
  --resource-token "WHITEBOARD_ID" --resource-type whiteboard
```

`--output-path` 若不带扩展名，自动根据 Content-Type 补充（如 `.png`、`.pdf`）。

返回字段：`saved_path`、`size_bytes`、`content_type`。

---

## 参数说明

| 参数               | 必填          | 说明                                                                                                                         |
| ------------------ | ------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `--open-id`        | 是            | 当前用户 open_id                                                                                                             |
| `--action`         | 是            | `insert` / `download`                                                                                                        |
| **insert 参数**    |               |                                                                                                                              |
| `--doc-id`         | insert 必填   | 文档 ID 或 URL                                                                                                               |
| `--file-path`      | insert 必填   | 本地文件绝对路径（≤20MB），必须在允许目录内                                                                                  |
| `--type`           | 可选          | `image`（默认）/ `file`                                                                                                      |
| `--align`          | 可选          | `left` / `center`（默认）/ `right`，仅图片                                                                                   |
| `--caption`        | 可选          | 图片描述文字                                                                                                                 |
| **download 参数**  |               |                                                                                                                              |
| `--resource-token` | download 必填 | file_token（媒体）或 whiteboard_id（画板）                                                                                   |
| `--resource-type`  | download 必填 | `media` / `whiteboard`                                                                                                       |
| `--output-path`    | 可选          | 本地保存路径（默认：`$ENCLAWS_USER_WORKSPACE/download/<resource_token>` 或 `./download/<resource_token>`），必须在允许目录内 |

---

## 路径限制

`--file-path` 和 `--output-path` 只允许以下目录内的路径：

- `/tmp/`
- `~/.enclaws/tenants/`（含所有租户 workspace）

其他路径会返回 `path_not_allowed` 错误。

---

## 典型场景

- 将本地截图插入飞书文档 → `insert --type image`
- 将报告 PDF 作为附件插入文档 → `insert --type file`
- 将文档中的图片保存到本地 → `download --resource-type media`
- 将画板导出为 PNG → `download --resource-type whiteboard`

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
