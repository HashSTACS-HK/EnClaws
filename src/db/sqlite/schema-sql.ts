/**
 * SQLite schema DDL — inlined as a TS constant so it survives bundling (tsdown).
 * Source of truth: src/db/sqlite/schema.sql (keep in sync manually).
 */

export const SQLITE_SCHEMA_SQL = `
-- EnClaws Multi-Tenant Schema (SQLite)

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- 1. Tenants
CREATE TABLE IF NOT EXISTS tenants (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  plan        TEXT NOT NULL DEFAULT 'free',
  status      TEXT NOT NULL DEFAULT 'active',
  settings    TEXT NOT NULL DEFAULT '{}',
  quotas      TEXT NOT NULL DEFAULT '{"maxUsers":10,"maxAgents":5,"maxChannels":5,"maxTokensPerMonth":20000000,"maxCronJobs":5}',
  trace_enabled    INTEGER NOT NULL DEFAULT 1,
  identity_prompt  TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants (status);

-- Plans (subscription plan dictionary). -1 = unlimited.
CREATE TABLE IF NOT EXISTS plans (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  max_users            INTEGER NOT NULL,
  max_agents           INTEGER NOT NULL,
  max_channels         INTEGER NOT NULL,
  max_tokens_per_month INTEGER NOT NULL,
  max_cron_jobs        INTEGER NOT NULL DEFAULT 5,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Seeds for max_cron_jobs are applied in initSqliteDb (after ADD COLUMN migration),
-- so this INSERT only covers the legacy columns to stay compatible with pre-upgrade tables.
INSERT OR IGNORE INTO plans (id, name, max_users, max_agents, max_channels, max_tokens_per_month) VALUES
  ('free',       '免费版', 10, 5,  5,  20000000),
  ('pro',        '专业版', 20, 20, 20, 200000000),
  ('enterprise', '企业版', -1, -1, -1, -1);

-- 2. Users
CREATE TABLE IF NOT EXISTS users (
  id                     TEXT PRIMARY KEY,
  tenant_id              TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  open_ids               TEXT DEFAULT '[]',
  union_id               TEXT,
  email                  TEXT,
  password_hash          TEXT,
  display_name           TEXT,
  role                   TEXT NOT NULL DEFAULT 'member',
  status                 TEXT NOT NULL DEFAULT 'active',
  avatar_url             TEXT,
  last_login_at          TEXT,
  channel_id             TEXT REFERENCES tenant_channels(id) ON DELETE SET NULL,
  settings               TEXT NOT NULL DEFAULT '{}',
  force_change_password  INTEGER NOT NULL DEFAULT 0,
  password_changed_at    TEXT,
  mfa_secret             TEXT,
  mfa_enabled            INTEGER NOT NULL DEFAULT 0,
  mfa_backup_codes       TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users (tenant_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
CREATE INDEX IF NOT EXISTS idx_users_status ON users (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_users_union_id ON users (union_id);
CREATE INDEX IF NOT EXISTS idx_users_channel ON users (channel_id);

-- 3. API Keys
CREATE TABLE IF NOT EXISTS tenant_api_keys (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,
  label         TEXT,
  key_encrypted TEXT NOT NULL,
  is_active     INTEGER NOT NULL DEFAULT 1,
  usage_count   INTEGER NOT NULL DEFAULT 0,
  last_used_at  TEXT,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON tenant_api_keys (tenant_id, provider);

-- 4. Channel Configs
CREATE TABLE IF NOT EXISTS tenant_channels (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_type    TEXT NOT NULL,
  channel_name    TEXT,
  channel_policy  TEXT NOT NULL DEFAULT 'open',
  config          TEXT NOT NULL DEFAULT '{}',
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, channel_type, channel_name)
);
CREATE INDEX IF NOT EXISTS idx_channels_tenant ON tenant_channels (tenant_id);

-- 5. Channel Apps
CREATE TABLE IF NOT EXISTS tenant_channel_apps (
  id           TEXT PRIMARY KEY,
  channel_id   TEXT NOT NULL REFERENCES tenant_channels(id) ON DELETE CASCADE,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  app_id       TEXT NOT NULL,
  app_secret   TEXT NOT NULL DEFAULT '',
  bot_name     TEXT,
  group_policy TEXT NOT NULL DEFAULT 'open',
  agent_id     TEXT,
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(channel_id, app_id)
);
CREATE INDEX IF NOT EXISTS idx_channel_apps_channel ON tenant_channel_apps (channel_id);
CREATE INDEX IF NOT EXISTS idx_channel_apps_tenant ON tenant_channel_apps (tenant_id);
CREATE INDEX IF NOT EXISTS idx_channel_apps_agent ON tenant_channel_apps (agent_id);

-- 6. Tenant Models
CREATE TABLE IF NOT EXISTS tenant_models (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider_type     TEXT NOT NULL,
  provider_name     TEXT NOT NULL,
  base_url          TEXT,
  api_protocol      TEXT NOT NULL DEFAULT 'openai-completions',
  auth_mode         TEXT NOT NULL DEFAULT 'api-key',
  api_key_encrypted TEXT,
  extra_headers     TEXT NOT NULL DEFAULT '{}',
  extra_config      TEXT NOT NULL DEFAULT '{}',
  models            TEXT NOT NULL DEFAULT '[]',
  visibility        TEXT NOT NULL DEFAULT 'private',
  is_active         INTEGER NOT NULL DEFAULT 1,
  created_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tenant_models_tenant ON tenant_models (tenant_id);

-- 7. Agent Configs
CREATE TABLE IF NOT EXISTS tenant_agents (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id       TEXT NOT NULL,
  name           TEXT NOT NULL,
  config         TEXT NOT NULL DEFAULT '{}',
  model_config   TEXT NOT NULL DEFAULT '[]',
  tools          TEXT NOT NULL DEFAULT '{"deny":[]}',
  skills         TEXT NOT NULL DEFAULT '[]',
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_agents_tenant ON tenant_agents (tenant_id);

-- 8. Refresh Tokens
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  device_info  TEXT,
  ip_address   TEXT,
  expires_at   TEXT NOT NULL,
  revoked      INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens (token_hash);

-- 8b. Password Reset Tokens (forgot-password + admin one-time view links)
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  purpose     TEXT NOT NULL DEFAULT 'reset',
  payload     TEXT,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires ON password_reset_tokens (expires_at);

-- 8c. Password History (Phase 2) — prevents reuse of recent passwords.
CREATE TABLE IF NOT EXISTS password_history (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pw_history_user ON password_history (user_id, created_at DESC);

-- 8d. Login Attempts (Phase 2) — persistent audit + hybrid rate limit state.
CREATE TABLE IF NOT EXISTS login_attempts (
  id         TEXT PRIMARY KEY,
  ip         TEXT NOT NULL,
  email      TEXT,
  success    INTEGER NOT NULL DEFAULT 0,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_time ON login_attempts (ip, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_attempts_email_time ON login_attempts (email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_attempts_created_at ON login_attempts (created_at);

-- 9. Audit Logs
CREATE TABLE IF NOT EXISTS audit_logs (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  resource    TEXT,
  detail      TEXT DEFAULT '{}',
  ip_address  TEXT,
  user_agent  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_logs (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs (tenant_id, action);

-- 10. Usage Tracking
CREATE TABLE IF NOT EXISTS usage_records (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id            TEXT,
  agent_id           TEXT,
  provider           TEXT,
  model              TEXT,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  session_key        TEXT,
  recorded_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_usage_tenant_time ON usage_records (tenant_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_records (tenant_id, user_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_usage_recorded_at ON usage_records (recorded_at);
CREATE INDEX IF NOT EXISTS idx_usage_model_time ON usage_records (model, recorded_at);
CREATE INDEX IF NOT EXISTS idx_usage_agent_time ON usage_records (agent_id, recorded_at);

-- 11. LLM Interaction Traces
CREATE TABLE IF NOT EXISTS llm_interaction_traces (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id            TEXT,
  session_key        TEXT,
  agent_id           TEXT,
  channel            TEXT,
  turn_id            TEXT NOT NULL,
  turn_index         INTEGER NOT NULL DEFAULT 0,
  user_input         TEXT,
  provider           TEXT,
  model              TEXT,
  system_prompt      TEXT,
  messages           TEXT NOT NULL DEFAULT '[]',
  tools              TEXT,
  request_params     TEXT,
  response           TEXT,
  stop_reason        TEXT,
  error_message      TEXT,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms        INTEGER,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_traces_tenant_time ON llm_interaction_traces (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_traces_session ON llm_interaction_traces (tenant_id, session_key, created_at);
CREATE INDEX IF NOT EXISTS idx_traces_turn ON llm_interaction_traces (turn_id);
CREATE INDEX IF NOT EXISTS idx_traces_user ON llm_interaction_traces (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_traces_agent ON llm_interaction_traces (tenant_id, agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_traces_created_at ON llm_interaction_traces (created_at);
CREATE INDEX IF NOT EXISTS idx_traces_model_time ON llm_interaction_traces (model, created_at);

-- 12. Migration tracking
CREATE TABLE IF NOT EXISTS _migrations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 13. System Gateway Config (single-row)
CREATE TABLE IF NOT EXISTS sys_gateway_config (
  id                       INTEGER PRIMARY KEY CHECK (id = 1),
  port                     INTEGER NOT NULL DEFAULT 18888,
  mode                     TEXT DEFAULT 'local',
  bind                     TEXT DEFAULT 'lan',
  custom_bind_host         TEXT,
  tailscale                TEXT NOT NULL DEFAULT '{}',
  remote                   TEXT NOT NULL DEFAULT '{}',
  reload                   TEXT NOT NULL DEFAULT '{}',
  tls                      TEXT NOT NULL DEFAULT '{}',
  http                     TEXT NOT NULL DEFAULT '{}',
  nodes                    TEXT NOT NULL DEFAULT '{}',
  trusted_proxies          TEXT NOT NULL DEFAULT '[]',
  allow_real_ip_fallback   INTEGER NOT NULL DEFAULT 0,
  auth                     TEXT NOT NULL DEFAULT '{"mode":"token","token":"70b8b8d138fcb84242a83aa69db615286a2977020a2efe73"}',
  tools                    TEXT NOT NULL DEFAULT '{}',
  channel_health_check_minutes INTEGER DEFAULT 5,
  multi_tenant             TEXT NOT NULL DEFAULT '{"enabled":true}',
  updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO sys_gateway_config (id) VALUES (1);

-- 14. System Logging Config (single-row)
CREATE TABLE IF NOT EXISTS sys_logging_config (
  id                       INTEGER PRIMARY KEY CHECK (id = 1),
  level                    TEXT DEFAULT 'info',
  file                     TEXT,
  max_file_bytes           INTEGER,
  console_level            TEXT,
  console_style            TEXT,
  redact_sensitive         TEXT DEFAULT 'tools',
  redact_patterns          TEXT NOT NULL DEFAULT '[]',
  updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO sys_logging_config (id) VALUES (1);

-- 15. System Plugins Config (single-row)
CREATE TABLE IF NOT EXISTS sys_plugins_config (
  id                       INTEGER PRIMARY KEY CHECK (id = 1),
  enabled                  INTEGER NOT NULL DEFAULT 1,
  allow                    TEXT NOT NULL DEFAULT '["openclaw-lark","wecom-openclaw-plugin","dingtalk-openclaw-connector"]',
  deny                     TEXT NOT NULL DEFAULT '[]',
  load                     TEXT NOT NULL DEFAULT '{}',
  slots                    TEXT NOT NULL DEFAULT '{}',
  entries                  TEXT NOT NULL DEFAULT '{"openclaw-lark":{"enabled":true},"wecom-openclaw-plugin":{"enabled":true},"dingtalk-openclaw-connector":{"enabled":true}}',
  installs                 TEXT NOT NULL DEFAULT '{}',
  updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO sys_plugins_config (id) VALUES (1);

-- 14b. System Tools Config (single-row)
CREATE TABLE IF NOT EXISTS sys_tools_config (
  id                             INTEGER PRIMARY KEY CHECK (id = 1),
  allow_dangerous_tools_override INTEGER NOT NULL DEFAULT 0,
  profile                        TEXT DEFAULT 'full',
  allow                          TEXT NOT NULL DEFAULT '[]',
  also_allow                     TEXT NOT NULL DEFAULT '[]',
  deny                           TEXT NOT NULL DEFAULT '[]',
  by_provider                    TEXT NOT NULL DEFAULT '{}',
  web                            TEXT NOT NULL DEFAULT '{"search":{"enabled":false}}',
  media                          TEXT NOT NULL DEFAULT '{}',
  links                          TEXT NOT NULL DEFAULT '{}',
  message                        TEXT NOT NULL DEFAULT '{}',
  agent_to_agent                 TEXT NOT NULL DEFAULT '{}',
  sessions                       TEXT NOT NULL DEFAULT '{}',
  elevated                       TEXT NOT NULL DEFAULT '{}',
  exec                           TEXT NOT NULL DEFAULT '{"security":"full","ask":"off","backgroundMs":600000}',
  fs                             TEXT NOT NULL DEFAULT '{}',
  loop_detection                 TEXT NOT NULL DEFAULT '{}',
  subagents                      TEXT NOT NULL DEFAULT '{}',
  sandbox                        TEXT NOT NULL DEFAULT '{}',
  updated_at                     TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO sys_tools_config (id) VALUES (1);

-- Auto-update updated_at triggers
CREATE TRIGGER IF NOT EXISTS trg_tenants_updated_at AFTER UPDATE ON tenants
  FOR EACH ROW BEGIN
    UPDATE tenants SET updated_at = datetime('now') WHERE id = NEW.id;
  END;

CREATE TRIGGER IF NOT EXISTS trg_users_updated_at AFTER UPDATE ON users
  FOR EACH ROW BEGIN
    UPDATE users SET updated_at = datetime('now') WHERE id = NEW.id;
  END;

CREATE TRIGGER IF NOT EXISTS trg_api_keys_updated_at AFTER UPDATE ON tenant_api_keys
  FOR EACH ROW BEGIN
    UPDATE tenant_api_keys SET updated_at = datetime('now') WHERE id = NEW.id;
  END;

CREATE TRIGGER IF NOT EXISTS trg_tenant_models_updated_at AFTER UPDATE ON tenant_models
  FOR EACH ROW BEGIN
    UPDATE tenant_models SET updated_at = datetime('now') WHERE id = NEW.id;
  END;

CREATE TRIGGER IF NOT EXISTS trg_agents_updated_at AFTER UPDATE ON tenant_agents
  FOR EACH ROW BEGIN
    UPDATE tenant_agents SET updated_at = datetime('now') WHERE id = NEW.id;
  END;

CREATE TRIGGER IF NOT EXISTS trg_channels_updated_at AFTER UPDATE ON tenant_channels
  FOR EACH ROW BEGIN
    UPDATE tenant_channels SET updated_at = datetime('now') WHERE id = NEW.id;
  END;

CREATE TRIGGER IF NOT EXISTS trg_channel_apps_updated_at AFTER UPDATE ON tenant_channel_apps
  FOR EACH ROW BEGIN
    UPDATE tenant_channel_apps SET updated_at = datetime('now') WHERE id = NEW.id;
  END;

-- Seed: Platform admin tenant + user (password: Aa123456!, stored as bcrypt(sha256(password)))
INSERT OR IGNORE INTO tenants (id, name, plan, status, quotas)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'EnClaws Platform',
  'enterprise',
  'active',
  '{"maxUsers":-1,"maxAgents":-1,"maxChannels":-1,"maxTokensPerMonth":-1,"maxCronJobs":-1}'
);

INSERT OR IGNORE INTO users (id, tenant_id, email, password_hash, display_name, role, status)
VALUES (
  '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000001',
  'admin@enclaws.local',
  '$2b$12$YAVi.E167RF.45y49zl69uRpr8NRQQQQdMEZcP.PEERR922d5tWHC',
  'Platform Admin',
  'platform-admin',
  'active'
);

-- 16. Customer Service Sessions
CREATE TABLE IF NOT EXISTS cs_sessions (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  visitor_id       TEXT NOT NULL,
  visitor_name     TEXT,
  state            TEXT NOT NULL DEFAULT 'ai_active',
  channel          TEXT NOT NULL DEFAULT 'web_widget',
  tags             TEXT NOT NULL DEFAULT '[]',
  identity_anchors TEXT NOT NULL DEFAULT '{}',
  metadata         TEXT NOT NULL DEFAULT '{}',
  assigned_to      TEXT REFERENCES users(id),
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_cs_sessions_tenant ON cs_sessions(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cs_sessions_state ON cs_sessions(tenant_id, state);

-- 17. Customer Service Messages
CREATE TABLE IF NOT EXISTS cs_messages (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES cs_sessions(id) ON DELETE CASCADE,
  tenant_id      TEXT NOT NULL,
  role           TEXT NOT NULL,
  content        TEXT NOT NULL,
  confidence     TEXT,
  feedback_type  TEXT,
  source_chunks  TEXT,
  turn_id        TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cs_messages_session ON cs_messages(session_id, created_at);

CREATE TRIGGER IF NOT EXISTS trg_cs_sessions_updated_at AFTER UPDATE ON cs_sessions
  FOR EACH ROW BEGIN
    UPDATE cs_sessions SET updated_at = datetime('now') WHERE id = NEW.id;
  END;

-- 18. CS API Objects (upper-app credentials, Agenora S2)
CREATE TABLE IF NOT EXISTS cs_api_objects (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  agent_id TEXT NOT NULL,
  app_id TEXT NOT NULL UNIQUE,
  app_secret_hash TEXT NOT NULL,
  rotating_from_hash TEXT,
  rotating_until TEXT,
  endpoint_url TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS cs_api_objects_tenant_idx ON cs_api_objects(tenant_id);
CREATE INDEX IF NOT EXISTS cs_api_objects_app_id_idx ON cs_api_objects(app_id);
`;
