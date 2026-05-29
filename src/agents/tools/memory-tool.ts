import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type { MemoryCitationsMode } from "../../config/types.memory.js";
import { resolveMemoryBackendConfig } from "../../memory/backend-config.js";
import { getMemorySearchManager } from "../../memory/index.js";
import type {
  MemoryOutlineFile,
  MemoryProgressiveBlock,
  MemoryProgressiveSection,
  MemoryRouteFile,
  MemorySearchManager,
  MemorySearchResult,
} from "../../memory/types.js";
import { DEFAULT_AGENT_ID, parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { resolveMemorySearchConfig } from "../memory-search.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const MemorySearchSchema = Type.Object({
  query: Type.String(),
  maxResults: Type.Optional(Type.Number()),
  minScore: Type.Optional(Type.Number()),
});

const MemoryGetSchema = Type.Object({
  path: Type.String(),
  from: Type.Optional(Type.Number()),
  lines: Type.Optional(Type.Number()),
});

const MemoryOutlineSchema = Type.Object({
  path: Type.Optional(Type.String()),
  maxSections: Type.Optional(Type.Number()),
  previewChars: Type.Optional(Type.Number()),
});

const MemoryRouteSchema = Type.Object({
  query: Type.String(),
  path: Type.Optional(Type.String()),
  maxResults: Type.Optional(Type.Number()),
  maxBlocksPerSection: Type.Optional(Type.Number()),
  previewChars: Type.Optional(Type.Number()),
});

const MEMORY_SEARCH_DEFAULT_MAX_RESULTS = 3;
const MEMORY_SEARCH_HARD_MAX_RESULTS = 4;
const MEMORY_SEARCH_SNIPPET_MAX_CHARS = 420;
const MEMORY_OUTLINE_DEFAULT_MAX_SECTIONS = 18;
const MEMORY_OUTLINE_PATH_MAX_SECTIONS = 36;
const MEMORY_OUTLINE_HARD_MAX_SECTIONS = 40;
const MEMORY_OUTLINE_DEFAULT_PREVIEW_CHARS = 120;
const MEMORY_OUTLINE_HARD_PREVIEW_CHARS = 180;
const MEMORY_ROUTE_DEFAULT_MAX_RESULTS = 3;
const MEMORY_ROUTE_HARD_MAX_RESULTS = 4;
const MEMORY_ROUTE_DEFAULT_BLOCKS = 1;
const MEMORY_ROUTE_HARD_BLOCKS = 2;
const MEMORY_ROUTE_DEFAULT_PREVIEW_CHARS = 180;
const MEMORY_ROUTE_HARD_PREVIEW_CHARS = 240;
const MEMORY_GET_DEFAULT_LINES = 80;
const MEMORY_GET_HARD_MAX_LINES = 120;
const MEMORY_SCOPED_FILE_HARD_MAX = 4;

function resolveMemoryToolContext(options: { config?: OpenClawConfig; agentSessionKey?: string }) {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }
  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
  if (!resolveMemorySearchConfig(cfg, agentId)) {
    return null;
  }
  return { cfg, agentId };
}

type ScopedMemoryManager = {
  scope: "tenant" | "agent";
  manager: MemorySearchManager;
};

async function resolveScopedMemoryManagers(options: {
  cfg: OpenClawConfig;
  agentId: string;
  agentWorkspaceDir?: string;
  agentDefaultStorePath?: string;
  tenantWorkspaceDir?: string;
  tenantDefaultStorePath?: string;
}): Promise<{ managers: ScopedMemoryManager[]; error?: string }> {
  const managers: ScopedMemoryManager[] = [];
  const errors: string[] = [];

  if (options.tenantWorkspaceDir && options.tenantDefaultStorePath) {
    const { manager, error } = await getMemorySearchManager({
      cfg: options.cfg,
      agentId: DEFAULT_AGENT_ID,
      workspaceDir: options.tenantWorkspaceDir,
      defaultStorePath: options.tenantDefaultStorePath,
    });
    if (manager) {
      managers.push({ scope: "tenant", manager });
    } else if (error) {
      errors.push(`tenant: ${error}`);
    }
  }

  const { manager, error } = await getMemorySearchManager({
    cfg: options.cfg,
    agentId: options.agentId,
    workspaceDir: options.agentWorkspaceDir,
    defaultStorePath: options.agentDefaultStorePath,
  });
  if (manager) {
    managers.push({ scope: "agent", manager });
  } else if (error) {
    errors.push(`agent: ${error}`);
  }

  return { managers, error: errors.length > 0 ? errors.join("; ") : undefined };
}

