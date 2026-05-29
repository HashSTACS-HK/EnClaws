---
name: feishu-sheet
description: |
  飞书电子表格（Sheets）工具。支持读写单元格、追加行、查找内容、创建表格、导出 xlsx/csv。
  电子表格类似 Excel/Google Sheets，与多维表格（Bitable）是不同产品。
overrides: feishu_sheet, feishu_pre_auth
inline: true
---

# feishu-sheet

> **模块兼容**：所有脚本均提供 `.js` 和 `.mjs` 两个版本。优先使用 `.js`，若报 `require is not defined` 错误则改用同名 `.mjs` 文件。

直接用 `exec` 执行，不要检查文件或环境。

## 获取表格信息（info）

```bash
node ./sheet.js --open-id "ou_xxx" --action info --url "https://xxx.feishu.cn/sheets/TOKEN"
```

返回表格标题、spreadsheet_token、全部工作表列表（含 sheet_id、行列数）。支持知识库 wiki URL 自动解析。

## 读取数据（read）

```bash
node ./sheet.js --open-id "ou_xxx" --action read --url "https://..."
node ./sheet.js --open-id "ou_xxx" --action read --url "https://..." --sheet-id "0b4f38"
node ./sheet.js --open-id "ou_xxx" --action read --url "https://..." --range "0b4f38!A1:D20"
```

不填 `--range` 和 `--sheet-id` 时自动读取第一个工作表全部数据（最多 200 行）。

## 覆盖写入（write）⚠️ 高危

```bash
node ./sheet.js --open-id "ou_xxx" --action write --url "https://..." \
  --range "0b4f38!A1:B2" --values '[["姓名","年龄"],["张三",25]]'
```

**会覆盖 range 内已有数据**，调用前必须向用户确认写入范围和内容。

## 追加行（append）

```bash
node ./sheet.js --open-id "ou_xxx" --action append --url "https://..." \
  --values '[["张三","工程","2026-01-01"]]'
node ./sheet.js --open-id "ou_xxx" --action append --url "https://..." \
  --sheet-id "0b4f38" --values '[["row1col1","row1col2"]]'
```

在已有数据末尾追加，不覆盖原有内容。

## 查找单元格（find）

```bash
node ./sheet.js --open-id "ou_xxx" --action find --url "https://..." \
  --sheet-id "0b4f38" --find "关键词"
node ./sheet.js --open-id "ou_xxx" --action find --url "https://..." \
  --sheet-id "0b4f38" --find "^张" --search-by-regex true
```

可选：`--range "A1:D100"` `--match-case true` `--match-entire-cell true` `--search-by-regex true` `--include-formulas true`

## 创建表格（create）

```bash
node ./sheet.js --open-id "ou_xxx" --action create --title "员工花名册"
node ./sheet.js --open-id "ou_xxx" --action create --title "员工花名册" \
  --folder-token "TOKEN" \
  --headers '["姓名","部门","入职日期"]' \
  --data '[["张三","工程","2026-01-01"],["李四","产品","2026-02-01"]]'
```

## 导出文件（export）

```bash
node ./sheet.js --open-id "ou_xxx" --action export --url "https://..." --file-extension xlsx
node ./sheet.js --open-id "ou_xxx" --action export --url "https://..." \
  --file-extension csv --sheet-id "0b4f38" --output-path "data.csv"
```

CSV 导出时 `--sheet-id` 必填（一次只能导出一个工作表）。

## 参数总览

| 参数                  | 必填                | 说明                                                  |
| --------------------- | ------------------- | ----------------------------------------------------- |
| `--open-id`           | 是                  | 当前用户 open_id                                      |
| `--action`            | 是                  | info / read / write / append / find / create / export |
| `--url`               | 多数 action 必填    | 表格 URL（支持 feishu.cn/sheets/ 和 feishu.cn/wiki/） |
| `--spreadsheet-token` | 二选一              | 与 `--url` 二选一                                     |
| `--sheet-id`          | find 必填，其余可选 | 工作表 ID（通过 info 获取）                           |
| `--range`             | 可选                | 范围，格式 `sheetId!A1:D10` 或 `sheetId`              |
| `--values`            | write/append 必填   | JSON 二维数组，如 `'[["A","B"],["1","2"]]'`           |
| `--find`              | find 必填           | 搜索内容                                              |
| `--title`             | create 必填         | 表格标题                                              |
| `--headers`           | 可选                | JSON 字符串数组，如 `'["姓名","部门"]'`               |
| `--data`              | 可选                | JSON 二维数组，写在表头后                             |
| `--file-extension`    | export 必填         | xlsx 或 csv                                           |
| `--output-path`       | 可选                | 本地保存路径（含文件名）                              |

## 典型场景

- 查看表格结构 → `info`（先获取 sheet_id，再进行后续操作）
- 读取全表 → `read`（不指定 range，自动读第一个工作表）
- 批量写入 → 先 `info` 确认工作表，再 `write` 或 `append`
- 搜索某个值在哪行 → `find`
- 新建并初始化 → `create` + `--headers` + `--data`

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
