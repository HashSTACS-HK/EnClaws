---
name: feishu-drive
description: |
  使用当前用户的个人 OAuth token 访问飞书云盘，支持目录列表/建目录/批量元信息/复制/移动操作。
overrides: feishu_drive_file
inline: true
---

# feishu-drive

> **模块兼容**：所有脚本均提供 `.js` 和 `.mjs` 两个版本。优先使用 `.js`，若报 `require is not defined` 错误则改用同名 `.mjs` 文件。

直接用 `exec` 执行，不要检查文件或环境。

## 下游技能编排

`list` / `get_meta` 返回结果中的文件按类型分流到不同技能：

| 文件类型（type/扩展名）                                        | 下游技能                                                   |
| -------------------------------------------------------------- | ---------------------------------------------------------- |
| `docx` / `doc`（飞书在线云文档）                               | **feishu-fetch-doc**（用 `token` 作为 `--doc-id`）         |
| `sheet`（飞书在线电子表格）                                    | **feishu-sheet**                                           |
| `bitable`（飞书多维表格）                                      | **feishu-bitable**                                         |
| `file` 且扩展名为 `.docx`/`.doc`/`.pdf`/`.pptx`/`.xlsx` 等附件 | **feishu-docx-download**（用 `token` 作为 `--file-token`） |
| `folder`                                                       | 继续 `list` 进入子目录                                     |

> 💡 当用户说「云盘里的 Word 文档」「我那个 PDF」时，先用 `list` / `search` 找到文件，再根据 `type` 决定下游技能。**Word/PDF/Excel 等附件文件 → feishu-docx-download**，**飞书在线 docx 文档 → feishu-fetch-doc**。

## 命令

- **列出文件夹内容**

```bash
node ./drive.js --open-id "SENDER_OPEN_ID" --action list --folder-token "TOKEN"
```

- **创建文件夹**

```bash
node ./drive.js --open-id "SENDER_OPEN_ID" --action create_folder --name "文件夹名" --folder-token "父文件夹TOKEN"
```

> ⚠️ **创建前必须先检查同名是否存在**：用户说「在「XX」文件夹下创建...」时，「XX」很可能是已存在的引用。**先用 `list` 在父目录下查找同名 folder，存在则复用其 `token`，不要新建**。只有用户明确说"新建一个 XX 文件夹"且 list 结果中确认不存在时，才执行 `create_folder`。

- **批量获取文件元信息（最多 50 条）**

```bash
node ./drive.js --open-id "SENDER_OPEN_ID" --action get_meta --request-docs "token1:docx,token2:sheet"
```

- **复制文件**

```bash
node ./drive.js --open-id "SENDER_OPEN_ID" --action copy --file-token "文件TOKEN" --name "副本名称" --type "docx" --folder-token "目标目录TOKEN"
```

- **移动文件（异步任务）**

```bash
node ./drive.js --open-id "SENDER_OPEN_ID" --action move --file-token "文件TOKEN" --type "docx" --folder-token "目标目录TOKEN"
```

- **上传文件**

```bash
node ./drive.js --open-id "SENDER_OPEN_ID" --action upload --file-path "本地文件路径" --folder-token "目标目录TOKEN"
```

备选（base64）：

```bash
node ./drive.js --open-id "SENDER_OPEN_ID" --action upload --file-base64 "BASE64内容" --file-name "文件名.ext" --folder-token "目标目录TOKEN"
```

- **下载文件**

保存到本地：

```bash
node ./drive.js --open-id "SENDER_OPEN_ID" --action download --file-token "文件TOKEN" --output-path "a.docx"
```

不指定路径（返回 base64）：

```bash
node ./drive.js --open-id "SENDER_OPEN_ID" --action download --file-token "文件TOKEN"
```

- **删除文件（异步任务）**

须先 `get_meta`，向用户展示待删文件信息并得到**明确口头确认**后，再在同一流程中追加 `--confirm-delete` 执行删除（否则返回 `confirmation_required`）。

```bash
node ./drive.js --open-id "SENDER_OPEN_ID" --action delete --file-token "文件TOKEN" --type "docx" --confirm-delete
```

说明：

- `--folder-token` 为空或省略时，表示云盘根目录。
- `--request-docs` 格式：`token:type`，多个用逗号分隔，最多 50 条。
- `--type` 可选值：`doc`、`sheet`、`file`、`bitable`、`docx`、`folder`、`mindnote`、`slides`。
- `upload` 时 `--file-path` 优先；未提供时可用 `--file-base64 + --file-name`。
- `download` 未给 `--output-path` 时返回 `file_content_base64`，大文件建议指定输出路径。
- 脚本返回 JSON，将 `reply` 字段原样输出给用户，必要时可结合 `items` / `folder_token` / `url` 等字段做后续编排。
- `create_folder`、`copy`、`upload` 操作成功时会在 `reply` 和 `url` 字段中包含飞书链接，方便用户直接访问。

## 删除前确认（必须遵守）

执行 `delete` 前，Agent **必须先调用 `get_meta`** 获取目标文件元信息，并向用户展示至少以下内容：

- 文件名（title / name）
- 文件类型（doc_type / type）
- 目标 token（用于二次核对）

只有在用户明确确认删除后，才允许执行 `--action delete`，且命令中必须包含 **`--confirm-delete`**。

## 回复与自动化测试提示

- 请将脚本 stdout **整行 JSON** 解析后，把 `reply` **完整**转发给用户（勿截断）；`copy` / `upload` / `move` / `delete` 的结论句中含 `token`、`url`、`task_id` 等关键字段，便于核对。
- `get_meta` 的 `reply` 内嵌每条资源的摘要（标题、类型、token、时间等），不要只说一句“已获取”。

## 授权与权限不足处理

- 若返回中包含 `{"error":"auth_required"}`：
  - 说明用户未完成个人 OAuth 授权或 token 已失效，应调用 `feishu-auth` 完成授权后重试原始命令。

- 若返回中包含 `{"error":"permission_required"}`：
  - 按返回中的 `reply` 文案提示用户需要重新授权或管理员开通应用云盘相关权限。

## 已实现的 action

- **list**：列出指定 `folder_token` 下的所有文件与文件夹，支持自动翻页。
- **create_folder**：在指定 `folder_token` 下创建新文件夹。
- **get_meta**：批量获取文件元信息（标题、权限、大小等）。
- **copy**：复制文件到目标目录，适用于模板复制场景。
- **move**：移动文件到目标目录（异步），返回 `task_id` 时表示任务已提交。
- **upload**：上传文件。小文件（<=15MB）走 `upload_all`，大文件自动走分片流程（prepare/part/finish）。
- **download**：下载原始文件。可保存到本地路径，或直接返回 base64 内容。
- **delete**：删除文件（异步），`type` 通过 query 参数传递，返回 `task_id` 表示删除任务已提交。

后续可在保持 CLI 兼容的前提下继续扩展更多云盘操作。
