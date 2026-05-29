---
name: feishu-search-doc
description: |
  按关键词搜索飞书云文档、知识库空间/节点，或在指定云盘目录下列表并按名称筛选。使用当前用户个人 OAuth token，可配合 create-doc / fetch-doc / update-doc 等解析 folder_token 与 wiki 节点。
overrides: feishu_search_doc_wiki
inline: true
---

# feishu-search-doc

> **模块兼容**：所有脚本均提供 `.js` 和 `.mjs` 两个版本。优先使用 `.js`，若报 `require is not defined` 错误则改用同名 `.mjs` 文件。

直接用 `exec` 执行，不要检查文件或环境。

## 依赖 API（飞书开放平台）

- 云文档搜索：`POST /open-apis/suite/docs-api/search/object`
- 知识库空间列表：`GET /open-apis/wiki/v2/spaces`
- 知识库子节点列表：`GET /open-apis/wiki/v2/spaces/:space_id/nodes`
- 云盘目录列表（按名称筛选）：`GET /open-apis/drive/v1/files`

## 命令

默认 **all**：并行搜索云文档（最多约 50 条）+ 按名称筛选知识库空间；可选叠加云盘筛选。

```bash
node ./search-doc.js --open-id "SENDER_OPEN_ID" --query "关键词" [--action all]
```

仅搜云文档（支持分页参数）：

```bash
node ./search-doc.js --open-id "SENDER_OPEN_ID" --query "关键词" --action docs [--count 20] [--offset 0]
```

仅按名称筛选知识库空间（在已拉取的全量空间列表上本地匹配）：

```bash
node ./search-doc.js --open-id "SENDER_OPEN_ID" --query "空间名" --action wiki_spaces
```

列出当前用户可见的全部知识库空间（无需 `--query`）：

```bash
node ./search-doc.js --open-id "SENDER_OPEN_ID" --action list_wiki_spaces
```

在某一知识库空间下按标题筛选节点（默认只查**一层**子节点；`--parent-node-token` 省略表示根下子节点）：

```bash
node ./search-doc.js --open-id "SENDER_OPEN_ID" --query "节点标题" --action wiki_nodes --wiki-space-id "SPACE_ID" [--parent-node-token "NODE_TOKEN"]
```

在知识库内**浅层遍历**子树按标题筛选（有 API 次数上限，默认 `--max-visits 80`）：

```bash
node ./search-doc.js --open-id "SENDER_OPEN_ID" --query "标题" --action wiki_nodes --wiki-space-id "SPACE_ID" --deep [--max-visits 80]
```

在云盘某目录下按名称筛选（`--folder-token` 省略或空字符串表示根目录）：

```bash
node ./search-doc.js --open-id "SENDER_OPEN_ID" --query "文件夹或文件名" --action drive [--folder-token "父目录TOKEN"]
```

在 **all** 模式下同时做云盘名称筛选（需显式打开，避免多余调用）：

```bash
node ./search-doc.js --open-id "SENDER_OPEN_ID" --query "关键词" --action all --include-drive [--folder-token "父目录TOKEN"]
```

## 输出

脚本输出单行 JSON。将 `reply` 原样给用户；编排时优先使用：

- 云文档：`docs[]` 中的 `docs_token`、`docs_type`、`url`
- 知识库空间：`wiki_spaces[]` 中的 `space_id`、`name`
- 知识库节点：`wiki_nodes[]` 中的 `node_token`、`obj_type`、`create_doc_token`（供 `feishu-create-doc` 的 `--wiki-node`）
- 云盘文件夹：`drive[]` 中 `type` 为 `folder` 的 `token`（供 `--folder-token`）

## 授权

若返回 `{"error":"auth_required"}` 或 `{"error":"permission_required"}`，按与其他 feishu 技能相同方式调用 `feishu-auth`；若 JSON 含 `required_scopes`，将其用空格拼入 `--scope` 后执行 `auth.js --auth-and-poll`。
