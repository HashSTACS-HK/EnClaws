# IM Simulator

基于 WebSocket RPC 的 IM 聊天测试框架。通过 Gateway 内部协议直接发送消息，绕过飞书等外部 IM 渠道。

## 消息链路

```
TestEnv (WebSocket RPC) → Gateway → Agent → LLM → Reply (WebSocket Event)
```

## 前置条件

1. Gateway 运行中：`pnpm openclaw gateway`
2. 数据库已配置：`.env` 中设置 `OPENCLAW_DB_URL`

## 运行

```bash
# 参数化测试（从 JSON 文件加载用例）
pnpm vitest run test/im-simulator/test-case/chat.test.ts

# 全流程测试（注册租户 → 创建模型 → 创建 Agent → 聊天）
pnpm vitest run test/im-simulator/test-case/register.test.ts
```

## 环境变量

| 变量                     | 默认值                         | 说明                                   |
| ------------------------ | ------------------------------ | -------------------------------------- |
| `TEST_GATEWAY_URL`       | `ws://127.0.0.1:18789`         | Gateway WebSocket 地址                 |
| `OPENCLAW_GATEWAY_TOKEN` | `""`                           | Gateway 认证 token                     |
| `TEST_DATA_DIR`          | `test-data/`                   | 测试数据目录（递归加载 `*.json`）      |
| `TEST_CSV_OUTPUT`        | `test-results/{timestamp}.csv` | CSV 报告输出路径                       |
| `TEST_CONCURRENCY`       | `2`                            | 并发执行的测试文件数                   |
| `TEST_DEEPSEEK_API_KEY`  | —                              | 模型 API Key（仅 full-setup 测试需要） |

## 测试数据格式

### 参数化测试（chat.test.ts）

每个 JSON 文件定义一组测试用例，通过已有账号登录并发送消息：

```jsonc
{
  "ownerEmail": "admin@example.com", // 租户 owner 邮箱（用于邀请用户）
  "ownerPassword": "xxx", // owner 密码
  "email": "test@example.com", // 测试用户邮箱
  "password": "xxx", // 测试用户密码
  "agentId": "agent1", // 目标 Agent ID
  "cases": [
    {
      "name": "基本问候",
      "message": "你好！",
    },
    {
      "name": "带断言",
      "message": "你是谁？",
      "assert": {
        "contains": "助手",
        "notContains": "error",
        "matches": "AI|机器人",
        "minLength": 2,
        "maxLength": 500,
      },
    },
  ],
}
```

### 字段说明

**顶层字段**

| 字段            | 必填 | 说明                                                              |
| --------------- | ---- | ----------------------------------------------------------------- |
| `email`         | 是   | 测试用户邮箱（用于登录）                                          |
| `password`      | 是   | 测试用户密码                                                      |
| `agentId`       | 是   | 消息发送的目标 Agent ID                                           |
| `ownerEmail`    | 否   | 租户 owner 邮箱（当 email 用户不存在时，用 owner 身份邀请该用户） |
| `ownerPassword` | 否   | owner 密码                                                        |
| `cases`         | 是   | 测试用例数组                                                      |

**cases 数组**

| 字段      | 必填 | 说明                             |
| --------- | ---- | -------------------------------- |
| `name`    | 是   | 用例名称                         |
| `message` | 是   | 发送给 Agent 的消息文本          |
| `assert`  | 否   | 断言规则（省略则仅检查回复非空） |

**assert 对象**

| 字段          | 类型     | 说明                     |
| ------------- | -------- | ------------------------ |
| `contains`    | `string` | 回复必须包含该子串       |
| `notContains` | `string` | 回复不得包含该子串       |
| `matches`     | `string` | 回复必须匹配的正则表达式 |
| `minLength`   | `number` | 回复文本最小长度         |
| `maxLength`   | `number` | 回复文本最大长度         |

## 目录结构

