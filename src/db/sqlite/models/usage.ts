/**
 * Usage tracking — SQLite implementation.
 */

import type { UsageRecord } from "../../types.js";
import { sqliteQuery, generateUUID } from "../index.js";

export interface UsageSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  recordCount: number;
}

export async function recordUsage(params: {
  tenantId: string;
  userId?: string;
  agentId?: string;
  provider?: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  sessionKey?: string;
}): Promise<void> {
  try {
    const id = generateUUID();
    sqliteQuery(
      `INSERT INTO usage_records
       (id, tenant_id, user_id, agent_id, provider, model, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, session_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        params.tenantId,
        params.userId ?? null,
        params.agentId ?? null,
        params.provider ?? null,
        params.model ?? null,
        params.inputTokens,
        params.outputTokens,
        params.cacheReadTokens ?? 0,
        params.cacheWriteTokens ?? 0,
        params.sessionKey ?? null,
      ],
    );
  } catch (err) {
    // errcode 787 = SQLITE_CONSTRAINT_FOREIGNKEY — tenant may have been deleted;
    // usage recording is best-effort, so demote to warn and do not re-throw.
    const isFkViolation =
      err instanceof Error && (err as unknown as Record<string, unknown>)["errcode"] === 787;
    if (isFkViolation) {
      console.warn(
        "[usage] Skipping usage record: tenant not found (tenantId=%s)",
        params.tenantId,
      );
    } else {
      console.error("[usage] Failed to record usage:", err);
      throw err;
    }
  }
}

export async function getTenantUsageSummary(
  tenantId: string,
  opts?: { since?: Date; until?: Date; userId?: string; agentId?: string },
): Promise<UsageSummary> {
  const conditions = ["tenant_id = ?"];
  const values: unknown[] = [tenantId];

  if (opts?.since) {
    conditions.push("recorded_at >= ?");
    values.push(opts.since);
  }
  if (opts?.until) {
    conditions.push("recorded_at < ?");
    values.push(opts.until);
  }
  if (opts?.userId) {
    conditions.push("user_id = ?");
    values.push(opts.userId);
  }
  if (opts?.agentId) {
    conditions.push("agent_id = ?");
    values.push(opts.agentId);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const result = sqliteQuery(
    `SELECT
       COALESCE(SUM(input_tokens), 0) as total_input_tokens,
       COALESCE(SUM(output_tokens), 0) as total_output_tokens,
       COALESCE(SUM(cache_read_tokens), 0) as total_cache_read_tokens,
       COALESCE(SUM(cache_write_tokens), 0) as total_cache_write_tokens,
       COUNT(*) as record_count
     FROM usage_records ${where}`,
    values,
  );

  const row = result.rows[0];
  return {
    totalInputTokens: Number(row.total_input_tokens),
    totalOutputTokens: Number(row.total_output_tokens),
    totalCacheReadTokens: Number(row.total_cache_read_tokens),
    totalCacheWriteTokens: Number(row.total_cache_write_tokens),
    recordCount: Number(row.record_count),
  };
}

export async function checkTokenQuota(
  tenantId: string,
  maxTokensPerMonth: number,
): Promise<{ allowed: boolean; used: number; max: number }> {
  // -1 (or any negative) means unlimited — skip the expensive aggregation.
  if (maxTokensPerMonth < 0) {
    return { allowed: true, used: 0, max: maxTokensPerMonth };
  }
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const summary = await getTenantUsageSummary(tenantId, { since: monthStart });
  const used = summary.totalInputTokens + summary.totalOutputTokens;

  return {
    allowed: used < maxTokensPerMonth,
    used,
    max: maxTokensPerMonth,
  };
}