function decorateScope(
  results: MemorySearchResult[],
  scope: "tenant" | "agent",
  prefixPath: boolean,
): MemorySearchResult[] {
  const prefix = scope === "tenant" ? "tenant/" : "knowledge/";
  const sourceLabel = scope === "tenant" ? "Enterprise Memory" : "Agent Knowledge";
  return results.map((entry) => ({
    ...entry,
    path: prefixPath && !entry.path.startsWith(prefix) ? `${prefix}${entry.path}` : entry.path,
    ...(prefixPath ? { scope, sourceLabel } : {}),
  }));
}

async function searchScopedMemory(params: {
  managers: ScopedMemoryManager[];
  query: string;
  maxResults?: number;
  defaultMaxResults: number;
  minScore?: number;
  sessionKey?: string;
}): Promise<MemorySearchResult[]> {
  const maxResults = clampIntParam(
    params.maxResults,
    Math.min(params.defaultMaxResults, MEMORY_SEARCH_DEFAULT_MAX_RESULTS),
    1,
    MEMORY_SEARCH_HARD_MAX_RESULTS,
  );
  const tenant = params.managers.find((entry) => entry.scope === "tenant");
  const agent = params.managers.find((entry) => entry.scope === "agent");
  const scopedTenantSearch = Boolean(tenant);
  const results: MemorySearchResult[] = [];

  if (tenant) {
    const tenantLimit = Math.min(2, maxResults);
    const tenantResults = await tenant.manager.search(params.query, {
      maxResults: tenantLimit,
      minScore: params.minScore,
      sessionKey: params.sessionKey,
    });
    results.push(...decorateScope(tenantResults, "tenant", true));
  }

  if (agent && results.length < maxResults) {
    const agentResults = await agent.manager.search(params.query, {
      maxResults: maxResults - results.length,
      minScore: params.minScore,
      sessionKey: params.sessionKey,
    });
    results.push(...decorateScope(agentResults, "agent", scopedTenantSearch));
  }

  return results.slice(0, maxResults);
}

function resolveScopedRead(params: {
  managers: ScopedMemoryManager[];
  relPath: string;
}): { manager: MemorySearchManager; relPath: string; scope: "tenant" | "agent" } | null {
  const tenant = params.managers.find((entry) => entry.scope === "tenant");
  const agent = params.managers.find((entry) => entry.scope === "agent");
  const rawPath = params.relPath.trim().replace(/\\/g, "/");
  if (rawPath.startsWith("tenant/")) {
    return tenant
      ? { manager: tenant.manager, relPath: rawPath.slice("tenant/".length), scope: "tenant" }
      : null;
  }
  if (rawPath.startsWith("knowledge/")) {
    return agent
      ? { manager: agent.manager, relPath: rawPath.slice("knowledge/".length), scope: "agent" }
      : null;
  }
  return agent ? { manager: agent.manager, relPath: rawPath, scope: "agent" } : null;
}

