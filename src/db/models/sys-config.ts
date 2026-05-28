/**
 * System config CRUD — PG primary implementation + SQLite dispatch.
 */

import { query, getDbType, DB_SQLITE } from "../index.js";
import * as sqliteSysConfig from "../sqlite/models/sys-config.js";
import type {
  SysGatewayConfigRow,
  SysLoggingConfigRow,
  SysPluginsConfigRow,
  SysToolsConfigRow,
} from "../types.js";

// ---------------------------------------------------------------------------
// Row adapters (PG rows use snake_case, auto-parsed JSONB)
// ---------------------------------------------------------------------------

function rowToGatewayConfig(row: Record<string, unknown>): SysGatewayConfigRow {
  return {
    id: row.id as number,
    port: row.port as number,
    mode: row.mode as string | null,
    bind: row.bind as string | null,
    customBindHost: row.custom_bind_host as string | null,
    tailscale: (row.tailscale ?? {}) as Record<string, unknown>,
    remote: (row.remote ?? {}) as Record<string, unknown>,
    reload: (row.reload ?? {}) as Record<string, unknown>,
    tls: (row.tls ?? {}) as Record<string, unknown>,
    http: (row.http ?? {}) as Record<string, unknown>,
    nodes: (row.nodes ?? {}) as Record<string, unknown>,
    trustedProxies: (row.trusted_proxies ?? []) as string[],
    allowRealIpFallback: (row.allow_real_ip_fallback as boolean) ?? false,
    auth: (row.auth ?? {}) as Record<string, unknown>,
    tools: (row.tools ?? {}) as Record<string, unknown>,
    channelHealthCheckMinutes: row.channel_health_check_minutes as number | null,
    multiTenant: (row.multi_tenant ?? {}) as Record<string, unknown>,
    updatedAt: row.updated_at as Date,
  };
}

function rowToLoggingConfig(row: Record<string, unknown>): SysLoggingConfigRow {
  return {
    id: row.id as number,
    level: row.level as string | null,
    file: row.file as string | null,
    maxFileBytes: row.max_file_bytes as number | null,
    consoleLevel: row.console_level as string | null,
    consoleStyle: row.console_style as string | null,
    redactSensitive: row.redact_sensitive as string | null,
    redactPatterns: (row.redact_patterns ?? []) as string[],
    updatedAt: row.updated_at as Date,
  };
}

function rowToPluginsConfig(row: Record<string, unknown>): SysPluginsConfigRow {
  return {
    id: row.id as number,
    enabled: (row.enabled as boolean) ?? true,
    allow: (row.allow ?? []) as string[],
    deny: (row.deny ?? []) as string[],
    load: (row.load ?? {}) as Record<string, unknown>,
    slots: (row.slots ?? {}) as Record<string, unknown>,
    entries: (row.entries ?? {}) as Record<string, unknown>,
    installs: (row.installs ?? {}) as Record<string, unknown>,
    updatedAt: row.updated_at as Date,
  };
}

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

export async function getSysGatewayConfig(): Promise<SysGatewayConfigRow> {
  if (getDbType() === DB_SQLITE) {return sqliteSysConfig.getSysGatewayConfig();}
  const result = await query("SELECT * FROM sys_gateway_config WHERE id = 1");
  return rowToGatewayConfig(result.rows[0]);
}

