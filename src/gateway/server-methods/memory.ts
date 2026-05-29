import fs from "node:fs/promises";
import path from "node:path";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { movePathToTrash } from "../../browser/trash.js";
import { loadConfig } from "../../config/config.js";
import {
  resolveTenantAgentKnowledgeDir,
  resolveTenantAgentMemoryIndexPath,
} from "../../config/sessions/tenant-paths.js";
import { isNotFoundPathError } from "../../infra/path-guards.js";
import {
  extractKnowledgeText,
  isEditableKnowledgeTextFile,
  isKnowledgeFilePath,
} from "../../memory/document-ingest.js";
import { getMemorySearchManager } from "../../memory/index.js";
import { buildFileEntry, listMemoryFiles } from "../../memory/internal.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../../routing/session-key.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateAgentsMemoryDeleteParams,
  validateAgentsMemoryGetParams,
  validateAgentsMemoryListParams,
  validateAgentsMemorySetParams,
  validateAgentsMemoryStatusParams,
} from "../protocol/index.js";
import { resolveRequestConfig } from "../tenant-session-utils.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";

function resolveAgentId(agentIdRaw: string) {
  if (agentIdRaw === "default") {
    return normalizeAgentId(DEFAULT_AGENT_ID) || DEFAULT_AGENT_ID;
  }
  return normalizeAgentId(agentIdRaw);
}

async function resolveAgentContext(
  rawAgentId: unknown,
  client?: GatewayRequestHandlerOptions["client"],
) {
  const tenant = client?.tenant;
  const cfg = tenant ? await resolveRequestConfig(tenant) : loadConfig();
  const idStr = typeof rawAgentId === "string" ? rawAgentId : "";
  const agentId = resolveAgentId(idStr);
  if (!agentId) {
    return null;
  }
  if (tenant?.tenantId) {
    const workspaceDir = resolveTenantAgentKnowledgeDir(tenant.tenantId, agentId);
    const defaultStorePath = resolveTenantAgentMemoryIndexPath(tenant.tenantId, agentId);
    return { cfg, agentId, workspaceDir, defaultStorePath, tenantId: tenant.tenantId };
  }
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  return { cfg, agentId, workspaceDir, defaultStorePath: undefined, tenantId: undefined };
}

