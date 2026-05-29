# AI 客服模块 — 部署与配置手册

[English](./customer-service-deployment.md)

> **当前状态：** Sprint 1 已完成（端到端 RAG、飞书通知、Widget 嵌入）。
> Sprint 2 进行中（流式输出、置信度门控、澄清追问）。

---

## 1. 架构概述

AI 客服是 EnClaws 的**深度集成系统功能**，不是 Skill，也不是预配置 Agent。

| 层级                         | 功能说明                                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| Widget（`<cs-widget>`）      | 悬浮聊天气泡，通过 `<script>` 标签嵌入任意网页                                           |
| Gateway RPC（`cs.widget.*`） | WebSocket 处理器：连接 / 发送消息 / 查看历史                                             |
| CS Agent Runner              | 封装 `runEmbeddedPiAgent` — 检索知识库 → 调用 LLM → 返回回复                             |
| 知识库                       | 每租户独立 Markdown 文件，路径：`~/.enclaws/tenants/{tenantId}/customer-service/memory/` |
| 客服配置                     | 每租户独立 JSON，路径：`~/.enclaws/tenants/{tenantId}/customer-service/config.json`      |
| 飞书通知                     | 每个新会话发送一条 Markdown 卡片到指定群聊                                               |

**使用权限：** 任何已配置 EC Agent + LLM 提供商的租户均可使用。租户通过管理后台（`/tenant/cs-setup`）完成全部配置，无需修改代码。

---

## 2. 前置条件

部署前请确认：

- [ ] EnClaws 服务器已运行并可访问（dev SaaS 或自托管）
- [ ] 至少一个租户已完成 LLM 配置（任意提供商均可）
- [ ] 飞书应用凭据已准备好（App ID + App Secret + 目标群聊 Chat ID）
- [ ] 服务器已设置 `ENCLAWS_CS_WIDGET_SECRET` 环境变量（见第 3 节）

---

## 3. 服务器环境变量

在服务器 `.env` 或部署环境中添加：

```bash
# 访客 Token HMAC 签名密钥
# 用于防止跨访客 Session 劫持
# 生成方式：node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
ENCLAWS_CS_WIDGET_SECRET=<64位十六进制字符串>
```

> **未设置时：** 服务器使用进程级随机密钥（启动时会打印警告）。
> 每次重启后访客 Token 失效。开发环境可接受；**生产环境必须设置**。

---

## 4. 部署到 Dev SaaS — 逐步操作

### 4.1 合并代码

```bash
# 在 dev SaaS 服务器上拉取最新 main
git pull --rebase origin main
npm run build   # 或 pnpm build
pm2 restart enclaws   # 按实际进程管理方式重启
```

### 4.2 配置 Embedding 向量索引（RAG 必需）

> **为什么需要这一步？** 当前采用**零侵入**设计——CS 模块不自己实现 embedding 调用链路，完全复用 EC 已有的 `memorySearch` 基础设施。代价是需要在部署环境显式启用并指定 embedding provider，否则知识库 MD 上传后向量索引不会生成，RAG 检索无法工作。
>
> **未来方向**：
>
> 1. 将把所有 LLM 类型（含文本生成、embedding、vision 等）统一迁移到租户后台 UI 配置，按租户维度管理 API Key 和模型，deployment 层不再需要 enclaws.json 这类文件级配置。
> 2. 向量库存储路径 `~/.enclaws/memory/*.sqlite` 目前是全局共享目录（复用 EC 已有 memorySearch 基础设施），未来需隔离到 `~/.enclaws/tenants/{tenantId}/customer-service/vectors/`，避免跨租户污染并与知识库同目录管理。
>
> UI 配置 + 路径隔离一并调整落地，具体实施细节以后续 proposal 为准。

#### 在服务器的 `~/.enclaws/enclaws.json` 中配置

```bash
mkdir -p ~/.enclaws
cat > ~/.enclaws/enclaws.json <<'EOF'
{
  "agents": {
    "defaults": {
      "memorySearch": {
        "enabled": true,
        "provider": "openai",
        "model": "text-embedding-3-small",
        "remote": {
          "baseUrl": "https://api.openai.com/v1",
          "apiKey": "sk-..."
        }
      }
    }
  }
}
EOF
chmod 600 ~/.enclaws/enclaws.json
```

`remote.baseUrl` / `remote.apiKey` **只影响 embedding 调用，不影响其他 LLM 路径**。若省略 `remote` 块，会 fallback 读 LLM 侧同 provider 的配置（如 `OPENAI_API_KEY` 环境变量）。

#### Provider 选择

