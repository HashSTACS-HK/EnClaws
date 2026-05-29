/**
 * Usage tracking - records token consumption per tenant/user/agent.
 */

import { query, getDbType, DB_SQLITE } from "../index.js";
import * as sqliteUsage from "../sqlite/models/usage.js";
import type { UsageRecord } from "../types.js";

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
  if (getDbType() === DB_SQLITE) {
    return sqliteUsage.recordUsage(params);
  }
  try {
    await query(
      `INSERT INTO usage_records
       (tenant_id, user_id, agent_id, provider, model, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, session_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
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
    console.error("[usage] Failed to record usage:", err);
    throw err;
  }
}

export interface UsageSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  recordCount: number;
}

export async function getTenantUsageSummary(
  tenantId: string,
  opts?: { since?: Date; until?: Date; userId?: string; agentId?: string },
): Promise<UsageSummary> {
  if (getDbType() === DB_SQLITE) {
    return sqliteUsage.getTenantUsageSummary(tenantId, opts);
  }
  const conditions = ["tenant_id = $1"];
  const values: unknown[] = [tenantId];
  let idx = 2;

  if (opts?.since) {
    conditions.push(`recorded_at >= $${idx++}`);
    values.push(opts.since);
  }
  if (opts?.until) {
    conditions.push(`recorded_at < $${idx++}`);
    values.push(opts.until);
  }
  if (opts?.userId) {
    conditions.push(`user_id = $${idx++}`);
    values.push(opts.userId);
  }
  if (opts?.agentId) {
    conditions.push(`agent_id = $${idx++}`);
    values.push(opts.agentId);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const result = await query(
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
    totalInputTokens: parseInt(row.total_input_tokens as string, 10),
    totalOutputTokens: parseInt(row.total_output_tokens as string, 10),
    totalCacheReadTokens: parseInt(row.total_cache_read_tokens as string, 10),
    totalCacheWriteTokens: parseInt(row.total_cache_write_tokens as string, 10),
    recordCount: parseInt(row.record_count as string, 10),
  };
}

/**
 * Check if a tenant has exceeded their monthly token quota.
 */
export async function checkTokenQuota(
  tenantId: string,
  maxTokensPerMonth: number,
): Promise<{ allowed: boolean; used: number; max: number }> {
  if (getDbType() === DB_SQLITE) {
    return sqliteUsage.checkTokenQuota(tenantId, maxTokensPerMonth);
  }
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
