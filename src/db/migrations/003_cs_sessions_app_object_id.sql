-- ============================================================
-- 003: cs_sessions — add app_object_id for CS API session tracking
--
-- Links CS API sessions created via upper-app relay to the
-- CsApiObject that created them. Enables countActiveSessionsForApiObject.
-- ============================================================

ALTER TABLE cs_sessions
  ADD COLUMN IF NOT EXISTS app_object_id TEXT REFERENCES cs_api_objects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_cs_sessions_app_object ON cs_sessions(app_object_id)
  WHERE app_object_id IS NOT NULL;
