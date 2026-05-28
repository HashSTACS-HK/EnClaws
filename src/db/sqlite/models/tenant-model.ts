/**
 * Tenant Model CRUD — SQLite implementation.
 */

import { sqliteQuery, generateUUID } from "../index.js";
import type { TenantModel, TenantModelDefinition, ModelVisibility } from "../../types.js";

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
    extraHeaders: (typeof row.extra_headers === "string"
      ? JSON.parse(row.extra_headers)
      : row.extra_headers ?? {}) as Record<string, string>,
    extraConfig: (typeof row.extra_config === "string"
      ? JSON.parse(row.extra_config)
      : row.extra_config ?? {}) as Record<string, unknown>,
    models: (typeof row.models === "string"
      ? JSON.parse(row.models)
      : row.models ?? []) as TenantModelDefinition[],
    visibility: (row.visibility as TenantModel["visibility"]) ?? "private",
    isActive: Boolean(row.is_active),
    createdBy: (row.created_by as string) ?? null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
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
  const id = generateUUID();
  sqliteQuery(
    `INSERT INTO tenant_models
       (id, tenant_id, provider_type, provider_name, base_url, api_protocol, auth_mode,
        api_key_encrypted, extra_headers, extra_config, models, visibility, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
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
  const result = sqliteQuery("SELECT * FROM tenant_models WHERE id = ?", [id]);
  return rowToModel(result.rows[0]);
}

export async function getTenantModel(tenantId: string, id: string): Promise<TenantModel | null> {
  const result = sqliteQuery(
    "SELECT * FROM tenant_models WHERE tenant_id = ? AND id = ?",
    [tenantId, id],
  );
  return result.rows.length > 0 ? rowToModel(result.rows[0]) : null;
}

export async function listTenantModels(
  tenantId: string,
  opts?: { activeOnly?: boolean; includeShared?: boolean },
): Promise<TenantModel[]> {
  const values: unknown[] = [tenantId];
  const activeFilter = opts?.activeOnly !== false ? " AND is_active = 1" : "";

  const where = opts?.includeShared !== false
    ? `(tenant_id = ?${activeFilter}) OR (visibility = 'shared'${activeFilter})`
    : `tenant_id = ?${activeFilter}`;

  const result = sqliteQuery(
    `SELECT * FROM tenant_models WHERE ${where} ORDER BY visibility DESC, created_at ASC`,
    values,
  );
  return result.rows.map(rowToModel);
}

export async function updateTenantModel(
  tenantId: string,
  id: string,
  updates: Partial<Pick<TenantModel, "providerName" | "baseUrl" | "apiProtocol" | "authMode" | "apiKeyEncrypted" | "extraHeaders" | "extraConfig" | "models" | "visibility" | "isActive">>,
): Promise<TenantModel | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (updates.providerName !== undefined) {
    sets.push("provider_name = ?");
    values.push(updates.providerName);
  }
  if (updates.baseUrl !== undefined) {
    sets.push("base_url = ?");
    values.push(updates.baseUrl);
  }
  if (updates.apiProtocol !== undefined) {
    sets.push("api_protocol = ?");
    values.push(updates.apiProtocol);
  }
  if (updates.authMode !== undefined) {
    sets.push("auth_mode = ?");
    values.push(updates.authMode);
  }
  if (updates.apiKeyEncrypted !== undefined) {
    sets.push("api_key_encrypted = ?");
    values.push(updates.apiKeyEncrypted);
  }
  if (updates.extraHeaders !== undefined) {
    sets.push("extra_headers = ?");
    values.push(JSON.stringify(updates.extraHeaders));
  }
  if (updates.extraConfig !== undefined) {
    sets.push("extra_config = ?");
    values.push(JSON.stringify(updates.extraConfig));
  }
  if (updates.models !== undefined) {
    sets.push("models = ?");
    values.push(JSON.stringify(updates.models));
  }
  if (updates.visibility !== undefined) {
    sets.push("visibility = ?");
    values.push(updates.visibility);
  }
  if (updates.isActive !== undefined) {
    sets.push("is_active = ?");
    values.push(updates.isActive ? 1 : 0);
  }

  if (sets.length === 0) {return getTenantModel(tenantId, id);}

  values.push(tenantId, id);
  sqliteQuery(
    `UPDATE tenant_models SET ${sets.join(", ")} WHERE tenant_id = ? AND id = ?`,
    values,
  );
  return getTenantModel(tenantId, id);
}

export async function deleteTenantModel(tenantId: string, id: string): Promise<boolean> {
  const result = sqliteQuery(
    "DELETE FROM tenant_models WHERE tenant_id = ? AND id = ?",
    [tenantId, id],
  );
  return result.rowCount > 0;
}
