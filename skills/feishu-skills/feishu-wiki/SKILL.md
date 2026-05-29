---
name: feishu-wiki
description: |
  飞书知识库管理工具。支持知识空间（Space）的增删查，以及知识库节点（Node）的增删查/移动/复制。
  节点是知识库中的文档，包括 docx、sheet、bitable 等类型。
overrides: feishu_wiki_space, feishu_wiki_space_node, feishu_pre_auth
inline: true
---

# feishu-wiki

> **模块兼容**：所有脚本均提供 `.js` 和 `.mjs` 两个版本。优先使用 `.js`，若报 `require is not defined` 错误则改用同名 `.mjs` 文件。

直接用 `exec` 执行，不要检查文件或环境。

---

## 知识空间（Space）操作

### 列出所有知识空间

```bash
node ./wiki.js --open-id "ou_xxx" --action space_list
node ./wiki.js --open-id "ou_xxx" --action space_list --page-size 20
```

### 获取知识空间详情

```bash
node ./wiki.js --open-id "ou_xxx" --action space_get --space-id "SPACE_ID"
```

### 创建知识空间

```bash
node ./wiki.js --open-id "ou_xxx" --action space_create --name "项目文档" --description "描述（可选）"
```

---

## 知识库节点（Node）操作

### 列出节点（根节点或子节点）

```bash
# 列出根节点
node ./wiki.js --open-id "ou_xxx" --action node_list --space-id "SPACE_ID"

# 列出某节点的子节点
node ./wiki.js --open-id "ou_xxx" --action node_list --space-id "SPACE_ID" --parent-node-token "NODE_TOKEN"
```

### 获取节点详情（含 obj_token）

```bash
node ./wiki.js --open-id "ou_xxx" --action node_get --token "NODE_OR_WIKI_TOKEN"
node ./wiki.js --open-id "ou_xxx" --action node_get --token "NODE_TOKEN" --obj-type wiki
```

> `node_get` 的核心用途：将 wiki 类型的 node_token 转换为实际文档的 obj_token（用于后续 feishu-fetch-doc、feishu-sheet 等 skill）。

返回 `url` 字段为节点链接（格式 `https://www.feishu.cn/wiki/{node_token}`）。

### 创建节点（新文档）

```bash
# 在根目录创建 docx 文档
node ./wiki.js --open-id "ou_xxx" --action node_create \
  --space-id "SPACE_ID" --obj-type docx --node-type origin --title "新文档标题"

# 在指定父节点下创建
node ./wiki.js --open-id "ou_xxx" --action node_create \
  --space-id "SPACE_ID" --obj-type docx --node-type origin \
  --parent-node-token "PARENT_TOKEN" --title "子文档"

# 创建快捷方式
node ./wiki.js --open-id "ou_xxx" --action node_create \
  --space-id "SPACE_ID" --obj-type docx --node-type shortcut \
  --origin-node-token "ORIGIN_TOKEN"
```

返回 `url` 字段为文档链接（格式 `https://www.feishu.cn/wiki/{node_token}`），`reply` 中直接包含链接。

### 移动节点

```bash
# 移动到另一父节点下
node ./wiki.js --open-id "ou_xxx" --action node_move \
  --space-id "SPACE_ID" --node-token "NODE_TOKEN" --target-parent-token "NEW_PARENT_TOKEN"

# 移动到根目录（不填 --target-parent-token）
node ./wiki.js --open-id "ou_xxx" --action node_move \
  --space-id "SPACE_ID" --node-token "NODE_TOKEN"
```

返回 `url` 字段为移动后节点的链接（格式 `https://www.feishu.cn/wiki/{node_token}`）。

### 复制节点

```bash
# 复制到同一知识空间的另一位置
node ./wiki.js --open-id "ou_xxx" --action node_copy \
  --space-id "SPACE_ID" --node-token "NODE_TOKEN" \
  --target-parent-token "TARGET_PARENT_TOKEN" --title "副本标题"

# 复制到另一个知识空间
node ./wiki.js --open-id "ou_xxx" --action node_copy \
  --space-id "SOURCE_SPACE_ID" --node-token "NODE_TOKEN" \
  --target-space-id "TARGET_SPACE_ID" --target-parent-token "TARGET_PARENT_TOKEN"
```

返回 `url` 字段为新节点链接（格式 `https://www.feishu.cn/wiki/{node_token}`）。

---

## 参数总览

| 参数                    | 必填              | 说明                                                          |
| ----------------------- | ----------------- | ------------------------------------------------------------- |
| `--open-id`             | 是                | 当前用户 open_id                                              |
| `--action`              | 是                | 见下方 Action 表                                              |
| `--space-id`            | 多数 action 必填  | 知识空间 ID                                                   |
| `--token`               | node_get 必填     | 节点 token 或文档 token                                       |
| `--node-token`          | move/copy 必填    | 被操作的节点 token                                            |
| `--parent-node-token`   | 可选              | node_list 时指定父节点；node_create 时指定父节点              |
| `--target-parent-token` | 可选              | move/copy 目标父节点                                          |
| `--target-space-id`     | 可选              | copy 时跨空间目标 space_id                                    |
| `--obj-type`            | node_create 必填  | `docx` / `sheet` / `bitable` / `mindnote` / `file` / `slides` |
| `--node-type`           | node_create 必填  | `origin`（新建）/ `shortcut`（快捷方式）                      |
| `--origin-node-token`   | shortcut 时必填   | 快捷方式指向的原始节点                                        |
| `--title`               | 可选              | 节点/空间标题                                                 |
| `--name`                | space_create 必填 | 知识空间名称                                                  |
| `--description`         | 可选              | 知识空间描述                                                  |
| `--page-size`           | 可选              | 分页大小                                                      |
| `--page-token`          | 可选              | 翻页 token                                                    |
| `--obj-type`            | node_get 可选     | 默认 `wiki`，可指定 `doc`/`sheet`/`bitable` 等                |

## Action 速查

| Action         | 说明                                                         |
| -------------- | ------------------------------------------------------------ |
| `space_list`   | 列出当前用户可见的知识空间                                   |
| `space_get`    | 获取指定知识空间详情                                         |
| `space_create` | 创建知识空间                                                 |
| `node_list`    | 列出空间内节点（根节点或指定父节点的子节点）                 |
| `node_get`     | 获取节点详情（可将 wiki token 转换为 obj_token），返回 `url` |
| `node_create`  | 在空间内创建新文档节点，返回 `url`                           |
| `node_move`    | 移动节点到另一位置，返回 `url`                               |
| `node_copy`    | 复制节点到另一位置（可跨空间），返回 `url`                   |

## 典型场景

- 查看知识库目录 → `space_list` 后 `node_list`
- 在知识库里创建新文档 → `node_create --obj-type docx`
- 获取知识库文档的实际 token（供 feishu-fetch-doc 使用）→ `node_get`
- 整理文档结构 → `node_move`
- 归档复制 → `node_copy`

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
