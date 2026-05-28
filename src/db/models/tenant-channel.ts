/**
 * Tenant Channel CRUD - stores channel configurations per tenant in PostgreSQL.
 */

import { query, getDbType, DB_SQLITE } from "../index.js";
import * as sqliteChannel from "../sqlite/models/tenant-channel.js";
import type { TenantChannel, TenantChannelConfig, ChannelPolicy } from "../types.js";
import { listChannelApps } from "./tenant-channel-app.js";

function parseConfig(raw: unknown): TenantChannelConfig {
  if (!raw) {return {} as TenantChannelConfig;}
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return {} as TenantChannelConfig; }
  }
  return raw as TenantChannelConfig;
}

function rowToChannel(row: Record<string, unknown>): TenantChannel {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    channelType: row.channel_type as string,
    channelName: (row.channel_name as string) ?? null,
    channelPolicy: (row.channel_policy as ChannelPolicy) ?? "open",
    config: parseConfig(row.config),
    isActive: row.is_active as boolean,
    createdBy: (row.created_by as string) ?? null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

export async function createTenantChannel(params: {
  tenantId: string;
  channelType: string;
  channelName?: string;
  channelPolicy?: ChannelPolicy;
  config?: Partial<TenantChannelConfig>;
  createdBy?: string;
}): Promise<TenantChannel> {
  if (getDbType() === DB_SQLITE) {return sqliteChannel.createTenantChannel(params);}
  const result = await query(
    `INSERT INTO tenant_channels (tenant_id, channel_type, channel_name, channel_policy, config, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      params.tenantId,
      params.channelType,
      params.channelName ?? null,
      params.channelPolicy ?? "open",
      JSON.stringify(params.config ?? {}),
      params.createdBy ?? null,
    ],
  );
  return rowToChannel(result.rows[0]);
}

export async function getTenantChannelById(
  tenantId: string,
  channelId: string,
): Promise<TenantChannel | null> {
  if (getDbType() === DB_SQLITE) {return sqliteChannel.getTenantChannelById(tenantId, channelId);}
  const result = await query(
    "SELECT * FROM tenant_channels WHERE tenant_id = $1 AND id = $2",
    [tenantId, channelId],
  );
  return result.rows.length > 0 ? rowToChannel(result.rows[0]) : null;
}

export async function listTenantChannels(
  tenantId: string,
  opts?: { activeOnly?: boolean; channelType?: string },
): Promise<TenantChannel[]> {
  if (getDbType() === DB_SQLITE) {return sqliteChannel.listTenantChannels(tenantId, opts);}
  const conditions = ["tenant_id = $1"];
  const values: unknown[] = [tenantId];
  let idx = 2;

  if (opts?.activeOnly !== false) {
    conditions.push("is_active = true");
  }
  if (opts?.channelType) {
    conditions.push(`channel_type = $${idx++}`);
    values.push(opts.channelType);
  }

  const result = await query(
    `SELECT * FROM tenant_channels WHERE ${conditions.join(" AND ")} ORDER BY channel_type, created_at ASC`,
    values,
  );
  return result.rows.map(rowToChannel);
}

export async function updateTenantChannel(
  tenantId: string,
  channelId: string,
  updates: Partial<Pick<TenantChannel, "isActive" | "channelName" | "channelPolicy" | "config">>,
): Promise<TenantChannel | null> {
  if (getDbType() === DB_SQLITE) {return sqliteChannel.updateTenantChannel(tenantId, channelId, updates);}
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (updates.isActive !== undefined) {
    sets.push(`is_active = $${idx++}`);
    values.push(updates.isActive);
  }
  if (updates.channelName !== undefined) {
    sets.push(`channel_name = $${idx++}`);
    values.push(updates.channelName);
  }
  if (updates.channelPolicy !== undefined) {
    sets.push(`channel_policy = $${idx++}`);
    values.push(updates.channelPolicy);
  }
  if (updates.config !== undefined) {
    sets.push(`config = $${idx++}`);
    values.push(JSON.stringify(updates.config));
  }

  if (sets.length === 0) {return null;}

  values.push(tenantId, channelId);
  const result = await query(
    `UPDATE tenant_channels SET ${sets.join(", ")}
     WHERE tenant_id = $${idx++} AND id = $${idx}
     RETURNING *`,
    values,
  );
  return result.rows.length > 0 ? rowToChannel(result.rows[0]) : null;
}

export async function deleteTenantChannel(tenantId: string, channelId: string): Promise<boolean> {
  if (getDbType() === DB_SQLITE) {return sqliteChannel.deleteTenantChannel(tenantId, channelId);}
  const result = await query(
    "DELETE FROM tenant_channels WHERE tenant_id = $1 AND id = $2",
    [tenantId, channelId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Convert tenant channels + their apps to EnClawsConfig channels format.
 * Reads apps from tenant_channel_apps for each channel.
 */
export async function toConfigChannels(channels: TenantChannel[]): Promise<Record<string, unknown>> {
  if (getDbType() === DB_SQLITE) {return sqliteChannel.toConfigChannels(channels);}
  const result: Record<string, unknown> = {};
  for (const ch of channels) {
    const key = ch.channelName ? `${ch.channelType}:${ch.channelName}` : ch.channelType;
    const apps = await listChannelApps(ch.id);
    const channelConfig: Record<string, unknown> = {
      ...ch.config,
      enabled: ch.isActive,
      channelPolicy: ch.channelPolicy,
      apps: apps.map((a) => ({
        appId: a.appId,
        appSecret: a.appSecret,
        groupPolicy: a.groupPolicy,
        isActive: a.isActive,
      })),
    };
    // Map channelPolicy → dmPolicy for feishu (openclaw-lark plugin reads dmPolicy)
    if (ch.channelType === "feishu") {
      channelConfig.dmPolicy = ch.channelPolicy;
      if (ch.channelPolicy === "open") {
        channelConfig.allowFrom = ["*"];
      }
    }
    result[key] = channelConfig;
  }
  return result;
}
