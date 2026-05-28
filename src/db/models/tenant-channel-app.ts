/**
 * Tenant Channel App CRUD - manages apps within a channel.
 */

import { query, getDbType, DB_SQLITE } from "../index.js";
import * as sqliteChannelApp from "../sqlite/models/tenant-channel-app.js";
import type { TenantChannelApp, ChannelPolicy } from "../types.js";

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
    isActive: row.is_active as boolean,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
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
  if (getDbType() === DB_SQLITE) {return sqliteChannelApp.createChannelApp(params);}
  const result = await query(
    `INSERT INTO tenant_channel_apps (channel_id, tenant_id, app_id, app_secret, bot_name, group_policy, agent_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      params.channelId,
      params.tenantId,
      params.appId,
      params.appSecret ?? "",
      params.botName ?? null,
      params.groupPolicy ?? "open",
      params.agentId ?? null,
    ],
  );
  return rowToApp(result.rows[0]);
}

export async function listChannelApps(channelId: string): Promise<TenantChannelApp[]> {
  if (getDbType() === DB_SQLITE) {return sqliteChannelApp.listChannelApps(channelId);}
  const result = await query(
    "SELECT * FROM tenant_channel_apps WHERE channel_id = $1 ORDER BY created_at ASC",
    [channelId],
  );
  return result.rows.map(rowToApp);
}

export async function updateChannelApp(
  appDbId: string,
  tenantId: string,
  updates: Partial<Pick<TenantChannelApp, "appId" | "appSecret" | "botName" | "groupPolicy" | "agentId" | "isActive">>,
): Promise<TenantChannelApp | null> {
  if (getDbType() === DB_SQLITE) {return sqliteChannelApp.updateChannelApp(appDbId, tenantId, updates);}
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (updates.appId !== undefined) {
    sets.push(`app_id = $${idx++}`);
    values.push(updates.appId);
  }
  if (updates.appSecret !== undefined) {
    sets.push(`app_secret = $${idx++}`);
    values.push(updates.appSecret);
  }
  if (updates.botName !== undefined) {
    sets.push(`bot_name = $${idx++}`);
    values.push(updates.botName);
  }
  if (updates.groupPolicy !== undefined) {
    sets.push(`group_policy = $${idx++}`);
    values.push(updates.groupPolicy);
  }
  if (updates.agentId !== undefined) {
    sets.push(`agent_id = $${idx++}`);
    values.push(updates.agentId);
  }
  if (updates.isActive !== undefined) {
    sets.push(`is_active = $${idx++}`);
    values.push(updates.isActive);
  }

  if (sets.length === 0) {return null;}

  values.push(tenantId, appDbId);
  const result = await query(
    `UPDATE tenant_channel_apps SET ${sets.join(", ")}
     WHERE tenant_id = $${idx++} AND id = $${idx}
     RETURNING *`,
    values,
  );
  return result.rows.length > 0 ? rowToApp(result.rows[0]) : null;
}

/**
 * Reverse lookup: find the tenant + creator for a channel app by channel type and app ID.
 *
 * Used by inbound message handlers to resolve tenant context from an incoming
 * message's channel type (e.g. "telegram") and account app ID.
 *
 * Returns { tenantId, userId } or null if no matching active app is found.
 */
export async function findTenantByChannelApp(
  channelType: string,
  appId: string,
): Promise<{ tenantId: string; userId: string; channelId?: string } | null> {
  if (getDbType() === DB_SQLITE) {return sqliteChannelApp.findTenantByChannelApp(channelType, appId);}
  // Some channel plugins (e.g. WeCom) normalize the inbound accountId to
  // lowercase, while tenant_channel_apps.app_id stores the original-case
  // credential id from onboarding. Match case-insensitively so the lookup
  // survives this divergence — otherwise user.channel_id stays NULL.
  const result = await query(
    `SELECT a.tenant_id, c.created_by, c.id as channel_id
     FROM tenant_channel_apps a
     JOIN tenant_channels c ON a.channel_id = c.id
     WHERE c.channel_type = $1
       AND LOWER(a.app_id) = LOWER($2)
       AND a.is_active = true
       AND c.is_active = true
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

/**
 * Check whether an active tenant_channel_apps row binds `agentId` to a
 * channel of type `channelType` within `tenantId`. Used by the agent chat
 * API to reject sessionKeys whose agent/channel pairing isn't configured.
 */
export async function agentChannelBindingExists(
  tenantId: string,
  agentId: string,
  channelType: string,
): Promise<boolean> {
  if (getDbType() === DB_SQLITE) {return sqliteChannelApp.agentChannelBindingExists(tenantId, agentId, channelType);}
  const result = await query(
    `SELECT 1
     FROM tenant_channel_apps ca
     JOIN tenant_channels tc ON tc.id = ca.channel_id
     WHERE ca.tenant_id = $1
       AND ca.agent_id = $2
       AND tc.channel_type = $3
       AND ca.is_active = true
       AND tc.is_active = true
     LIMIT 1`,
    [tenantId, agentId, channelType],
  );
  return result.rows.length > 0;
}

/**
 * Find the first active channel app bound to a specific agent.
 * Used by agent-scoped cron to resolve the delivery accountId automatically.
 */
export async function findChannelAppByAgent(
  tenantId: string,
  agentId: string,
): Promise<{ channelType: string; appId: string; appSecret: string; botName: string } | null> {
  if (getDbType() === DB_SQLITE) {return sqliteChannelApp.findChannelAppByAgent(tenantId, agentId);}
  const result = await query(
    `SELECT tc.channel_type, ca.app_id, ca.app_secret, ca.bot_name
     FROM tenant_channel_apps ca
     JOIN tenant_channels tc ON tc.id = ca.channel_id
     WHERE ca.tenant_id = $1
       AND ca.agent_id = $2
       AND ca.is_active = true
       AND tc.is_active = true
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
  if (getDbType() === DB_SQLITE) {return sqliteChannelApp.deleteChannelApp(appDbId, tenantId);}
  const result = await query(
    "DELETE FROM tenant_channel_apps WHERE id = $1 AND tenant_id = $2",
    [appDbId, tenantId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * List all active channel apps for a tenant, joined with channel info.
 * Used by the agent creation form to populate the channel app dropdown.
 */
export async function listAllTenantChannelApps(tenantId: string): Promise<Array<{
  id: string;
  channelId: string;
  channelType: string;
  channelName: string | null;
  appId: string;
  botName: string;
  agentId: string | null;
}>> {
  if (getDbType() === DB_SQLITE) {return sqliteChannelApp.listAllTenantChannelApps(tenantId);}
  const result = await query(
    `SELECT ca.id, ca.channel_id, tc.channel_type, tc.channel_name,
            ca.app_id, ca.bot_name, ca.agent_id
     FROM tenant_channel_apps ca
     JOIN tenant_channels tc ON tc.id = ca.channel_id
     WHERE ca.tenant_id = $1 AND ca.is_active = true AND tc.is_active = true
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
