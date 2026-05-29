# feishu-meeting-minutes 方案设计

## 概述

通过飞书视频会议录制文件，自动转写语音并生成 AI 会议纪要。

## 目录结构

```
feishu-meeting-minutes/
├── DESIGN.md             # 本方案文档
├── SKILL.md              # AI 调用说明
├── minutes.py            # 主脚本：下载录制 + 转写
└── requirements.txt      # Python 依赖
```

## 触发方式

用户手动触发：在群聊或私聊中对 bot 说"帮我总结会议"。

## 整体流程

```
用户："帮我总结会议"
        │
        ▼
   AI 调 feishu-calendar 查用户最近日程
   找到有 vchat 的日程（含 meeting_url）
   提取 9 位会议号
        │
        ▼
   AI 调 minutes.py --meeting-no "xxx" --open-id "ou_xxx"
        │
   ┌────┴─────────────────────────────────────┐
   │  minutes.py 内部流程                      │
   │                                           │
   │  1. 获取 tenant_access_token              │
   │  2. meeting_no → list_by_no → meeting_id  │
   │  3. meeting_id → recording → 下载地址      │
   │  4. 下载录制 mp4 到临时目录                 │
   │  5. faster-whisper 直接转写 mp4 → 文本     │
   │  6. 输出 JSON（transcript + 元信息）       │
   │  7. 清理临时文件                           │
   └───────────────────────────────────────────┘
        │
        ▼  返回转写文本给 AI
   AI 用 LLM 生成结构化会议纪要
        │
        ▼
   AI 调 feishu-create-doc 创建飞书文档写入纪要
        │
        ▼
   AI 调 send-card 发卡片到群（含文档链接按钮）
```

## 关键设计决策

### 1. Skill 职责边界

minutes.py 只负责 **下载 + 转写**，不做 LLM 总结。

原因：

- Skill 职责单一，只做一件事
- LLM 总结由 OpenClaw agent 完成，prompt 和格式更灵活
- 完全复用现有的 feishu-create-doc 和 send-card 能力

### 2. 语音转写方案

使用 faster-whisper（已部署），CLI 方式调用：

```python
from faster_whisper import WhisperModel
model = WhisperModel("small", device="cpu", compute_type="int8")
segments, info = model.transcribe(audio_file, vad_filter=True, language="zh")
```

### 3. 直接转写 mp4

faster-whisper 支持直接处理 mp4 文件（内部通过 ffmpeg 库解码音频轨），无需手动提取音频。

### 4. 配置复用

复用 feishu-auth/config.json 中的 appId/appSecret，或环境变量 FEISHU_APP_ID/FEISHU_APP_SECRET。
Python 脚本直接读取 ../feishu-auth/config.json。

### 5. 录制文件大小限制

1GB，1 小时 720p 会议录制约 200-500MB，足够覆盖。

## 飞书 API 调用

### 获取 tenant_access_token

```
POST /open-apis/auth/v3/tenant_access_token/internal
Body: { app_id, app_secret }
```

### 按会议号查会议

```
GET /open-apis/vc/v1/meetings/list_by_no
Params: meeting_no, start_time, end_time
权限: vc:meeting:readonly
返回: meeting_briefs[].id, .topic
```

### 获取录制文件

```
GET /open-apis/vc/v1/meetings/{meeting_id}/recording
权限: vc:record:readonly
返回: url (录制下载地址), duration (时长 ms)
```

## 所需权限

- `vc:meeting:readonly` — 按会议号查询会议信息
- `vc:record:readonly` — 获取会议录制文件

## minutes.py 输入输出

### 输入

```bash
python minutes.py --meeting-no "123456789" --open-id "ou_xxx"
```

### 输出（JSON）

```json
{
  "meeting_topic": "产品评审会",
  "meeting_id": "xxx",
  "duration_seconds": 3600,
  "transcript": "完整转写文本...",
  "reply": "会议「产品评审会」转写完成，共 3600 秒"
}
```

### 错误输出

```json
{
  "error": "no_recording",
  "message": "该会议没有录制文件"
}
```

## AI 编排流程（SKILL.md 指导）

1. 用户说"总结会议" → 先用 feishu-calendar 查最近有 vchat 的日程
2. 如有多个 → 列出让用户选择
3. 从 meeting_url 提取 9 位会议号
4. 调用 `python minutes.py --meeting-no "xxx" --open-id "ou_xxx"`
5. 拿到转写文本 → LLM 生成结构化会议纪要（主题/讨论点/决策/待办）
6. 调 feishu-create-doc 创建飞书文档写入纪要，拿到文档 URL
7. 调 send-card 发卡片到群，按钮链接到文档
