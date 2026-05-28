/**
 * Platform-level statistics — SQLite implementation.
 * Cross-tenant aggregation queries for the platform overview dashboard.
 */

import { sqliteQuery } from "../index.js";

/** Fixed UUID of the seeded platform tenant (see schema-sql.ts). */
const PLATFORM_TENANT_ID = "00000000-0000-0000-0000-000000000001";

// Time filter helper
function periodCondition(column: string, period: "all" | "month" | "today"): string {
  if (period === "month") {return `${column} >= DATE('now', 'start of month')`;}
  if (period === "today") {return `${column} >= DATE('now')`;}
  return "1=1"; // all
}

export function getPlatformSummary() {
  // tenants
  const tenantTotal = Number(sqliteQuery(`SELECT COUNT(*) as c FROM tenants WHERE status != 'deleted' AND id != '${PLATFORM_TENANT_ID}'`).rows[0].c);
  const tenantActive = Number(sqliteQuery("SELECT COUNT(DISTINCT tenant_id) as c FROM llm_interaction_traces WHERE created_at >= DATE('now', '-30 days')").rows[0].c);

  // month tokens
  const currentMonth = Number(sqliteQuery("SELECT COALESCE(SUM(input_tokens + output_tokens), 0) as c FROM usage_records WHERE recorded_at >= DATE('now', 'start of month')").rows[0].c);
  const lastMonth = Number(sqliteQuery("SELECT COALESCE(SUM(input_tokens + output_tokens), 0) as c FROM usage_records WHERE recorded_at >= DATE('now', 'start of month', '-1 month') AND recorded_at < DATE('now', 'start of month')").rows[0].c);

  // agents
  const agentTotal = Number(sqliteQuery("SELECT COUNT(*) as c FROM tenant_agents").rows[0].c);
  const agentEnabled = Number(sqliteQuery("SELECT COUNT(*) as c FROM tenant_agents WHERE is_active = 1").rows[0].c);
  const agentActive = Number(sqliteQuery("SELECT COUNT(DISTINCT agent_id) as c FROM llm_interaction_traces WHERE created_at >= DATE('now', '-30 days')").rows[0].c);

  return {
    tenants: { total: tenantTotal, active30d: tenantActive },
    monthTokens: { current: currentMonth, lastMonth },
    agents: { total: agentTotal, enabled: agentEnabled, active30d: agentActive },
  };
}

export function getTokenTrend(days: number) {
  const result = sqliteQuery(
    `SELECT DATE(recorded_at) AS day,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens
     FROM usage_records
     WHERE recorded_at >= DATE('now', ?)
     GROUP BY DATE(recorded_at)
     ORDER BY day ASC`,
    [`-${days} days`],
  );
  return result.rows.map((r: any) => {
    const d = new Date(r.day as string);
    return {
      date: `${d.getMonth() + 1}/${d.getDate()}`,
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
    };
  });
}

export function getTokenRank(period: "all" | "month" | "today", limit: number) {
  const cond = periodCondition("u.recorded_at", period);

  // Tenant rank
  const tenants = sqliteQuery(
    `SELECT t.name, t.plan, SUM(u.input_tokens + u.output_tokens) AS tokens
     FROM usage_records u JOIN tenants t ON u.tenant_id = t.id
     WHERE ${cond} AND t.id != '${PLATFORM_TENANT_ID}'
     GROUP BY u.tenant_id ORDER BY tokens DESC LIMIT ?`,
    [limit],
  ).rows.map((r: any) => ({ name: r.name as string, plan: r.plan as string, tokens: Number(r.tokens) }));

  // User rank
  const users = sqliteQuery(
    `SELECT COALESCE(us.display_name, us.email, u.user_id) AS name, t.name AS tenant_name, SUM(u.input_tokens + u.output_tokens) AS tokens
     FROM usage_records u
     LEFT JOIN users us ON us.tenant_id = u.tenant_id AND (u.user_id = us.id OR u.user_id = us.union_id)
     JOIN tenants t ON u.tenant_id = t.id
     WHERE ${cond} AND t.id != '${PLATFORM_TENANT_ID}' AND u.user_id IS NOT NULL
     GROUP BY u.tenant_id, u.user_id ORDER BY tokens DESC LIMIT ?`,
    [limit],
  ).rows.map((r: any) => ({ name: (r.name as string) || "-", tenantName: (r.tenant_name as string) || "-", tokens: Number(r.tokens) }));

  // Model rank
  const modelRows = sqliteQuery(
    `SELECT model, SUM(input_tokens + output_tokens) AS tokens
     FROM usage_records
     WHERE ${cond.replace('u.recorded_at', 'recorded_at')} AND model IS NOT NULL
     GROUP BY model ORDER BY tokens DESC LIMIT ?`,
    [limit],
  ).rows;
  const modelTotal = modelRows.reduce((s: number, r: any) => s + Number(r.tokens), 0);
  const models = modelRows.map((r: any) => ({
    model: r.model as string,
    tokens: Number(r.tokens),
    percent: modelTotal > 0 ? Math.round(Number(r.tokens) / modelTotal * 1000) / 10 : 0,
  }));

  // Agent rank
  const agents = sqliteQuery(
    `SELECT u.agent_id AS name, t.name AS tenant_name, SUM(u.input_tokens + u.output_tokens) AS tokens
     FROM usage_records u
     JOIN tenants t ON u.tenant_id = t.id
     WHERE ${cond} AND u.agent_id IS NOT NULL AND t.id != '${PLATFORM_TENANT_ID}'
     GROUP BY u.tenant_id, u.agent_id ORDER BY tokens DESC LIMIT ?`,
    [limit],
  ).rows.map((r: any) => ({ name: r.name as string, tenantName: r.tenant_name as string, tokens: Number(r.tokens) }));

  return { tenants, users, models, agents };
}

