# Feishu Simulator

端到端飞书聊天测试框架。通过飞书 API 以真实用户身份向 Bot 发送消息，等待 Bot 回复并进行断言验证。

## 消息链路

```
User (via Feishu API) → Feishu Server → Lark Plugin → Agent → LLM → Reply → Feishu API (poll)
```

## 前置条件

1. Gateway 运行中，且 Lark 插件已连接
2. 飞书开发者后台已创建应用，并开启以下用户权限：
   - `im:message` — 消息读写
   - `im:message.send_as_user` — 以用户身份发消息
3. 首次运行需在浏览器完成 Device Flow 授权（后续通过 refresh token 自动续期，7 天内无感）

## 运行

```bash
# Layer 1: 直接调用 skill 脚本测试（不需要 Gateway，只需飞书 token）
pnpm vitest run test/feishu-simulator/test-case/feishu-skills-layer1.test.ts

# Layer 2: 端到端飞书 skill 测试（需要 Gateway + Lark 插件运行）
pnpm vitest run test/feishu-simulator/test-case/feishu-skills-layer2.test.ts

# 原有通用聊天测试
pnpm vitest run test/feishu-simulator/test-case/feishu-chat.test.ts
```

## 环境变量

| 变量                   | 默认值                         | 说明                              |
| ---------------------- | ------------------------------ | --------------------------------- |
| `TEST_DATA_DIR`        | `test-data/`                   | 测试数据目录（递归加载 `*.json`） |
| `TEST_CSV_OUTPUT`      | `test-results/{timestamp}.csv` | CSV 报告输出路径                  |
| `TEST_CONCURRENCY`     | `2`                            | 并发执行的测试文件数              |
| `TEST_REPLY_TIMEOUT`   | `60000`                        | 等待 Bot 回复的超时时间（ms）     |
| `TEST_POLL_INTERVAL`   | `1000`                         | 轮询回复的间隔（ms）              |
| `TEST_COMMAND_TIMEOUT` | `30000`                        | Layer1 脚本执行超时（ms）         |

## 测试数据格式

### Layer 1: 脚本直接调用测试

直接执行 skill 脚本，验证输入输出契约：

```jsonc
{
  "skillsDir": "D:/web3/feishu-skills", // skill 脚本所在目录
  "env": {
    // 环境变量
    "FEISHU_APP_ID": "cli_xxx",
    "FEISHU_APP_SECRET": "xxx",
  },
  "vars": {
    // 模板变量，用于 {{VAR}} 替换
    "OPEN_ID": "ou_xxx",
  },
  "cases": [
    {
      "name": "创建文档-正常流程",
      "command": "node ./feishu-create-doc/create-doc.js --open-id {{OPEN_ID}} --title 测试文档",
      "assert": {
        "exitCode": 0, // 期望退出码
        "jsonPath": {
          // JSON 输出字段断言
          "doc_id": { "matches": "^docx_" },
          "doc_url": { "contains": "feishu.cn" },
          "reply": { "contains": "已创建" },
        },
      },
      "cleanup": "node ./feishu-drive/drive.js --open-id {{OPEN_ID}} --action delete --token {{result.doc_id}}",
    },
    {
      "name": "缺少必填参数",
      "command": "node ./feishu-create-doc/create-doc.js --title 测试",
      "assert": {
        "exitCode": 1,
        "jsonPath": {
          "error": { "equals": "missing_param" },
        },
      },
    },
  ],
}
```

### Layer 2: 端到端测试 (E2E)

每个 JSON 文件定义一个测试场景，包含飞书应用凭据和测试用例列表：