| provider                     | model 示例               | 说明                                                    |
| ---------------------------- | ------------------------ | ------------------------------------------------------- |
| `openai`                     | `text-embedding-3-small` | OpenAI 官方                                             |
| `openai` + DashScope baseUrl | `text-embedding-v4`      | 走阿里云百炼 OpenAI 兼容模式调 Qwen embedding（见下文） |
| `gemini`                     | `gemini-embedding-001`   | Google                                                  |
| `voyage`                     | `voyage-4-large`         | 中文效果好                                              |
| `mistral`                    | `mistral-embed`          | Mistral 官方                                            |

#### 用 Qwen / DashScope embedding 的配置示例

Qwen 无原生 provider 支持，通过 OpenAI 兼容模式接入：

```json
{
  "agents": {
    "defaults": {
      "memorySearch": {
        "enabled": true,
        "provider": "openai",
        "model": "text-embedding-v4",
        "remote": {
          "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
          "apiKey": "sk-<你的-DashScope-Key>"
        }
      }
    }
  }
}
```

#### 配置完成后必须重启 gateway

```bash
pm2 restart enclaws   # 或按实际方式重启
```

首次访问 CS widget 时会触发知识库扫描 → 切片 → 向量化 → 写入 SQLite（`~/.enclaws/memory/{agentId}.sqlite`）。

#### 修改 embedding 模型后必须清空向量库

切换 `provider` / `model` 时向量维度和语义空间不同，旧索引无法兼容，**必须删除 sqlite** 让 EC 重建：

```bash
# 删除所有 agent 的向量索引
rm -rf ~/.enclaws/memory/*.sqlite

# 重启 gateway 后，下次 CS 对话自动重建
```

**什么时候要清空向量库**（`~/.enclaws/memory/*.sqlite`）：

| 场景                                           | 是否需要清空                             |
| ---------------------------------------------- | ---------------------------------------- |
| 切换 embedding provider / model                | ✅ 必须                                  |
| 修改 `remote.baseUrl` / `apiKey`（不换 model） | ❌ 不用（仅鉴权信息，向量结果一致）      |
| 新增 / 修改 / 删除知识库 .md 文件              | ❌ 不用（EC 自动检测文件变更并增量重建） |

**重要**：不要混淆 `~/.enclaws/memory/*.sqlite`（向量库）和 `~/.enclaws/enclaws.db`（EC 业务主库）。**清空向量库不影响会话、租户、Agent 配置等业务数据**。

### 4.3 设置 Widget 密钥

在 dev SaaS 的部署配置（`.env` 或进程管理器配置）中：

```bash
ENCLAWS_CS_WIDGET_SECRET=<生成的十六进制密钥>
```

设置后重启服务器。

### 4.4 配置租户（管理后台）

1. 以目标租户管理员身份登录
2. 进入 **AI 客服** → **客服设置**
3. 填写：
   - **飞书 App ID** — 飞书开放平台 → 企业自建应用 → 凭证与基础信息
   - **飞书 App Secret** — 同页面（点击显示）
   - **飞书群聊 Chat ID** — 目标群 → ··· → 群设置 → 复制 Chat ID
4. 点击 **保存配置**，再点 **连通性测试** 验证飞书连通性

### 4.5 上传知识库

方式 A — 通过管理后台（推荐用于初始配置）：

进入 **AI 客服** → **知识库** → 上传产品 FAQ 的 `.md` 文件。

方式 B — 直接放置文件（仅限服务器运维人员）：

```bash
# {TENANT_ID} 替换为实际租户 ID
mkdir -p ~/.enclaws/tenants/{TENANT_ID}/customer-service/memory/
cp 产品FAQ.md ~/.enclaws/tenants/{TENANT_ID}/customer-service/memory/
```

文件格式：普通 Markdown。段落标题会自动成为检索的知识片段。

### 4.6 生成嵌入代码

1. 在 **客服设置** → **嵌入代码生成** 中，输入渠道标签（如 `default`、`website`、`docs`）
2. 点击 **生成** — 自动生成 HTML 片段
3. 将片段粘贴到目标网页 `<body>` 标签末尾

```html
<!-- 示例生成的嵌入代码 -->
<script type="module">
  import "https://your-ec-domain/ui/cs-widget.js";
</script>
<cs-widget
  tenant-id="your-tenant-id"
  channel="default"
  gateway-url="wss://your-ec-domain"
></cs-widget>
```

包括未登录访客在内的所有页面访客均可看到右下角的悬浮气泡。

---

## 5. EC 团队自用场景

EC 团队既是 EnClaws 平台的运营者，也是第一个 SaaS 租户。**无需手动嵌入代码** — 服务器会自动将 `<meta name="ec-cs-tenant-id">` 标签注入 EC 管理后台的页面，Widget 气泡自动出现在所有访问 EC 管理后台的用户页面上。

