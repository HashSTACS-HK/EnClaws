import crypto from "node:crypto";
import { query } from "../db/index.js";
import { createUser, getUserByEmail, updateLastLogin, updateUser } from "../db/models/user.js";
import type { SafeUser, UserRole } from "../db/types.js";

const PROVIDER = "embed-sso";
const KEY_PREFIX = "agnr_embed_";
const TOKEN_PREFIX = "sso_";
const DEFAULT_TOKEN_TTL_SECONDS = 300;
const DEFAULT_ROLE: UserRole = "admin";

export interface EmbedSsoKeyRecord {
  id: string;
  tenantId: string;
  keyPrefix: string;
  isActive: boolean;
  usageCount: number;
  lastUsedAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateEmbedSsoKeyInput {
  tenantId: string;
  createdBy?: string | null;
}

export interface IssueEmbedSsoTokenInput {
  apiKey: string;
  tenantId: string;
  externalUserId: string;
  displayName?: string;
  role?: UserRole;
  targetPath?: string;
  ttlSeconds?: number;
}

export interface IssuedEmbedSsoToken {
  token: string;
  expiresAt: Date;
  targetPath: string;
}

export interface ConsumedEmbedSsoToken {
  tenantId: string;
  user: SafeUser;
  targetPath: string;
  externalUserId: string;
}

interface PendingEmbedSsoToken {
  tenantId: string;
  externalUserId: string;
  displayName: string | null;
  role: UserRole;
  targetPath: string;
  expiresAt: number;
}

const pendingTokens = new Map<string, PendingEmbedSsoToken>();

function generateSecret(prefix: string): string {
  return `${prefix}${crypto.randomBytes(32).toString("base64url")}`;
}

function hashSecret(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

function safeHashEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length !== bb.length) {
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

function normalizeTargetPath(raw?: string): string {
  if (!raw || !raw.startsWith("/")) {
    return "/";
  }
  if (raw.startsWith("//") || raw.includes("\\")) {
    return "/";
  }
  return raw;
}

function normalizeRole(role?: UserRole): UserRole {
  if (role === "owner" || role === "admin" || role === "member" || role === "viewer") {
    return role;
  }
  return DEFAULT_ROLE;
}

function normalizeExternalUserId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function syntheticEmail(tenantId: string, externalUserId: string): string {
  const stable = crypto
    .createHash("sha256")
    .update(`${tenantId}:${externalUserId}`)
    .digest("hex")
    .slice(0, 24);
  return `embed-${stable}@embed-sso.local`;
}

function rowToKeyRecord(row: Record<string, unknown>): EmbedSsoKeyRecord {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    keyPrefix: (row.label as string | null) ?? "",
    isActive: Boolean(row.is_active),
    usageCount: Number(row.usage_count ?? 0),
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at as string | Date) : null,
    createdBy: (row.created_by as string | null) ?? null,
    createdAt: new Date(row.created_at as string | Date),
    updatedAt: new Date(row.updated_at as string | Date),
  };
}

export async function createEmbedSsoKey(
  input: CreateEmbedSsoKeyInput,
): Promise<{ key: string; record: EmbedSsoKeyRecord }> {
  if (!input.tenantId) {
    throw new Error("tenantId is required");
  }
  const key = generateSecret(KEY_PREFIX);
  const recordId = crypto.randomUUID();
  const keyPrefix = key.slice(0, 20);
  const keyHash = hashSecret(key);
  const result = await query(
    `INSERT INTO tenant_api_keys (id, tenant_id, provider, label, key_encrypted, is_active, created_by)
     VALUES ($1, $2, $3, $4, $5, true, $6)
     RETURNING *`,
    [recordId, input.tenantId, PROVIDER, keyPrefix, `sha256:${keyHash}`, input.createdBy ?? null],
  );
  return { key, record: rowToKeyRecord(result.rows[0]) };
}

export async function listEmbedSsoKeys(tenantId: string): Promise<EmbedSsoKeyRecord[]> {
  const result = await query(
    `SELECT * FROM tenant_api_keys
     WHERE tenant_id = $1 AND provider = $2
     ORDER BY created_at DESC`,
    [tenantId, PROVIDER],
  );
  return result.rows.map(rowToKeyRecord);
}

export async function revokeEmbedSsoKey(input: {
  tenantId: string;
  keyId: string;
}): Promise<boolean> {
  const result = await query(
    `UPDATE tenant_api_keys
     SET is_active = false, updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND provider = $3 AND is_active = true`,
    [input.keyId, input.tenantId, PROVIDER],
  );
  return (result.rowCount ?? 0) > 0;
}