export async function upsertSysGatewayConfig(
  data: Partial<Omit<SysGatewayConfigRow, "id" | "updatedAt">>,
): Promise<SysGatewayConfigRow> {
  if (getDbType() === DB_SQLITE) {return sqliteSysConfig.upsertSysGatewayConfig(data);}
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (data.port !== undefined) { sets.push(`port = $${idx++}`); values.push(data.port); }
  if (data.mode !== undefined) { sets.push(`mode = $${idx++}`); values.push(data.mode); }
  if (data.bind !== undefined) { sets.push(`bind = $${idx++}`); values.push(data.bind); }
  if (data.customBindHost !== undefined) { sets.push(`custom_bind_host = $${idx++}`); values.push(data.customBindHost); }
  if (data.tailscale !== undefined) { sets.push(`tailscale = $${idx++}`); values.push(JSON.stringify(data.tailscale)); }
  if (data.remote !== undefined) { sets.push(`remote = $${idx++}`); values.push(JSON.stringify(data.remote)); }
  if (data.reload !== undefined) { sets.push(`reload = $${idx++}`); values.push(JSON.stringify(data.reload)); }
  if (data.tls !== undefined) { sets.push(`tls = $${idx++}`); values.push(JSON.stringify(data.tls)); }
  if (data.http !== undefined) { sets.push(`http = $${idx++}`); values.push(JSON.stringify(data.http)); }
  if (data.nodes !== undefined) { sets.push(`nodes = $${idx++}`); values.push(JSON.stringify(data.nodes)); }
  if (data.trustedProxies !== undefined) { sets.push(`trusted_proxies = $${idx++}`); values.push(JSON.stringify(data.trustedProxies)); }
  if (data.allowRealIpFallback !== undefined) { sets.push(`allow_real_ip_fallback = $${idx++}`); values.push(data.allowRealIpFallback); }
  if (data.auth !== undefined) { sets.push(`auth = $${idx++}`); values.push(JSON.stringify(data.auth)); }
  if (data.tools !== undefined) { sets.push(`tools = $${idx++}`); values.push(JSON.stringify(data.tools)); }
  if (data.channelHealthCheckMinutes !== undefined) { sets.push(`channel_health_check_minutes = $${idx++}`); values.push(data.channelHealthCheckMinutes); }
  if (data.multiTenant !== undefined) { sets.push(`multi_tenant = $${idx++}`); values.push(JSON.stringify(data.multiTenant)); }

  if (sets.length > 0) {
    await query(`UPDATE sys_gateway_config SET ${sets.join(", ")}, updated_at = NOW() WHERE id = 1`, values);
  }
  return getSysGatewayConfig();
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

export async function getSysLoggingConfig(): Promise<SysLoggingConfigRow> {
  if (getDbType() === DB_SQLITE) {return sqliteSysConfig.getSysLoggingConfig();}
  const result = await query("SELECT * FROM sys_logging_config WHERE id = 1");
  return rowToLoggingConfig(result.rows[0]);
}

export async function upsertSysLoggingConfig(
  data: Partial<Omit<SysLoggingConfigRow, "id" | "updatedAt">>,
): Promise<SysLoggingConfigRow> {
  if (getDbType() === DB_SQLITE) {return sqliteSysConfig.upsertSysLoggingConfig(data);}
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (data.level !== undefined) { sets.push(`level = $${idx++}`); values.push(data.level); }
  if (data.file !== undefined) { sets.push(`file = $${idx++}`); values.push(data.file); }
  if (data.maxFileBytes !== undefined) { sets.push(`max_file_bytes = $${idx++}`); values.push(data.maxFileBytes); }
  if (data.consoleLevel !== undefined) { sets.push(`console_level = $${idx++}`); values.push(data.consoleLevel); }
  if (data.consoleStyle !== undefined) { sets.push(`console_style = $${idx++}`); values.push(data.consoleStyle); }
  if (data.redactSensitive !== undefined) { sets.push(`redact_sensitive = $${idx++}`); values.push(data.redactSensitive); }
  if (data.redactPatterns !== undefined) { sets.push(`redact_patterns = $${idx++}`); values.push(JSON.stringify(data.redactPatterns)); }

  if (sets.length > 0) {
    await query(`UPDATE sys_logging_config SET ${sets.join(", ")}, updated_at = NOW() WHERE id = 1`, values);
  }
  return getSysLoggingConfig();
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

export async function getSysPluginsConfig(): Promise<SysPluginsConfigRow> {
  if (getDbType() === DB_SQLITE) {return sqliteSysConfig.getSysPluginsConfig();}
  const result = await query("SELECT * FROM sys_plugins_config WHERE id = 1");
  return rowToPluginsConfig(result.rows[0]);
}

export async function upsertSysPluginsConfig(
  data: Partial<Omit<SysPluginsConfigRow, "id" | "updatedAt">>,
): Promise<SysPluginsConfigRow> {
  if (getDbType() === DB_SQLITE) {return sqliteSysConfig.upsertSysPluginsConfig(data);}
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (data.enabled !== undefined) { sets.push(`enabled = $${idx++}`); values.push(data.enabled); }
  if (data.allow !== undefined) { sets.push(`allow = $${idx++}`); values.push(JSON.stringify(data.allow)); }
  if (data.deny !== undefined) { sets.push(`deny = $${idx++}`); values.push(JSON.stringify(data.deny)); }
  if (data.load !== undefined) { sets.push(`load = $${idx++}`); values.push(JSON.stringify(data.load)); }
  if (data.slots !== undefined) { sets.push(`slots = $${idx++}`); values.push(JSON.stringify(data.slots)); }
  if (data.entries !== undefined) { sets.push(`entries = $${idx++}`); values.push(JSON.stringify(data.entries)); }
  if (data.installs !== undefined) { sets.push(`installs = $${idx++}`); values.push(JSON.stringify(data.installs)); }

  if (sets.length > 0) {
    await query(`UPDATE sys_plugins_config SET ${sets.join(", ")}, updated_at = NOW() WHERE id = 1`, values);
  }
  return getSysPluginsConfig();
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function rowToToolsConfig(row: Record<string, unknown>): SysToolsConfigRow {
  return {
    id: row.id as number,
    allowDangerousToolsOverride: (row.allow_dangerous_tools_override as boolean) ?? false,
    profile: row.profile as string | null,
    allow: (row.allow ?? []) as string[],
    alsoAllow: (row.also_allow ?? []) as string[],
    deny: (row.deny ?? []) as string[],
    byProvider: (row.by_provider ?? {}) as Record<string, unknown>,
    web: (row.web ?? {}) as Record<string, unknown>,
    media: (row.media ?? {}) as Record<string, unknown>,
    links: (row.links ?? {}) as Record<string, unknown>,
    message: (row.message ?? {}) as Record<string, unknown>,
    agentToAgent: (row.agent_to_agent ?? {}) as Record<string, unknown>,
    sessions: (row.sessions ?? {}) as Record<string, unknown>,
    elevated: (row.elevated ?? {}) as Record<string, unknown>,
    exec: (row.exec ?? {}) as Record<string, unknown>,
    fs: (row.fs ?? {}) as Record<string, unknown>,
    loopDetection: (row.loop_detection ?? {}) as Record<string, unknown>,
    subagents: (row.subagents ?? {}) as Record<string, unknown>,
    sandbox: (row.sandbox ?? {}) as Record<string, unknown>,
    updatedAt: row.updated_at as Date,
  };
}

export async function getSysToolsConfig(): Promise<SysToolsConfigRow> {
  if (getDbType() === DB_SQLITE) {return sqliteSysConfig.getSysToolsConfig();}
  const result = await query("SELECT * FROM sys_tools_config WHERE id = 1");
  return rowToToolsConfig(result.rows[0]);
}

export async function upsertSysToolsConfig(
  data: Partial<Omit<SysToolsConfigRow, "id" | "updatedAt">>,
): Promise<SysToolsConfigRow> {
  if (getDbType() === DB_SQLITE) {return sqliteSysConfig.upsertSysToolsConfig(data);}
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (data.allowDangerousToolsOverride !== undefined) { sets.push(`allow_dangerous_tools_override = $${idx++}`); values.push(data.allowDangerousToolsOverride); }
  if (data.profile !== undefined) { sets.push(`profile = $${idx++}`); values.push(data.profile); }
  if (data.allow !== undefined) { sets.push(`allow = $${idx++}`); values.push(JSON.stringify(data.allow)); }
  if (data.alsoAllow !== undefined) { sets.push(`also_allow = $${idx++}`); values.push(JSON.stringify(data.alsoAllow)); }
  if (data.deny !== undefined) { sets.push(`deny = $${idx++}`); values.push(JSON.stringify(data.deny)); }
  if (data.byProvider !== undefined) { sets.push(`by_provider = $${idx++}`); values.push(JSON.stringify(data.byProvider)); }
  if (data.web !== undefined) { sets.push(`web = $${idx++}`); values.push(JSON.stringify(data.web)); }
  if (data.media !== undefined) { sets.push(`media = $${idx++}`); values.push(JSON.stringify(data.media)); }
  if (data.links !== undefined) { sets.push(`links = $${idx++}`); values.push(JSON.stringify(data.links)); }
  if (data.message !== undefined) { sets.push(`message = $${idx++}`); values.push(JSON.stringify(data.message)); }
  if (data.agentToAgent !== undefined) { sets.push(`agent_to_agent = $${idx++}`); values.push(JSON.stringify(data.agentToAgent)); }
  if (data.sessions !== undefined) { sets.push(`sessions = $${idx++}`); values.push(JSON.stringify(data.sessions)); }
  if (data.elevated !== undefined) { sets.push(`elevated = $${idx++}`); values.push(JSON.stringify(data.elevated)); }
  if (data.exec !== undefined) { sets.push(`exec = $${idx++}`); values.push(JSON.stringify(data.exec)); }
  if (data.fs !== undefined) { sets.push(`fs = $${idx++}`); values.push(JSON.stringify(data.fs)); }
  if (data.loopDetection !== undefined) { sets.push(`loop_detection = $${idx++}`); values.push(JSON.stringify(data.loopDetection)); }
  if (data.subagents !== undefined) { sets.push(`subagents = $${idx++}`); values.push(JSON.stringify(data.subagents)); }
  if (data.sandbox !== undefined) { sets.push(`sandbox = $${idx++}`); values.push(JSON.stringify(data.sandbox)); }

  if (sets.length > 0) {
    await query(`UPDATE sys_tools_config SET ${sets.join(", ")}, updated_at = NOW() WHERE id = 1`, values);
  }
  return getSysToolsConfig();
}

// ---------------------------------------------------------------------------
// Bulk load
// ---------------------------------------------------------------------------

export async function loadAllSysConfig(): Promise<{
  gateway: SysGatewayConfigRow;
  logging: SysLoggingConfigRow;
  plugins: SysPluginsConfigRow;
  tools: SysToolsConfigRow;
}> {
  if (getDbType() === DB_SQLITE) {return sqliteSysConfig.loadAllSysConfig();}
  const [gateway, logging, plugins, tools] = await Promise.all([
    getSysGatewayConfig(),
    getSysLoggingConfig(),
    getSysPluginsConfig(),
    getSysToolsConfig(),
  ]);
  return { gateway, logging, plugins, tools };
}
