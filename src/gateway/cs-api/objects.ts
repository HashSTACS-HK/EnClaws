/**
 * CRUD handlers for CS API Objects (Agenora S2 integration credentials).
 *
 * Routes:
 *   POST   /api/cs-api/objects              — create (returns one-time secret)
 *   GET    /api/cs-api/objects              — list
 *   GET    /api/cs-api/objects/:id          — get
 *   PATCH  /api/cs-api/objects/:id          — update fields
 *   POST   /api/cs-api/objects/:id/regenerate-secret
 *   DELETE /api/cs-api/objects/:id
 *
 * 所有写操作需要 owner/admin 权限，返回时均进行 tenant 隔离。
 */

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import bcrypt from "bcryptjs";
import { Value } from "@sinclair/typebox/value";
import { tryJwtAuth } from "../../auth/middleware.js";
import { createCsApiObject, getCsApiObjectById, listCsApiObjects, updateCsApiObject, rotateCsApiObjectSecret, deleteCsApiObject } from "../../db/models/cs-api-object.js";
import { createAuditLog } from "../../db/models/audit-log.js";
import { countActiveSessionsForApiObject } from "../../db/models/cs-session.js";
import { CreateObjectInput, UpdateObjectInput } from "../protocol/schema/cs-api.js";
import { ErrorCodes } from "../protocol/schema/error-codes.js";
import { sendJson, sendError, readJsonBody } from "./http-helpers.js";
import type { TenantContext } from "../../auth/middleware.js";

// ── Secret helpers ────────────────────────────────────────────────────────────

const BCRYPT_ROUNDS = 10;

/**
 * Generate a plaintext secret in the form `agnr_secret_<48 hex chars>`.
 * 生成明文 secret。
 */
function generateSecret(): string {
  return `agnr_secret_${randomBytes(24).toString("hex")}`;
}

/**
 * Derive the public endpoint URL for a given appId.
 * Priority: AGENORA_BASE_URL (explicit) > ENCLAWS_GATEWAY_PORT (env) > 19001 (dev default).
 * 根据 appId 推导 endpoint URL：优先读 AGENORA_BASE_URL，回退到本地 gateway 端口。
 */
export function endpointUrlFor(appId: string): string {
  const base =
    process.env.AGENORA_BASE_URL ??
    `http://localhost:${process.env.ENCLAWS_GATEWAY_PORT ?? "19001"}`;
  return `${base}/api/cs-api/${appId}`;
}

// ── Auth helper ───────────────────────────────────────────────────────────────

/**
 * Require an owner or admin JWT. Returns the tenant context or null (response already sent).
 * 要求 owner/admin JWT，失败时直接响应并返回 null。
 */
