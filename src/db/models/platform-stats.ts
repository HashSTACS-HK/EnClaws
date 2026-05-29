/**
 * Platform-level statistics — cross-tenant aggregation queries.
 */

import { query, getDbType, DB_SQLITE } from "../index.js";
import * as sqliteStats from "../sqlite/models/platform-stats.js";

/** Fixed UUID of the seeded platform tenant (see 001_init.sql). */
const PLATFORM_TENANT_ID = "00000000-0000-0000-0000-000000000001";

function periodCondition(column: string, period: "all" | "month" | "today"): string {
  if (period === "month") {
    return `${column} >= DATE_TRUNC('month', NOW())`;
  }
  if (period === "today") {
    return `${column} >= DATE_TRUNC('day', NOW())`;
  }
  return "1=1";
}

export async function getPlatformSummary() {
  if (getDbType() === DB_SQLITE) {
    return sqliteStats.getPlatformSummary();
  }

  const [tenantTotal, tenantActive, curMonth, lastMonth, agentTotal, agentEnabled, agentActive] =
    await Promise.all([
      query(
        `SELECT COUNT(*) as c FROM tenants WHERE status != 'deleted' AND id != '${PLATFORM_TENANT_ID}'`,
      ),
      query(
        "SELECT COUNT(DISTINCT tenant_id) as c FROM llm_interaction_traces WHERE created_at >= NOW() - INTERVAL '30 days'",
      ),
      query(
        "SELECT COALESCE(SUM(input_tokens + output_tokens), 0) as c FROM usage_records WHERE recorded_at >= DATE_TRUNC('month', NOW())",
      ),
      query(
        "SELECT COALESCE(SUM(input_tokens + output_tokens), 0) as c FROM usage_records WHERE recorded_at >= DATE_TRUNC('month', NOW()) - INTERVAL '1 month' AND recorded_at < DATE_TRUNC('month', NOW())",
      ),
      query("SELECT COUNT(*) as c FROM tenant_agents"),
      query("SELECT COUNT(*) as c FROM tenant_agents WHERE is_active = true"),
      query(
        "SELECT COUNT(DISTINCT agent_id) as c FROM llm_interaction_traces WHERE created_at >= NOW() - INTERVAL '30 days'",
      ),
    ]);

  return {
    tenants: {
      total: parseInt(String(tenantTotal.rows[0].c), 10),
      active30d: parseInt(String(tenantActive.rows[0].c), 10),
    },
    monthTokens: {
      current: parseInt(String(curMonth.rows[0].c), 10),
      lastMonth: parseInt(String(lastMonth.rows[0].c), 10),
    },
    agents: {
      total: parseInt(String(agentTotal.rows[0].c), 10),
      enabled: parseInt(String(agentEnabled.rows[0].c), 10),
      active30d: parseInt(String(agentActive.rows[0].c), 10),
    },
  };
}

export async function getTokenTrend(days = 30) {
  if (getDbType() === DB_SQLITE) {
    return sqliteStats.getTokenTrend(days);
  }

  const result = await query(
    `SELECT DATE(recorded_at) AS day,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens
     FROM usage_records
     WHERE recorded_at >= NOW() - $1::INTERVAL
     GROUP BY DATE(recorded_at)
     ORDER BY day ASC`,
    [`${days} days`],
  );
  return result.rows.map((r) => {
    const d = new Date(r.day as string);
    return {
      date: `${d.getMonth() + 1}/${d.getDate()}`,
      inputTokens: parseInt(String(r.input_tokens), 10),
      outputTokens: parseInt(String(r.output_tokens), 10),
    };
  });
}

export async function getTokenRank(period: "all" | "month" | "today" = "all", limit = 5) {
  if (getDbType() === DB_SQLITE) {
    return sqliteStats.getTokenRank(period, limit);
  }

  const cond = periodCondition("u.recorded_at", period);
  const condNoAlias = periodCondition("recorded_at", period);

  const [tenantsRes, usersRes, modelsRes, agentsRes] = await Promise.all([
    query(
      `SELECT t.name, t.plan, SUM(u.input_tokens + u.output_tokens) AS tokens
       FROM usage_records u JOIN tenants t ON u.tenant_id = t.id
       WHERE ${cond} AND t.id != '${PLATFORM_TENANT_ID}'
       GROUP BY u.tenant_id, t.name, t.plan ORDER BY tokens DESC LIMIT $1`,
      [limit],
    ),
    query(
      `SELECT COALESCE(us.display_name, us.email, u.user_id) AS name, t.name AS tenant_name, SUM(u.input_tokens + u.output_tokens) AS tokens
       FROM usage_records u
       LEFT JOIN users us ON us.tenant_id = u.tenant_id AND (u.user_id = us.id::text OR u.user_id = us.union_id)
       JOIN tenants t ON u.tenant_id = t.id
       WHERE ${cond} AND t.id != '${PLATFORM_TENANT_ID}' AND u.user_id IS NOT NULL
       GROUP BY u.tenant_id, u.user_id, us.display_name, us.email, t.name ORDER BY tokens DESC LIMIT $1`,
      [limit],
    ),
    query(
      `SELECT model, SUM(input_tokens + output_tokens) AS tokens
       FROM usage_records
       WHERE ${condNoAlias} AND model IS NOT NULL
       GROUP BY model ORDER BY tokens DESC LIMIT $1`,
      [limit],
    ),
    query(
      `SELECT u.agent_id AS name, t.name AS tenant_name, SUM(u.input_tokens + u.output_tokens) AS tokens
       FROM usage_records u JOIN tenants t ON u.tenant_id = t.id
       WHERE ${cond} AND u.agent_id IS NOT NULL AND t.id != '${PLATFORM_TENANT_ID}'
       GROUP BY u.tenant_id, u.agent_id, t.name ORDER BY tokens DESC LIMIT $1`,
      [limit],
    ),
  ]);

  const modelTotal = modelsRes.rows.reduce((s, r) => s + parseInt(String(r.tokens), 10), 0);

  return {
    tenants: tenantsRes.rows.map((r) => ({
      name: r.name as string,
      plan: r.plan as string,
      tokens: parseInt(String(r.tokens), 10),
    })),
    users: usersRes.rows.map((r) => ({
      name: r.name as string,
      tenantName: r.tenant_name as string,
      tokens: parseInt(String(r.tokens), 10),
    })),
    models: modelsRes.rows.map((r) => {
      const tokens = parseInt(String(r.tokens), 10);
      return {
        model: r.model as string,
        tokens,
        percent: modelTotal > 0 ? Math.round((tokens / modelTotal) * 1000) / 10 : 0,
      };
    }),
    agents: agentsRes.rows.map((r) => ({
      name: r.name as string,
      tenantName: r.tenant_name as string,
      tokens: parseInt(String(r.tokens), 10),
    })),
  };
}

