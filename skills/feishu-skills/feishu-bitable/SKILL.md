---
name: feishu-bitable
description: |
  飞书多维表格管理。支持创建/查询/更新应用、数据表、字段、记录和视图的完整操作。
overrides: feishu_bitable_app, feishu_bitable_app_table, feishu_bitable_app_table_record, feishu_bitable_app_table_field, feishu_bitable_app_table_view, feishu_pre_auth
inline: true
---

# feishu-bitable

> **模块兼容**：所有脚本均提供 `.js` 和 `.mjs` 两个版本。优先使用 `.js`，若报 `require is not defined` 错误则改用同名 `.mjs` 文件。

⚠️ **读完本文件后，不要检查文件是否存在、不要检查环境、不要列目录。脚本文件已就绪，直接用 `exec` 工具执行下方命令。**

## 执行环境

- 所有 `node ./bitables.js` 命令的相对路径基准点是本 SKILL.md 所在目录（`feishu-bitable/`）
- harness 通常已自动设置正确 cwd，**无需手动 cd**
- 跨技能调用使用 `node ../feishu-auth/auth.js` 这样的相对路径即可

## 一次性申请全套权限（避免反复触发授权）

bitable 的不同 action 需要不同 scope。**首次使用前一次性申请下面这套**，避免每个 action 失败一次再补一次：

```bash
node ../feishu-auth/auth.js --auth-and-poll --open-id "SENDER_OPEN_ID" --chat-id "CHAT_ID" --timeout 60 \
  --scope "bitable:app drive:drive"
```

之后所有 bitable 操作都用同一个 token，不需要再次授权。

基础命令: `node ./bitables.js --open-id "SENDER_OPEN_ID"`

## 应用操作

```bash
node ./bitables.js --open-id "ou_xxx" --action create_app --name "应用名称" --folder-token "FOLDER_TOKEN"
node ./bitables.js --open-id "ou_xxx" --action get_app --app-token "APP_TOKEN"
node ./bitables.js --open-id "ou_xxx" --action update_app --app-token "APP_TOKEN" --name "新名称"
node ./bitables.js --open-id "ou_xxx" --action copy_app --app-token "APP_TOKEN" --name "副本名称" --folder-token "FOLDER_TOKEN"
```

## 数据表操作

```bash
node ./bitables.js --open-id "ou_xxx" --action create_table --app-token "APP_TOKEN" --name "表名"
node ./bitables.js --open-id "ou_xxx" --action list_tables --app-token "APP_TOKEN"
node ./bitables.js --open-id "ou_xxx" --action update_table --app-token "APP_TOKEN" --table-id "TABLE_ID" --name "新表名"
node ./bitables.js --open-id "ou_xxx" --action delete_table --app-token "APP_TOKEN" --table-id "TABLE_ID"
node ./bitables.js --open-id "ou_xxx" --action batch_create_tables --app-token "APP_TOKEN" --table-names '[{"name":"表1"},{"name":"表2"}]'
node ./bitables.js --open-id "ou_xxx" --action batch_delete_tables --app-token "APP_TOKEN" --table-ids "tblXXX,tblYYY"
```

## 字段操作

```bash
node ./bitables.js --open-id "ou_xxx" --action create_field --app-token "APP_TOKEN" --table-id "TABLE_ID" --name "字段名" --field-type 1
node ./bitables.js --open-id "ou_xxx" --action list_fields --app-token "APP_TOKEN" --table-id "TABLE_ID"
node ./bitables.js --open-id "ou_xxx" --action update_field --app-token "APP_TOKEN" --table-id "TABLE_ID" --field-id "FIELD_ID" --name "新字段名"
node ./bitables.js --open-id "ou_xxx" --action delete_field --app-token "APP_TOKEN" --table-id "TABLE_ID" --field-id "FIELD_ID"
```

### `--field-type` 类型编号（必须按用户语义选择正确类型）

