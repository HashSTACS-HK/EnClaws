/**
 * Gateway RPC handlers for tenant settings management.
 *
 * Methods:
 *   tenant.settings.get    - Get current tenant settings (name, identityPrompt)
 *   tenant.settings.update - Update tenant settings and sync IDENTITY.md to disk
 *   tenant.memory.get      - Get current tenant MEMORY.md content
 *   tenant.memory.update   - Update tenant MEMORY.md content
 *   tenant.memory.list     - List enterprise knowledge Markdown files
 *   tenant.memory.file.get - Get one enterprise knowledge Markdown file
 *   tenant.memory.file.set - Create/update one enterprise knowledge Markdown file
 *   tenant.memory.delete   - Delete one enterprise knowledge Markdown file
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { TenantContext } from "../../auth/middleware.js";
import { assertPermission, RbacError } from "../../auth/rbac.js";
import { movePathToTrash } from "../../browser/trash.js";
import {
  resolveTenantDir,
  resolveTenantMemoryIndexPath,
} from "../../config/sessions/tenant-paths.js";
import { isDbInitialized } from "../../db/index.js";
import { createAuditLog } from "../../db/models/audit-log.js";
import { getTenantById, updateTenant } from "../../db/models/tenant.js";
import { isNotFoundPathError } from "../../infra/path-guards.js";
import {
  extractKnowledgeText,
  isEditableKnowledgeTextFile,
  isKnowledgeFilePath,
} from "../../memory/document-ingest.js";
import { getMemorySearchManager } from "../../memory/index.js";
import { buildFileEntry, listMemoryFiles } from "../../memory/internal.js";
import { DEFAULT_AGENT_ID } from "../../routing/session-key.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { resolveRequestConfig } from "../tenant-session-utils.js";
import type { GatewayRequestHandlers, GatewayRequestHandlerOptions } from "./types.js";

const IDENTITY_FILENAME = "IDENTITY.md";
const MEMORY_FILENAME = "MEMORY.md";

function resolveTenantMemoryIoPath(
  tenantDir: string,
  reqPath: string,
): { target: string; rel: string } | null {
  const target = path.resolve(tenantDir, reqPath);
  if (!isKnowledgeFilePath(target)) {
    return null;
  }
  const rel = path.relative(tenantDir, target).replace(/\\/g, "/");
  if (rel.startsWith("../") || path.isAbsolute(rel)) {
    return null;
  }
  if (rel === "MEMORY.md" || rel === "memory.md" || rel.startsWith("memory/")) {
    return { target, rel };
  }
  return null;
}

function readTenantMemoryFileName(params: unknown): string | null {
  const raw = params as { name?: unknown; path?: unknown };
  const name = typeof raw?.name === "string" ? raw.name : raw?.path;
  return typeof name === "string" && name.trim() ? name : null;
}

function getTenantCtx(
  client: GatewayRequestHandlerOptions["client"],
  respond: GatewayRequestHandlerOptions["respond"],
): TenantContext | null {
  if (!isDbInitialized()) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "Multi-tenant mode not enabled"),
    );
    return null;
  }
  const tenant = (client as unknown as { tenant?: TenantContext })?.tenant;
  if (!tenant) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Authentication required"));
    return null;
  }
  return tenant;
}

/** Sync identityPrompt to the tenant's IDENTITY.md file on disk. */
async function syncTenantIdentityFile(tenantId: string, identityPrompt: string): Promise<void> {
  const tenantDir = resolveTenantDir(tenantId);
  await fs.mkdir(tenantDir, { recursive: true });
  const filePath = path.join(tenantDir, IDENTITY_FILENAME);
  if (identityPrompt.trim()) {
    await fs.writeFile(filePath, identityPrompt, "utf-8");
  } else {
    // If empty, remove the file so it doesn't inject empty content
    try {
      await fs.unlink(filePath);
    } catch {
      // File may not exist, ignore
    }
  }
}

