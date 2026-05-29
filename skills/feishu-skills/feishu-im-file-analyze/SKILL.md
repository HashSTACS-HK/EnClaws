---
name: feishu-im-file-analyze
description: |
  下载并解析飞书 IM 消息里的附件（pdf / docx / pptx / xlsx / xls / doc / ppt / rtf / epub / html / txt / csv / md / zip），
  返回结构化文本供 AI 分析。zip 会自动解压后递归处理支持的类型。
  适用场景（凡是"用户把文件直接发给机器人让它读/总结/对比/提炼"都走本 skill）：
  - 简历筛选：HR/老板把 PDF 简历或打包简历 zip 甩给机器人，让机器人提炼候选人亮点
  - 合同/协议审阅：法务/业务发 Word、PDF 合同给机器人，让机器人抽关键条款、找风险点
  - 会议/访谈材料：把 pptx 培训资料、doc 纪要、md 笔记发进群，让机器人生成摘要或问答
  - 数据表汇总：把 xlsx/xls/csv 报表发给机器人，让它读表头和样例、给解读或对比
  - 技术文档问答：把需求文档、接口说明（docx/html/md）发给机器人，让它回答具体问题
  - 批量附件分析：群里发一个 zip 打包的多份材料，机器人解压后逐份抽文本汇总
  - 小说/电子书阅读：epub/txt 发给机器人问剧情或提炼观点
  - 日志排查：log/txt/json 日志发给机器人，让它找异常或时间线
inline: true
---

# feishu-im-file-analyze

> **模块兼容**：脚本提供 `.js` 和 `.mjs` 两个版本。优先使用 `.js`，若报 `require is not defined` 改用 `.mjs`。

直接用 `exec` 执行，不要检查文件或环境。单文件文本抽取复用 `feishu-docx-download/extract.js`，首次运行会自动安装所需 npm 包（xlsx / pdf-parse 等）。zip 解压仅需系统 `unzip`（Linux/macOS 自带，Windows 可装 [7-Zip](https://www.7-zip.org/) 或 `choco install unzip`）。

## 命令

### 分析 IM 消息里的附件

```bash
node ./analyze.js --message-id "om_xxx" --file-key "file_v3_xxx"
```

### 分析本地文件（测试 / 已下载的附件）

```bash
node ./analyze.js --local-path "/tmp/foo.zip"
```

### 可选参数

| 参数            | 默认 | 说明                     |
| --------------- | ---- | ------------------------ |
| `--max-size-mb` | 50   | 单文件大小上限           |
| `--max-files`   | 100  | zip 内文件数上限         |
| `--max-text-kb` | 200  | 总文本上限（防爆上下文） |
| `--per-file-kb` | 20   | 单个文件抽出文本截断     |
| `--keep-temp`   | 否   | 调试用，保留临时目录     |

## 支持的类型

| 扩展名                                                                                                | 处理方式                                                 |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `.zip`                                                                                                | `unzip` 解压到临时目录 → 递归处理                        |
| `.pdf` `.docx` `.pptx` `.xlsx` `.xls` `.doc` `.ppt` `.rtf` `.epub` `.html` `.htm` `.txt` `.csv` `.md` | 委派给 `feishu-docx-download/extract.js`（npm 按需安装） |
| `.png` `.jpg` `.jpeg` `.gif` `.webp` `.bmp`                                                           | 返回元信息 + 提示调 feishu-image-ocr                     |
| 其他                                                                                                  | 返回元信息 + `type: "unsupported"`                       |

## 不支持的场景（硬失败）

- ❌ **IM 文件夹附件**（`msg_type=folder`）——飞书 open API 未公开下载接口。本 skill 会在下载前先调 `GET /im/v1/messages/{id}` 读 `msg_type`，若为 `folder` 直接短路返回 `folder_attachment_not_supported`，引导用户压缩成 zip 或上传云盘
- ❌ 加密 / 带密码的 zip / pdf
- ❌ 超过 `--max-size-mb` 的单文件

## 输出格式

单行 JSON：

```json
{
  "action": "analyze",
  "source": { "kind": "im|local", "message_id": "...", "file_key": "...", "path": "..." },
  "root_type": "zip|pdf|docx|xlsx|pptx|...|image|unsupported",
  "files": [
    {
      "path": "resume.pdf",
      "size": 12345,
      "type": "pdf",
      "text": "抽取出的文本...",
      "truncated": false
    }
  ],
  "total_files": 3,
  "total_text_bytes": 45678,
  "text_truncated": false,
  "warnings": [],
  "reply": "已解析「文件名」的 N 个文件，共 X 字符文本。"
}
```

失败场景：

```json
{ "error": "missing_system_tool", "tool": "unzip", "install_hint": "apt install unzip" }
{ "error": "resource_not_found", "api_code": 234003, "possible_causes": [...], "hint": "..." }
{ "error": "file_too_large", "size_mb": 123, "limit_mb": 50 }
{ "error": "auth_required" }
```

### 关于 `resource_not_found` (234003)

文件夹附件（`msg_type=folder`）已在下载前通过 `GET /im/v1/messages/{id}` **前置拦截**，返回独立错误 `folder_attachment_not_supported`，不会走到 234003 这条分支。同一前置检查还会比对消息 content 里的 `file_key` 与传入的 `--file-key`，不一致直接返回 `file_key_mismatch`。

走到 234003 时的真实原因有三类：

1. **message_id 与 file_key 不匹配**（最常见）—— 必须来自同一条消息
2. **file_key 已过期**
3. 消息被撤回或机器人无权访问

调用方应先核对 message_id 和 file_key 是否配对，再排查其余两种。

## 授权

使用 `tenant_access_token`（应用级，需 `im:resource` 权限）。无需用户 OAuth。

若返回 `{"error":"permission_required"}`，告知用户管理员需在飞书开放平台开通 `im:resource` 权限。
