/**
 * Tenant Channel CRUD — SQLite implementation.
 */

import type { TenantChannel, TenantChannelConfig, ChannelPolicy } from "../../types.js";
import { sqliteQuery, generateUUID } from "../index.js";
import { listChannelApps } from "./tenant-channel-app.js";

function parseConfig(raw: unknown): TenantChannelConfig {
  if (!raw) {
    return {} as TenantChannelConfig;
  }
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {} as TenantChannelConfig;
    }
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
    isActive: Boolean(row.is_active),
    createdBy: (row.created_by as string) ?? null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
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
  const id = generateUUID();
  sqliteQuery(
    `INSERT INTO tenant_channels (id, tenant_id, channel_type, channel_name, channel_policy, config, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      params.tenantId,
      params.channelType,
      params.channelName ?? null,
      params.channelPolicy ?? "open",
      JSON.stringify(params.config ?? {}),
      params.createdBy ?? null,
    ],
  );
  const result = sqliteQuery("SELECT * FROM tenant_channels WHERE id = ?", [id]);
  return rowToChannel(result.rows[0]);
}

export async function getTenantChannelById(
  tenantId: string,
  channelId: string,
): Promise<TenantChannel | null> {
  const result = sqliteQuery("SELECT * FROM tenant_channels WHERE tenant_id = ? AND id = ?", [
    tenantId,
    channelId,
  ]);
  return result.rows.length > 0 ? rowToChannel(result.rows[0]) : null;
}

export async function listTenantChannels(
  tenantId: string,
  opts?: { activeOnly?: boolean; channelType?: string },
): Promise<TenantChannel[]> {
  const conditions = ["tenant_id = ?"];
  const values: unknown[] = [tenantId];

  if (opts?.activeOnly !== false) {
    conditions.push("is_active = 1");
  }
  if (opts?.channelType) {
    conditions.push("channel_type = ?");
    values.push(opts.channelType);
  }

  const result = sqliteQuery(
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
  const sets: string[] = [];
  const values: unknown[] = [];

  if (updates.isActive !== undefined) {
    sets.push("is_active = ?");
    values.push(updates.isActive);
  }
  if (updates.channelName !== undefined) {
    sets.push("channel_name = ?");
    values.push(updates.channelName);
  }
  if (updates.channelPolicy !== undefined) {
    sets.push("channel_policy = ?");
    values.push(updates.channelPolicy);
  }
  if (updates.config !== undefined) {
    sets.push("config = ?");
    values.push(JSON.stringify(updates.config));
  }

  if (sets.length === 0) {
    return null;
  }

  values.push(tenantId, channelId);
  sqliteQuery(
    `UPDATE tenant_channels SET ${sets.join(", ")} WHERE tenant_id = ? AND id = ?`,
    values,
  );
  return getTenantChannelById(tenantId, channelId);
}

export async function deleteTenantChannel(tenantId: string, channelId: string): Promise<boolean> {
  const result = sqliteQuery("DELETE FROM tenant_channels WHERE tenant_id = ? AND id = ?", [
    tenantId,
    channelId,
  ]);
  return result.rowCount > 0;
}

export async function toConfigChannels(
  channels: TenantChannel[],
): Promise<Record<string, unknown>> {
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