async function outlineScopedMemory(params: {
  managers: ScopedMemoryManager[];
  relPath?: string;
  maxSections?: number;
  previewChars?: number;
}) {
  const hasPath = Boolean(params.relPath?.trim());
  const maxSections = clampIntParam(
    params.maxSections,
    hasPath ? MEMORY_OUTLINE_PATH_MAX_SECTIONS : MEMORY_OUTLINE_DEFAULT_MAX_SECTIONS,
    1,
    MEMORY_OUTLINE_HARD_MAX_SECTIONS,
  );
  const previewChars = clampIntParam(
    params.previewChars,
    MEMORY_OUTLINE_DEFAULT_PREVIEW_CHARS,
    40,
    MEMORY_OUTLINE_HARD_PREVIEW_CHARS,
  );

  if (hasPath) {
    const relPath = params.relPath ?? "";
    const scoped = resolveScopedRead({ managers: params.managers, relPath });
    if (!scoped?.manager.outline) {
      return null;
    }
    const result = await scoped.manager.outline({
      relPath: scoped.relPath,
      maxSections,
      previewChars,
    });
    const scopedTenantRead = params.managers.some((entry) => entry.scope === "tenant");
    const prefix = scoped.scope === "tenant" ? "tenant/" : "knowledge/";
    const shouldPrefix = scoped.scope === "tenant" || scopedTenantRead;
    return clampOutlineResult({
      files: result.files.map((file) => ({
        ...file,
        path: shouldPrefix && !file.path.startsWith(prefix) ? `${prefix}${file.path}` : file.path,
        scope: scoped.scope,
        sourceLabel: scoped.scope === "tenant" ? "Enterprise Memory" : "Agent Knowledge",
      })),
    });
  }

  const scopedTenantRead = params.managers.some((entry) => entry.scope === "tenant");
  const files = [];
  for (const entry of params.managers) {
    if (!entry.manager.outline) {
      continue;
    }
    const result = await entry.manager.outline({ maxSections, previewChars });
    const prefix = entry.scope === "tenant" ? "tenant/" : "knowledge/";
    const shouldPrefix = entry.scope === "tenant" || scopedTenantRead;
    files.push(
      ...result.files.map((file) => ({
        ...file,
        path: shouldPrefix && !file.path.startsWith(prefix) ? `${prefix}${file.path}` : file.path,
        scope: entry.scope,
        sourceLabel: entry.scope === "tenant" ? "Enterprise Memory" : "Agent Knowledge",
      })),
    );
  }
  return clampOutlineResult({ files });
}

async function routeScopedMemory(params: {
  managers: ScopedMemoryManager[];
  query: string;
  relPath?: string;
  maxResults?: number;
  maxBlocksPerSection?: number;
  previewChars?: number;
}) {
  const maxResults = clampIntParam(
    params.maxResults,
    MEMORY_ROUTE_DEFAULT_MAX_RESULTS,
    1,
    MEMORY_ROUTE_HARD_MAX_RESULTS,
  );
  const maxBlocksPerSection = clampIntParam(
    params.maxBlocksPerSection,
    MEMORY_ROUTE_DEFAULT_BLOCKS,
    0,
    MEMORY_ROUTE_HARD_BLOCKS,
  );
  const previewChars = clampIntParam(
    params.previewChars,
    MEMORY_ROUTE_DEFAULT_PREVIEW_CHARS,
    40,
    MEMORY_ROUTE_HARD_PREVIEW_CHARS,
  );

  if (params.relPath?.trim()) {
    const relPath = params.relPath;
    const scoped = resolveScopedRead({ managers: params.managers, relPath });
    if (!scoped?.manager.route) {
      return null;
    }
    const result = await scoped.manager.route({
      query: params.query,
      relPath: scoped.relPath,
      maxResults,
      maxBlocksPerSection,
      previewChars,
    });
    const scopedTenantRead = params.managers.some((entry) => entry.scope === "tenant");
    const prefix = scoped.scope === "tenant" ? "tenant/" : "knowledge/";
    const shouldPrefix = scoped.scope === "tenant" || scopedTenantRead;
    return clampRouteResult({
      files: result.files.map((file) => ({
        ...file,
        path: shouldPrefix && !file.path.startsWith(prefix) ? `${prefix}${file.path}` : file.path,
        scope: scoped.scope,
        sourceLabel: scoped.scope === "tenant" ? "Enterprise Memory" : "Agent Knowledge",
      })),
    });
  }

  const scopedTenantRead = params.managers.some((entry) => entry.scope === "tenant");
  const files = [];
  for (const entry of params.managers) {
    if (!entry.manager.route) {
      continue;
    }
    const result = await entry.manager.route({
      query: params.query,
      maxResults,
      maxBlocksPerSection,
      previewChars,
    });
    const prefix = entry.scope === "tenant" ? "tenant/" : "knowledge/";
    const shouldPrefix = entry.scope === "tenant" || scopedTenantRead;
    files.push(
      ...result.files.map((file) => ({
        ...file,
        path: shouldPrefix && !file.path.startsWith(prefix) ? `${prefix}${file.path}` : file.path,
        scope: entry.scope,
        sourceLabel: entry.scope === "tenant" ? "Enterprise Memory" : "Agent Knowledge",
      })),
    );
  }
  return clampRouteResult({ files });
}