export function getLlmStats(period: "all" | "month" | "today") {
  const cond = periodCondition("created_at", period);

  const turns = Number(sqliteQuery(`SELECT COUNT(DISTINCT turn_id) as c FROM llm_interaction_traces WHERE ${cond}`).rows[0].c);

  const avgRow = sqliteQuery(`SELECT AVG(duration_ms) as avg_ms FROM llm_interaction_traces WHERE duration_ms IS NOT NULL AND ${cond}`).rows[0];
  const avgDurationMs = Math.round(Number(avgRow.avg_ms) || 0);

  const errorRow = sqliteQuery(
    `SELECT COUNT(CASE WHEN error_message IS NOT NULL OR stop_reason = 'error' THEN 1 END) as err_count, COUNT(*) as total_count FROM llm_interaction_traces WHERE ${cond}`
  ).rows[0];
  const errCount = Number(errorRow.err_count) || 0;
  const totalCount2 = Number(errorRow.total_count) || 0;
  const errorRate = totalCount2 > 0 ? Math.round(errCount / totalCount2 * 1000) / 10 : 0;

  const modelRows = sqliteQuery(
    `SELECT model, COUNT(*) as count FROM llm_interaction_traces WHERE model IS NOT NULL AND ${cond} GROUP BY model ORDER BY count DESC`
  ).rows;
  const totalCount = modelRows.reduce((s: number, r: any) => s + Number(r.count), 0);
  const modelDistribution = modelRows.map((r: any) => ({
    model: r.model as string,
    count: Number(r.count),
    percent: totalCount > 0 ? Math.round(Number(r.count) / totalCount * 100) : 0,
  }));

  return { turns, avgDurationMs, errorRate, modelDistribution };
}

export function getChannelDistribution() {
  return sqliteQuery(
    `SELECT tc.channel_type AS type, COUNT(ca.id) AS count
     FROM tenant_channels tc LEFT JOIN tenant_channel_apps ca ON ca.channel_id = tc.id
     WHERE tc.is_active = 1
     GROUP BY tc.channel_type ORDER BY count DESC`
  ).rows.map((r: any) => ({ type: r.type as string, count: Number(r.count) }));
}

export function getUserActivity() {
  const total = Number(sqliteQuery(
    `SELECT COUNT(*) as c FROM (SELECT DISTINCT u.tenant_id, COALESCE(u.union_id, u.id) as uid FROM users u JOIN tenants t ON u.tenant_id = t.id WHERE u.status = 'active' AND t.id != '${PLATFORM_TENANT_ID}')`
  ).rows[0].c);

  const active30d = Number(sqliteQuery(
    `SELECT COUNT(DISTINCT tr.user_id) as c FROM llm_interaction_traces tr JOIN tenants t ON tr.tenant_id = t.id WHERE tr.created_at >= DATE('now', '-30 days') AND t.id != '${PLATFORM_TENANT_ID}'`
  ).rows[0].c);

  const newToday = Number(sqliteQuery(
    `SELECT COUNT(*) as c FROM (SELECT DISTINCT u.tenant_id, COALESCE(u.union_id, u.id) as uid FROM users u JOIN tenants t ON u.tenant_id = t.id WHERE u.status = 'active' AND t.id != '${PLATFORM_TENANT_ID}' AND u.created_at >= DATE('now'))`
  ).rows[0].c);

  const newThisWeek = Number(sqliteQuery(
    `SELECT COUNT(*) as c FROM (SELECT DISTINCT u.tenant_id, COALESCE(u.union_id, u.id) as uid FROM users u JOIN tenants t ON u.tenant_id = t.id WHERE u.status = 'active' AND t.id != '${PLATFORM_TENANT_ID}' AND u.created_at >= DATE('now', '-7 days'))`
  ).rows[0].c);

  return { total, active30d, newToday, newThisWeek };
}