| 编号 | 类型     | 适用场景                               | 是否需要 `--property` |
| ---- | -------- | -------------------------------------- | --------------------- |
| 1    | 多行文本 | 标题、描述、备注                       | 否                    |
| 2    | 数字     | 金额、数量、得分                       | 可选（格式化）        |
| 3    | **单选** | **状态、等级、优先级、分类**等枚举字段 | **必须**（预设选项）  |
| 4    | **多选** | 标签、负责模块等可多选的枚举           | **必须**（预设选项）  |
| 5    | 日期     | 创建时间、截止日期                     | 可选                  |
| 7    | 复选框   | 是否完成、是否归档                     | 否                    |
| 11   | **人员** | **负责人**、协作者、审核人             | 否                    |
| 13   | 电话号码 | 联系方式                               | 否                    |
| 15   | 超链接   | URL 字段                               | 否                    |
| 17   | 附件     | 图片、文件                             | 否                    |
| 18   | 单向关联 | 关联其他表的记录                       | 是                    |
| 19   | 查找引用 | 从关联表取值                           | 是                    |
| 20   | 公式     | 计算字段                               | 是                    |

### 单选 / 多选字段（type=3 或 4）必须传 `--property`

```bash
# 单选「严重等级」字段，预设 P0/P1/P2/P3 选项
node ./bitables.js --open-id "ou_xxx" --action create_field \
  --app-token "APP_TOKEN" --table-id "TABLE_ID" \
  --name "严重等级" --field-type 3 \
  --property '{"options":[{"name":"P0"},{"name":"P1"},{"name":"P2"},{"name":"P3"}]}'

# 单选「状态」字段
node ./bitables.js --open-id "ou_xxx" --action create_field \
  --app-token "APP_TOKEN" --table-id "TABLE_ID" \
  --name "状态" --field-type 3 \
  --property '{"options":[{"name":"待处理"},{"name":"处理中"},{"name":"已完成"},{"name":"已关闭"}]}'
```

> ⚠️ **创建单选/多选字段时若未传 `--property`，字段会变成空选项的下拉，用户后续无法正常使用。** 用户提到「等级」「状态」「优先级」「类别」等词时，**主动预设合理选项值**，不要只创建空字段。

### 人员字段（type=11）

人员字段不需要 `--property`，但用户提到「负责人」「协作者」「审核人」时应使用 type=11，**不要**用 type=1（文本）。

## 记录操作

```bash
node ./bitables.js --open-id "ou_xxx" --action create_record --app-token "APP_TOKEN" --table-id "TABLE_ID" --fields '{"字段名":"值"}'
node ./bitables.js --open-id "ou_xxx" --action list_records --app-token "APP_TOKEN" --table-id "TABLE_ID"
node ./bitables.js --open-id "ou_xxx" --action update_record --app-token "APP_TOKEN" --table-id "TABLE_ID" --record-id "RECORD_ID" --fields '{"字段名":"新值"}'
node ./bitables.js --open-id "ou_xxx" --action delete_record --app-token "APP_TOKEN" --table-id "TABLE_ID" --record-id "RECORD_ID"
node ./bitables.js --open-id "ou_xxx" --action batch_create_records --app-token "APP_TOKEN" --table-id "TABLE_ID" --records '[{"fields":{"字段名":"值1"}}]'
node ./bitables.js --open-id "ou_xxx" --action batch_update_records --app-token "APP_TOKEN" --table-id "TABLE_ID" --records '[{"record_id":"recXXX","fields":{"字段名":"新值"}}]'
node ./bitables.js --open-id "ou_xxx" --action batch_delete_records --app-token "APP_TOKEN" --table-id "TABLE_ID" --record-ids "recXXX,recYYY"
```

## 视图操作