async function syncAgentKnowledgeIndex(
  context: NonNullable<Awaited<ReturnType<typeof resolveAgentContext>>>,
  reason: string,
): Promise<void> {
  try {
    const { manager, error } = await getMemorySearchManager({
      cfg: context.cfg,
      agentId: context.agentId,
      workspaceDir: context.workspaceDir,
      defaultStorePath: context.defaultStorePath,
    });
    if (!manager) {
      console.warn(
        `[memory] index sync skipped for agent ${context.agentId}: ${error ?? "manager unavailable"}`,
      );
      return;
    }
    await manager.sync?.({ reason, force: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[memory] index sync failed for agent ${context.agentId}: ${message}`);
  }
}

function resolveMemoryIoPath(
  workspaceDir: string,
  reqPath: string,
): { target: string; rel: string } | null {
  const target = path.resolve(workspaceDir, reqPath);
  if (!isKnowledgeFilePath(target)) {
    return null;
  }
  // Ensure it's inside the workspace
  const rel = path.relative(workspaceDir, target).replace(/\\/g, "/");
  if (rel.startsWith("../") || path.isAbsolute(rel)) {
    return null;
  }
  if (rel === "MEMORY.md" || rel === "memory.md" || rel.startsWith("memory/")) {
    return { target, rel };
  }
  return null;
}

export const memoryHandlers: GatewayRequestHandlers = {
  "agents.memory.list": async ({ params, client, respond }) => {
    if (!validateAgentsMemoryListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid params: ${formatValidationErrors(validateAgentsMemoryListParams.errors)}`,
        ),
      );
      return;
    }

    const context = await resolveAgentContext(params.agentId, client);
    if (!context) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown agent id"));
      return;
    }

    const { agentId, workspaceDir } = context;
    const absPaths = await listMemoryFiles(workspaceDir);

    const files = [];
    for (const p of absPaths) {
      const entry = await buildFileEntry(p, workspaceDir);
      if (entry) {
        files.push({
          name: path.relative(workspaceDir, entry.absPath).replace(/\\/g, "/"),
          path: path.relative(workspaceDir, entry.absPath).replace(/\\/g, "/"),
          missing: false,
          size: entry.size,
          updatedAtMs: entry.mtimeMs,
        });
      }
    }

    respond(true, {
      agentId,
      workspaceDir,
      files,
    });
  },

  "agents.memory.get": async ({ params, client, respond }) => {
    if (!validateAgentsMemoryGetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          formatValidationErrors(validateAgentsMemoryGetParams.errors),
        ),
      );
      return;
    }

    const context = await resolveAgentContext(params.agentId, client);
    if (!context) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown agent id"));
      return;
    }

    const { agentId, workspaceDir } = context;
    const resolved = resolveMemoryIoPath(workspaceDir, params.name);
    if (!resolved) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid memory file path"));
      return;
    }

    const entry = await buildFileEntry(resolved.target, workspaceDir);
    if (!entry) {
      // Missing
      respond(true, {
        agentId,
        workspaceDir,
        file: {
          name: resolved.rel,
          path: resolved.rel,
          missing: true,
        },
      });
      return;
    }

    let content = "";
    try {
      content = isEditableKnowledgeTextFile(resolved.target)
        ? await fs.readFile(resolved.target, "utf-8")
        : (await extractKnowledgeText(resolved.target)).text;
    } catch (err) {
      if (!isNotFoundPathError(err)) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "failed to read file"));
        return;
      }
    }

    respond(true, {
      agentId,
      workspaceDir,
      file: {
        name: resolved.rel,
        path: resolved.rel,
        missing: false,
        size: entry.size,
        updatedAtMs: entry.mtimeMs,
        content,
        editable: isEditableKnowledgeTextFile(resolved.target),
      },
    });
  },

  "agents.memory.set": async ({ params, client, respond }) => {
    if (!validateAgentsMemorySetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          formatValidationErrors(validateAgentsMemorySetParams.errors),
        ),
      );
      return;
    }

    const context = await resolveAgentContext(params.agentId, client);
    if (!context) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown agent id"));
      return;
    }

    const { agentId, workspaceDir } = context;
    const resolved = resolveMemoryIoPath(workspaceDir, params.name);
    if (!resolved) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid memory file path"));
      return;
    }

    await fs.mkdir(path.dirname(resolved.target), { recursive: true });

    const rawParams = params as typeof params & { contentBase64?: string };
    if (rawParams.contentBase64) {
      await fs.writeFile(resolved.target, Buffer.from(rawParams.contentBase64, "base64"));
    } else {
      await fs.writeFile(resolved.target, params.content, "utf-8");
    }

    const entry = await buildFileEntry(resolved.target, workspaceDir);
    if (!entry) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "failed to stat written file"));
      return;
    }

    await syncAgentKnowledgeIndex(context, "agent-memory-file-set");

    respond(true, {
      ok: true,
      agentId,
      workspaceDir,
      file: {
        name: resolved.rel,
        path: resolved.rel,
        missing: false,
        size: entry.size,
        updatedAtMs: entry.mtimeMs,
        content: isEditableKnowledgeTextFile(resolved.target)
          ? params.content
          : (await extractKnowledgeText(resolved.target)).text,
        editable: isEditableKnowledgeTextFile(resolved.target),
      },
    });
  },

  "agents.memory.delete": async ({ params, client, respond }) => {
    if (!validateAgentsMemoryDeleteParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          formatValidationErrors(validateAgentsMemoryDeleteParams.errors),
        ),
      );
      return;
    }

    const context = await resolveAgentContext(params.agentId, client);
    if (!context) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown agent id"));
      return;
    }

    const { agentId, workspaceDir } = context;
    const resolved = resolveMemoryIoPath(workspaceDir, params.name);
    if (!resolved) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid memory file path"));
      return;
    }

    try {
      await movePathToTrash(resolved.target);
    } catch (err) {
      if (!isNotFoundPathError(err)) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "failed to delete file"));
        return;
      }
    }

    await syncAgentKnowledgeIndex(context, "agent-memory-delete");

    respond(true, {
      ok: true,
      agentId,
      name: resolved.rel,
    });
  },

  "agents.memory.status": async ({ params, client, respond }) => {
    if (!validateAgentsMemoryStatusParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          formatValidationErrors(validateAgentsMemoryStatusParams.errors),
        ),
      );
      return;
    }

    const context = await resolveAgentContext(params.agentId, client);
    if (!context) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown agent id"));
      return;
    }

    const { cfg, agentId, workspaceDir, defaultStorePath } = context;

    const { manager } = await getMemorySearchManager({
      cfg,
      agentId,
      workspaceDir,
      defaultStorePath,
    });
    let totalChunks = 0;
    let totalVectors = 0;

    if (manager) {
      try {
        const status = manager.status();
        totalChunks = status.chunks ?? 0;
        totalVectors = status.chunks ?? 0;
      } catch (err) {
        console.error(`Failed to get memory stats for agent ${agentId}:`, err);
      }
    }

    respond(true, {
      agentId,
      status: {
        totalChunks,
        totalVectors,
      },
    });
  },
};
