/**
 * Tenant Channel App CRUD — SQLite implementation.
 */

import { sqliteQuery, generateUUID } from "../index.js";
import type { TenantChannelApp, ChannelPolicy } from "../../types.js";

function rowToApp(row: Record<string, unknown>): TenantChannelApp {
  return {
    id: row.id as string,
    channelId: row.channel_id as string,
    tenantId: row.tenant_id as string,
    appId: row.app_id as string,
    appSecret: row.app_secret as string,
    botName: (row.bot_name as string) ?? "",
    groupPolicy: (row.group_policy as ChannelPolicy) ?? "open",
    agentId: (row.agent_id as string) ?? null,
    isActive: Boolean(row.is_active),
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

export async function createChannelApp(params: {
  channelId: string;
  tenantId: string;
  appId: string;
  appSecret?: string;
  botName?: string;
  groupPolicy?: ChannelPolicy;
  agentId?: string | null;
}): Promise<TenantChannelApp> {
  const id = generateUUID();
  sqliteQuery(
    `INSERT INTO tenant_channel_apps (id, channel_id, tenant_id, app_id, app_secret, bot_name, group_policy, agent_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      params.channelId,
      params.tenantId,
      params.appId,
      params.appSecret ?? "",
      params.botName ?? null,
      params.groupPolicy ?? "open",
      params.agentId ?? null,
    ],
  );
  const result = sqliteQuery("SELECT * FROM tenant_channel_apps WHERE id = ?", [id]);
  return rowToApp(result.rows[0]);
}

export async function listChannelApps(channelId: string): Promise<TenantChannelApp[]> {
  const result = sqliteQuery(
    "SELECT * FROM tenant_channel_apps WHERE channel_id = ? ORDER BY created_at ASC",
    [channelId],
  );
  return result.rows.map(rowToApp);
}

export async function updateChannelApp(
  appDbId: string,
  tenantId: string,
  updates: Partial<Pick<TenantChannelApp, "appId" | "appSecret" | "botName" | "groupPolicy" | "agentId" | "isActive">>,
): Promise<TenantChannelApp | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (updates.appId !== undefined) {
    sets.push("app_id = ?");
    values.push(updates.appId);
  }
  if (updates.appSecret !== undefined) {
    sets.push("app_secret = ?");
    values.push(updates.appSecret);
  }
  if (updates.botName !== undefined) {
    sets.push("bot_name = ?");
    values.push(updates.botName);
  }
  if (updates.groupPolicy !== undefined) {
    sets.push("group_policy = ?");
    values.push(updates.groupPolicy);
  }
  if (updates.agentId !== undefined) {
    sets.push("agent_id = ?");
    values.push(updates.agentId);
  }
  if (updates.isActive !== undefined) {
    sets.push("is_active = ?");
    values.push(updates.isActive);
  }

  if (sets.length === 0) {return null;}

  values.push(tenantId, appDbId);
  sqliteQuery(
    `UPDATE tenant_channel_apps SET ${sets.join(", ")} WHERE tenant_id = ? AND id = ?`,
    values,
  );

  const result = sqliteQuery("SELECT * FROM tenant_channel_apps WHERE id = ? AND tenant_id = ?", [appDbId, tenantId]);
  return result.rows.length > 0 ? rowToApp(result.rows[0]) : null;
}

export async function findTenantByChannelApp(
  channelType: string,
  appId: string,
): Promise<{ tenantId: string; userId: string; channelId?: string } | null> {
  // Some channel plugins (e.g. WeCom) normalize the inbound accountId to
  // lowercase while tenant_channel_apps.app_id stores the original-case
  // credential id. Match case-insensitively so user.channel_id gets filled.
  const result = sqliteQuery(
    `SELECT a.tenant_id, c.created_by, c.id as channel_id
     FROM tenant_channel_apps a
     JOIN tenant_channels c ON a.channel_id = c.id
     WHERE c.channel_type = ?
       AND LOWER(a.app_id) = LOWER(?)
       AND a.is_active = 1
       AND c.is_active = 1
     LIMIT 1`,
    [channelType, appId],
  );
  if (result.rows.length === 0) {return null;}
  const row = result.rows[0];
  const tenantId = row.tenant_id as string;
  const userId = row.created_by as string | null;
  if (!userId) {return null;}
  return { tenantId, userId, channelId: row.channel_id as string };
}

export async function agentChannelBindingExists(
  tenantId: string,
  agentId: string,
  channelType: string,
): Promise<boolean> {
  const result = sqliteQuery(
    `SELECT 1
     FROM tenant_channel_apps ca
     JOIN tenant_channels tc ON tc.id = ca.channel_id
     WHERE ca.tenant_id = ?
       AND ca.agent_id = ?
       AND tc.channel_type = ?
       AND ca.is_active = 1
       AND tc.is_active = 1
     LIMIT 1`,
    [tenantId, agentId, channelType],
  );
  return result.rows.length > 0;
}

export async function findChannelAppByAgent(
  tenantId: string,
  agentId: string,
): Promise<{ channelType: string; appId: string; appSecret: string; botName: string } | null> {
  const result = sqliteQuery(
    `SELECT tc.channel_type, ca.app_id, ca.app_secret, ca.bot_name
     FROM tenant_channel_apps ca
     JOIN tenant_channels tc ON tc.id = ca.channel_id
     WHERE ca.tenant_id = ?
       AND ca.agent_id = ?
       AND ca.is_active = 1
       AND tc.is_active = 1
     LIMIT 1`,
    [tenantId, agentId],
  );
  if (result.rows.length === 0) {return null;}
  const row = result.rows[0];
  return {
    channelType: row.channel_type as string,
    appId: row.app_id as string,
    appSecret: row.app_secret as string,
    botName: (row.bot_name as string) ?? "",
  };
}

export async function deleteChannelApp(appDbId: string, tenantId: string): Promise<boolean> {
  const result = sqliteQuery(
    "DELETE FROM tenant_channel_apps WHERE id = ? AND tenant_id = ?",
    [appDbId, tenantId],
  );
  return result.rowCount > 0;
}

export async function listAllTenantChannelApps(tenantId: string): Promise<Array<{
  id: string;
  channelId: string;
  channelType: string;
  channelName: string | null;
  appId: string;
  botName: string;
  agentId: string | null;
}>> {
  const result = sqliteQuery(
    `SELECT ca.id, ca.channel_id, tc.channel_type, tc.channel_name,
            ca.app_id, ca.bot_name, ca.agent_id
     FROM tenant_channel_apps ca
     JOIN tenant_channels tc ON tc.id = ca.channel_id
     WHERE ca.tenant_id = ? AND ca.is_active = 1 AND tc.is_active = 1
     ORDER BY tc.channel_type, ca.bot_name ASC`,
    [tenantId],
  );
  return result.rows.map((r) => ({
    id: r.id as string,
    channelId: r.channel_id as string,
    channelType: r.channel_type as string,
    channelName: (r.channel_name as string) ?? null,
    appId: r.app_id as string,
    botName: (r.bot_name as string) ?? "",
    agentId: (r.agent_id as string) ?? null,
  }));
}
