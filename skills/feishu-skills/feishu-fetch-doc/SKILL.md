---
name: feishu-fetch-doc
description: |
  读取**飞书在线云文档**（URL 含 `/docx/` 或 `/docs/`，或 Wiki 节点 obj_type=docx/doc）内容，返回 Markdown。
  **不处理云盘附件文件**（Word .docx/PDF/Excel 等二进制文件）—— 那种请用 feishu-docx-download。
overrides: feishu_fetch_doc, feishu_wiki_space_node, feishu_pre_auth
inline: true
---

# feishu-fetch-doc

> **模块兼容**：所有脚本均提供 `.js` 和 `.mjs` 两个版本。优先使用 `.js`，若报 `require is not defined` 错误则改用同名 `.mjs` 文件。

直接用 `exec` 执行，不要检查文件或环境。

## 命令

```bash
node ./fetch-doc.js --open-id "SENDER_OPEN_ID" --doc-id "文档TOKEN或URL"
```

若为 wiki 链接，加 `--wiki`。脚本自动从 URL 解析 token。

## 适用范围（先判断再调用）

| 用户描述                                        | 是否用本技能                   |
| ----------------------------------------------- | ------------------------------ |
| 「读取这个文档」+ URL 含 `/docx/` 或 `/docs/`   | ✅ 用本技能                    |
| 「读取 wiki 文档」+ Wiki 节点 obj_type=docx/doc | ✅ 用本技能                    |
| 「读取/下载云盘里的 Word/PDF/Excel 文件」       | ❌ 用 **feishu-docx-download** |
| 「读取我那个 .docx / .pdf 文件」                | ❌ 用 **feishu-docx-download** |
| Wiki 节点 obj_type=file（附件文件）             | ❌ 用 **feishu-docx-download** |

> ⚠️ **「Word 文档」≠ 飞书在线 docx**：用户说"Word 文档"通常指 .docx 二进制文件（云盘附件），应走 feishu-docx-download。

## 用户只提供文档标题时

如果用户只提供了文档标题而非链接或 token，**必须先用 feishu-search-doc 搜索**，从结果中取得文档 token 后再执行本脚本：

```bash
node ../feishu-search-doc/search-doc.js --open-id "SENDER_OPEN_ID" --query "文档标题"
```

从搜索结果中找到匹配的文档 token（`doc_token` 字段），再传给 `--doc-id`。**不要因为缺少 token 就向用户询问，应主动搜索。**

## 必须确认的参数

| 参数       | 何时询问                                                                        |
| ---------- | ------------------------------------------------------------------------------- |
| `--doc-id` | 用户未提供文档链接或 token，且通过 feishu-search-doc 搜索后仍无法确定目标文档时 |

## 输出

脚本返回 JSON，将 `markdown` 字段内容展示给用户。

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

## 文件类型不支持时

若返回 `{"error":"unsupported_type"}` 且 `hint` 字段提示使用 `feishu-docx-download`，说明该文档是附件文件（Word、PDF 等），不是在线云文档。**必须立即改用 feishu-docx-download 技能处理**，不要放弃或自行总结。
