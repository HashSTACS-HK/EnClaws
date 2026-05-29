/**
 * Tenant CRUD operations.
 */

import { query, getDbType, DB_SQLITE } from "../index.js";
import * as sqliteTenant from "../sqlite/models/tenant.js";
import type {
  Tenant,
  CreateTenantInput,
  TenantPlan,
  TenantQuotas,
  TenantSettings,
  TenantStatus,
} from "../types.js";

function rowToTenant(row: Record<string, unknown>): Tenant {
  return {
    id: row.id as string,
    name: row.name as string,
    plan: row.plan as TenantPlan,
    status: row.status as TenantStatus,
    settings: (row.settings ?? {}) as TenantSettings,
    quotas: (row.quotas ?? {}) as TenantQuotas,
    traceEnabled: (row.trace_enabled as boolean) ?? false,
    identityPrompt: (row.identity_prompt as string) ?? "",
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

/**
 * Hard-coded fallback used only when the `plans` table is unavailable
 * (e.g. plans table not seeded yet, or DB connection issue during boot).
 * Real defaults live in the `plans` table — see migration 009_plans.sql.
 */
const FALLBACK_FREE_QUOTAS: TenantQuotas = {
  maxUsers: 10,
  maxAgents: 5,
  maxChannels: 5,
  maxTokensPerMonth: 20_000_000,
  maxCronJobs: 5,
};

/**
 * Look up the quotas for a given plan id from the `plans` table.
 * Returns FALLBACK_FREE_QUOTAS if the plan id is unknown or the table
 * cannot be queried (best-effort, never throws).
 */
/**
 * Merge a tenant's stored quotas with plan defaults for any missing fields.
 * Ensures pre-existing tenants (whose quotas JSON predates a new quota
 * field like `maxCronJobs`) render sensible values instead of undefined/0.
 */
export async function resolveEffectiveQuotas(tenant: Tenant): Promise<TenantQuotas> {
  const planDefaults = await getPlanQuotas(tenant.plan);
  const stored: Record<string, number> = {};
  for (const [k, v] of Object.entries(tenant.quotas ?? {})) {
    if (typeof v === "number" && !Number.isNaN(v)) {
      stored[k] = v;
    }
  }
  return { ...planDefaults, ...stored } as TenantQuotas;
}

export async function getPlanQuotas(planId: string): Promise<TenantQuotas> {
  if (getDbType() === DB_SQLITE) {
    return sqliteTenant.getPlanQuotas(planId);
  }
  try {
    const result = await query(
      `SELECT max_users, max_agents, max_channels, max_tokens_per_month, max_cron_jobs
       FROM plans WHERE id = $1`,
      [planId],
    );
    const row = result.rows[0];
    if (!row) {
      return FALLBACK_FREE_QUOTAS;
    }
    return {
      maxUsers: parseInt(row.max_users as string, 10),
      maxAgents: parseInt(row.max_agents as string, 10),
      maxChannels: parseInt(row.max_channels as string, 10),
      maxTokensPerMonth: parseInt(row.max_tokens_per_month as string, 10),
      maxCronJobs: parseInt(row.max_cron_jobs as string, 10),
    };
  } catch (err) {
    console.warn(`[tenant] getPlanQuotas(${planId}) failed, using fallback: ${String(err)}`);
    return FALLBACK_FREE_QUOTAS;
  }
}

export async function createTenant(input: CreateTenantInput): Promise<Tenant> {
  if (getDbType() === DB_SQLITE) {
    return sqliteTenant.createTenant(input);
  }
  // Quotas come from the plans table snapshot for this plan, with optional
  // per-tenant overrides supplied by the caller (e.g. platform admin granting
  // a custom quota beyond the plan's defaults).
  const planQuotas = await getPlanQuotas(input.plan ?? "free");
  const quotas = { ...planQuotas, ...input.quotas };
  const result = await query(
    `INSERT INTO tenants (name, plan, settings, quotas)
     VALUES ($1, $2, $3::jsonb, $4::jsonb)
     RETURNING *`,
    [
      input.name,
      input.plan ?? "free",
      JSON.stringify(input.settings ?? {}),
      JSON.stringify(quotas),
    ],
  );
  return rowToTenant(result.rows[0]);
}

export async function getTenantById(id: string): Promise<Tenant | null> {
  if (getDbType() === DB_SQLITE) {
    return sqliteTenant.getTenantById(id);
  }
  const result = await query("SELECT * FROM tenants WHERE id = $1", [id]);
  return result.rows.length > 0 ? rowToTenant(result.rows[0]) : null;
}

export async function listTenants(opts?: {
  status?: TenantStatus;
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<{ tenants: Tenant[]; total: number }> {
  if (getDbType() === DB_SQLITE) {
    return sqliteTenant.listTenants(opts);
  }
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (opts?.status) {
    conditions.push(`status = $${idx++}`);
    values.push(opts.status);
  }
  if (opts?.search) {
    conditions.push(`name ILIKE $${idx++}`);
    values.push(`%${opts.search}%`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts?.limit ?? 50;
  const offset = opts?.offset ?? 0;

  const [dataResult, countResult] = await Promise.all([
    query(
      `SELECT * FROM tenants ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      [...values, limit, offset],
    ),
    query(`SELECT COUNT(*) as count FROM tenants ${where}`, values),
  ]);

  return {
    tenants: dataResult.rows.map(rowToTenant),
    total: parseInt(countResult.rows[0].count as string, 10),
  };
}

export async function updateTenant(
  id: string,
  updates: Partial<
    Pick<
      Tenant,
      "name" | "plan" | "status" | "settings" | "quotas" | "traceEnabled" | "identityPrompt"
    >
  >,
): Promise<Tenant | null> {
  if (getDbType() === DB_SQLITE) {
    return sqliteTenant.updateTenant(id, updates);
  }
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (updates.name !== undefined) {
    sets.push(`name = $${idx++}`);
    values.push(updates.name);
  }
  if (updates.plan !== undefined) {
    sets.push(`plan = $${idx++}`);
    values.push(updates.plan);
  }
  if (updates.status !== undefined) {
    sets.push(`status = $${idx++}`);
    values.push(updates.status);
  }
  if (updates.settings !== undefined) {
    sets.push(`settings = $${idx++}::jsonb`);
    values.push(JSON.stringify(updates.settings));
  }
  if (updates.quotas !== undefined) {
    sets.push(`quotas = $${idx++}::jsonb`);
    values.push(JSON.stringify(updates.quotas));
  }
  if (updates.traceEnabled !== undefined) {
    sets.push(`trace_enabled = $${idx++}`);
    values.push(updates.traceEnabled);
  }
  if (updates.identityPrompt !== undefined) {
    sets.push(`identity_prompt = $${idx++}`);
    values.push(updates.identityPrompt);
  }

  if (sets.length === 0) {
    return getTenantById(id);
  }

  values.push(id);
  const result = await query(
    `UPDATE tenants SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
    values,
  );
  return result.rows.length > 0 ? rowToTenant(result.rows[0]) : null;
}

export async function deleteTenant(id: string): Promise<boolean> {
  if (getDbType() === DB_SQLITE) {
    return sqliteTenant.deleteTenant(id);
  }
  const result = await query(
    "UPDATE tenants SET status = 'deleted' WHERE id = $1 AND status != 'deleted'",
    [id],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Check if a tenant has exceeded a quota.
 */
export async function checkTenantQuota(
  tenantId: string,
  resource: "users" | "agents" | "channels",
): Promise<{ allowed: boolean; current: number; max: number }> {
  if (getDbType() === DB_SQLITE) {
    return sqliteTenant.checkTenantQuota(tenantId, resource);
  }
  const tenant = await getTenantById(tenantId);
  if (!tenant) {
    return { allowed: false, current: 0, max: 0 };
  }

  const tableMap = {
    users: "users",
    agents: "tenant_agents",
    channels: "tenant_channels",
  };
  const quotaKeyMap = {
    users: "maxUsers",
    agents: "maxAgents",
    channels: "maxChannels",
  } as const;

  const countResult = await query(
    `SELECT COUNT(*) as count FROM ${tableMap[resource]} WHERE tenant_id = $1`,
    [tenantId],
  );
  const current = parseInt(countResult.rows[0].count as string, 10);
  const max = tenant.quotas[quotaKeyMap[resource]];

  // -1 means unlimited (enterprise plan).
  if (max < 0) {
    return { allowed: true, current, max };
  }
  return { allowed: current < max, current, max };
}

export async function getMonthlyTokenUsage(tenantId: string): Promise<number> {
  if (getDbType() === DB_SQLITE) {
    return sqliteTenant.getMonthlyTokenUsage(tenantId);
  }
  const result = await query(
    `SELECT COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS total
     FROM usage_records
     WHERE tenant_id = $1
       AND recorded_at >= date_trunc('month', now())`,
    [tenantId],
  );
  return parseInt(result.rows[0].total as string, 10) || 0;
}
