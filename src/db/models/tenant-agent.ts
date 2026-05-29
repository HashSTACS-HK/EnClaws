/**
 * Tenant Agent CRUD - stores agent configurations per tenant in PostgreSQL.
 */

import { DEFAULT_DISABLED_BUNDLED_SKILLS } from "../../agents/skills/defaults.js";
import { query, getDbType, DB_SQLITE } from "../index.js";
import * as sqliteAgent from "../sqlite/models/tenant-agent.js";
import type { TenantAgent, ModelConfigEntry } from "../types.js";

function rowToAgent(row: Record<string, unknown>): TenantAgent {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    agentId: row.agent_id as string,
    name: (row.name as string) ?? null,
    config: (row.config ?? {}) as Record<string, unknown>,
    modelConfig: (row.model_config ?? []) as ModelConfigEntry[],
    tools: (row.tools ?? { deny: [] }) as { deny: string[] },
    skills: (Array.isArray(row.skills) ? row.skills : null) as string[] | null,
    isActive: row.is_active as boolean,
    createdBy: (row.created_by as string) ?? null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

export async function createTenantAgent(params: {
  tenantId: string;
  agentId: string;
  name?: string;
  config?: Record<string, unknown>;
  modelConfig?: ModelConfigEntry[];
  tools?: { deny: string[] };
  skills?: string[];
  createdBy?: string;
}): Promise<TenantAgent> {
  if (getDbType() === DB_SQLITE) {
    return sqliteAgent.createTenantAgent(params);
  }
  const result = await query(
    `INSERT INTO tenant_agents (tenant_id, agent_id, name, config, model_config, tools, skills, created_by)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8)
     RETURNING *`,
    [
      params.tenantId,
      params.agentId,
      params.name,
      JSON.stringify(params.config ?? {}),
      JSON.stringify(params.modelConfig ?? []),
      JSON.stringify(params.tools ?? { deny: [] }),
      JSON.stringify(params.skills ?? DEFAULT_DISABLED_BUNDLED_SKILLS),
      params.createdBy ?? null,
    ],
  );
  return rowToAgent(result.rows[0]);
}

export async function getTenantAgent(
  tenantId: string,
  agentId: string,
): Promise<TenantAgent | null> {
  if (getDbType() === DB_SQLITE) {
    return sqliteAgent.getTenantAgent(tenantId, agentId);
  }
  const result = await query("SELECT * FROM tenant_agents WHERE tenant_id = $1 AND agent_id = $2", [
    tenantId,
    agentId,
  ]);
  return result.rows.length > 0 ? rowToAgent(result.rows[0]) : null;
}

export async function listTenantAgents(
  tenantId: string,
  opts?: { activeOnly?: boolean; createdBy?: string },
): Promise<TenantAgent[]> {
  if (getDbType() === DB_SQLITE) {
    return sqliteAgent.listTenantAgents(tenantId, opts);
  }
  const conditions = ["tenant_id = $1"];
  const values: unknown[] = [tenantId];

  if (opts?.activeOnly !== false) {
    conditions.push("is_active = true");
  }

  if (opts?.createdBy) {
    values.push(opts.createdBy);
    conditions.push(`created_by = $${values.length}`);
  }

  const result = await query(
    `SELECT * FROM tenant_agents WHERE ${conditions.join(" AND ")} ORDER BY created_at ASC`,
    values,
  );
  return result.rows.map(rowToAgent);
}

export async function updateTenantAgent(
  tenantId: string,
  agentId: string,
  updates: Partial<
    Pick<TenantAgent, "name" | "config" | "modelConfig" | "tools" | "skills" | "isActive">
  >,
): Promise<TenantAgent | null> {
  if (getDbType() === DB_SQLITE) {
    return sqliteAgent.updateTenantAgent(tenantId, agentId, updates);
  }
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (updates.name !== undefined) {
    sets.push(`name = $${idx++}`);
    values.push(updates.name);
  }
  if (updates.config !== undefined) {
    sets.push(`config = $${idx++}::jsonb`);
    values.push(JSON.stringify(updates.config));
  }
  if (updates.modelConfig !== undefined) {
    sets.push(`model_config = $${idx++}::jsonb`);
    values.push(JSON.stringify(updates.modelConfig));
  }
  if (updates.tools !== undefined) {
    sets.push(`tools = $${idx++}::jsonb`);
    values.push(JSON.stringify(updates.tools));
  }
  if (updates.skills !== undefined) {
    sets.push(`skills = $${idx++}::jsonb`);
    values.push(JSON.stringify(updates.skills));
  }
  if (updates.isActive !== undefined) {
    sets.push(`is_active = $${idx++}`);
    values.push(updates.isActive);
  }

  if (sets.length === 0) {
    return getTenantAgent(tenantId, agentId);
  }

  values.push(tenantId, agentId);
  const result = await query(
    `UPDATE tenant_agents SET ${sets.join(", ")} WHERE tenant_id = $${idx++} AND agent_id = $${idx}
     RETURNING *`,
    values,
  );
  return result.rows.length > 0 ? rowToAgent(result.rows[0]) : null;
}

export async function deleteTenantAgent(tenantId: string, agentId: string): Promise<boolean> {
  if (getDbType() === DB_SQLITE) {
    return sqliteAgent.deleteTenantAgent(tenantId, agentId);
  }
  const result = await query("DELETE FROM tenant_agents WHERE tenant_id = $1 AND agent_id = $2", [
    tenantId,
    agentId,
  ]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Build a stable, unique provider key for a tenant_models record.
 * Uses "tm-{id}" to guarantee no collisions with built-in or other providers.
 */
export function buildTenantModelProviderKey(tm: import("../types.js").TenantModel): string {
  return `tm-${tm.id}`;
}

/**
 * Convert tenant agents to the EnClawsConfig agents.list format.
 *
 * model_config → model.primary + model.fallbacks:
 *   - isDefault=true entry → model.primary ("tm-{providerId}/{modelId}")
 *   - isDefault=false entries in array order → model.fallbacks
 *
 * If model_config is empty, the agent is output without a model field
 * (will use the global default model).
 *
 * @param agents - tenant agent records
 * @param tenantModelsMap - map of tenant_models.id → TenantModel (used to validate entries exist)
 */
export function toConfigAgentsList(
  agents: TenantAgent[],
  tenantModelsMap?: Map<string, import("../types.js").TenantModel>,
): Array<Record<string, unknown>> {
  return agents.map((a) => {
    const modelConfig = a.modelConfig ?? [];

    const defaultEntry = modelConfig.find((e) => e.isDefault);
    const fallbackEntries = modelConfig.filter((e) => !e.isDefault);

    const toModelRef = (entry: import("../types.js").ModelConfigEntry): string =>
      `tm-${entry.providerId}/${entry.modelId}`;

    const primary = defaultEntry ? toModelRef(defaultEntry) : undefined;
    const fallbacks = fallbackEntries.map(toModelRef);

    const modelField = primary
      ? fallbacks.length > 0
        ? { primary, fallbacks }
        : primary // single model — use plain string form
      : undefined;

    const toolsDeny = a.tools?.deny ?? [];

    // NOTE: `a.skills` is a denylist of bundled skills in multi-tenant mode.
    // It is consumed via getTenantAgent → disabledBundledSkills in get-reply.ts.
    // Do NOT copy it into cfg.agents.list[*].skills, which carries the legacy
    // file-config allowlist semantic — doing so would make resolveAgentSkillsFilter
    // misread the denylist as an allowlist and filter every non-listed skill out.
    return {
      id: a.agentId,
      name: a.name,
      ...a.config,
      ...(modelField !== undefined ? { model: modelField } : {}),
      ...(toolsDeny.length > 0
        ? { tools: { ...((a.config?.tools as Record<string, unknown>) ?? {}), deny: toolsDeny } }
        : {}),
    };
  });
}