async function requireAdmin(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<TenantContext | null> {
  const auth = await tryJwtAuth(req);
  if (!auth?.ok || !auth.tenant) {
    sendError(res, 401, ErrorCodes.UNAUTHORIZED, "Login required");
    return null;
  }
  const { role } = auth.tenant;
  if (role !== "owner" && role !== "admin") {
    sendError(res, 403, "FORBIDDEN", "Owner or admin required");
    return null;
  }
  return auth.tenant;
}

// ── Handlers ──────────────────────────────────────────────────────────────────

/**
 * POST /api/cs-api/objects
 * Create a new API object and return the one-time plaintext secret.
 * 创建 API 对象，返回一次性明文 secret。
 */
export async function createObject(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const tenant = await requireAdmin(req, res);
  if (!tenant) { return; }

  const body = await readJsonBody(req);
  if (!Value.Check(CreateObjectInput, body)) {
    sendError(res, 400, ErrorCodes.INVALID_REQUEST, "Invalid body shape");
    return;
  }

  const plainSecret = generateSecret();
  const secretHash = await bcrypt.hash(plainSecret, BCRYPT_ROUNDS);
  const { tenantId, userId } = tenant;

  // Create the record; appId is generated inside createCsApiObject.
  // We pass a sentinel endpoint URL — it gets overwritten below once we have appId.
  const obj = await createCsApiObject({
    tenantId,
    name: body.name,
    description: body.description,
    agentId: body.agentId,
    appSecretHash: secretHash,
    endpointUrl: "pending",
  });

  // Derive endpoint URL dynamically from appId (column stores "pending" sentinel; see backlog).
  const realEndpoint = endpointUrlFor(obj.appId);

  void createAuditLog({
    tenantId,
    userId,
    action: "cs.api-object.create",
    resource: obj.id,
    detail: { name: obj.name, agentId: obj.agentId, appId: obj.appId },
  });

  sendJson(res, 201, {
    id: obj.id,
    appId: obj.appId,
    appSecret: plainSecret,
    endpointUrl: realEndpoint,
    isActive: obj.isActive,
    createdAt: obj.createdAt instanceof Date ? obj.createdAt.toISOString() : obj.createdAt,
  });
}

/**
 * GET /api/cs-api/objects
 * List all API objects for the authenticated tenant.
 * 列出当前 tenant 的所有 API 对象。
 */
export async function listObjects(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const tenant = await requireAdmin(req, res);
  if (!tenant) { return; }

  const objects = await listCsApiObjects(tenant.tenantId);
  sendJson(res, 200, {
    objects: objects.map((o) => ({
      id: o.id,
      name: o.name,
      agentId: o.agentId,
      appId: o.appId,
      isActive: o.isActive,
      createdAt: o.createdAt instanceof Date ? o.createdAt.toISOString() : o.createdAt,
      lastUsedAt:
        o.lastUsedAt instanceof Date
          ? o.lastUsedAt.toISOString()
          : (o.lastUsedAt ?? null),
    })),
  });
}

/**
 * GET /api/cs-api/objects/:id
 * Get a single API object by ID.
 * 获取单个 API 对象详情。
 */
export async function getObject(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
): Promise<void> {
  const tenant = await requireAdmin(req, res);
  if (!tenant) { return; }

  const obj = await getCsApiObjectById(id, tenant.tenantId);
  if (!obj) {
    sendError(res, 404, ErrorCodes.OBJECT_NOT_FOUND, "API object not found");
    return;
  }

  sendJson(res, 200, {
    id: obj.id,
    name: obj.name,
    description: obj.description ?? null,
    agentId: obj.agentId,
    appId: obj.appId,
    isActive: obj.isActive,
    endpointUrl: endpointUrlFor(obj.appId),
    appSecretMask: "agnr_secret_****", // static mask — real secret not stored plaintext, only bcrypt hash
    lastUsedAt:
      obj.lastUsedAt instanceof Date
        ? obj.lastUsedAt.toISOString()
        : (obj.lastUsedAt ?? null),
  });
}

/**
 * PATCH /api/cs-api/objects/:id
 * Update mutable fields on an API object.
 * 更新 API 对象的可变字段。
 */
export async function patchObject(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
): Promise<void> {
  const tenant = await requireAdmin(req, res);
  if (!tenant) { return; }

  const body = await readJsonBody(req);
  if (!Value.Check(UpdateObjectInput, body)) {
    sendError(res, 400, ErrorCodes.INVALID_REQUEST, "Invalid body shape");
    return;
  }

  const { tenantId, userId } = tenant;
  const obj = await updateCsApiObject(id, tenantId, {
    name: body.name,
    description: body.description,
    agentId: body.agentId,
    isActive: body.isActive,
  });

  if (!obj) {
    sendError(res, 404, ErrorCodes.OBJECT_NOT_FOUND, "API object not found");
    return;
  }

  void createAuditLog({
    tenantId,
    userId,
    action: "cs.api-object.update",
    resource: id,
    detail: body as Record<string, unknown>,
  });

  sendJson(res, 200, {
    id: obj.id,
    name: obj.name,
    description: obj.description ?? null,
    agentId: obj.agentId,
    appId: obj.appId,
    isActive: obj.isActive,
    updatedAt: obj.updatedAt instanceof Date ? obj.updatedAt.toISOString() : obj.updatedAt,
  });
}

/**
 * POST /api/cs-api/objects/:id/regenerate-secret
 * Rotate the app secret with a 24-hour grace window for the old secret.
 * 轮换 secret，旧 secret 保留 24 小时宽限期。
 */
export async function regenerateSecret(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
): Promise<void> {
  const tenant = await requireAdmin(req, res);
  if (!tenant) { return; }

  const { tenantId, userId } = tenant;

  // Verify object exists and belongs to tenant.
  const existing = await getCsApiObjectById(id, tenantId);
  if (!existing) {
    sendError(res, 404, ErrorCodes.OBJECT_NOT_FOUND, "API object not found");
    return;
  }

  const plainSecret = generateSecret();
  const newHash = await bcrypt.hash(plainSecret, BCRYPT_ROUNDS);
  const graceUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);

  // 4-arg signature: (id, tenantId, newHash, rotatingUntil)
  await rotateCsApiObjectSecret(id, tenantId, newHash, graceUntil);

  void createAuditLog({
    tenantId,
    userId,
    action: "cs.api-object.regenerate-secret",
    resource: id,
    detail: { graceUntil: graceUntil.toISOString() },
  });

  sendJson(res, 200, {
    appSecret: plainSecret,
    rotatingFromExpiresAt: graceUntil.toISOString(),
  });
}

/**
 * DELETE /api/cs-api/objects/:id
 * Delete an API object. Blocked if active sessions exist.
 * 删除 API 对象。有活跃会话时拒绝删除。
 */
export async function deleteObject(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
): Promise<void> {
  const tenant = await requireAdmin(req, res);
  if (!tenant) { return; }

  const { tenantId, userId } = tenant;

  // Guard: reject if there are active sessions.
  const activeCount = await countActiveSessionsForApiObject(tenantId, id);
  if (activeCount > 0) {
    sendError(
      res,
      409,
      ErrorCodes.OBJECT_HAS_ACTIVE_SESSIONS,
      "Cannot delete object with active sessions",
    );
    return;
  }

  const deleted = await deleteCsApiObject(id, tenantId);
  if (!deleted) {
    sendError(res, 404, ErrorCodes.OBJECT_NOT_FOUND, "API object not found");
    return;
  }

  void createAuditLog({
    tenantId,
    userId,
    action: "cs.api-object.delete",
    resource: id,
  });

  res.statusCode = 204;
  res.end();
}