export function createMemorySearchTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
  /** Override knowledge root (multi-tenant: tenants/{tid}/agents/{agentId}/knowledge/). */
  workspaceDir?: string;
  /** Override the default SQLite index path when memorySearch.store.path is not configured. */
  defaultStorePath?: string;
  /** Tenant-level enterprise memory root for scoped tenant-first retrieval. */
  tenantWorkspaceDir?: string;
  /** Tenant-level enterprise memory SQLite index path for scoped tenant-first retrieval. */
  tenantDefaultStorePath?: string;
}): AnyAgentTool | null {
  const ctx = resolveMemoryToolContext(options);
  if (!ctx) {
    return null;
  }
  const { cfg, agentId } = ctx;
  const settings = resolveMemorySearchConfig(cfg, agentId, {
    defaultStorePath: options.defaultStorePath,
  });
  return {
    label: "Memory Search",
    name: "memory_search",
    description:
      "Mandatory recall step: search enterprise and agent knowledge files before answering questions about prior work, decisions, dates, people, preferences, products, or todos; returns top snippets with path + lines. If response has disabled=true, memory retrieval is unavailable and should be surfaced to the user.",
    parameters: MemorySearchSchema,
    execute: async (_toolCallId, params) => {
      const query = readStringParam(params, "query", { required: true });
      const maxResults = readNumberParam(params, "maxResults");
      const minScore = readNumberParam(params, "minScore");
      const { managers, error } = await resolveScopedMemoryManagers({
        cfg,
        agentId,
        agentWorkspaceDir: options.workspaceDir,
        agentDefaultStorePath: options.defaultStorePath,
        tenantWorkspaceDir: options.tenantWorkspaceDir,
        tenantDefaultStorePath: options.tenantDefaultStorePath,
      });
      if (managers.length === 0) {
        return jsonResult(buildMemorySearchUnavailableResult(error));
      }
      try {
        const citationsMode = resolveMemoryCitationsMode(cfg);
        const includeCitations = shouldIncludeCitations({
          mode: citationsMode,
          sessionKey: options.agentSessionKey,
        });
        const rawResults = await searchScopedMemory({
          managers,
          query,
          maxResults,
          minScore,
          sessionKey: options.agentSessionKey,
          defaultMaxResults: settings?.query.maxResults ?? 6,
        });
        const status = managers[managers.length - 1].manager.status();
        const compactResults = clampMemorySearchResults(rawResults);
        const decorated = decorateCitations(compactResults, includeCitations);
        const resolved = resolveMemoryBackendConfig({
          cfg,
          agentId,
          workspaceDir: options.workspaceDir,
        });
        const results =
          status.backend === "qmd"
            ? clampResultsByInjectedChars(decorated, resolved.qmd?.limits.maxInjectedChars)
            : decorated;
        const searchMode = (status.custom as { searchMode?: string } | undefined)?.searchMode;
        return jsonResult({
          results,
          provider: status.provider,
          model: status.model,
          fallback: status.fallback,
          citations: citationsMode,
          mode: searchMode,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult(buildMemorySearchUnavailableResult(message));
      }
    },
  };
}

export function createMemoryOutlineTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
  /** Override knowledge root (multi-tenant: tenants/{tid}/agents/{agentId}/knowledge/). */
  workspaceDir?: string;
  /** Override the default SQLite index path when memorySearch.store.path is not configured. */
  defaultStorePath?: string;
  /** Tenant-level enterprise memory root for scoped reads. */
  tenantWorkspaceDir?: string;
  /** Tenant-level enterprise memory SQLite index path for scoped reads. */
  tenantDefaultStorePath?: string;
}): AnyAgentTool | null {
  const ctx = resolveMemoryToolContext(options);
  if (!ctx) {
    return null;
  }
  const { cfg, agentId } = ctx;
  return {
    label: "Memory Outline",
    name: "memory_outline",
    description:
      "Progressive retrieval step: inspect knowledge file outlines with section line ranges and short previews before deciding which exact lines to read with memory_get.",
    parameters: MemoryOutlineSchema,
    execute: async (_toolCallId, params) => {
      const relPath = readStringParam(params, "path");
      const maxSections = readNumberParam(params, "maxSections", { integer: true });
      const previewChars = readNumberParam(params, "previewChars", { integer: true });
      const { managers, error } = await resolveScopedMemoryManagers({
        cfg,
        agentId,
        agentWorkspaceDir: options.workspaceDir,
        agentDefaultStorePath: options.defaultStorePath,
        tenantWorkspaceDir: options.tenantWorkspaceDir,
        tenantDefaultStorePath: options.tenantDefaultStorePath,
      });
      if (managers.length === 0) {
        return jsonResult({ files: [], disabled: true, error });
      }
      try {
        const result = await outlineScopedMemory({
          managers,
          relPath,
          maxSections,
          previewChars,
        });
        if (!result) {
          return jsonResult({ files: [], disabled: true, error: "path required" });
        }
        return jsonResult(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ files: [], disabled: true, error: message });
      }
    },
  };
}