```bash
node ./bitables.js --open-id "ou_xxx" --action create_view --app-token "APP_TOKEN" --table-id "TABLE_ID" --name "视图名" --view-type "grid"
node ./bitables.js --open-id "ou_xxx" --action list_views --app-token "APP_TOKEN" --table-id "TABLE_ID"
node ./bitables.js --open-id "ou_xxx" --action get_view --app-token "APP_TOKEN" --table-id "TABLE_ID" --view-id "VIEW_ID"
node ./bitables.js --open-id "ou_xxx" --action update_view --app-token "APP_TOKEN" --table-id "TABLE_ID" --view-id "VIEW_ID" --name "新视图名"
node ./bitables.js --open-id "ou_xxx" --action delete_view --app-token "APP_TOKEN" --table-id "TABLE_ID" --view-id "VIEW_ID"
```

## 查看表格结构（数据表 + 字段）

当用户要求查看多维表格有哪些数据表和字段时，需要两步操作：

1. 先执行 `list_tables` 获取所有数据表
2. 对每个数据表执行 `list_fields --table-id "TABLE_ID"` 获取字段列表
3. 将数据表名称及其字段信息一起结构化展示给用户

> ⚠️ `list_tables` 仅返回表名和 ID，不含字段信息。必须额外调用 `list_fields` 才能获取字段。

## 执行前确认

**以下参数缺失或含糊时，必须先向用户询问，不得猜测或使用默认值：**

| 参数          | 何时需要询问                                                                  |
| ------------- | ----------------------------------------------------------------------------- |
| `--app-token` | 用户未提供多维表格链接或 token                                                |
| `--table-id`  | 操作记录/字段/视图时，未指明目标数据表（可先用 `list_tables` 列出让用户选择） |
| `--fields`    | 创建/更新记录时用户未提供字段内容                                             |
| `--name`      | 创建应用/数据表/视图时用户未说明名称                                          |

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

## 错误处理决策树（不要无脑重试）

| 返回内容                                                | 含义                                              | 正确动作                                                              |
| ------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------- |
| `{"error":"missing_param"}`                             | 命令缺少必填参数                                  | 检查命令拼写，**不要**重新执行；必要时向用户补充                      |
| `{"error":"invalid_param"}`                             | 参数值非法（如 field-type 不存在）                | 检查取值，**不要**重试相同命令                                        |
| `{"error":"auth_required"}`                             | 用户未授权                                        | 走"一次性申请全套权限"流程                                            |
| `{"error":"permission_required"}`                       | scope 不足                                        | 用返回的 `required_scopes` 重新授权一次，之后不要再补                 |
| `{"error":"api_error","message":"...code=1254XXX..."}`  | bitable 业务错误（如表/字段不存在、字段不匹配等） | **先读 message 文本理解原因**，对应修复后再调用；不要无脑重试相同请求 |
| `{"error":"api_error","message":"...code=99991663..."}` | token 失效                                        | 重新授权                                                              |
| 重复创建报错（已存在）                                  | 同名资源已存在                                    | **先用 list_tables / list_fields 找现有 ID，复用而非新建**            |

> **核心原则**：错误返回后**先读 message，再决定下一步**。失败的命令重试 2 次以上一定有问题，停下来分析。

## 创建前必须先检查（避免重复创建）

- **创建多维表格应用**（`create_app`）前：先用 feishu-search-doc / feishu-drive 在目标文件夹下查找同名应用，存在则直接复用 `app_token`
- **创建数据表**（`create_table`）前：先 `list_tables` 查看是否已有同名表
- **创建字段**（`create_field`）前：先 `list_fields` 查看是否已有同名字段
- **创建记录** 不需要预检查，但批量创建时同一批次内不要有重复

## 禁止事项

- **禁止**检查文件、列目录、检查环境，脚本已就绪
- **禁止**调用任何 `feishu_` 开头的工具
- **禁止**只描述不执行，必须直接调用 `exec`
- `CHAT_ID` 为当前会话的 chat_id，如不知道可省略
