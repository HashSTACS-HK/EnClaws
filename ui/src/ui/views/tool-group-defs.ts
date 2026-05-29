/**
 * Shared tool catalog definitions for tenant-agents and platform-tools views.
 *
 * Single source of truth for group/tool IDs, their i18n label/description
 * keys, and the server-id → key lookup maps. Keeping both views on the same
 * data avoids i18n drift (e.g. admin seeing raw English plugin descriptions
 * while tenant users see translated ones).
 */

export type SharedToolDef = {
  id: string;
  label: string;
  labelKey?: string;
  descKey: string;
};

export type SharedToolGroupDef = {
  id: string;
  labelKey: string;
  tools: SharedToolDef[];
};

/** Tool group/tool ID definitions — labels resolved at render time via i18n. */
export const TOOL_GROUP_DEFS: SharedToolGroupDef[] = [
  {
    id: "fs",
    labelKey: "tenantAgents.toolGroupFs",
    tools: [
      {
        id: "read",
        label: "read",
        labelKey: "tenantAgents.toolLabelRead",
        descKey: "tenantAgents.toolRead",
      },
      {
        id: "write",
        label: "write",
        labelKey: "tenantAgents.toolLabelWrite",
        descKey: "tenantAgents.toolWrite",
      },
      {
        id: "edit",
        label: "edit",
        labelKey: "tenantAgents.toolLabelEdit",
        descKey: "tenantAgents.toolEdit",
      },
      {
        id: "apply_patch",
        label: "apply_patch",
        labelKey: "tenantAgents.toolLabelApplyPatch",
        descKey: "tenantAgents.toolApplyPatch",
      },
      {
        id: "grep",
        label: "grep",
        labelKey: "tenantAgents.toolLabelGrep",
        descKey: "tenantAgents.toolGrep",
      },
      {
        id: "find",
        label: "find",
        labelKey: "tenantAgents.toolLabelFind",
        descKey: "tenantAgents.toolFind",
      },
      {
        id: "ls",
        label: "ls",
        labelKey: "tenantAgents.toolLabelLs",
        descKey: "tenantAgents.toolLs",
      },
    ],
  },
  {
    id: "runtime",
    labelKey: "tenantAgents.toolGroupRuntime",
    tools: [
      {
        id: "exec",
        label: "exec",
        labelKey: "tenantAgents.toolLabelExec",
        descKey: "tenantAgents.toolExec",
      },
      {
        id: "process",
        label: "process",
        labelKey: "tenantAgents.toolLabelProcess",
        descKey: "tenantAgents.toolProcess",
      },
    ],
  },
  {
    id: "web",
    labelKey: "tenantAgents.toolGroupWeb",
    tools: [
      {
        id: "web_search",
        label: "web_search",
        labelKey: "tenantAgents.toolLabelWebSearch",
        descKey: "tenantAgents.toolWebSearch",
      },
      {
        id: "web_fetch",
        label: "web_fetch",
        labelKey: "tenantAgents.toolLabelWebFetch",
        descKey: "tenantAgents.toolWebFetch",
      },
    ],
  },
  {
    id: "memory",
    labelKey: "tenantAgents.toolGroupMemory",
    tools: [
      {
        id: "memory_search",
        label: "memory_search",
        labelKey: "tenantAgents.toolLabelMemorySearch",
        descKey: "tenantAgents.toolMemorySearch",
      },
      {
        id: "memory_get",
        label: "memory_get",
        labelKey: "tenantAgents.toolLabelMemoryGet",
        descKey: "tenantAgents.toolMemoryGet",
      },
    ],
  },
  {
    id: "sessions",
    labelKey: "tenantAgents.toolGroupSessions",
    tools: [
      {
        id: "sessions_list",
        label: "sessions_list",
        labelKey: "tenantAgents.toolLabelSessionsList",
        descKey: "tenantAgents.toolSessionsList",
      },
      {
        id: "sessions_history",
        label: "sessions_history",
        labelKey: "tenantAgents.toolLabelSessionsHistory",
        descKey: "tenantAgents.toolSessionsHistory",
      },
      {
        id: "sessions_send",
        label: "sessions_send",
        labelKey: "tenantAgents.toolLabelSessionsSend",
        descKey: "tenantAgents.toolSessionsSend",
      },
      {
        id: "sessions_spawn",
        label: "sessions_spawn",
        labelKey: "tenantAgents.toolLabelSessionsSpawn",
        descKey: "tenantAgents.toolSessionsSpawn",
      },
      {
        id: "subagents",
        label: "subagents",
        labelKey: "tenantAgents.toolLabelSubagents",
        descKey: "tenantAgents.toolSubagents",
      },
      {
        id: "session_status",
        label: "session_status",
        labelKey: "tenantAgents.toolLabelSessionStatus",
        descKey: "tenantAgents.toolSessionStatus",
      },
    ],
  },
  {
    id: "messaging",
    labelKey: "tenantAgents.toolGroupMessaging",
    tools: [
      {
        id: "message",
        label: "message",
        labelKey: "tenantAgents.toolLabelMessage",
        descKey: "tenantAgents.toolMessage",
      },
    ],
  },
  {
    id: "automation",
    labelKey: "tenantAgents.toolGroupAutomation",
    tools: [
      {
        id: "cron",
        label: "cron",
        labelKey: "tenantAgents.toolLabelCron",
        descKey: "tenantAgents.toolCron",
      },
      {
        id: "gateway",
        label: "gateway",
        labelKey: "tenantAgents.toolLabelGateway",
        descKey: "tenantAgents.toolGateway",
      },
    ],
  },
  {
    id: "ui",
    labelKey: "tenantAgents.toolGroupUi",
    tools: [
      {
        id: "browser",
        label: "browser",
        labelKey: "tenantAgents.toolLabelBrowser",
        descKey: "tenantAgents.toolBrowser",
      },
      {
        id: "canvas",
        label: "canvas",
        labelKey: "tenantAgents.toolLabelCanvas",
        descKey: "tenantAgents.toolCanvas",
      },
    ],
  },
  {
    id: "other",
    labelKey: "tenantAgents.toolGroupOther",
    tools: [
      {
        id: "nodes",
        label: "nodes",
        labelKey: "tenantAgents.toolLabelNodes",
        descKey: "tenantAgents.toolNodes",
      },
      {
        id: "agents_list",
        label: "agents_list",
        labelKey: "tenantAgents.toolLabelAgentsList",
        descKey: "tenantAgents.toolAgentsList",
      },
      {
        id: "image",
        label: "image",
        labelKey: "tenantAgents.toolLabelImage",
        descKey: "tenantAgents.toolImage",
      },
      {
        id: "tts",
        label: "tts",
        labelKey: "tenantAgents.toolLabelTts",
        descKey: "tenantAgents.toolTts",
      },
    ],
  },
  // Plugin-provided tools (e.g. Feishu/Lark) intentionally omitted:
  // their label/description come directly from the plugin's tool registration
  // and pass through verbatim in the UI. Do not add i18n keys for them here.
];

export const ALL_TOOL_IDS: string[] = TOOL_GROUP_DEFS.flatMap((g) => g.tools.map((td) => td.id));

/**
 * Id → i18n key lookup. IDs declared in TOOL_GROUP_DEFS get translated;
 * plugin-provided IDs not present here fall through and keep their
 * server/plugin-supplied label/description at render time.
 */
export const GROUP_LABEL_KEY: Record<string, string> = {};
export const TOOL_LABEL_KEY: Record<string, string> = {};
export const TOOL_DESC_KEY: Record<string, string> = {};
for (const g of TOOL_GROUP_DEFS) {
  GROUP_LABEL_KEY[g.id] = g.labelKey;
  for (const td of g.tools) {
    TOOL_DESC_KEY[td.id] = td.descKey;
    if (td.labelKey) {
      TOOL_LABEL_KEY[td.id] = td.labelKey;
    }
  }
}
// Server-side catalog splits nodes/image+tts into their own groups (nodes, media),
// while the local fallback bundles them under "other". Map those server ids so
// the group header still gets translated when the catalog RPC is the source.
GROUP_LABEL_KEY.nodes = "tenantAgents.toolGroupNodes";
GROUP_LABEL_KEY.media = "tenantAgents.toolGroupMedia";
