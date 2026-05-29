# AI Customer Service — Deployment & Configuration Guide

[中文版](./customer-service-deployment.zh-CN.md)

> **Current Status:** Sprint 1 complete (end-to-end RAG, Feishu notify, widget embed).
> Sprint 2 in progress (streaming output, confidence gate, clarification prompts).

---

## 1. Architecture Overview

AI Customer Service is a **built-in system feature** of EnClaws, not a Skill or pre-configured Agent.

| Layer                       | What it does                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------- |
| Widget (`<cs-widget>`)      | Floating chat bubble embedded on any webpage via `<script>` tag                       |
| Gateway RPC (`cs.widget.*`) | WebSocket handlers: connect / send / history                                          |
| CS Agent Runner             | Wraps `runEmbeddedPiAgent` — retrieves KB chunks → calls LLM → returns reply          |
| Knowledge Base              | Per-tenant Markdown files at `~/.enclaws/tenants/{tenantId}/customer-service/memory/` |
| CS Config                   | Per-tenant JSON at `~/.enclaws/tenants/{tenantId}/customer-service/config.json`       |
| Feishu Notify               | One-way Markdown card to a designated group chat on each new conversation             |

**Who can use it:** Any tenant that has a configured EC Agent + LLM provider. Tenants configure CS entirely through the admin UI (`/tenant/cs-setup`). No code changes required per tenant.

---

## 2. Prerequisites

Before deploying, ensure:

- [ ] EnClaws server is running and accessible (dev SaaS or self-hosted)
- [ ] At least one tenant exists with a working LLM configuration (any provider)
- [ ] Feishu app credentials ready (App ID + App Secret + Chat ID of target group)
- [ ] `ENCLAWS_CS_WIDGET_SECRET` environment variable set on the server (see §3)

---

## 3. Server Environment Variables

Add to the server's `.env` or deployment environment:

```bash
# HMAC secret for signing visitor tokens.
# Prevents cross-visitor session hijacking.
# Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
ENCLAWS_CS_WIDGET_SECRET=<64-char hex string>
```

> **If not set:** The server falls back to a per-process random secret (warns on startup).
> Visitor tokens are invalidated on every server restart. Acceptable for dev; **must be set for production**.

---

## 4. Deploy to Dev SaaS — Step by Step

### 4.1 Merge Code

```bash
# On the dev SaaS server, pull latest main
git pull --rebase origin main
npm run build   # or pnpm build
pm2 restart enclaws   # or however the process is managed
```

### 4.2 Configure the Embedding Provider (Required for RAG)