export function createMemoryRouteTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
  /** Override knowledge root (multi-tenant: tenants/{tid}/agents/{agentId}/knowledge/). */
  workspaceDir?: string;
  /** Override the default SQLite index path when memorySearch.store.path is not configured. */
  defaultStorePath?: string;
  /** Tenant-level enterprise memory root for scoped reads. */
  tenantWorkspaceDir?: string;
  /** Tenant-level enterprise memory SQLite index path for scoped reads. */
  tenantDefaultStorePath?: string;
}): AnyAgentTool | null {
  const ctx = resolveMemoryToolContext(options);
  if (!ctx) {
    return null;
  }
  const { cfg, agentId } = ctx;
  return {
    label: "Memory Route",
    name: "memory_route",
    description:
      "Progressive retrieval router: route a question through knowledge document sections, summaries, keywords, and local blocks before reading exact lines with memory_get.",
    parameters: MemoryRouteSchema,
    execute: async (_toolCallId, params) => {
      const query = readStringParam(params, "query", { required: true });
      const relPath = readStringParam(params, "path");
      const maxResults = readNumberParam(params, "maxResults", { integer: true });
      const maxBlocksPerSection = readNumberParam(params, "maxBlocksPerSection", {
        integer: true,
      });
      const previewChars = readNumberParam(params, "previewChars", { integer: true });
      const { managers, error } = await resolveScopedMemoryManagers({
        cfg,
        agentId,
        agentWorkspaceDir: options.workspaceDir,
        agentDefaultStorePath: options.defaultStorePath,
        tenantWorkspaceDir: options.tenantWorkspaceDir,
        tenantDefaultStorePath: options.tenantDefaultStorePath,
      });
      if (managers.length === 0) {
        return jsonResult({ files: [], disabled: true, error });
      }
      try {
        const result = await routeScopedMemory({
          managers,
          query,
          relPath,
          maxResults,
          maxBlocksPerSection,
          previewChars,
        });
        if (!result) {
          return jsonResult({ files: [], disabled: true, error: "path required" });
        }
        return jsonResult(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ files: [], disabled: true, error: message });
      }
    },
  };
}