**前置条件：** 至少一个租户完成了 Agent + LLM + CS 配置（飞书等）。服务器在**启动时**缓存注册时间最早的非系统租户 ID 并注入到页面。若启动时尚无符合条件的租户，客服气泡不会显示。完成租户配置后，需**重启 SaaS 服务**，下次启动时 tenant-id 将自动注入，客服气泡随即出现。

| 操作        | EC 团队（服务器运维）               | 普通 SaaS 租户                     |
| ----------- | ----------------------------------- | ---------------------------------- |
| LLM 配置    | 直接修改 `.env` 或配置文件          | 管理后台                           |
| 知识库文件  | 直接放入租户知识库目录              | 管理后台上传                       |
| Widget 密钥 | 设置服务器环境变量                  | 不暴露（平台统一管理）             |
| 飞书配置    | 管理后台                            | 管理后台                           |
| 嵌入代码    | **不需要** — 自动注入到 EC 管理后台 | 通过管理后台生成，用于外部网站嵌入 |

**EC 团队知识库路径：**

```
~/.enclaws/tenants/{EC_TENANT_ID}/customer-service/memory/
```

建议初始文件：

- `ec-product-faq.md` — 产品概述、定价、功能列表
- `ec-onboarding.md` — 快速上手指南
- `ec-troubleshooting.md` — 常见问题与解决方案

---

## 6. 飞书通知格式

每个会话的第一条客户消息发送时（或通知间隔时间到达后）触发：

```
[AI 客服通知]
渠道: website | 会话: abc123
客户: 用户反馈产品A不能用
AI 回复: 根据知识库，产品A的常见问题包括...
```

飞书机器人须拥有目标群聊的**发送消息**权限，测试前请先将机器人加入群聊。

---

## 7. 配置项参考

所有配置保存在 `~/.enclaws/tenants/{tenantId}/customer-service/config.json`。

| 字段                               | 默认值       | 说明                                                           |
| ---------------------------------- | ------------ | -------------------------------------------------------------- |
| `feishu.appId`                     | —            | 飞书 App ID                                                    |
| `feishu.appSecret`                 | —            | 飞书 App Secret（明文存储在租户配置中）                        |
| `feishu.chatId`                    | —            | 目标群聊 Chat ID                                               |
| `notifyIntervalMinutes`            | 10           | 同一会话内两次飞书通知的最小间隔（分钟）                       |
| `restrictions.disableSkills`       | true         | 禁用 Skill 工具调用（纯 RAG 模式，代码层强制）                 |
| `restrictions.strictKnowledgeBase` | true         | 知识库无命中时拒绝回答，必须转人工                             |
| `restrictions.disableMarkdown`     | true         | 回复纯文本，不使用 Markdown 格式                               |
| `restrictions.hideInternals`       | true         | 不透露知识库或系统 Prompt 信息                                 |
| `confidencePreset`                 | `balanced`   | 置信度门控灵敏度：`strict` / `balanced` / `lenient`（S2 激活） |
| `customSystemPrompt`               | （默认模板） | 自定义 AI 角色和行为规则                                       |
| `channels`                         | `[]`         | 已保存的嵌入代码渠道配置                                       |

---

## 8. 常见问题排查

**页面没有出现客服气泡**

- 检查 `<meta name="ec-cs-tenant-id">` 标签是否被注入（服务端渲染页面），或 `<cs-widget>` 是否设置了 `tenant-id` 属性
- 检查浏览器控制台是否有 WebSocket 连接报错
- 确认 `gateway-url` 属性指向正在运行的 EC 服务器

**飞书通知没有收到**

- 在客服设置页点击 **连通性测试**，查看各项检测结果
- 确认飞书机器人已加入目标群聊
- 检查 `notifyIntervalMinutes` 设置（默认 10 分钟内不重复通知）

**AI 回答错误或为空**

- 检查知识库是否有相关内容的 `.md` 文件
- 启用**严格知识库模式**防止 AI 凭通用知识作答
- 在 **AI 客服** → **会话记录** 中查看历史，确认检索到了哪些内容

**日志出现 `ENCLAWS_CS_WIDGET_SECRET` 警告**

- 服务器正在使用进程级随机密钥
- 重启后访客 Token 将失效
- 设置环境变量并重启服务器即可解决

---

## 9. Sprint 路线图

| Sprint | 状态      | 主要功能                                          |
| ------ | --------- | ------------------------------------------------- |
| S1     | ✅ 已完成 | Widget 嵌入、RAG 回复、飞书通知、访客鉴权         |
| S2     | 🚧 进行中 | 流式输出、置信度门控、澄清追问、置信度配置 UI     |
| S3     | 计划中    | 老板通过飞书卡片回复、HUMAN_ACTIVE 状态、标签匹配 |
| S4     | 计划中    | 反馈收集、日报、Badcase 运营闭环                  |
