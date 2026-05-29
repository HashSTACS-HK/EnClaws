# 部署指南

EnClaws 生产环境部署方案——从单机开发到多租户企业级部署。

---

## 部署方式概览

| 方式                                | 适用场景               | 数据库     | 复杂度 |
| ----------------------------------- | ---------------------- | ---------- | ------ |
| [CLI 本地运行](#1-cli-本地运行)     | 开发、个人使用         | SQLite     | 低     |
| [Docker Compose](#2-docker-compose) | 小团队、预发布         | PostgreSQL | 中     |
| [Windows 安装包](#3-windows-安装包) | Windows 用户、离线环境 | SQLite     | 低     |
| [macOS 安装包](#4-macos-安装包)     | macOS 用户             | SQLite     | 低     |
| [VPS / 云服务器](#5-vps--云服务器)  | 生产环境、常驻运行     | PostgreSQL | 中     |
| [多实例高可用](#6-多实例高可用)     | 企业级、高可用         | PostgreSQL | 高     |

---

## 1. CLI 本地运行

最简单的方式——直接在本机运行。

### 安装与启动

```bash
# 全局安装
npm install -g enclaws

# 启动 Gateway
enclaws gateway
```

### 配置

```bash
# 设置环境变量
export ENCLAWS_GATEWAY_PORT=18789
export ENCLAWS_GATEWAY_PASSWORD=your-password
export OPENAI_API_KEY=sk-...

# 带参数启动
enclaws gateway --port 18789 --bind loopback --auth password
```

### CLI 参数

| 参数                   | 默认值   | 说明                                            |
| ---------------------- | -------- | ----------------------------------------------- |
| `--port <n>`           | 18789    | Gateway 端口                                    |
| `--bind <mode>`        | loopback | `loopback` / `lan` / `tailnet` / `auto`         |
| `--auth <mode>`        | token    | `none` / `token` / `password` / `trusted-proxy` |
| `--token <t>`          | —        | WebSocket 认证 Token                            |
| `--password <p>`       | —        | 密码认证                                        |
| `--dev`                | false    | 开发模式                                        |
| `--verbose`            | false    | 详细日志                                        |
| `--allow-unconfigured` | false    | 跳过配置校验                                    |

### 数据目录

```
~/.enclaws/
├── config.toml          # Gateway 配置
├── workspace/           # 文件存储
├── sessions/            # 聊天会话
└── tenants/             # 租户数据（多租户模式）
```

---

## 2. Docker Compose

生产环境推荐——内含 PostgreSQL，支持多租户。

### 前置条件

- Docker >= 20.10
- Docker Compose >= 2.0

### 初始化

```bash
# 克隆仓库
git clone https://github.com/hashSTACS-Global/EnClaws.git
cd EnClaws

# 创建环境配置
cp .env.example .env
```

### 配置 .env

```bash
# === 数据库 ===
OPENCLAW_DB_URL=postgresql://openclaw:openclaw_secret@openclaw-db:5432/openclaw

# === 认证 ===
OPENCLAW_JWT_SECRET=修改为至少32字符的随机字符串
OPENCLAW_GATEWAY_TOKEN=your-gateway-access-token

# === Gateway ===
OPENCLAW_GATEWAY_PORT=18789
OPENCLAW_GATEWAY_BIND=lan

# === LLM 提供商 ===
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...

# === 通道（可选）===
TELEGRAM_BOT_TOKEN=...
DISCORD_BOT_TOKEN=...
```

### 启动

```bash
# 启动所有服务
docker-compose up -d

# 检查状态
docker-compose ps

# 查看日志
docker-compose logs -f gateway

# 运行数据库迁移
docker-compose exec cli node --import tsx src/db/migrate.ts

# 检查迁移状态
docker-compose exec cli node --import tsx src/db/migrate.ts --status
```

### Docker Compose 服务

| 服务          | 端口         | 说明                            |
| ------------- | ------------ | ------------------------------- |
| `openclaw-db` | 5432         | PostgreSQL 16 Alpine            |
| `gateway`     | 18789, 18790 | EnClaws Gateway                 |
| `cli`         | —            | CLI 工具（与 Gateway 共享网络） |

### 数据卷

| 卷                | 用途                  |
| ----------------- | --------------------- |
| `openclaw-pgdata` | PostgreSQL 持久化存储 |
| `./data/enclaws`  | Gateway 状态目录      |

### 升级

```bash
# 拉取最新代码
git pull

# 重新构建并重启
docker-compose build
docker-compose up -d

# 运行新的迁移
docker-compose exec cli node --import tsx src/db/migrate.ts
```

---

## 3. Windows 安装包

零依赖的 Windows 安装程序。

### 构建安装包

```powershell
# 在项目根目录执行
.\installer\build-installer.ps1

# 自定义选项
.\installer\build-installer.ps1 `
  -NodeVersion 22.16.0 `
  -Registry https://registry.npmmirror.com `
  -InnoSetupPath "C:\Program Files (x86)\Inno Setup 6\iscc.exe"
```

### 包含内容

- 便携版 Node.js 运行时（无需系统 Node）
- 预构建的 EnClaws 应用
- 飞书 Skill 包（从 `feishu-skills` 仓库打包）
- 自动启动配置

### 安装与运行

1. 运行 `EnClaws-Setup-x.x.x.exe`（无需管理员权限）
2. 在开始菜单搜索"EnClaws"
3. Gateway 在 `http://localhost:18789` 启动

### 数据目录

```
%LOCALAPPDATA%\EnClaws\
├── node\                # 内置 Node.js
├── app\                 # 应用文件
├── skills-pack\         # 飞书 Skill 包
└── data\                # 运行时数据
```

---

## 4. macOS 安装包

自包含的 DMG 安装包。

### 构建 DMG

```bash
# 为当前架构构建
./scripts/build-mac-installer.sh

# 指定架构
BUILD_ARCHS=arm64 ./scripts/build-mac-installer.sh

# 环境变量
NODE_VERSION=22.16.0      # 内置的 Node.js 版本
SKIP_BUILD=1              # 跳过 pnpm build（如果 dist/ 已存在）
SKIP_DMG=1                # 只构建 .app（不生成 DMG）
```

### 安装

1. 打开 `EnClaws-x.x.x.dmg`
2. 将 EnClaws 拖入「应用程序」
3. 从启动台或 Spotlight 启动

### 包含内容

- 内置 Node.js 运行时
- 代码签名的 .app 包
- CFBundleIdentifier（macOS 安全要求）
- 可选开机自启

---

## 5. VPS / 云服务器

用于常驻运行的生产环境部署。

### 前置条件

- Ubuntu 22.04+ / Debian 12+ / RHEL 9+
- Node.js >= 22.12.0
- PostgreSQL 16+（多租户）

### 安装

```bash
# 一键安装
curl -fsSL --proto '=https' --tlsv1.2 \
  https://raw.githubusercontent.com/hashSTACS-Global/EnClaws/main/install.sh | bash

# 或从源码构建
git clone https://github.com/hashSTACS-Global/EnClaws.git
cd EnClaws
pnpm install && pnpm build && pnpm ui:build
```

### PostgreSQL 配置

```bash
# 安装 PostgreSQL
sudo apt install postgresql-16

# 创建数据库和用户
sudo -u postgres psql <<SQL
CREATE USER enclaws WITH PASSWORD 'your-secure-password';
CREATE DATABASE enclaws OWNER enclaws;
SQL

# 设置连接字符串
export ENCLAWS_DB_URL=postgresql://enclaws:your-secure-password@localhost:5432/enclaws

# 运行迁移
pnpm db:migrate
```

### systemd 服务

创建 `/etc/systemd/system/enclaws.service`：

```ini
[Unit]
Description=EnClaws AI Assistant Gateway
After=network.target postgresql.service

[Service]
Type=simple
User=enclaws
Group=enclaws
WorkingDirectory=/opt/enclaws
EnvironmentFile=/opt/enclaws/.env
ExecStart=/usr/bin/node openclaw.mjs gateway --bind lan --auth password
Restart=on-failure
RestartSec=5

# 安全加固
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/enclaws/data

[Install]
WantedBy=multi-user.target
```

```bash
# 启用并启动
sudo systemctl daemon-reload
sudo systemctl enable enclaws
sudo systemctl start enclaws

# 检查状态
sudo systemctl status enclaws
sudo journalctl -u enclaws -f
```

### 反向代理（Nginx）

```nginx
server {
    listen 443 ssl http2;
    server_name enclaws.example.com;

    ssl_certificate     /etc/letsencrypt/live/enclaws.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/enclaws.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:18789;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}
```

使用反向代理时，配置 trusted-proxy 认证：

```bash
export ENCLAWS_GATEWAY_AUTH=trusted-proxy
```

### 防火墙

```bash
# 开放 Gateway 端口（未使用反向代理时）
sudo ufw allow 18789/tcp

# 或限制特定 IP
sudo ufw allow from 10.0.0.0/8 to any port 18789
```

---

## 6. 多实例高可用

企业级高可用部署，支持负载均衡。

### 架构

```
                    ┌──────────────┐
                    │   负载       │
                    │   均衡器     │
                    │   (Nginx)    │
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
        ┌─────┴─────┐ ┌───┴─────┐ ┌───┴─────┐
        │ Gateway 1 │ │ Gateway 2│ │ Gateway 3│
        │ (活跃)    │ │ (活跃)   │ │ (活跃)  │
        └─────┬─────┘ └───┬─────┘ └───┬─────┘
              │            │            │
              └────────────┼────────────┘
                           │
                    ┌──────┴───────┐
                    │ PostgreSQL   │
                    │ (主库 +      │
                    │  只读副本)   │
                    └──────────────┘
```

### 负载均衡配置

```nginx
upstream enclaws_backend {
    # WebSocket 会话粘滞（必须）
    ip_hash;

    server gateway1.internal:18789;
    server gateway2.internal:18789;
    server gateway3.internal:18789;
}

server {
    listen 443 ssl http2;
    server_name enclaws.example.com;

    location / {
        proxy_pass http://enclaws_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400;
    }
}
```

### 注意事项

- **会话粘滞** — WebSocket 连接必须保持在同一实例（使用 `ip_hash` 或 Cookie）
- **共享 PostgreSQL** — 所有实例连接同一数据库
- **共享文件系统** — 使用 NFS 或对象存储存放租户工作区
- **Cron 协调** — 只能有一个实例运行定时任务（使用 Leader 选举或专用 Cron Worker）
- **通道连接** — 每个通道 Bot 只从一个实例连接

---

## 环境变量参考

### 核心配置

| 变量                       | 默认值       | 说明                                              |
| -------------------------- | ------------ | ------------------------------------------------- |
| `ENCLAWS_GATEWAY_PORT`     | `18789`      | Gateway 端口                                      |
| `ENCLAWS_GATEWAY_BIND`     | `loopback`   | 绑定模式：`loopback` / `lan` / `tailnet` / `auto` |
| `ENCLAWS_GATEWAY_PASSWORD` | —            | 认证密码                                          |
| `ENCLAWS_STATE_DIR`        | `~/.enclaws` | 状态目录路径                                      |
| `ENCLAWS_HOME`             | `~`          | 主目录                                            |

### 数据库

| 变量                  | 默认值         | 说明            |
| --------------------- | -------------- | --------------- |
| `ENCLAWS_DB_URL`      | `sqlite://...` | 完整连接 URL    |
| `ENCLAWS_DB_HOST`     | `localhost`    | PostgreSQL 主机 |
| `ENCLAWS_DB_PORT`     | `5432`         | PostgreSQL 端口 |
| `ENCLAWS_DB_NAME`     | `enclaws`      | 数据库名        |
| `ENCLAWS_DB_USER`     | `enclaws`      | 数据库用户      |
| `ENCLAWS_DB_PASSWORD` | —              | 数据库密码      |
| `ENCLAWS_DB_SSL`      | `false`        | 启用 SSL        |
| `ENCLAWS_DB_POOL_MAX` | `20`           | 连接池大小      |

### 认证

| 变量                                     | 默认值  | 说明                       |
| ---------------------------------------- | ------- | -------------------------- |
| `ENCLAWS_JWT_SECRET`                     | —       | JWT 签名密钥（多租户必填） |
| `ENCLAWS_JWT_ACCESS_EXPIRES`             | `30m`   | Access Token 有效期        |
| `ENCLAWS_JWT_REFRESH_EXPIRES`            | `7d`    | Refresh Token 有效期       |
| `ENCLAWS_CONTROL_UI_DISABLE_DEVICE_AUTH` | `false` | 禁用设备认证               |
| `ENCLAWS_CONTROL_UI_ALLOWED_ORIGINS`     | —       | 控制面板 CORS 来源         |

### LLM 提供商

| 变量                 | 说明                  |
| -------------------- | --------------------- |
| `OPENAI_API_KEY`     | OpenAI API Key        |
| `OPENAI_API_KEYS`    | 多个 Key（逗号分隔）  |
| `ANTHROPIC_API_KEY`  | Anthropic API Key     |
| `GEMINI_API_KEY`     | Google Gemini API Key |
| `OPENROUTER_API_KEY` | OpenRouter API Key    |
| `DEEPSEEK_API_KEY`   | DeepSeek API Key      |

### 消息通道

| 变量                   | 说明                  |
| ---------------------- | --------------------- |
| `TELEGRAM_BOT_TOKEN`   | Telegram Bot Token    |
| `DISCORD_BOT_TOKEN`    | Discord Bot Token     |
| `SLACK_BOT_TOKEN`      | Slack Bot Token       |
| `SLACK_APP_TOKEN`      | Slack App-Level Token |
| `MATTERMOST_BOT_TOKEN` | Mattermost Bot Token  |
| `ZALO_BOT_TOKEN`       | Zalo Bot Token        |

### Skill 包

| 变量                      | 默认值  | 说明              |
| ------------------------- | ------- | ----------------- |
| `SKILL_PACK_AUTO_INSTALL` | `false` | 自动安装 Skill 包 |
| `SKILL_PACK_LOCAL_DIR`    | —       | 本地 Skill 包目录 |
| `SKILL_PACK_GIT_URL`      | —       | Skill 包 Git 地址 |

---

## 数据库操作

### 迁移

```bash
# 运行待执行的迁移
pnpm db:migrate

# 查看迁移状态
pnpm db:migrate:status

# 或直接执行
node --import tsx src/db/migrate.ts
node --import tsx src/db/migrate.ts --status
```

### 数据库自动检测

EnClaws 自动检测数据库类型：

1. `ENCLAWS_DB_URL` 以 `postgresql://` 或 `postgres://` 开头 → **PostgreSQL**
2. `ENCLAWS_DB_URL` 以 `sqlite://` 开头 → **SQLite**
3. 设置了 `ENCLAWS_DB_HOST`（无 URL）→ **PostgreSQL**
4. 未设置 → **SQLite**（默认，存储在状态目录）

### 备份

```bash
# PostgreSQL 备份
pg_dump -U enclaws -h localhost enclaws > backup.sql

# PostgreSQL 恢复
psql -U enclaws -h localhost enclaws < backup.sql

# SQLite 备份（直接复制文件）
cp ~/.enclaws/data.db ~/.enclaws/data.db.backup
```

---

## 安全检查清单

- [ ] 设置强 `ENCLAWS_JWT_SECRET`（32+ 字符）
- [ ] 生产环境设置 `ENCLAWS_GATEWAY_PASSWORD`
- [ ] 非必要不使用 `--bind lan`，默认使用 `loopback`
- [ ] 公网访问时通过反向代理（Nginx/Caddy）启用 TLS
- [ ] 限制 PostgreSQL 只允许 Gateway 实例访问
- [ ] 定期轮换 API Key
- [ ] 监控审计日志，关注异常活动
- [ ] 以非 root 用户运行（Docker 镜像使用 `node` 用户）
- [ ] 保持 Node.js 和依赖更新

---

## 故障排查

### Gateway 无法启动

```bash
# 检查端口占用
lsof -i :18789

# 查看详细日志
enclaws gateway --verbose

# 跳过配置校验
enclaws gateway --allow-unconfigured
```

### 数据库连接失败

```bash
# 测试 PostgreSQL 连接
psql -U enclaws -h localhost -d enclaws -c "SELECT 1"

# 检查迁移状态
pnpm db:migrate:status

# 重新运行迁移
pnpm db:migrate
```

### 通道无法连接

```bash
# 检查 Gateway 状态
enclaws gateway status

# 通过 RPC 查看通道健康状态
enclaws gateway call tenant.channels.list
```