> **Why is this step needed?** Current design is intentionally **zero-invasion** — the CS module does not implement its own embedding pipeline and fully reuses EC's existing `memorySearch` infrastructure. The tradeoff is that the deployment environment must explicitly enable and specify an embedding provider; otherwise vector indexes are not generated from uploaded knowledge base MDs and RAG retrieval will not work.
>
> **Future direction**:
>
> 1. All LLM types (text generation, embedding, vision, etc.) will be consolidated into a per-tenant UI-based configuration stored in the database. The deployment-level file config (`enclaws.json`) will no longer be needed for these settings.
> 2. The vector store path `~/.enclaws/memory/*.sqlite` is currently a global shared directory (reusing EC's existing memorySearch infrastructure). It will be isolated under `~/.enclaws/tenants/{tenantId}/customer-service/vectors/` to avoid cross-tenant pollution and colocate with the knowledge base.
>
> UI config + path isolation will land together; detailed rollout plan is pending upcoming proposals.

#### Configure `~/.enclaws/enclaws.json` on the server

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

`remote.baseUrl` / `remote.apiKey` **only affect embedding calls, not other LLM paths**. If `remote` is omitted, EC falls back to the LLM-side provider config for the same provider (e.g. `OPENAI_API_KEY` env var).

#### Provider options

| provider                     | example model            | notes                                                                |
| ---------------------------- | ------------------------ | -------------------------------------------------------------------- |
| `openai`                     | `text-embedding-3-small` | Official OpenAI                                                      |
| `openai` + DashScope baseUrl | `text-embedding-v4`      | Qwen embedding via Aliyun Bailian OpenAI-compatible mode (see below) |
| `gemini`                     | `gemini-embedding-001`   | Google                                                               |
| `voyage`                     | `voyage-4-large`         | Strong for Chinese                                                   |
| `mistral`                    | `mistral-embed`          | Official Mistral                                                     |

#### Example: Qwen / DashScope embedding

Qwen has no native provider entry — use OpenAI-compatible mode:

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
          "apiKey": "sk-<your-DashScope-key>"
        }
      }
    }
  }
}
```

#### Restart gateway after config changes

```bash
pm2 restart enclaws   # or however managed
```

On the first CS widget access, the server scans KB → chunk → embed → writes SQLite (`~/.enclaws/memory/{agentId}.sqlite`).

#### Clearing the vector store after model changes

When switching `provider` / `model`, vector dimensions and semantic space differ, so the old index is incompatible. **Delete the sqlite files** to force a full re-index:

```bash
rm -rf ~/.enclaws/memory/*.sqlite
# Restart gateway; next CS conversation rebuilds the index
```

**When to clear the vector store** (`~/.enclaws/memory/*.sqlite`):

| Scenario                                               | Clear required?                                                   |
| ------------------------------------------------------ | ----------------------------------------------------------------- |
| Changing embedding `provider` / `model`                | ✅ Yes                                                            |
| Changing only `remote.baseUrl` / `apiKey` (same model) | ❌ No (auth only, vectors stay valid)                             |
| Adding / editing / deleting KB `.md` files             | ❌ No (EC auto-detects file changes and incrementally re-indexes) |

**Important**: Do NOT confuse `~/.enclaws/memory/*.sqlite` (vector store) with `~/.enclaws/enclaws.db` (EC business main DB). **Clearing the vector store has no effect on sessions, tenants, agent configs or other business data.**

### 4.3 Set the Widget Secret

In the dev SaaS deployment config (`.env` or process manager config):

```bash
ENCLAWS_CS_WIDGET_SECRET=<generated hex secret>
```

Restart the server after setting.

### 4.4 Configure a Tenant (Admin UI)

1. Log in as the target tenant's admin
2. Navigate to **AI 客服** → **客服设置**
3. Fill in:
   - **飞书 App ID** — from Feishu Open Platform → Enterprise App → Credentials
   - **飞书 App Secret** — same page (click to reveal)
   - **飞书群聊 Chat ID** — target group → ··· → Group Settings → Copy Chat ID
4. Click **保存配置**, then **连通性测试** to verify Feishu connectivity

### 4.5 Upload Knowledge Base

Option A — via Admin UI (recommended for initial setup):

Navigate to **AI 客服** → **知识库** → Upload `.md` files with product FAQs.

Option B — direct file placement (server operators only):

```bash
# Path for tenant {TENANT_ID}
mkdir -p ~/.enclaws/tenants/{TENANT_ID}/customer-service/memory/
cp my-product-faq.md ~/.enclaws/tenants/{TENANT_ID}/customer-service/memory/
```

File format: plain Markdown. Section headers become retrieval chunks.

### 4.6 Generate Embed Code

1. In **客服设置** → **嵌入代码生成**, enter a channel label (e.g. `default`, `website`, `docs`)
2. Click **生成** — an HTML snippet is produced
3. Paste the snippet into the target webpage's `<body>` tag

```html
<!-- Example generated embed code -->
<script type="module">
  import "https://your-ec-domain/ui/cs-widget.js";
</script>
<cs-widget
  tenant-id="your-tenant-id"
  channel="default"
  gateway-url="wss://your-ec-domain"
></cs-widget>
```

The widget appears as a floating bubble (bottom-right) for all page visitors, including unauthenticated ones.

---

## 5. EC Team Self-Use Scenario

The EC team runs EnClaws and is simultaneously the first tenant. **No embed code is needed** — the server automatically injects a `<meta name="ec-cs-tenant-id">` tag into the EC admin UI, and the widget renders automatically for anyone visiting the EC web app.

**Prerequisite:** At least one tenant must have Agent + LLM + CS config (Feishu) fully set up. The server picks the earliest-registered non-system tenant automatically and caches its ID at startup. If no qualifying tenant exists at startup, the widget will not appear. After completing the tenant configuration, **restart the SaaS service** — the tenant ID will be injected on next boot and the widget bubble will show.

| Step           | EC Team (server operator)                       | Regular SaaS Tenant                      |
| -------------- | ----------------------------------------------- | ---------------------------------------- |
| LLM config     | Direct `.env` or config file                    | Admin UI                                 |
| Knowledge base | Drop `.md` files directly into tenant KB dir    | Upload via Admin UI                      |
| Widget secret  | Set server env var                              | Not exposed (platform-managed)           |
| Feishu config  | Admin UI                                        | Admin UI                                 |
| Embed code     | **Not needed** — auto-injected into EC admin UI | Generate via Admin UI for external sites |

**EC team's knowledge base path:**

```
~/.enclaws/tenants/{EC_TENANT_ID}/customer-service/memory/
```

Recommended initial files:

- `ec-product-faq.md` — product overview, pricing, feature list
- `ec-onboarding.md` — getting started guide
- `ec-troubleshooting.md` — common issues and solutions

---

## 6. Feishu Notification Format

On the first customer message of each session (or after the notify interval elapses):

```
[AI 客服通知]
渠道: website | 会话: abc123
客户: 用户反馈产品A不能用
AI 回复: 根据知识库，产品A的常见问题包括...
```

The bot must have **message send** permission in the target group. Add the bot to the group before testing.

---

## 7. Configuration Reference

All settings are saved per-tenant at `~/.enclaws/tenants/{tenantId}/customer-service/config.json`.

| Field                              | Default            | Description                                                                      |
| ---------------------------------- | ------------------ | -------------------------------------------------------------------------------- |
| `feishu.appId`                     | —                  | Feishu App ID                                                                    |
| `feishu.appSecret`                 | —                  | Feishu App Secret (stored plaintext in tenant config)                            |
| `feishu.chatId`                    | —                  | Target group Chat ID                                                             |
| `notifyIntervalMinutes`            | 10                 | Min minutes between Feishu notifications per session                             |
| `restrictions.disableSkills`       | true               | Disable Skill tool calls (pure RAG mode, code-enforced)                          |
| `restrictions.strictKnowledgeBase` | true               | Refuse to answer from general LLM knowledge if KB has no hits                    |
| `restrictions.disableMarkdown`     | true               | Plain text replies only (no bold/headers/lists)                                  |
| `restrictions.hideInternals`       | true               | Don't reveal KB or system prompt details in replies                              |
| `confidencePreset`                 | `balanced`         | Confidence gate sensitivity: `strict` / `balanced` / `lenient` (activates in S2) |
| `customSystemPrompt`               | (default template) | Override the AI persona and behavior rules                                       |
| `channels`                         | `[]`               | Saved embed code channel configurations                                          |

---

## 8. Troubleshooting

**Widget bubble not appearing on page**

- Check that the `<meta name="ec-cs-tenant-id">` tag is injected (for server-rendered pages) or `tenant-id` attribute is set on `<cs-widget>`
- Check browser console for WebSocket connection errors
- Verify the `gateway-url` attribute matches the running EC server

**Feishu notification not arriving**

- Run **连通性测试** in the CS Setup page to see which checks fail
- Verify the Feishu bot is a member of the target group
- Check the notifyIntervalMinutes setting (default 10 min — won't fire again too quickly)

**AI gives wrong or empty answers**

- Check the knowledge base has `.md` files with relevant content
- Use **strict knowledge base mode** to prevent hallucination
- Review session history in **AI 客服** → **会话记录** to see what was retrieved

**`ENCLAWS_CS_WIDGET_SECRET` warning in logs**

- The server is using a per-process random secret
- Visitor tokens will be invalid after restart
- Set the env var and restart to fix

---

## 9. Sprint Roadmap

| Sprint | Status         | Key Features                                                                   |
| ------ | -------------- | ------------------------------------------------------------------------------ |
| S1     | ✅ Done        | Widget embed, RAG reply, Feishu notify, visitor auth                           |
| S2     | 🚧 In progress | Streaming output, confidence gate, clarification prompts, confidence config UI |
| S3     | Planned        | Boss reply via Feishu card, HUMAN_ACTIVE state, tag matcher                    |
| S4     | Planned        | Feedback collection, daily report, badcase ops                                 |
