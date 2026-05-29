---
name: feishu-docx-download
description: |
  下载并提取**附件文件**正文：Word(.docx/.doc)、PDF、PPT(.pptx/.ppt)、Excel(.xlsx/.xls)、html/rtf/epub/txt/csv 等。
  仅处理云盘文件 (`/file/`) 和 Wiki 附件 (`/wiki/` 中 obj_type=file)。**飞书在线云文档（URL 含 `/docx/` `/docs/`）请用 feishu-fetch-doc。**
overrides: feishu_drive_file, feishu_pre_auth
inline: true
---

# feishu-docx-download

> **模块兼容**：所有脚本均提供 `.js` 和 `.mjs` 两个版本。优先使用 `.js`，若报 `require is not defined` 错误则改用同名 `.mjs` 文件。

⚠️ **读完本文件后，不要检查文件是否存在、不要检查环境、不要列目录。脚本文件已就绪，直接用 `exec` 工具执行下方命令。**

## 判断是否使用本技能

| URL 特征                                | 文档形式    | 处理方式                |
| --------------------------------------- | ----------- | ----------------------- |
| 含 `/docx/` 或 `/docs/`                 | 在线云文档  | 用 **feishu-fetch-doc** |
| 含 `/wiki/`，`obj_type` 为 `doc`/`docx` | Wiki 云文档 | 用 **feishu-fetch-doc** |
| 含 `/wiki/`，`obj_type` 为 `file`       | Wiki 附件   | **使用本技能** ✓        |
| 含 `/file/`                             | 云盘文件    | **使用本技能** ✓        |

## 上下游工作流

### 上游：用户没给 URL 或 file_token 时（不要直接询问用户）

如果用户只描述「云盘里的 Word 文件」「我那个 PDF」等模糊请求，**必须先调用 feishu-drive 查找**，从结果中拿到 `file_token`：

```bash
# 列出云盘根目录或指定文件夹
node ../feishu-drive/drive.js --open-id "SENDER_OPEN_ID" --action list

# 或按名称搜索
node ../feishu-search-doc/search-doc.js --open-id "SENDER_OPEN_ID" --query "文件名关键词"
```

从结果中筛选出附件类型的文件（type 为 `file`、扩展名为 .docx/.pdf/.xlsx 等），取 `token` 字段传给本技能。

### 下游：提取文本后写入新文档

提取出的纯文本通常是为了写入新文档。**正确做法**：分两步执行，先把 `extract.js` 的输出读进来，再作为 `feishu-create-doc` 的 `--markdown` 参数传入：

1. 第一步：执行 `node ./extract.js "<filepath>"`，把 stdout 完整捕获为文本变量
2. 第二步：执行 `node ../feishu-create-doc/create-doc.js --open-id "..." --title "..." --markdown "<上一步的文本>"`，传参时对内容做必要的 shell 转义

> ⚠️ **不要用 `$(...)` shell 命令替换**：提取的文本常含双引号、`$`、反引号、换行等字符，会破坏 shell 解析；大文档还可能超过 argv 长度上限；Windows shell 也不支持该语法。务必先把内容捕获到变量再传参。

## 执行前确认

**以下参数缺失或含糊时，必须先向用户询问，不得猜测或使用默认值：**

| 参数                     | 何时需要询问                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| `--url` / `--file-token` | 用户未提供飞书链接或 file token，**且通过 feishu-drive / feishu-search-doc 也无法定位**时 |

## 步骤 1 — 下载文件

```bash
node ./download-doc.js --open-id "SENDER_OPEN_ID" --url "FEISHU_URL"
```

支持的 URL 格式：

- Wiki 附件：`https://xxx.feishu.cn/wiki/TOKEN`
- 云盘文件：`https://xxx.feishu.cn/file/TOKEN`

也可直接传 file_token：

```bash
node ./download-doc.js --open-id "SENDER_OPEN_ID" --file-token "FILE_TOKEN" --type "docx"
```

可选参数：`--output-dir <目录>`、`--output 自定义文件名.docx`

文件默认下载到当前用户的工作空间目录。脚本输出 JSON，其中 `file_path` 为本地路径，`file_type` 为扩展名。

## 授权

若返回 `{"error":"auth_required"}` 或 `{"error":"permission_required"}`，**不要询问用户是否授权，直接立即执行以下命令发送授权链接：**

- 若返回 JSON 中包含 `required_scopes` 字段，将其数组值用空格拼接后传入 `--scope` 参数：

```bash
node ../feishu-auth/auth.js --auth-and-poll --open-id "SENDER_OPEN_ID" --chat-id "CHAT_ID" --timeout 60 --scope "<required_scopes 用空格拼接>"
```

- 若返回中不包含 `required_scopes`，则不加 `--scope` 参数。

- `{"status":"authorized"}` → 重新执行下载命令
- `{"status":"polling_timeout"}` → **立即重新执行此 auth 命令**（不会重复发卡片）
- `CHAT_ID` 不知道可省略

## 步骤 2 — 提取文本（必须执行）

⚠️ **下载成功后必须立即执行此命令提取文本，不要跳过，不要用其他方式替代。**

```bash
node ./extract.js "<filepath>"
```

- `<filepath>` 替换为步骤 1 返回的 `file_path`
- 支持格式：docx、pdf、pptx、xlsx、xls、doc、ppt、rtf、epub、html、htm、txt、csv、md
- 纯 Node.js 实现，**不需要 Python**，缺少的 npm 依赖会自动安装
- 脚本根据扩展名自动选择提取方式，直接输出纯文本

## 步骤 3 — 图片文字识别（按需，必须用 feishu-image-ocr 技能）

提取结果中如果包含 `[图片]` 或 `[文档包含 N 张图片]` 标记，说明文档中嵌入了图片，但图片内容未被提取为文字。

**你必须主动告知用户：**

> 文档中包含 X 张图片，图片内容暂未识别。如需识别图片中的文字，我可以使用 OCR 技能为您进一步处理。

**用户确认后**，必须且只能使用 `feishu-image-ocr` 技能来识别图片文字：

```bash
node ../feishu-image-ocr/ocr.js --image "<image_path>" --json
```

- **禁止**自行编写图片识别代码或调用其他 OCR API/库，**必须使用 `feishu-image-ocr` 技能**
- `feishu-image-ocr` 调用飞书 OCR API，支持中英文混排，纯 Node.js，零额外依赖
- 如果用户未确认，**不要自动调用 OCR**，仅保留 `[图片]` 标记即可

## 禁止事项

- **禁止**检查文件、列目录、检查环境，脚本已就绪
- **禁止**调用任何 `feishu_` 开头的工具
- **禁止**只描述不执行，必须直接调用 `exec`
- **禁止**自行编写提取代码或使用 Python，必须使用 `node ./extract.js`
- **禁止**告诉用户"无法提取"或"需要安装 Python"，`extract.js` 已内置所有提取能力
- **禁止**自行实现图片识别或调用第三方视觉 API，图片识别**只能使用 `feishu-image-ocr` 技能**（`node ../feishu-image-ocr/ocr.js`）
- `CHAT_ID` 为当前会话的 chat_id，如不知道可省略
