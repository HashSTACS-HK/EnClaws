---
name: feishu-meeting-minutes
description: |
  飞书会议纪要生成。下载会议录制文件，通过 faster-whisper 转写语音，返回转写文本供 AI 生成会议纪要。
overrides: feishu_meeting_minutes, feishu_pre_auth
inline: true
---

# feishu-meeting-minutes

直接用 `exec` 执行，不要检查文件或环境。

## 转写会议录制

两种输入方式：

```bash
# 方式 1：本地文件（用户已上传或服务器上已有文件）
python ./minutes.py --open-id "SENDER_OPEN_ID" --file "/path/to/recording.mp4"

# 方式 2：按会议号自动查找
python ./minutes.py --open-id "SENDER_OPEN_ID" --meeting-no "123456789"
```

返回 JSON 包含 `transcript`（纯文本）和 `transcript_timestamped`（带时间戳）。

## 用户说"总结会议"时的完整编排流程

**必须按以下步骤依次执行，不得跳过或合并：**

### 第 1 步：确定录制文件来源

**场景 A**：用户发送了录制文件（音频/视频） → 保存到本地，使用 `--file` 方式
**场景 B**：用户说"总结会议"但没给文件 → 走第 2 步查找会议

### 第 2 步：查找会议（仅场景 B）

用 feishu-calendar 查用户最近有视频会议的日程：

```bash
node ../feishu-calendar/calendar.js --open-id "SENDER_OPEN_ID" --action list_events --start-min "7天前ISO8601" --start-max "现在ISO8601"
```

从返回的日程中筛选有 `vchat.meeting_url` 的日程。

- **只有一个** → 确认后继续
- **有多个** → 列出日程（主题 + 时间），让用户选择
- **没有** → 回复"最近 7 天没有找到有视频会议的日程"
- 用户指定了会议主题关键词 → 按关键词匹配

### 第 3 步：提取会议号（仅场景 B）

从 `meeting_url`（如 `https://vc.feishu.cn/j/123456789`）中提取 9 位会议号。

### 第 4 步：执行转写

```bash
python ./minutes.py --meeting-no "123456789" --open-id "SENDER_OPEN_ID"
```

**注意**：转写过程可能需要几分钟，先回复用户"正在转写会议录制，请稍候..."。

### 第 5 步：生成会议纪要

拿到返回的 `transcript` 后，用以下结构生成会议纪要：

```
# 会议纪要：{meeting_topic}

## 基本信息
- 会议主题：xxx
- 会议时间：xxx
- 会议时长：xxx 分钟

## 会议摘要
（2-3 句话概括会议核心内容）

## 关键讨论点
1. xxx
2. xxx

## 决策事项
- [ ] xxx

## 待办事项
| 事项 | 负责人 | 截止时间 |
|------|--------|---------|
| xxx  | xxx    | xxx     |
```

### 第 6 步：写入飞书文档

调用 feishu-create-doc 创建文档：

```bash
node ../feishu-create-doc/create-doc.js --open-id "SENDER_OPEN_ID" --title "会议纪要：{主题} {日期}" --markdown "<生成的纪要内容>"
```

### 第 7 步：发送卡片到群

如果有 `CHAT_ID`，将文档链接通过卡片发送到群：

```bash
node ../feishu-auth/send-card.js --chat-id "CHAT_ID" --title "会议纪要已生成" --body "会议「{主题}」的纪要已生成" --button-text "查看文档" --button-url "{文档URL}" --color green
```

## 错误处理

| 错误                  | 含义                  | 处理                                                         |
| --------------------- | --------------------- | ------------------------------------------------------------ |
| `not_found`           | 未找到对应会议        | 提示用户确认会议号                                           |
| `no_recording`        | 没有录制文件          | 提示用户该会议未开启录制                                     |
| `file_too_large`      | 录制文件超过 1GB      | 提示用户文件过大                                             |
| `file_not_found`      | 本地文件不存在        | 检查文件路径                                                 |
| `download_error`      | 下载失败              | 录制 URL 可能不支持直接下载，改用 `--file` 或 `--file-token` |
| `auth_required`       | 用户未授权            | 执行下方授权流程                                             |
| `permission_required` | scope 不足            | 执行下方授权流程（含 required_scopes）                       |
| `dependency_error`    | faster-whisper 未安装 | 提示管理员安装依赖                                           |
| `config_error`        | 配置缺失              | 检查 feishu-auth/config.json                                 |
| `api_error`           | API 调用失败          | 查看具体 msg                                                 |

## 授权

若返回 `{"error":"auth_required"}` 或 `{"error":"permission_required"}`，**直接执行授权命令：**

```bash
node ../feishu-auth/auth.js --auth-and-poll --open-id "SENDER_OPEN_ID" --chat-id "CHAT_ID" --timeout 60 --scope "<required_scopes 用空格拼接>"
```

- `{"status":"authorized"}` → 重新执行原始命令
- `{"status":"polling_timeout"}` → 立即重新执行此 auth 命令

## 所需飞书权限

- `vc:meeting.meetingid:read` — 按会议号查询会议信息（tenant_access_token）
- `vc:record:readonly` — 获取会议录制信息（tenant_access_token）
- `minutes:minutes.media:export` — 下载妙记音视频文件（user_access_token）