export async function getLlmStats(period: "all" | "month" | "today" = "all") {
  if (getDbType() === DB_SQLITE) {
    return sqliteStats.getLlmStats(period);
  }

  const cond = periodCondition("created_at", period);

  const [turnsRes, avgRes, errorRes, modelRes] = await Promise.all([
    query(`SELECT COUNT(DISTINCT turn_id) as c FROM llm_interaction_traces WHERE ${cond}`),
    query(
      `SELECT AVG(duration_ms) as avg_ms FROM llm_interaction_traces WHERE duration_ms IS NOT NULL AND ${cond}`,
    ),
    query(
      `SELECT COUNT(CASE WHEN error_message IS NOT NULL OR stop_reason = 'error' THEN 1 END) as err, COUNT(*) as total FROM llm_interaction_traces WHERE ${cond}`,
    ),
    query(
      `SELECT model, COUNT(*) as count FROM llm_interaction_traces WHERE model IS NOT NULL AND ${cond} GROUP BY model ORDER BY count DESC`,
    ),
  ]);

  const turns = parseInt(String(turnsRes.rows[0].c), 10);
  const avgDurationMs = Math.round(parseFloat(String(avgRes.rows[0].avg_ms)) || 0);
  const errCount = parseInt(String(errorRes.rows[0].err), 10);
  const totalCount = parseInt(String(errorRes.rows[0].total), 10);
  const errorRate = totalCount > 0 ? Math.round((errCount / totalCount) * 1000) / 10 : 0;

  const modelTotalCount = modelRes.rows.reduce((s, r) => s + parseInt(String(r.count), 10), 0);
  const modelDistribution = modelRes.rows.map((r) => {
    const count = parseInt(String(r.count), 10);
    return {
      model: r.model as string,
      count,
      percent: modelTotalCount > 0 ? Math.round((count / modelTotalCount) * 100) : 0,
    };
  });

  return { turns, avgDurationMs, errorRate, modelDistribution };
}

export async function getChannelDistribution() {
  if (getDbType() === DB_SQLITE) {
    return sqliteStats.getChannelDistribution();
  }

  const result = await query(
    `SELECT tc.channel_type AS type, COUNT(ca.id) AS count
     FROM tenant_channels tc LEFT JOIN tenant_channel_apps ca ON ca.channel_id = tc.id
     WHERE tc.is_active = true
     GROUP BY tc.channel_type ORDER BY count DESC`,
  );
  return result.rows.map((r) => ({ type: r.type as string, count: parseInt(String(r.count), 10) }));
}

export async function getUserActivity() {
  if (getDbType() === DB_SQLITE) {
    return sqliteStats.getUserActivity();
  }

  const [totalRes, activeRes, todayRes, weekRes] = await Promise.all([
    query(
      `SELECT COUNT(*) as c FROM (SELECT DISTINCT u.tenant_id, COALESCE(u.union_id, u.id::text) FROM users u JOIN tenants t ON u.tenant_id = t.id WHERE u.status = 'active' AND t.id != '${PLATFORM_TENANT_ID}') sub`,
    ),
    query(
      `SELECT COUNT(DISTINCT t.user_id) as c FROM llm_interaction_traces t JOIN tenants tn ON t.tenant_id = tn.id WHERE t.created_at >= NOW() - INTERVAL '30 days' AND tn.id != '${PLATFORM_TENANT_ID}'`,
    ),
    query(
      `SELECT COUNT(*) as c FROM (SELECT DISTINCT u.tenant_id, COALESCE(u.union_id, u.id::text) FROM users u JOIN tenants t ON u.tenant_id = t.id WHERE u.status = 'active' AND t.id != '${PLATFORM_TENANT_ID}' AND u.created_at >= DATE_TRUNC('day', NOW())) sub`,
    ),
    query(
      `SELECT COUNT(*) as c FROM (SELECT DISTINCT u.tenant_id, COALESCE(u.union_id, u.id::text) FROM users u JOIN tenants t ON u.tenant_id = t.id WHERE u.status = 'active' AND t.id != '${PLATFORM_TENANT_ID}' AND u.created_at >= NOW() - INTERVAL '7 days') sub`,
    ),
  ]);

  return {
    total: parseInt(String(totalRes.rows[0].c), 10),
    active30d: parseInt(String(activeRes.rows[0].c), 10),
    newToday: parseInt(String(todayRes.rows[0].c), 10),
    newThisWeek: parseInt(String(weekRes.rows[0].c), 10),
  };
}
