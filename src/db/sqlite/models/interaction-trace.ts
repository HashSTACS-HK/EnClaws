/**
 * LLM Interaction Trace CRUD — SQLite implementation.
 */

import type { LlmInteractionTrace } from "../../types.js";
import { sqliteQuery, generateUUID } from "../index.js";

function rowToTrace(row: Record<string, unknown>): LlmInteractionTrace {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    userId: (row.user_id as string) ?? null,
    sessionKey: (row.session_key as string) ?? null,
    agentId: (row.agent_id as string) ?? null,
    channel: (row.channel as string) ?? null,
    turnId: row.turn_id as string,
    turnIndex: Number(row.turn_index),
    userInput: (row.user_input as string) ?? null,
    provider: (row.provider as string) ?? null,
    model: (row.model as string) ?? null,
    systemPrompt: (row.system_prompt as string) ?? null,
    messages: (typeof row.messages === "string"
      ? JSON.parse(row.messages)
      : (row.messages ?? [])) as unknown[],
    tools: row.tools
      ? ((typeof row.tools === "string" ? JSON.parse(row.tools) : row.tools) as unknown[])
      : null,
    requestParams: row.request_params
      ? ((typeof row.request_params === "string"
          ? JSON.parse(row.request_params)
          : row.request_params) as Record<string, unknown>)
      : null,
    response: row.response
      ? typeof row.response === "string"
        ? JSON.parse(row.response)
        : row.response
      : null,
    stopReason: (row.stop_reason as string) ?? null,
    errorMessage: (row.error_message as string) ?? null,
    inputTokens: Number(row.input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    cacheReadTokens: Number(row.cache_read_tokens ?? 0),
    cacheWriteTokens: Number(row.cache_write_tokens ?? 0),
    durationMs: row.duration_ms != null ? Number(row.duration_ms) : null,
    createdAt: new Date(row.created_at as string),
  };
}