```jsonc
{
  "appId": "cli_xxx", // 飞书应用 App ID
  "appSecret": "xxx", // 飞书应用 App Secret
  "userOpenId": "ou_xxx", // 发送消息的用户 Open ID
  "cases": [
    {
      "name": "基本问候", // 用例名称（用于日志和报告）
      "message": "你好！", // 发送给 Bot 的消息
      "tags": ["P0"], // 可选：标签，用于筛选
    },
    {
      "name": "文本断言",
      "message": "你是谁？",
      "assert": {
        // 可选：对 Bot 回复进行断言
        "contains": "助手", // 回复必须包含该字符串
        "notContains": "error", // 回复不得包含该字符串
        "matches": "AI|机器人", // 回复必须匹配该正则表达式
        "minLength": 2, // 回复最小长度
        "maxLength": 500, // 回复最大长度
        "containsAny": ["AI", "助手", "机器人"], // 包含任意一个即可
        "containsAll": ["你好", "帮助"], // 必须全部包含
      },
    },
    {
      "name": "文件导出",
      "message": "把表格导出为Excel",
      "assert": {
        "msgType": "file", // 断言消息类型
        "hasFile": true, // 断言包含文件
        "fileNameMatches": "\\.(xlsx|xls|csv)$", // 断言文件名匹配正则
      },
    },
    {
      "name": "图片生成",
      "message": "画一只猫",
      "assert": {
        "hasImage": true, // 断言包含图片
      },
    },
  ],
}
```

### 字段说明

**Layer 1 — assert 对象**

| 字段                | 类型     | 说明                                                                 |
| ------------------- | -------- | -------------------------------------------------------------------- |
| `exitCode`          | `number` | 期望退出码（默认 0）                                                 |
| `jsonPath`          | `object` | JSON 输出字段断言（支持 equals/contains/matches/notContains/exists） |
| `stdoutContains`    | `string` | stdout 包含指定文本                                                  |
| `stdoutNotContains` | `string` | stdout 不包含指定文本                                                |
| `stderrContains`    | `string` | stderr 包含指定文本                                                  |

**Layer 2 — assert 对象**

| 字段              | 类型       | 说明                     |
| ----------------- | ---------- | ------------------------ |
| `contains`        | `string`   | 回复必须包含该子串       |
| `notContains`     | `string`   | 回复不得包含该子串       |
| `matches`         | `string`   | 回复必须匹配的正则表达式 |
| `minLength`       | `number`   | 回复文本最小长度         |
| `maxLength`       | `number`   | 回复文本最大长度         |
| `msgType`         | `string`   | 断言消息类型             |
| `hasFile`         | `boolean`  | 断言包含文件             |
| `hasImage`        | `boolean`  | 断言包含图片             |
| `fileNameMatches` | `string`   | 文件名匹配正则           |
| `containsAny`     | `string[]` | 包含列表中任意一个即通过 |
| `containsAll`     | `string[]` | 必须包含列表中全部       |

## 支持的消息类型

| msgType       | 提取的 text                          | 额外元数据                        |
| ------------- | ------------------------------------ | --------------------------------- |
| `text`        | 消息文本                             | —                                 |
| `post`        | 富文本中的纯文本                     | —                                 |
| `interactive` | CardKit v2 卡片的 summary 或元素文本 | —                                 |
| `file`        | 文件名                               | `fileKey`、`fileName`             |
| `image`       | （空）                               | `imageKey`                        |
| `media`       | 文件名                               | `fileKey`、`fileName`、`imageKey` |
| `audio`       | （空）                               | —                                 |

## 目录结构