export function createMemoryGetTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
  /** Override knowledge root (multi-tenant: tenants/{tid}/agents/{agentId}/knowledge/). */
  workspaceDir?: string;
  /** Override the default SQLite index path when memorySearch.store.path is not configured. */
  defaultStorePath?: string;
  /** Tenant-level enterprise memory root for scoped reads. */
  tenantWorkspaceDir?: string;
  /** Tenant-level enterprise memory SQLite index path for scoped reads. */
  tenantDefaultStorePath?: string;
}): AnyAgentTool | null {
  const ctx = resolveMemoryToolContext(options);
  if (!ctx) {
    return null;
  }
  const { cfg, agentId } = ctx;
  return {
    label: "Memory Get",
    name: "memory_get",
    description:
      "Safe snippet read from enterprise or agent knowledge files with optional from/lines; use after memory_search/memory_route to pull only the needed lines and keep context small.",
    parameters: MemoryGetSchema,
    execute: async (_toolCallId, params) => {
      const relPath = readStringParam(params, "path", { required: true });
      const from = readNumberParam(params, "from", { integer: true });
      const lines = readNumberParam(params, "lines", { integer: true });
      const resolvedLines =
        from !== undefined || lines !== undefined
          ? clampIntParam(lines, MEMORY_GET_DEFAULT_LINES, 1, MEMORY_GET_HARD_MAX_LINES)
          : undefined;
      const { managers, error } = await resolveScopedMemoryManagers({
        cfg,
        agentId,
        agentWorkspaceDir: options.workspaceDir,
        agentDefaultStorePath: options.defaultStorePath,
        tenantWorkspaceDir: options.tenantWorkspaceDir,
        tenantDefaultStorePath: options.tenantDefaultStorePath,
      });
      if (managers.length === 0) {
        return jsonResult({ path: relPath, text: "", disabled: true, error });
      }
      try {
        const scoped = resolveScopedRead({ managers, relPath });
        if (!scoped) {
          return jsonResult({ path: relPath, text: "", disabled: true, error: "path required" });
        }
        const result = await scoped.manager.readFile({
          relPath: scoped.relPath,
          from: from ?? undefined,
          lines: resolvedLines,
        });
        const scopedTenantRead = managers.some((entry) => entry.scope === "tenant");
        const prefix = scoped.scope === "tenant" ? "tenant/" : "knowledge/";
        const shouldPrefix = scoped.scope === "tenant" || scopedTenantRead;
        return jsonResult({
          ...result,
          path:
            shouldPrefix && !result.path.startsWith(prefix)
              ? `${prefix}${result.path}`
              : result.path,
          ...(shouldPrefix
            ? {
                scope: scoped.scope,
                sourceLabel: scoped.scope === "tenant" ? "Enterprise Memory" : "Agent Knowledge",
              }
            : {}),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ path: relPath, text: "", disabled: true, error: message });
      }
    },
  };
}

function resolveMemoryCitationsMode(cfg: OpenClawConfig): MemoryCitationsMode {
  const mode = cfg.memory?.citations;
  if (mode === "on" || mode === "off" || mode === "auto") {
    return mode;
  }
  return "auto";
}

function decorateCitations(results: MemorySearchResult[], include: boolean): MemorySearchResult[] {
  if (!include) {
    return results.map((entry) => ({ ...entry, citation: undefined }));
  }
  return results.map((entry) => {
    const citation = formatCitation(entry);
    const snippet = `${entry.snippet.trim()}\n\nSource: ${citation}`;
    return { ...entry, citation, snippet };
  });
}

function formatCitation(entry: MemorySearchResult): string {
  const lineRange =
    entry.startLine === entry.endLine
      ? `#L${entry.startLine}`
      : `#L${entry.startLine}-L${entry.endLine}`;
  return `${entry.path}${lineRange}`;
}

function clampResultsByInjectedChars(
  results: MemorySearchResult[],
  budget?: number,
): MemorySearchResult[] {
  if (!budget || budget <= 0) {
    return results;
  }
  let remaining = budget;
  const clamped: MemorySearchResult[] = [];
  for (const entry of results) {
    if (remaining <= 0) {
      break;
    }
    const snippet = entry.snippet ?? "";
    if (snippet.length <= remaining) {
      clamped.push(entry);
      remaining -= snippet.length;
    } else {
      const trimmed = snippet.slice(0, Math.max(0, remaining));
      clamped.push({ ...entry, snippet: trimmed });
      break;
    }
  }
  return clamped;
}

