# Architecture Deep Dive

A comprehensive look at EnClaws internals — how messages flow, how tenants are isolated, and how the agent runtime executes tasks.

---

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          Client Layer                                   │
│   Web Control UI (Lit)  │  CLI / TUI  │  macOS / iOS / Android Apps    │
└────────────────┬────────────────┬────────────────┬──────────────────────┘
                 │                │                │
                 ▼                ▼                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          Channel Layer (41+)                            │
│  Feishu │ Discord │ Telegram │ Slack │ WhatsApp │ Teams │ Matrix │ ... │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          Gateway Layer                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                  │
│  │  WebSocket    │  │  HTTP Server │  │  RPC Dispatch │                 │
│  │  Server       │  │  (Express 5) │  │  (Methods)    │                 │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘                  │
│         │                 │                  │                           │
│  ┌──────┴─────────────────┴──────────────────┴───────┐                  │
│  │              Authentication & Authorization        │                 │
│  │         JWT + 5-Level RBAC + Method Scoping        │                 │
│  └──────────────────────┬────────────────────────────┘                  │
│                         │                                               │
│  ┌──────────┐  ┌────────┴────┐  ┌──────────┐  ┌──────────┐            │
│  │ Channel  │  │  Tenant     │  │  Plugin  │  │   Cron   │            │
│  │ Manager  │  │  Router     │  │  Manager │  │  Service │            │
│  └──────────┘  └─────────────┘  └──────────┘  └──────────┘            │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          Core Engine                                    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                  │
│  │  Message      │  │  Reply       │  │  Agent       │                 │
│  │  Dispatch     │  │  Engine      │  │  Runner      │                 │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘                  │
│         │                 │                  │                           │
│  ┌──────┴─────────────────┴──────────────────┴───────┐                  │
│  │         StreamFn Execution Pipeline                │                 │
│  │    (chained processors with error handling)        │                 │
│  └──────────────────────┬────────────────────────────┘                  │
│                         │                                               │
│  ┌──────────┐  ┌────────┴────┐  ┌──────────────────┐                   │
│  │  Tool    │  │  Skill      │  │  ACP (Concurrent │                   │
│  │  System  │  │  System     │  │  Task Executor)  │                   │
│  │  (60+)   │  │  (55)       │  │                  │                   │
│  └──────────┘  └─────────────┘  └──────────────────┘                   │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        LLM Provider Layer                               │
│  Anthropic │ OpenAI │ Gemini │ DeepSeek │ Qwen │ Moonshot │ Ollama    │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          Storage Layer                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ PostgreSQL   │  │   SQLite     │  │ LanceDB  │  │  File System  │  │
│  │ (multi-      │  │  (light-     │  │ (vector  │  │ (tenant-      │  │
│  │  tenant)     │  │   weight)    │  │  memory) │  │  isolated)    │  │
│  └──────────────┘  └──────────────┘  └──────────┘  └───────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        Observability Layer                              │
│  Interaction Traces │ Audit Logs │ Token Usage │ Structured Logging    │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Message Flow

A complete request lifecycle from user message to bot reply:

```
1. User sends message via Feishu/Discord/Telegram/etc.
                    │
2. Channel adapter receives message, normalizes to internal format
                    │
3. Gateway authenticates request (JWT / token / password)
                    │
4. Tenant Router extracts tenant context from channel metadata
                    │
5. Session Resolver finds or creates session for (tenant, user, channel)
                    │
6. Message Dispatch routes to the correct Agent based on config
                    │
7. Agent Runner loads agent configuration:
   - SOUL.md (personality)
   - TOOLS.md (available tools)
   - MEMORY.md (context)
   - Skills (applicable skill files)
                    │
8. Reply Engine orchestrates the LLM call:
   - Builds prompt from context + memory + skill instructions
   - Calls LLM provider (Anthropic/OpenAI/etc.)
   - Handles tool calls (execute tool → feed result back → re-call LLM)
   - Streams response tokens
                    │
9. Interaction Tracer records: prompt, completion, model, tokens, cost, duration
                    │
10. Response sent back through Channel adapter to user
                    │
11. Audit Logger records the interaction for compliance
```

---

## Multi-Tenant Architecture

### Tenant Isolation Model

Every piece of data in EnClaws is scoped to a tenant:

```
Tenant (company/team/department)
├── Users (members with roles)
├── Agents (AI assistants)
│   ├── Configuration (SOUL.md, TOOLS.md)
│   ├── Skills (per-agent skill overrides)
│   └── Tool deny-lists
├── Channels (messaging integrations)
│   └── Channel Apps (specific bot instances)
├── Models (LLM provider configurations)
├── Stats (token usage tracking)
├── Traces (interaction logs)
└── Audit Logs
```

