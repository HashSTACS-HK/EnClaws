# 快速上手指南

10 分钟内让 EnClaws 跑起来。

---

## 前置条件

- **Node.js** >= 22.12.0
- **pnpm** >= 10.23.0（源码构建时需要）
- 至少一个 LLM API Key（OpenAI、Anthropic、DeepSeek 等）

---

## 安装

### 方式一：npm 安装（推荐）

```bash
npm install -g enclaws
enclaws gateway
```

### 方式二：Windows 安装包

从 [Releases](https://github.com/hashSTACS-Global/EnClaws/releases) 页面下载 `EnClaws-Setup-x.x.x.exe`。

- 无需管理员权限
- 内置 Node.js 运行时（可离线安装）
- 双击安装，搜索"EnClaws"即可启动

### 方式三：一键安装（macOS / Linux）

```bash
curl -fsSL --proto '=https' --tlsv1.2 \
  https://raw.githubusercontent.com/hashSTACS-Global/EnClaws/main/install.sh | bash
```

### 方式四：从源码构建

```bash
git clone https://github.com/hashSTACS-Global/EnClaws.git
cd EnClaws
pnpm install
pnpm build && pnpm ui:build
npm link
enclaws gateway
```

---

## 首次启动

安装完成后，Gateway 默认在 **http://localhost:18888** 启动。

### 1. 打开控制面板

在浏览器中访问 `http://localhost:18888`。

### 2. 配置 LLM 提供商

通过环境变量设置 API Key：

```bash
# 选择你的提供商
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...
export GEMINI_API_KEY=AIza...

# 启动 Gateway
enclaws gateway
```

也可以在控制面板的引导向导中交互式配置。

### 3. 接入消息通道

EnClaws 支持 41+ 消息通道，常用选项：

| 通道          | 配置方式                                             |
| ------------- | ---------------------------------------------------- |
| **WebChat**   | 内置——打开控制面板直接聊天                           |
| **飞书/Lark** | 安装 `openclaw-lark` 插件，配置 App ID 和 App Secret |
| **Telegram**  | 设置 `TELEGRAM_BOT_TOKEN` 环境变量                   |
| **Discord**   | 设置 `DISCORD_BOT_TOKEN` 环境变量                    |
| **Slack**     | 设置 `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` 环境变量  |

### 4. 开始对话

通过任意已连接的通道发送消息，AI 助手会通过 Agent 运行时处理并回复。

---

## Docker 快速启动

生产环境或多租户场景推荐使用 Docker：

```bash
# 克隆仓库
git clone https://github.com/hashSTACS-Global/EnClaws.git
cd EnClaws

# 复制并编辑环境配置
cp .env.example .env
# 编辑 .env：设置 ENCLAWS_JWT_SECRET、API Key 等

# 启动服务（PostgreSQL + Gateway）
docker-compose up -d

# 运行数据库迁移
docker-compose exec cli node --import tsx src/db/migrate.ts

# 打开控制面板
open http://localhost:18888
```

---

## 关键环境变量

| 变量                       | 默认值  | 说明                        |
| -------------------------- | ------- | --------------------------- |
| `ENCLAWS_GATEWAY_PORT`     | `18888` | Gateway HTTP/WebSocket 端口 |
| `ENCLAWS_GATEWAY_PASSWORD` | —       | 认证密码                    |
| `ENCLAWS_DB_URL`           | SQLite  | 数据库连接字符串            |
| `ENCLAWS_JWT_SECRET`       | —       | JWT 签名密钥（多租户必填）  |
| `OPENAI_API_KEY`           | —       | OpenAI API Key              |
| `ANTHROPIC_API_KEY`        | —       | Anthropic API Key           |

完整列表见 `.env.example`。

---

## 接下来

- [架构深度解析](./architecture-deep-dive.md) — 了解 EnClaws 内部运作原理
- [部署指南](./deployment-guide.md) — 生产环境部署方案
- [配置参考](./gateway/configuration-reference.md) — 完整配置文档
