-- ============================================================
-- 002: cs_api_objects — upper-app API credentials (Agenora S2 jiumi)
-- ============================================================

CREATE TABLE IF NOT EXISTS cs_api_objects (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT,
  agent_id        TEXT NOT NULL,
  app_id          TEXT NOT NULL UNIQUE,
  app_secret_hash TEXT NOT NULL,
  rotating_from_hash    TEXT,
  rotating_until        TIMESTAMPTZ,
  endpoint_url    TEXT NOT NULL,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  last_used_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS cs_api_objects_tenant_idx ON cs_api_objects(tenant_id);
CREATE INDEX IF NOT EXISTS cs_api_objects_app_id_idx  ON cs_api_objects(app_id);

ALTER TABLE cs_messages
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'agenora-ai'
  CHECK (source IN ('agenora-ai','upper-app-relay'));
