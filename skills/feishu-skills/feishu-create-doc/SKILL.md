---
name: feishu-create-doc
description: |
  创建飞书云文档。使用当前用户的个人 OAuth token。标题须与用户输入逐字一致；成功回复含 Markdown 文档链接。
overrides: feishu_create_doc, feishu_pre_auth
inline: true
---

# feishu-create-doc

> **模块兼容**：所有脚本均提供 `.js` 和 `.mjs` 两个版本。优先使用 `.js`，若报 `require is not defined` 错误则改用同名 `.mjs` 文件。

直接用 `exec` 执行，不要检查文件或环境。

## 常见上游

`--markdown` 入参可以来自其它技能的输出：

| 上游技能                                | 用途                                                                       |
| --------------------------------------- | -------------------------------------------------------------------------- |
| **feishu-docx-download** + `extract.js` | 把云盘里的 Word/PDF/PPT/Excel 等附件文件提取为纯文本，再写入新建的飞书文档 |
| **feishu-fetch-doc**                    | 把已有的飞书在线云文档内容（markdown 字段）作为新文档初始内容              |
| 用户消息 / 其它任意来源                 | 直接传 `--markdown "..."`                                                  |

> 典型工作流：`feishu-drive list` → `feishu-docx-download` 下载并提取 → **feishu-create-doc** 创建新文档并写入提取的内容。

## 一次性创建 + 写入（禁止 create 后再 update）

⛔ **禁止**先创建空文档再调用 `feishu-update-doc` 写入内容。`create-doc.js` 的 `--markdown` 参数支持创建时直接写入完整内容，**一次 API 调用即可完成**。

```bash
# ✅ 正确：创建时一次性传入内容
node ./create-doc.js --open-id "SENDER_OPEN_ID" --title "文档标题" --markdown "## 第一章\n内容..."

# ❌ 错误：分两步（多余 API 调用，标题/内容易不一致）
node ./create-doc.js --open-id "SENDER_OPEN_ID" --title "文档标题"
node ../feishu-update-doc/update-doc.js --doc-id "TOKEN" --mode append --markdown "..."
```

只有在以下情况才用 `feishu-update-doc`：

- 修改/追加**已存在**的文档（不是本次新建的）
- 创建后**用户后续要求**追加新内容

## 标题与回复格式（必须遵守）

- **`--title` 必须与用户给出的标题逐字一致**（含下划线 `_`、空格、中英文括号等）。禁止擅自「美化」或改写标题。
- 执行完脚本后，将返回 JSON 中的 **`reply` 完整**发给用户（含 **Markdown 链接** `[标题](doc_url)`，见脚本输出）；并可同时附上 `doc_url` 字段，避免只写「点击查看」而无 URL。
- 用户要求在某个**知识库**中新建文档时：
  - 若未给出 `wiki` 节点 token：先用 **feishu-search-doc**（如 `list_wiki_spaces` / `wiki_nodes`）列出候选空间或节点，请用户确认**具体知识库与位置**；说明应用/用户需对该知识库有创建权限。
  - 取得 `node_token` 后传入 `--wiki-node` 再创建；不要猜测 token。

## 文件夹 / 知识库仅有名称、没有 token 时

当用户指定了**云盘文件夹名称**或**知识库 / 节点名称**，但未提供 `folder_token` / `wiki` 节点 token 时，**不要猜测 token**：先调用 **feishu-search-doc** 搜索，从返回 JSON 中取 `create_doc_token` 或对应字段，再执行本技能下的 `create-doc.js`。

- 云盘文件夹：`feishu-search-doc` 的 `drive` / `all --include-drive` 结果中文件夹的 `token` → 传给 `--folder-token`
- 知识库节点：`wiki_nodes` 结果中的 `node_token` → 传给 `--wiki-node`

## 命令

```bash
node ./create-doc.js --open-id "SENDER_OPEN_ID" --title "文档标题" --markdown "Markdown内容"
```

可选：`--folder-token TOKEN`、`--wiki-node TOKEN`

## 必须确认的参数

| 参数         | 何时询问                             |
| ------------ | ------------------------------------ |
| `--title`    | 用户未说明标题                       |
| `--markdown` | 用户未提供内容（明确要空文档可省略） |

## 输出

脚本返回 JSON，将 **`reply` 字段原样、完整**输出给用户（勿截断）；`reply` 中已包含可点击的 Markdown 文档链接。

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

## 与其他技能的编排建议

当用户仅给出「文件夹名称」而未提供 `folder_token` 时，建议按以下顺序编排多个技能：

1. **优先通过搜索确认文件夹是否已存在**
   - 调用 `feishu-search-doc`（假设已安装）按名称搜索相关文档 / 文件夹。
   - 若搜索结果明确且唯一，可直接从搜索结果中拿到目标文件夹或父目录信息。

2. **搜索结果不确定时，使用云盘浏览确认**
   - 当搜索结果较多或用户无法确认时，调用 `feishu-drive`：
     - `node ./drive.js --open-id "SENDER_OPEN_ID" --action list --folder-token "父目录TOKEN"`
   - 引导用户在列出的 `items` 中确认目标文件夹，或告知确实不存在。

3. **文件夹不存在时自动创建**
   - 当确认文件夹不存在时，调用 `feishu-drive` 创建：
     - `node ./drive.js --open-id "SENDER_OPEN_ID" --action create_folder --name "文件夹名" --folder-token "父目录TOKEN"`
   - 从返回结果中读取新建文件夹的 `folder_token`。

4. **拿到 `folder_token` 后创建文档**
   - 使用本技能创建文档，并将 `folder_token` 透传给脚本：
     - `node ./create-doc.js --open-id "SENDER_OPEN_ID" --title "文档标题" --markdown "Markdown内容" --folder-token "TOKEN"`

通过上述编排，`feishu-search-doc` 负责查找，`feishu-drive` 负责浏览与创建文件夹，`feishu-create-doc` 专注于创建文档，三个技能职责单一且可复用。