### File System Isolation

```
~/.enclaws/tenants/{tenantId}/
├── SOUL.md                          # Tenant-level personality
├── TOOLS.md                         # Tenant-level tool config
├── MEMORY.md                        # Tenant-level memory
├── agents/{agentId}/
│   ├── AGENT.md / SOUL.md           # Agent personality
│   ├── IDENTITY.md                  # Agent identity
│   ├── HEARTBEAT.md                 # Health check config
│   ├── BOOTSTRAP.md                 # Init script
│   └── skills/{skillName}/SKILL.md  # Agent-specific skills
├── skills/{skillName}/SKILL.md      # Tenant-level shared skills
└── users/{unionId}/
    ├── USER.md                      # User profile
    ├── sessions/                    # Chat sessions
    ├── workspace/                   # File uploads
    ├── devices/                     # Paired devices
    ├── credentials/                 # User credentials
    └── cron/jobs.json               # Scheduled tasks
```

### Database Schema

PostgreSQL with tenant-scoped tables:

| Table                 | Purpose           | Key Fields                      |
| --------------------- | ----------------- | ------------------------------- |
| `tenants`             | Tenant registry   | id, name, plan, quotas          |
| `tenant_users`        | User membership   | tenant_id, user_id, role        |
| `tenant_agents`       | Agent configs     | tenant_id, agent_id, config     |
| `tenant_channels`     | Channel bindings  | tenant_id, channel_type, policy |
| `tenant_channel_apps` | Bot instances     | channel_id, app_config          |
| `tenant_models`       | LLM providers     | tenant_id, provider, api_key    |
| `tenant_stats`        | Usage metrics     | tenant_id, tokens, cost         |
| `tenant_traces`       | Interaction logs  | tenant_id, prompt, completion   |
| `tenant_audit_logs`   | Compliance trail  | tenant_id, action, actor        |
| `_migrations`         | Schema versioning | version, applied_at             |

---

## Authentication & Authorization

### JWT Flow

```
Client ──→ POST /auth/login (credentials)
       ←── { accessToken (30m), refreshToken (7d) }

Client ──→ WS connect (Authorization: Bearer <accessToken>)
       ←── Connected (tenant + user context extracted)

Client ──→ RPC call (method: "tenant.agents.list")
       ←── Gateway checks: role >= required role for method
       ←── Response or 403 Forbidden
```

### Role Hierarchy

```
platform-admin    Full system access, cross-tenant operations
      │
    owner         Full tenant access, manage members
      │
    admin         Manage agents, channels, models within tenant
      │
    member        Use agents, view configs
      │
    viewer        Read-only access
```

### Method-Level Permissions

Each RPC method declares its minimum required role:

```typescript
// Example: only admin+ can create channels
"tenant.channels.create": { minRole: "admin" }

// Example: members can list agents
"tenant.agents.list": { minRole: "member" }

// Example: only platform-admin can manage tenants
"platform.tenants.create": { minRole: "platform-admin" }
```

---

## Agent Runtime

### Execution Pipeline

```
Inbound Message
      │
      ▼
┌─────────────┐
│ Skill       │  Match applicable skills by message content
│ Eligibility │  Check user permissions for each skill
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ Context     │  Load: SOUL.md + MEMORY.md + session history
│ Assembly    │  Apply: skill instructions + tool definitions
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ StreamFn    │  Chain of processors:
│ Pipeline    │  → pre-process → LLM call → tool execution → post-process
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ ACP         │  Concurrent task isolation
│ Executor    │  Multiple tasks run in parallel (no queuing)
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ Response    │  Format reply for target channel
│ Formatter   │  (text, card, file, image, etc.)
└─────────────┘
```

### Concurrent Execution (ACP)

The Assistant Control Plane enables true parallel task processing:

- Each task runs in an isolated execution context
- No artificial queuing — 100+ tasks can execute simultaneously
- Designed for enterprise scenarios (e.g., finance bot handling 100 reimbursements at once)
- Error isolation — one task failure doesn't affect others

### Skill System

Skills are markdown-based instruction files that extend agent capabilities:

```
skills/
├── github/SKILL.md         # GitHub integration
├── gmail/SKILL.md          # Email management
├── notion/SKILL.md         # Notion workspace
├── coding-agent/SKILL.md   # Code generation
└── ...                     # 55 total
```

**Skill Override Chain:**

```
Built-in Skill (default)
      │
      ▼
Tenant-level Override (tenant admin customization)
      │
      ▼
Agent-level Override (per-agent specialization)
```

**Inline Frontmatter:** Skills support YAML metadata for conditional execution:

