-- ============================================================
-- 004: cs_messages — add turn_id linking AI messages to LLM
--      interaction traces (llm_interaction_traces.turn_id).
--
-- Nullable: customer/human messages and legacy rows have no trace.
-- 添加 turn_id 列，关联 LLM 推理轨迹；客户/人工/历史消息为 NULL。
-- ============================================================

ALTER TABLE cs_messages
  ADD COLUMN IF NOT EXISTS turn_id TEXT;
