---
name: feishu-im-read
description: |
  读取飞书 IM 消息。支持会话历史和跨会话搜索。
overrides: feishu_im_user_get_messages, feishu_im_user_search_messages, feishu_im_user_get_thread_messages, feishu_pre_auth
inline: true
---

# feishu-im-read

> **模块兼容**：所有脚本均提供 `.js` 和 `.mjs` 两个版本。优先使用 `.js`，若报 `require is not defined` 错误则改用同名 `.mjs` 文件。

直接用 `exec` 执行，不要检查文件或环境。

## 获取会话消息（应用级权限，无需用户授权）

使用 tenant_access_token，机器人必须在群组中。

```bash
node ./im-read.js --action "get_messages" --open-id "SENDER_OPEN_ID" --chat-id "oc_xxx"
```

可选：`--thread-id "omt_xxx"` `--relative-time "today"` `--start-time "ISO8601"` `--end-time "ISO8601"` `--sort-rule "create_time_asc"` `--page-size 20` `--page-token "xxx"`

## 搜索消息（需要用户授权）

使用 user_access_token。

```bash
node ./im-read.js --action "search_messages" --open-id "SENDER_OPEN_ID" --query "关键词"
```

可选：`--chat-id "oc_xxx"` `--sender-ids "ou_xxx,ou_yyy"` `--message-type "file"` `--chat-type "group"`

## 必须确认的参数

| 参数                             | 何时询问                                          |
| -------------------------------- | ------------------------------------------------- |
| `--chat-id` / `--target-open-id` | 用户未指明会话（当前会话 chat_id 可从上下文获取） |
| `--query`                        | search_messages 时未提供关键词                    |

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

## 消息内容分类（识别附件类型，防止误用跨层 ID）

机器人拿到消息 `content` 后，按下列规则判别，**严格按 kind 分派**，不要跨层调用：

| 识别特征                                                                                    | kind                   | 后续动作                                                                                                                            |
| ------------------------------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `msg_type === "folder"`（content: `{file_key, file_name}`，file*key 前缀 `file_v3_0110n*`） | `im_folder_attachment` | ❌ **不可下载**。走下方"文件夹附件兜底"话术，**禁止**把 `file_v3_...` 当 folder_token 调云盘 API，**禁止**拿 `file_name` 去云盘搜索 |
| `msg_type === "file"` 且 `file_name` 以 `.zip` / `.tar.gz` / `.tgz` / `.rar` / `.7z` 结尾   | `im_archive`           | 调 feishu-im-file-analyze（自动下载 + 解压 + 逐文件抽文本）                                                                         |
| `msg_type === "file"`（其他单个文件，file*key 前缀 `file_v3_0010n*`）                       | `im_file`              | 调 feishu-im-file-analyze（支持 pdf/docx/pptx/xlsx/... 等）                                                                         |
| 正文含 `/drive/folder/[A-Za-z0-9]+`（纯字母数字 token，非 `file_` 前缀）                    | `drive_folder_link`    | 提取 folder_token → 调 feishu-drive / feishu-search-doc                                                                             |
| 正文含 `/wiki/[A-Za-z0-9]+`                                                                 | `wiki_node_link`       | 提取 node_token → 走 wiki 路径                                                                                                      |
| 其他                                                                                        | `plain_text`           | 按文本处理                                                                                                                          |

> **权威字段是 `msg_type`**。早期文档说"msg_type 枚举不含 folder"并不正确——实测飞书 API 会返回 `msg_type: "folder"`，content 形如 `{"file_key":"file_v3_0110n_xxx","file_name":"..."}`，与 `msg_type=file` 格式一致，**仅靠 content 字段无法区分**，必须看 `msg_type`。file_key 前缀 `0110n`（folder）vs `0010n`（file）可作次要判据。

### 命名空间铁律

**IM `file_key`（以 `file_` 开头，如 `file_v3_0110n_...`）⇄ 云盘 `folder_token`（纯字母数字、无前缀）是两套独立 ID 体系**。飞书 `/drive/*` skill 已在入口硬拒绝 `file_*` 前缀的 token，传入会直接 `invalid_folder_token_im_file_key` 报错。改前缀、换格式都不通——根本不在同一个命名空间里。

### 文件夹附件兜底话术（`im_folder_attachment`）

识别到此类消息后，**立即回复以下内容，禁止尝试任何云盘查询**：

> 📁 收到文件夹消息「{name}」。
>
> 当前飞书 open API 未公开 `msg_type=folder` 附件的下载接口（尝试走 `im:resource` 会报 234003 `File not in msg.`），机器人无法直接读取内部文件。
>
> **请改用以下任一方式：**
>
> 1. 本地把文件夹**压缩为 .zip** 后发给我（最省事，zip 是标准附件可直接读）
> 2. 把文件夹**上传到飞书云盘** → 右键"分享" → 把 `https://xxx.feishu.cn/drive/folder/xxx` 链接发给我
> 3. 把里面的文件**逐个**发送

### 历史事故模式（禁止复现）

- ❌ 拿 `file_v3_...` 当 folder_token 调 `/drive/v1/files` → 必然失败
- ❌ 失败后不传 folder_token 调 `/drive/v1/files` → 拿到**云盘根目录**列表
- ❌ 把根目录的 N 个文件**当作该文件夹的内容**回复用户（幻觉）
- ❌ 拿 `<folder name>` 里的展示名去云盘搜索，把无关结果凑上当关联