async function findActiveKeyBySecret(
  tenantId: string,
  apiKey: string,
): Promise<EmbedSsoKeyRecord | null> {
  const hash = hashSecret(apiKey);
  const result = await query(
    `SELECT * FROM tenant_api_keys
     WHERE tenant_id = $1 AND provider = $2 AND is_active = true`,
    [tenantId, PROVIDER],
  );
  for (const row of result.rows) {
    const stored = String(row.key_encrypted ?? "");
    const storedHash = stored.startsWith("sha256:") ? stored.slice("sha256:".length) : stored;
    if (/^[a-f0-9]{64}$/i.test(storedHash) && safeHashEqual(hash, storedHash)) {
      return rowToKeyRecord(row);
    }
  }
  return null;
}

export async function issueEmbedSsoToken(
  input: IssueEmbedSsoTokenInput,
): Promise<IssuedEmbedSsoToken> {
  if (!input.apiKey || !input.tenantId || !input.externalUserId) {
    throw new Error("apiKey, tenantId and externalUserId are required");
  }
  const key = await findActiveKeyBySecret(input.tenantId, input.apiKey);
  if (!key) {
    throw new Error("invalid embed sso api key");
  }

  const ttlSeconds = Math.max(30, Math.min(input.ttlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS, 900));
  const token = generateSecret(TOKEN_PREFIX);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  pendingTokens.set(token, {
    tenantId: input.tenantId,
    externalUserId: input.externalUserId,
    displayName: input.displayName?.trim() || null,
    role: normalizeRole(input.role),
    targetPath: normalizeTargetPath(input.targetPath),
    expiresAt: expiresAt.getTime(),
  });

  await query(
    `UPDATE tenant_api_keys
     SET usage_count = usage_count + 1, last_used_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [key.id],
  );

  return { token, expiresAt, targetPath: normalizeTargetPath(input.targetPath) };
}

async function findOrCreateEmbedUser(payload: PendingEmbedSsoToken): Promise<SafeUser> {
  const externalId = normalizeExternalUserId(payload.externalUserId);
  if (!externalId) {
    throw new Error("externalUserId is invalid");
  }
  const email = syntheticEmail(payload.tenantId, externalId);
  const existing = await getUserByEmail(payload.tenantId, email);
  if (existing) {
    if (existing.status !== "active") {
      throw new Error("embed sso user is not active");
    }
    const updates: Parameters<typeof updateUser>[1] = {};
    if (payload.displayName && payload.displayName !== existing.displayName) {
      updates.displayName = payload.displayName;
    }
    if (payload.role !== existing.role) {
      updates.role = payload.role;
    }
    const updated = Object.keys(updates).length > 0 ? await updateUser(existing.id, updates) : null;
    await updateLastLogin(existing.id);
    return (
      updated ?? {
        id: existing.id,
        tenantId: existing.tenantId,
        channelId: existing.channelId,
        openIds: existing.openIds,
        unionId: existing.unionId,
        email: existing.email,
        displayName: existing.displayName,
        role: existing.role,
        status: existing.status,
        avatarUrl: existing.avatarUrl,
        lastLoginAt: existing.lastLoginAt,
        settings: existing.settings,
        forceChangePassword: existing.forceChangePassword,
        passwordChangedAt: existing.passwordChangedAt,
        mfaEnabled: existing.mfaEnabled,
        createdAt: existing.createdAt,
        updatedAt: existing.updatedAt,
      }
    );
  }

  const user = await createUser(
    {
      tenantId: payload.tenantId,
      email,
      displayName: payload.displayName ?? payload.externalUserId,
      role: payload.role,
    },
    { skipDirInit: true },
  );
  await updateLastLogin(user.id);
  return user;
}

export async function consumeEmbedSsoToken(token: string): Promise<ConsumedEmbedSsoToken> {
  const payload = pendingTokens.get(token);
  if (!payload || payload.expiresAt <= Date.now()) {
    pendingTokens.delete(token);
    throw new Error("embed sso token expired or consumed");
  }
  pendingTokens.delete(token);
  const user = await findOrCreateEmbedUser(payload);
  return {
    tenantId: payload.tenantId,
    user,
    targetPath: payload.targetPath,
    externalUserId: payload.externalUserId,
  };
}