function buildMemorySearchUnavailableResult(error: string | undefined) {
  const reason = (error ?? "memory search unavailable").trim() || "memory search unavailable";
  const isQuotaError = /insufficient_quota|quota|429/.test(reason.toLowerCase());
  const warning = isQuotaError
    ? "Memory search is unavailable because the embedding provider quota is exhausted."
    : "Memory search is unavailable due to an embedding/provider error.";
  const action = isQuotaError
    ? "Top up or switch embedding provider, then retry memory_search."
    : "Check embedding provider configuration and retry memory_search.";
  return {
    results: [],
    disabled: true,
    unavailable: true,
    error: reason,
    warning,
    action,
  };
}

function shouldIncludeCitations(params: {
  mode: MemoryCitationsMode;
  sessionKey?: string;
}): boolean {
  if (params.mode === "on") {
    return true;
  }
  if (params.mode === "off") {
    return false;
  }
  // auto: show citations in direct chats; suppress in groups/channels by default.
  const chatType = deriveChatTypeFromSessionKey(params.sessionKey);
  return chatType === "direct";
}

function deriveChatTypeFromSessionKey(sessionKey?: string): "direct" | "group" | "channel" {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed?.rest) {
    return "direct";
  }
  const tokens = new Set(parsed.rest.toLowerCase().split(":").filter(Boolean));
  if (tokens.has("channel")) {
    return "channel";
  }
  if (tokens.has("group")) {
    return "group";
  }
  return "direct";
}

function clampIntParam(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const intValue = Math.floor(raw);
  return Math.min(max, Math.max(min, intValue));
}

function truncateText(value: string | undefined, maxChars: number): string {
  const text = value ?? "";
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function clampMemorySearchResults(results: MemorySearchResult[]): MemorySearchResult[] {
  return results.slice(0, MEMORY_SEARCH_HARD_MAX_RESULTS).map((entry) => ({
    ...entry,
    snippet: truncateText(entry.snippet, MEMORY_SEARCH_SNIPPET_MAX_CHARS),
  }));
}

type ScopedOutlineFile = MemoryOutlineFile & {
  scope?: "tenant" | "agent";
  sourceLabel?: string;
};

type ScopedRouteFile = MemoryRouteFile & {
  scope?: "tenant" | "agent";
  sourceLabel?: string;
};

function clampOutlineResult(result: { files: ScopedOutlineFile[] }): {
  files: ScopedOutlineFile[];
} {
  return {
    files: result.files.slice(0, MEMORY_SCOPED_FILE_HARD_MAX).map((file) => ({
      ...file,
      sections: file.sections
        .slice(0, MEMORY_OUTLINE_HARD_MAX_SECTIONS)
        .map((section) => clampProgressiveSection(section, MEMORY_OUTLINE_HARD_PREVIEW_CHARS)),
    })),
  };
}

function clampRouteResult(result: { files: ScopedRouteFile[] }): { files: ScopedRouteFile[] } {
  return {
    files: result.files.slice(0, MEMORY_SCOPED_FILE_HARD_MAX).map((file) => ({
      ...file,
      matches: file.matches.slice(0, MEMORY_ROUTE_HARD_MAX_RESULTS).map((match) => ({
        ...match,
        section: clampProgressiveSection(match.section, MEMORY_ROUTE_HARD_PREVIEW_CHARS),
        blocks: match.blocks
          .slice(0, MEMORY_ROUTE_HARD_BLOCKS)
          .map((block) => clampProgressiveBlock(block)),
      })),
    })),
  };
}

function clampProgressiveSection(
  section: MemoryProgressiveSection,
  previewChars: number,
): MemoryProgressiveSection {
  const next = {
    ...section,
    preview: truncateText(section.preview, previewChars),
  };
  if ("summary" in section) {
    next.summary = truncateText(section.summary, previewChars);
  }
  return next;
}

function clampProgressiveBlock(block: MemoryProgressiveBlock): MemoryProgressiveBlock {
  return {
    ...block,
    preview: truncateText(block.preview, MEMORY_ROUTE_HARD_PREVIEW_CHARS),
  };
}