```markdown
---
name: my-skill
when: message contains "create doc"
requires: feishu-token
---

Instructions for the agent...
```

---

## Hierarchical Memory

### Four-Level Memory Pyramid

```
┌─────────────────────────────┐
│    Industry Memory          │  Regulations, standards, domain knowledge
│    (shared across tenants)  │  e.g., financial compliance rules
├─────────────────────────────┤
│    Company Memory           │  Policies, culture, product knowledge
│    (tenant-level)           │  e.g., company coding standards
├─────────────────────────────┤
│    Department Memory        │  Workflows, playbooks, team norms
│    (agent-level)            │  e.g., customer support scripts
├─────────────────────────────┤
│    Personal Memory          │  Preferences, habits, history
│    (user-level)             │  e.g., preferred response format
└─────────────────────────────┘
```

### Promotion Pipeline

Valuable knowledge automatically flows upward:

```
Personal insight proven useful
      │
      ▼ (automatic promotion)
Department-level playbook
      │
      ▼ (admin approval)
Company-wide knowledge base
```

### Vector Memory (LanceDB)

- Embeddings generated for all memory entries
- Semantic search during context assembly
- Relevant memories injected into agent prompt automatically

---

## Observability Stack

### Interaction Traces

Every LLM call is recorded with:

| Field               | Description            |
| ------------------- | ---------------------- |
| `trace_id`          | Unique identifier      |
| `tenant_id`         | Owning tenant          |
| `agent_id`          | Executing agent        |
| `user_id`           | Requesting user        |
| `model`             | LLM model used         |
| `prompt_tokens`     | Input token count      |
| `completion_tokens` | Output token count     |
| `cost`              | Estimated cost (USD)   |
| `duration_ms`       | Response time          |
| `timestamp`         | When the call happened |

### Token Usage Analytics

The management dashboard provides:

- **7-day / 30-day trends** — token consumption over time
- **User rankings** — top consumers by token usage
- **Agent rankings** — which agents use the most tokens
- **Model rankings** — cost distribution by LLM provider
- **Channel distribution** — usage patterns across messaging channels

### Audit Logs

Compliance-grade event logging:

```json
{
  "action": "agent.config.update",
  "actor": "user:alice@company.com",
  "tenant": "tenant-123",
  "target": "agent:support-bot",
  "changes": { "soul": "..." },
  "timestamp": "2026-04-03T10:00:00Z",
  "ip": "192.168.1.100"
}
```

---

## Cron & Scheduled Tasks

### Architecture

```
Cron Service (runs in Gateway process)
      │
      ├── Parses cron expressions from user configs
      ├── Triggers at scheduled times
      ├── Creates isolated agent execution context
      ├── Sends message to target channel(s)
      ├── Tracks delivery status (pending → sent → delivered → failed)
      └── Retries on failure with backoff
```

### Delivery Plans

Each cron job has a delivery plan specifying:

- **Target channels** — which channels receive the output
- **Retry policy** — max retries, backoff strategy
- **Isolation** — each execution runs in its own agent context
- **Audit trail** — all deliveries logged for compliance

---

## Plugin Architecture

### Extension Points

Plugins can hook into multiple extension points via the Plugin SDK:

| Extension Point | Purpose                              |
| --------------- | ------------------------------------ |
| `setup`         | Initialize plugin on gateway startup |
| `channel`       | Add new messaging channel            |
| `reply`         | Modify reply behavior                |
| `config`        | Extend configuration schema          |
| `security`      | Add auth/authorization logic         |
| `memory`        | Custom memory backend                |
| `tool`          | Register new tools                   |

### Plugin Lifecycle

```
Gateway Startup
      │
      ▼
Plugin Discovery (scan extensions/ directory)
      │
      ▼
Plugin Loading (import plugin module)
      │
      ▼
Plugin Setup (call setup() with gateway context)
      │
      ▼
Plugin Active (hooks registered, ready to process)
```

---

## Key Source Files

| File                          | Purpose                         |
| ----------------------------- | ------------------------------- |
| `src/entry.ts`                | CLI entry point                 |
| `src/index.ts`                | Main module exports             |
| `src/gateway/boot.ts`         | Gateway boot sequence           |
| `src/cli/gateway-cli/run.ts`  | Gateway run command             |
| `src/db/index.ts`             | Database connection (PG/SQLite) |
| `src/db/migrate.ts`           | Schema migration runner         |
| `src/gateway/server-methods/` | RPC method handlers             |
| `src/acp/`                    | Concurrent execution engine     |
| `src/auth/`                   | JWT + RBAC implementation       |
| `src/cron/`                   | Scheduled task engine           |
| `extensions/openclaw-lark/`   | Feishu integration plugin       |
