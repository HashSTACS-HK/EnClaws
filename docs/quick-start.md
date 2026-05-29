# Quick Start Guide

Get EnClaws running in under 10 minutes.

---

## Prerequisites

- **Node.js** >= 22.12.0
- **pnpm** >= 10.23.0 (for source builds)
- At least one LLM API key (OpenAI, Anthropic, DeepSeek, etc.)

---

## Installation

### Option 1: npm (Recommended)

```bash
npm install -g enclaws
enclaws gateway
```

### Option 2: Windows Installer

Download `EnClaws-Setup-x.x.x.exe` from the [Releases](https://github.com/hashSTACS-Global/EnClaws/releases) page.

- No admin rights required
- Bundled Node.js runtime (offline ready)
- Double-click to install, search "EnClaws" to launch

### Option 3: One-Line Install (macOS / Linux)

```bash
curl -fsSL --proto '=https' --tlsv1.2 \
  https://raw.githubusercontent.com/hashSTACS-Global/EnClaws/main/install.sh | bash
```

### Option 4: Build from Source

```bash
git clone https://github.com/hashSTACS-Global/EnClaws.git
cd EnClaws
pnpm install
pnpm build && pnpm ui:build
npm link
enclaws gateway
```

---

## First Launch

After installation, the gateway starts at **http://localhost:18789** by default.

### 1. Open the Control UI

Navigate to `http://localhost:18789` in your browser.

### 2. Configure an LLM Provider

Set one or more API keys via environment variables:

```bash
# Pick your provider
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...
export GEMINI_API_KEY=AIza...

# Then start the gateway
enclaws gateway
```

Or use the onboarding wizard in the Control UI to configure providers interactively.

### 3. Connect a Channel

EnClaws supports 41+ messaging channels. Common options:

| Channel         | Setup                                                         |
| --------------- | ------------------------------------------------------------- |
| **WebChat**     | Built-in — open Control UI and start chatting                 |
| **Feishu/Lark** | Install the `openclaw-lark` plugin, configure App ID & Secret |
| **Telegram**    | Set `TELEGRAM_BOT_TOKEN` env var                              |
| **Discord**     | Set `DISCORD_BOT_TOKEN` env var                               |
| **Slack**       | Set `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` env vars            |

### 4. Start Chatting

Send a message through any connected channel. The AI assistant processes it through the agent runtime and replies.

---

## Quick Start with Docker

For production or multi-tenant setups, Docker is recommended:

```bash
# Clone the repo
git clone https://github.com/hashSTACS-Global/EnClaws.git
cd EnClaws

# Copy and edit environment config
cp .env.example .env
# Edit .env: set ENCLAWS_JWT_SECRET, API keys, etc.

# Start services (PostgreSQL + Gateway)
docker-compose up -d

# Run database migrations
docker-compose exec cli node --import tsx src/db/migrate.ts

# Open Control UI
open http://localhost:18789
```

---

## Key Environment Variables

| Variable                   | Default | Description                                    |
| -------------------------- | ------- | ---------------------------------------------- |
| `ENCLAWS_GATEWAY_PORT`     | `18789` | Gateway HTTP/WebSocket port                    |
| `ENCLAWS_GATEWAY_PASSWORD` | —       | Authentication password                        |
| `ENCLAWS_DB_URL`           | SQLite  | Database connection string                     |
| `ENCLAWS_JWT_SECRET`       | —       | JWT signing secret (required for multi-tenant) |
| `OPENAI_API_KEY`           | —       | OpenAI API key                                 |
| `ANTHROPIC_API_KEY`        | —       | Anthropic API key                              |

See `.env.example` for the full list.

---

## What's Next

- [Architecture Deep Dive](./architecture-deep-dive.md) — Understand how EnClaws works under the hood
- [Deployment Guide](./deployment-guide.md) — Production deployment options
- [Configuration Reference](./gateway/configuration-reference.md) — Full configuration documentation