export async function createInteractionTrace(params: {
  tenantId: string;
  userId?: string;
  sessionKey?: string;
  agentId?: string;
  channel?: string;
  turnId: string;
  turnIndex: number;
  userInput?: string;
  provider?: string;
  model?: string;
  systemPrompt?: string;
  messages: unknown[];
  tools?: unknown[];
  requestParams?: Record<string, unknown>;
  response?: unknown;
  stopReason?: string;
  errorMessage?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  durationMs?: number;
}): Promise<void> {
  try {
    const id = generateUUID();
    sqliteQuery(
      `INSERT INTO llm_interaction_traces
       (id, tenant_id, user_id, session_key, agent_id, channel, turn_id, turn_index,
        user_input, provider, model, system_prompt, messages, tools,
        request_params, response, stop_reason, error_message,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, duration_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        params.tenantId,
        params.userId ?? null,
        params.sessionKey ?? null,
        params.agentId ?? null,
        params.channel ?? null,
        params.turnId,
        params.turnIndex,
        params.userInput ?? null,
        params.provider ?? null,
        params.model ?? null,
        params.systemPrompt ?? null,
        JSON.stringify(params.messages),
        params.tools ? JSON.stringify(params.tools) : null,
        params.requestParams ? JSON.stringify(params.requestParams) : null,
        params.response ? JSON.stringify(params.response) : null,
        params.stopReason ?? null,
        params.errorMessage ?? null,
        params.inputTokens ?? 0,
        params.outputTokens ?? 0,
        params.cacheReadTokens ?? 0,
        params.cacheWriteTokens ?? 0,
        params.durationMs ?? null,
      ],
    );
  } catch (err) {
    console.error("[interaction-trace] Failed to record trace:", err);
  }
}

export async function listInteractionTraces(
  tenantId: string,
  opts?: {
    sessionKey?: string;
    agentId?: string;
    userId?: string;
    since?: Date;
    until?: Date;
    limit?: number;
    offset?: number;
  },
): Promise<{ traces: LlmInteractionTrace[]; total: number }> {
  const conditions = ["tenant_id = ?"];
  const values: unknown[] = [tenantId];

  if (opts?.sessionKey) {
    conditions.push("session_key = ?");
    values.push(opts.sessionKey);
  }
  if (opts?.agentId) {
    conditions.push("agent_id = ?");
    values.push(opts.agentId);
  }
  if (opts?.userId) {
    conditions.push("user_id = ?");
    values.push(opts.userId);
  }
  if (opts?.since) {
    conditions.push("created_at >= ?");
    values.push(opts.since);
  }
  if (opts?.until) {
    conditions.push("created_at <= ?");
    values.push(opts.until);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;

  const countResult = sqliteQuery(
    `SELECT COUNT(*) as total FROM llm_interaction_traces ${where}`,
    values,
  );
  const total = Number(countResult.rows[0].total);

  const limit = Math.min(opts?.limit ?? 50, 200);
  const offset = opts?.offset ?? 0;

  const result = sqliteQuery(
    `SELECT * FROM llm_interaction_traces ${where}
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
    [...values, limit, offset],
  );

  return { traces: result.rows.map(rowToTrace), total };
}

export async function getInteractionsByTurn(turnId: string): Promise<LlmInteractionTrace[]> {
  const result = sqliteQuery(
    "SELECT * FROM llm_interaction_traces WHERE turn_id = ? ORDER BY turn_index ASC",
    [turnId],
  );
  return result.rows.map(rowToTrace);
}

export async function getInteractionTrace(id: string): Promise<LlmInteractionTrace | null> {
  const result = sqliteQuery("SELECT * FROM llm_interaction_traces WHERE id = ?", [id]);
  return result.rows.length > 0 ? rowToTrace(result.rows[0]) : null;
}

export async function getMaxTurnIndex(turnId: string): Promise<number> {
  const result = sqliteQuery(
    "SELECT MAX(turn_index) as max_index FROM llm_interaction_traces WHERE turn_id = ?",
    [turnId],
  );
  const row = result.rows[0];
  return row?.max_index != null ? Number(row.max_index) : -1;
}

export async function listInteractionTurns(
  tenantId: string,
  opts?: {
    sessionKey?: string;
    agentId?: string;
    userId?: string;
    since?: Date;
    until?: Date;
    limit?: number;
    offset?: number;
  },
): Promise<{
  turns: Array<{
    turnId: string;
    userInput: string | null;
    agentId: string | null;
    agentName: string | null;
    channel: string | null;
    userId: string | null;
    sessionKey: string | null;
    provider: string | null;
    model: string | null;
    interactionCount: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalDurationMs: number;
    createdAt: Date;
  }>;
  total: number;
}> {
  const conditions = ["tenant_id = ?"];
  const values: unknown[] = [tenantId];

  if (opts?.sessionKey) {
    conditions.push("session_key = ?");
    values.push(opts.sessionKey);
  }
  if (opts?.agentId) {
    conditions.push("agent_id = ?");
    values.push(opts.agentId);
  }
  if (opts?.userId) {
    conditions.push("user_id = ?");
    values.push(opts.userId);
  }
  if (opts?.since) {
    conditions.push("created_at >= ?");
    values.push(opts.since);
  }
  if (opts?.until) {
    conditions.push("created_at <= ?");
    values.push(opts.until);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;

  const countResult = sqliteQuery(
    `SELECT COUNT(DISTINCT turn_id) as total FROM llm_interaction_traces ${where}`,
    values,
  );
  const total = Number(countResult.rows[0].total);

  const limit = Math.min(opts?.limit ?? 50, 200);
  const offset = opts?.offset ?? 0;

  const result = sqliteQuery(
    `SELECT g.*,
            COALESCE(ta.name, g.agent_id) as agent_name
     FROM (
       SELECT
         turn_id,
         MAX(CASE WHEN turn_index = 0 THEN user_input END) as user_input,
         MAX(agent_id) as agent_id,
         MAX(channel) as channel,
         MAX(user_id) as user_id,
         MAX(session_key) as session_key,
         MAX(provider) as provider,
         MAX(model) as model,
         COUNT(*) as interaction_count,
         COALESCE(SUM(input_tokens), 0) as total_input_tokens,
         COALESCE(SUM(output_tokens), 0) as total_output_tokens,
         COALESCE(SUM(duration_ms), 0) as total_duration_ms,
         MIN(created_at) as created_at,
         MAX(tenant_id) as tenant_id
       FROM llm_interaction_traces ${where}
       GROUP BY turn_id
       ORDER BY MIN(created_at) DESC
       LIMIT ? OFFSET ?
     ) g
     LEFT JOIN tenant_agents ta ON ta.agent_id = g.agent_id AND ta.tenant_id = g.tenant_id`,
    [...values, limit, offset],
  );

  return {
    turns: result.rows.map((row) => ({
      turnId: row.turn_id as string,
      userInput: (row.user_input as string) ?? null,
      agentId: (row.agent_id as string) ?? null,
      agentName: (row.agent_name as string) ?? null,
      channel: (row.channel as string) ?? null,
      userId: (row.user_id as string) ?? null,
      sessionKey: (row.session_key as string) ?? null,
      provider: (row.provider as string) ?? null,
      model: (row.model as string) ?? null,
      interactionCount: Number(row.interaction_count),
      totalInputTokens: Number(row.total_input_tokens),
      totalOutputTokens: Number(row.total_output_tokens),
      totalDurationMs: Number(row.total_duration_ms),
      createdAt: new Date(row.created_at as string),
    })),
    total,
  };
}