```
test/feishu-simulator/
├── feishu-client.ts              # 飞书 API 客户端（授权、发消息、轮询回复）
├── types.ts                      # 类型定义（含 Layer1/Layer3 类型）
├── test-case/
│   ├── feishu-chat.test.ts               # 通用聊天 E2E 测试入口
│   ├── feishu-skills-layer1.test.ts      # Layer 1 脚本测试入口
│   ├── feishu-skills-layer2.test.ts      # Layer 2 E2E 测试入口
│   └── feishu-skills-layer3.test.ts      # Layer 3 LLM Judge 测试入口
├── test-data/
│   ├── example.json                  # 通用聊天测试数据
│   ├── feishu-skills-layer1/         # Layer 1 — 每个 skill 一个文件
│   │   ├── create-doc.json
│   │   ├── fetch-doc.json
│   │   ├── search-doc.json
│   │   ├── update-doc.json
│   │   ├── calendar.json
│   │   ├── task.json
│   │   ├── chat.json
│   │   ├── search-user.json
│   │   ├── im-read.json
│   │   ├── drive.json
│   │   ├── sheet.json
│   │   ├── wiki.json
│   │   ├── bitable.json
│   │   ├── docx-download.json
│   │   └── image-ocr.json
│   ├── feishu-skills-layer2/         # Layer 2 — 每个 skill 一个文件
│   │   ├── create-doc.json
│   │   ├── fetch-doc.json
│   │   ├── search-doc.json
│   │   ├── update-doc.json
│   │   ├── calendar.json
│   │   ├── task.json
│   │   ├── chat.json
│   │   ├── search-user.json
│   │   ├── im-read.json
│   │   ├── drive.json
│   │   ├── sheet.json
│   │   ├── wiki.json
│   │   ├── bitable.json
│   │   ├── docx-download.json
│   │   ├── image-ocr.json
│   │   └── orchestration.json        # 多 skill 编排场景
│   └── feishu-skills-layer3/         # Layer 3 — 每个 skill 一个文件
│       ├── create-doc.json
│       ├── fetch-doc.json
│       ├── search-doc.json
│       ├── calendar.json
│       ├── task.json
│       ├── chat.json
│       ├── search-user.json
│       ├── im-read.json
│       ├── drive.json
│       ├── sheet.json
│       ├── wiki.json
│       ├── bitable.json
│       ├── docx-download.json
│       ├── image-ocr.json
│       └── orchestration.json        # 多 skill 编排场景
├── test-results/                     # CSV 测试报告（自动生成）
├── test-runner/
│   ├── index.ts                      # 导出入口
│   ├── runner.ts                     # E2E 测试执行引擎（集成 LLM Judge）
│   ├── script-runner.ts              # Layer 1 脚本测试执行引擎
│   ├── llm-judge.ts                  # Layer 3 LLM 评判器
│   ├── asserter.ts                   # 断言验证（含 containsAny/All + JSON path）
│   ├── file-loader.ts                # JSON 文件加载器
│   └── csv-writer.ts                 # CSV 报告生成
└── .token-cache/                     # OAuth token 缓存（自动生成，勿提交）
```

## 授权机制

1. **首次运行**：自动发起 Device Flow，终端输出授权链接和 User Code，在浏览器打开链接完成授权
2. **token 有效期内**（~2h）：直接使用缓存的 access_token
3. **access_token 过期**：自动用 refresh_token 刷新（无需人工干预）
4. **refresh_token 过期**（~7d）：重新触发 Device Flow 授权

token 缓存在 `.token-cache/` 目录，按 `{appId}_{userOpenId}.json` 命名。

## CSV 报告

每次运行自动生成 CSV 报告，包含以下列：

| 列              | 说明                    |
| --------------- | ----------------------- |
| File Name       | 测试文件名              |
| Case Name       | 用例名称                |
| Message Input   | 发送的消息 / 执行的命令 |
| Expected Output | 断言规则描述            |
| Actual Output   | Bot 实际回复 / 脚本输出 |
| Result          | PASS / FAIL             |
| Duration        | 耗时（ms）              |

## 快速开始

1. 复制测试数据模板，填入真实凭据：

   ```bash
   # 编辑各层目录下每个 JSON 文件，替换 appId、appSecret、userOpenId
   cd test/feishu-simulator/test-data/feishu-skills-layer1/
   cd test/feishu-simulator/test-data/feishu-skills-layer2/
   cd test/feishu-simulator/test-data/feishu-skills-layer3/
   ```

2. 运行 Layer 1（不需要 Gateway）：

   ```bash
   pnpm vitest run test/feishu-simulator/test-case/feishu-skills-layer1.test.ts
   ```

3. 运行 Layer 2（需要 Gateway + Lark 连接）：

   ```bash
   pnpm vitest run test/feishu-simulator/test-case/feishu-skills-layer2.test.ts
   ```

4. 查看报告：`test-results/*.csv`
