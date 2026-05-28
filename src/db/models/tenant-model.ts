/**
 * Tenant Model CRUD - stores LLM provider/model configurations per tenant in PostgreSQL.
 */

import { query, getDbType, DB_SQLITE } from "../index.js";
import { sqliteQuery } from "../sqlite/index.js";
import * as sqliteTenantModel from "../sqlite/models/tenant-model.js";
import type { TenantModel, TenantModelDefinition, ModelVisibility } from "../types.js";

function rowToModel(row: Record<string, unknown>): TenantModel {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    providerType: row.provider_type as string,
    providerName: row.provider_name as string,
    baseUrl: (row.base_url as string) ?? null,
    apiProtocol: row.api_protocol as TenantModel["apiProtocol"],
    authMode: row.auth_mode as TenantModel["authMode"],
    apiKeyEncrypted: (row.api_key_encrypted as string) ?? null,
    extraHeaders: (row.extra_headers ?? {}) as Record<string, string>,
    extraConfig: (row.extra_config ?? {}) as Record<string, unknown>,
    models: (row.models ?? []) as TenantModelDefinition[],
    visibility: (row.visibility as ModelVisibility) ?? "private",
    isActive: row.is_active as boolean,
    createdBy: (row.created_by as string) ?? null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

export async function createTenantModel(params: {
  tenantId: string;
  providerType: string;
  providerName: string;
  baseUrl?: string;
  apiProtocol?: string;
  authMode?: string;
  apiKeyEncrypted?: string;
  extraHeaders?: Record<string, string>;
  extraConfig?: Record<string, unknown>;
  models?: TenantModelDefinition[];
  visibility?: ModelVisibility;
  createdBy?: string;
}): Promise<TenantModel> {
  if (getDbType() === DB_SQLITE) {return sqliteTenantModel.createTenantModel(params);}
  const result = await query(
    `INSERT INTO tenant_models
       (tenant_id, provider_type, provider_name, base_url, api_protocol, auth_mode,
        api_key_encrypted, extra_headers, extra_config, models, visibility, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      params.tenantId,
      params.providerType,
      params.providerName,
      params.baseUrl ?? null,
      params.apiProtocol ?? "openai-completions",
      params.authMode ?? "api-key",
      params.apiKeyEncrypted ?? null,
      JSON.stringify(params.extraHeaders ?? {}),
      JSON.stringify(params.extraConfig ?? {}),
      JSON.stringify(params.models ?? []),
      params.visibility ?? "private",
      params.createdBy ?? null,
    ],
  );
  return rowToModel(result.rows[0]);
}

export async function getTenantModel(tenantId: string, id: string): Promise<TenantModel | null> {
  if (getDbType() === DB_SQLITE) {return sqliteTenantModel.getTenantModel(tenantId, id);}
  const result = await query(
    "SELECT * FROM tenant_models WHERE tenant_id = $1 AND id = $2",
    [tenantId, id],
  );
  return result.rows.length > 0 ? rowToModel(result.rows[0]) : null;
}

export async function listTenantModels(
  tenantId: string,
  opts?: { activeOnly?: boolean; includeShared?: boolean },
): Promise<TenantModel[]> {
  if (getDbType() === DB_SQLITE) {return sqliteTenantModel.listTenantModels(tenantId, opts);}
  const values: unknown[] = [tenantId];
  const activeFilter = opts?.activeOnly !== false ? " AND is_active = true" : "";

  // Include shared models from other tenants alongside tenant's own
  const where = opts?.includeShared !== false
    ? `(tenant_id = $1${activeFilter}) OR (visibility = 'shared'${activeFilter})`
    : `tenant_id = $1${activeFilter}`;

  const result = await query(
    `SELECT * FROM tenant_models WHERE ${where} ORDER BY visibility DESC, created_at ASC`,
    values,
  );
  return result.rows.map(rowToModel);
}

/** List all shared models (platform-admin view). */
export async function listSharedModels(
  opts?: { activeOnly?: boolean },
): Promise<TenantModel[]> {
  if (getDbType() === DB_SQLITE) {
    const activeFilter = opts?.activeOnly !== false ? " AND is_active = 1" : "";
    const result = sqliteQuery(
      `SELECT * FROM tenant_models WHERE visibility = 'shared'${activeFilter} ORDER BY created_at ASC`,
    );
    return result.rows.map(rowToModel);
  }
  const activeFilter = opts?.activeOnly !== false ? " AND is_active = true" : "";
  const result = await query(
    `SELECT * FROM tenant_models WHERE visibility = 'shared'${activeFilter} ORDER BY created_at ASC`,
  );
  return result.rows.map(rowToModel);
}

/** Get a model by ID without tenant scope (for platform-admin). */
export async function getModelById(id: string): Promise<TenantModel | null> {
  if (getDbType() === DB_SQLITE) {
    const result = sqliteQuery("SELECT * FROM tenant_models WHERE id = ?", [id]);
    return result.rows.length > 0 ? rowToModel(result.rows[0]) : null;
  }
  const result = await query("SELECT * FROM tenant_models WHERE id = $1", [id]);
  return result.rows.length > 0 ? rowToModel(result.rows[0]) : null;
}

/** Update a model by ID without tenant scope (for platform-admin). */
export async function updateModelById(
  id: string,
  updates: Partial<Pick<TenantModel, "providerName" | "baseUrl" | "apiProtocol" | "authMode" | "apiKeyEncrypted" | "extraHeaders" | "extraConfig" | "models" | "visibility" | "isActive">>,
): Promise<TenantModel | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  const isSqlite = getDbType() === DB_SQLITE;
  let idx = 1;

  const fieldMap: Record<string, string> = {
    providerName: "provider_name",
    baseUrl: "base_url",
    apiProtocol: "api_protocol",
    authMode: "auth_mode",
    apiKeyEncrypted: "api_key_encrypted",
    isActive: "is_active",
    visibility: "visibility",
  };
  const jsonFields = new Set(["extraHeaders", "extraConfig", "models"]);

  for (const [key, col] of Object.entries(fieldMap)) {
    const val = (updates as Record<string, unknown>)[key];
    if (val !== undefined) {
      sets.push(isSqlite ? `${col} = ?` : `${col} = $${idx++}`);
      values.push(key === "isActive" && isSqlite ? (val ? 1 : 0) : val);
    }
  }
  for (const key of jsonFields) {
    const val = (updates as Record<string, unknown>)[key];
    if (val !== undefined) {
      const col = key === "extraHeaders" ? "extra_headers" : key === "extraConfig" ? "extra_config" : "models";
      sets.push(isSqlite ? `${col} = ?` : `${col} = $${idx++}`);
      values.push(JSON.stringify(val));
    }
  }

  if (sets.length === 0) {return getModelById(id);}

  values.push(id);
  if (isSqlite) {
    sqliteQuery(`UPDATE tenant_models SET ${sets.join(", ")} WHERE id = ?`, values);
    return getModelById(id);
  }
  const result = await query(
    `UPDATE tenant_models SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
    values,
  );
  return result.rows.length > 0 ? rowToModel(result.rows[0]) : null;
}

/** Delete a model by ID without tenant scope (for platform-admin). */
export async function deleteModelById(id: string): Promise<boolean> {
  if (getDbType() === DB_SQLITE) {
    const result = sqliteQuery("DELETE FROM tenant_models WHERE id = ?", [id]);
    return result.rowCount > 0;
  }
  const result = await query("DELETE FROM tenant_models WHERE id = $1", [id]);
  return (result.rowCount ?? 0) > 0;
}

export async function updateTenantModel(
  tenantId: string,
  id: string,
  updates: Partial<Pick<TenantModel, "providerName" | "baseUrl" | "apiProtocol" | "authMode" | "apiKeyEncrypted" | "extraHeaders" | "extraConfig" | "models" | "visibility" | "isActive">>,
): Promise<TenantModel | null> {
  if (getDbType() === DB_SQLITE) {return sqliteTenantModel.updateTenantModel(tenantId, id, updates);}
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (updates.providerName !== undefined) {
    sets.push(`provider_name = $${idx++}`);
    values.push(updates.providerName);
  }
  if (updates.baseUrl !== undefined) {
    sets.push(`base_url = $${idx++}`);
    values.push(updates.baseUrl);
  }
  if (updates.apiProtocol !== undefined) {
    sets.push(`api_protocol = $${idx++}`);
    values.push(updates.apiProtocol);
  }
  if (updates.authMode !== undefined) {
    sets.push(`auth_mode = $${idx++}`);
    values.push(updates.authMode);
  }
  if (updates.apiKeyEncrypted !== undefined) {
    sets.push(`api_key_encrypted = $${idx++}`);
    values.push(updates.apiKeyEncrypted);
  }
  if (updates.extraHeaders !== undefined) {
    sets.push(`extra_headers = $${idx++}`);
    values.push(JSON.stringify(updates.extraHeaders));
  }
  if (updates.extraConfig !== undefined) {
    sets.push(`extra_config = $${idx++}`);
    values.push(JSON.stringify(updates.extraConfig));
  }
  if (updates.models !== undefined) {
    sets.push(`models = $${idx++}`);
    values.push(JSON.stringify(updates.models));
  }
  if (updates.visibility !== undefined) {
    sets.push(`visibility = $${idx++}`);
    values.push(updates.visibility);
  }
  if (updates.isActive !== undefined) {
    sets.push(`is_active = $${idx++}`);
    values.push(updates.isActive);
  }

  if (sets.length === 0) {return getTenantModel(tenantId, id);}

  values.push(tenantId, id);
  const result = await query(
    `UPDATE tenant_models SET ${sets.join(", ")} WHERE tenant_id = $${idx++} AND id = $${idx}
     RETURNING *`,
    values,
  );
  return result.rows.length > 0 ? rowToModel(result.rows[0]) : null;
}

export async function deleteTenantModel(tenantId: string, id: string): Promise<boolean> {
  if (getDbType() === DB_SQLITE) {return sqliteTenantModel.deleteTenantModel(tenantId, id);}
  const result = await query(
    "DELETE FROM tenant_models WHERE tenant_id = $1 AND id = $2",
    [tenantId, id],
  );
  return (result.rowCount ?? 0) > 0;
}