```
test/im-simulator/
├── index.ts                  # 公共导出（TestEnv、RpcClient、类型）
├── test-env.ts               # 测试环境类（注册、登录、建模型、建 Agent、发消息）
├── rpc-client.ts             # WebSocket RPC 客户端
├── types.ts                  # 类型定义（连接、认证、模型、Agent、聊天）
├── test-case/
│   ├── chat.test.ts         # 参数化聊天测试
│   └── register.test.ts   # 全流程测试（注册→建模型→建 Agent）
├── test-data/                # 测试数据（JSON 文件，支持子目录）
│   ├── example.json
│   ├── example1.json
│   └── aaa/
│       ├── example.json
│       └── example1.json
├── test-results/             # CSV 测试报告（自动生成）
└── test-runner/
    ├── index.ts              # 导出入口
    ├── runner.ts             # 测试执行引擎
    ├── types.ts              # Runner 类型定义
    ├── asserter.ts           # 断言验证
    ├── file-loader.ts        # JSON 文件加载器
    └── csv-writer.ts         # CSV 报告生成
```

## 两种测试模式

### 1. 参数化测试（chat.test.ts）

使用已有的租户、用户、Agent，仅测试聊天功能：

- 从 JSON 文件加载测试用例
- 自动登录（如用户不存在，用 owner 身份邀请后登录）
- 向指定 Agent 发消息、等待回复、验证断言
- 支持并发执行多个测试文件

### 2. 全流程测试（register.test.ts）

从零开始搭建完整环境：

```
注册租户 → 创建模型配置 → 创建 Agent → 发消息
```

适合验证完整链路的集成测试。示例：

```typescript
const env = new TestEnv({ url: "ws://127.0.0.1:18789", gatewayToken: "" });

// 1. 注册租户
await env.register({ tenantName: "Test", email: "admin@test.com", password: "xxx" });

// 2. 创建模型
const model = await env.createModel({
  providerType: "openai",
  providerName: "My Provider",
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-xxx",
  models: [{ id: "gpt-4", name: "GPT-4" }],
});

// 3. 创建 Agent
await env.createAgent({
  agentId: "greeter",
  name: "Greeter Bot",
  systemPrompt: "你是一个友好的问候机器人。",
  modelConfig: [{ providerId: model.id, modelId: "gpt-4", isDefault: true }],
});

// 4. 发消息
const reply = await env.sendAsUser("greeter", "你好！");
console.log(reply.text);

// 5. 清理
await env.disconnect();
```

## TestEnv API

| 方法                           | 说明                                 |
| ------------------------------ | ------------------------------------ |
| `register(opts)`               | 注册新租户并以 owner 身份登录        |
| `login(opts)`                  | 以已有用户登录                       |
| `inviteUser(opts)`             | 邀请新用户加入租户（需 owner 权限）  |
| `createModel(opts)`            | 创建 LLM 模型提供商配置              |
| `createAgent(opts)`            | 创建 Agent（含系统提示词和模型配置） |
| `sendAsUser(agentId, message)` | 发送消息并等待回复（默认超时 60s）   |
| `disconnect()`                 | 关闭 WebSocket 连接                  |

## CSV 报告

每次运行自动生成 CSV 报告，包含以下列：

| 列              | 说明           |
| --------------- | -------------- |
| File Name       | 测试文件名     |
| Case Name       | 用例名称       |
| Message Input   | 发送的消息     |
| Expected Output | 断言规则描述   |
| Actual Output   | Agent 实际回复 |
| Result          | PASS / FAIL    |
| Duration        | 耗时（ms）     |

## 与 Feishu Simulator 的区别

|          | IM Simulator                  | Feishu Simulator                |
| -------- | ----------------------------- | ------------------------------- |
| 通信方式 | WebSocket RPC（直连 Gateway） | 飞书 Open API（经飞书服务器）   |
| 认证方式 | 邮箱/密码登录（JWT）          | 飞书 OAuth Device Flow          |
| 消息链路 | 不经过外部 IM                 | 经过真实飞书服务器和 Lark 插件  |
| 适用场景 | Agent 逻辑测试、快速迭代      | 飞书渠道端到端验证              |
| 速度     | 快（直连）                    | 较慢（经飞书服务器 + 流式卡片） |