async function syncTenantKnowledgeIndex(ctx: TenantContext, reason: string): Promise<void> {
  try {
    const cfg = await resolveRequestConfig(ctx);
    const { manager, error } = await getMemorySearchManager({
      cfg,
      agentId: DEFAULT_AGENT_ID,
      workspaceDir: resolveTenantDir(ctx.tenantId),
      defaultStorePath: resolveTenantMemoryIndexPath(ctx.tenantId),
    });
    if (!manager) {
      console.warn(
        `[memory] tenant index sync skipped for ${ctx.tenantId}: ${error ?? "manager unavailable"}`,
      );
      return;
    }
    await manager.sync?.({ reason, force: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[memory] tenant index sync failed for ${ctx.tenantId}: ${message}`);
  }
}

function scheduleTenantKnowledgeIndexSync(ctx: TenantContext, reason: string): void {
  void syncTenantKnowledgeIndex(ctx, reason);
}

export const tenantSettingsHandlers: GatewayRequestHandlers = {
  "tenant.settings.get": async ({ client, respond }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {
      return;
    }

    try {
      assertPermission(ctx.role, "tenant.read");
    } catch (err) {
      if (err instanceof RbacError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
        return;
      }
      throw err;
    }

    const tenant = await getTenantById(ctx.tenantId);
    if (!tenant) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Tenant not found"));
      return;
    }

    respond(true, {
      name: tenant.name,
      identityPrompt: tenant.identityPrompt,
    });
  },

  "tenant.settings.update": async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {
      return;
    }

    try {
      assertPermission(ctx.role, "tenant.update");
    } catch (err) {
      if (err instanceof RbacError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
        return;
      }
      throw err;
    }

    const { name, identityPrompt } = params as {
      name?: string;
      identityPrompt?: string;
    };

    const updates: Record<string, unknown> = {};
    if (name !== undefined) {
      updates.name = name;
    }
    if (identityPrompt !== undefined) {
      updates.identityPrompt = identityPrompt;
    }

    if (Object.keys(updates).length === 0) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_PARAMS, "No fields to update"));
      return;
    }

    const updated = await updateTenant(ctx.tenantId, updates as any);
    if (!updated) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Tenant not found"));
      return;
    }

    // Sync IDENTITY.md to disk
    if (identityPrompt !== undefined) {
      await syncTenantIdentityFile(ctx.tenantId, identityPrompt);
    }

    await createAuditLog({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: "tenant.settings.update",
      resource: `tenant:${ctx.tenantId}`,
      detail: { name, hasIdentityPrompt: identityPrompt !== undefined },
    });

    respond(true, {
      name: updated.name,
      identityPrompt: updated.identityPrompt,
    });
  },

  "tenant.memory.get": async ({ client, respond }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {
      return;
    }

    try {
      assertPermission(ctx.role, "tenant.read");
    } catch (err) {
      if (err instanceof RbacError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
        return;
      }
      throw err;
    }

    const tenantDir = resolveTenantDir(ctx.tenantId);
    const memoryPath = path.join(tenantDir, MEMORY_FILENAME);
    let content = "";
    try {
      content = await fs.readFile(memoryPath, "utf-8");
    } catch {
      // File may not exist yet
    }

    respond(true, { content });
  },

  "tenant.memory.update": async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {
      return;
    }

    try {
      assertPermission(ctx.role, "tenant.update");
    } catch (err) {
      if (err instanceof RbacError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
        return;
      }
      throw err;
    }

    const { content } = params as { content?: string };
    if (content === undefined) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_PARAMS, "content is required"));
      return;
    }

    const tenantDir = resolveTenantDir(ctx.tenantId);
    await fs.mkdir(tenantDir, { recursive: true });
    const memoryPath = path.join(tenantDir, MEMORY_FILENAME);

    if (content.trim()) {
      await fs.writeFile(memoryPath, content, "utf-8");
    } else {
      try {
        await fs.unlink(memoryPath);
      } catch {
        // File may not exist
      }
    }

    await createAuditLog({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: "tenant.memory.update",
      resource: `tenant:${ctx.tenantId}`,
      detail: { contentLength: content.length },
    });

    await syncTenantKnowledgeIndex(ctx, "tenant-memory-update");

    respond(true, { content });
  },

  "tenant.memory.list": async ({ client, respond }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {
      return;
    }

    try {
      assertPermission(ctx.role, "tenant.read");
    } catch (err) {
      if (err instanceof RbacError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
        return;
      }
      throw err;
    }

    const tenantDir = resolveTenantDir(ctx.tenantId);
    const absPaths = await listMemoryFiles(tenantDir);
    const files = [];
    for (const absPath of absPaths) {
      const entry = await buildFileEntry(absPath, tenantDir);
      if (!entry) {
        continue;
      }
      const rel = path.relative(tenantDir, entry.absPath).replace(/\\/g, "/");
      files.push({
        name: rel,
        path: rel,
        missing: false,
        size: entry.size,
        updatedAtMs: entry.mtimeMs,
      });
    }

    respond(true, {
      workspace: tenantDir,
      files,
    });
  },

  "tenant.memory.file.get": async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {
      return;
    }

    try {
      assertPermission(ctx.role, "tenant.read");
    } catch (err) {
      if (err instanceof RbacError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
        return;
      }
      throw err;
    }

    const name = readTenantMemoryFileName(params);
    if (!name) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_PARAMS, "name is required"));
      return;
    }
    const tenantDir = resolveTenantDir(ctx.tenantId);
    const resolved = resolveTenantMemoryIoPath(tenantDir, name);
    if (!resolved) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid memory file path"));
      return;
    }

    const entry = await buildFileEntry(resolved.target, tenantDir);
    if (!entry) {
      respond(true, {
        workspace: tenantDir,
        file: { name: resolved.rel, path: resolved.rel, missing: true },
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
      workspace: tenantDir,
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

  "tenant.memory.file.set": async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {
      return;
    }

    try {
      assertPermission(ctx.role, "tenant.update");
    } catch (err) {
      if (err instanceof RbacError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
        return;
      }
      throw err;
    }

    const raw = params as { name?: unknown; content?: unknown; contentBase64?: unknown };
    const name = readTenantMemoryFileName(params);
    if (!name || (typeof raw.content !== "string" && typeof raw.contentBase64 !== "string")) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_PARAMS, "name and content are required"),
      );
      return;
    }

    const tenantDir = resolveTenantDir(ctx.tenantId);
    const resolved = resolveTenantMemoryIoPath(tenantDir, name);
    if (!resolved) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid memory file path"));
      return;
    }

    await fs.mkdir(path.dirname(resolved.target), { recursive: true });
    if (typeof raw.contentBase64 === "string") {
      await fs.writeFile(resolved.target, Buffer.from(raw.contentBase64, "base64"));
    } else {
      await fs.writeFile(resolved.target, String(raw.content ?? ""), "utf-8");
    }

    const entry = await buildFileEntry(resolved.target, tenantDir);
    if (!entry) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "failed to stat written file"));
      return;
    }

    await createAuditLog({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: "tenant.memory.file.set",
      resource: `tenant:${ctx.tenantId}:memory:${resolved.rel}`,
      detail: {
        contentLength:
          typeof raw.content === "string"
            ? raw.content.length
            : String(raw.contentBase64 ?? "").length,
      },
    });

    scheduleTenantKnowledgeIndexSync(ctx, "tenant-memory-file-set");

    respond(true, {
      ok: true,
      workspace: tenantDir,
      file: {
        name: resolved.rel,
        path: resolved.rel,
        missing: false,
        size: entry.size,
        updatedAtMs: entry.mtimeMs,
        editable: isEditableKnowledgeTextFile(resolved.target),
      },
    });
  },

  "tenant.memory.delete": async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {
      return;
    }

    try {
      assertPermission(ctx.role, "tenant.update");
    } catch (err) {
      if (err instanceof RbacError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
        return;
      }
      throw err;
    }

    const name = readTenantMemoryFileName(params);
    if (!name) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_PARAMS, "name is required"));
      return;
    }
    const tenantDir = resolveTenantDir(ctx.tenantId);
    const resolved = resolveTenantMemoryIoPath(tenantDir, name);
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

    await createAuditLog({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: "tenant.memory.delete",
      resource: `tenant:${ctx.tenantId}:memory:${resolved.rel}`,
      detail: {},
    });

    scheduleTenantKnowledgeIndexSync(ctx, "tenant-memory-delete");

    respond(true, { ok: true, name: resolved.rel });
  },
};
