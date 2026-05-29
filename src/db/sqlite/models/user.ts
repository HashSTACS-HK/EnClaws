/**
 * User CRUD operations — SQLite implementation.
 */

import fs from "node:fs";
import { hashPassword } from "../../../auth/password.js";
import {
  resolveTenantDevicesDir,
  resolveTenantCredentialsDir,
  resolveTenantCronDir,
} from "../../../config/sessions/tenant-paths.js";
import { UserQuotaExceededError } from "../../models/user-quota-error.js";
import type {
  User,
  SafeUser,
  CreateUserInput,
  UpdateUserInput,
  UserRole,
  UserStatus,
} from "../../types.js";
import { sqliteQuery, generateUUID } from "../index.js";
import { checkTenantQuota } from "./tenant.js";

function rowToUser(row: Record<string, unknown>): User {
  let openIds: string[] = [];
  if (Array.isArray(row.open_ids)) {
    openIds = row.open_ids as string[];
  } else if (typeof row.open_ids === "string") {
    try {
      openIds = JSON.parse(row.open_ids);
    } catch {
      openIds = [];
    }
  }

  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    channelId: (row.channel_id as string) ?? null,
    openIds,
    unionId: (row.union_id as string) ?? null,
    email: (row.email as string) ?? null,
    passwordHash: (row.password_hash as string) ?? null,
    displayName: (row.display_name as string) ?? null,
    role: row.role as UserRole,
    status: row.status as UserStatus,
    avatarUrl: (row.avatar_url as string) ?? null,
    lastLoginAt: row.last_login_at ? new Date(row.last_login_at as string) : null,
    settings: (typeof row.settings === "string"
      ? JSON.parse(row.settings)
      : (row.settings ?? {})) as User["settings"],
    forceChangePassword: Number(row.force_change_password ?? 0) === 1,
    passwordChangedAt: row.password_changed_at ? new Date(row.password_changed_at as string) : null,
    mfaSecret: (row.mfa_secret as string) ?? null,
    mfaEnabled: Number(row.mfa_enabled ?? 0) === 1,
    mfaBackupCodes: (row.mfa_backup_codes as string) ?? null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

export function toSafeUser(user: User): SafeUser {
  const { passwordHash: _, mfaSecret: _s, mfaBackupCodes: _b, ...safe } = user;
  return safe;
}

export async function createUser(
  input: CreateUserInput & { forceChangePassword?: boolean },
  opts?: { skipDirInit?: boolean },
): Promise<SafeUser> {
  const id = generateUUID();
  const passwordHash = input.password ? await hashPassword(input.password) : null;
  const fcp = input.forceChangePassword ? 1 : 0;
  const passwordChangedAt = passwordHash ? new Date().toISOString() : null;

  sqliteQuery(
    `INSERT INTO users (id, tenant_id, channel_id, email, password_hash, display_name, role,
                        force_change_password, password_changed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.tenantId,
      input.channelId ?? null,
      input.email ? input.email.toLowerCase().trim() : null,
      passwordHash,
      input.displayName ?? null,
      input.role ?? "member",
      fcp,
      passwordChangedAt,
    ],
  );

  const result = sqliteQuery("SELECT * FROM users WHERE id = ?", [id]);
  const user = rowToUser(result.rows[0]);

  // Initialize tenant-scoped directories
  if (!opts?.skipDirInit) {
    const dirKey = user.unionId ?? user.id;
    try {
      const dirs = [
        resolveTenantDevicesDir(user.tenantId, dirKey),
        resolveTenantCredentialsDir(user.tenantId, dirKey),
        resolveTenantCronDir(user.tenantId, dirKey),
      ];
      for (const dir of dirs) {
        fs.mkdirSync(dir, { recursive: true });
      }
    } catch {
      // Non-fatal
    }
  }

  return toSafeUser(user);
}

export async function getUserById(id: string): Promise<User | null> {
  const result = sqliteQuery("SELECT * FROM users WHERE id = ?", [id]);
  return result.rows.length > 0 ? rowToUser(result.rows[0]) : null;
}

export async function getUserByUnionId(unionId: string): Promise<User | null> {
  const result = sqliteQuery(
    `SELECT * FROM users WHERE union_id = ? AND status = 'active'
     ORDER BY last_login_at DESC LIMIT 1`,
    [unionId],
  );
  return result.rows.length > 0 ? rowToUser(result.rows[0]) : null;
}

export async function getUserByEmail(tenantId: string, email: string): Promise<User | null> {
  const result = sqliteQuery("SELECT * FROM users WHERE tenant_id = ? AND email = ?", [
    tenantId,
    email.toLowerCase().trim(),
  ]);
  return result.rows.length > 0 ? rowToUser(result.rows[0]) : null;
}

export async function findUserByEmail(email: string): Promise<User | null> {
  const result = sqliteQuery(
    `SELECT u.* FROM users u
     JOIN tenants t ON u.tenant_id = t.id
     WHERE u.email = ? AND u.status = 'active' AND t.status = 'active'
     ORDER BY CASE WHEN u.last_login_at IS NULL THEN 1 ELSE 0 END, u.last_login_at DESC
     LIMIT 1`,
    [email.toLowerCase().trim()],
  );
  return result.rows.length > 0 ? rowToUser(result.rows[0]) : null;
}

export async function findUserByEmailAnyTenant(email: string): Promise<User | null> {
  const result = sqliteQuery(
    `SELECT u.* FROM users u
     WHERE u.email = ? AND u.status = 'active'
     ORDER BY CASE WHEN u.last_login_at IS NULL THEN 1 ELSE 0 END, u.last_login_at DESC
     LIMIT 1`,
    [email.toLowerCase().trim()],
  );
  return result.rows.length > 0 ? rowToUser(result.rows[0]) : null;
}

export async function listUsers(
  tenantId: string,
  opts?: {
    status?: UserStatus;
    role?: UserRole;
    channelId?: string;
    limit?: number;
    offset?: number;
  },
): Promise<{
  users: (SafeUser & { channelName: string | null; channelType: string | null })[];
  total: number;
}> {
  const conditions: string[] = ["u.tenant_id = ?"];
  const values: unknown[] = [tenantId];

  if (opts?.status) {
    conditions.push("u.status = ?");
    values.push(opts.status);
  }
  if (opts?.role) {
    conditions.push("u.role = ?");
    values.push(opts.role);
  }
  if (opts?.channelId) {
    conditions.push("u.channel_id = ?");
    values.push(opts.channelId);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const limit = opts?.limit ?? 50;
  const offset = opts?.offset ?? 0;

  // LEFT JOIN tenant_channels to fetch channel_name; users without channel_id get null.
  const dataResult = sqliteQuery(
    `SELECT u.*, tc.channel_name, tc.channel_type
       FROM users u
       LEFT JOIN tenant_channels tc ON tc.id = u.channel_id
       ${where}
       ORDER BY u.created_at DESC
       LIMIT ? OFFSET ?`,
    [...values, limit, offset],
  );
  const countResult = sqliteQuery(`SELECT COUNT(*) as count FROM users u ${where}`, values);

  return {
    users: dataResult.rows.map((row) => {
      const safe = toSafeUser(rowToUser(row));
      return {
        ...safe,
        channelName: (row.channel_name as string) ?? null,
        channelType: (row.channel_type as string) ?? null,
      };
    }),
    total: Number(countResult.rows[0].count),
  };
}

export async function updateUser(id: string, updates: UpdateUserInput): Promise<SafeUser | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (updates.displayName !== undefined) {
    sets.push("display_name = ?");
    values.push(updates.displayName);
  }
  if (updates.role !== undefined) {
    sets.push("role = ?");
    values.push(updates.role);
  }
  if (updates.status !== undefined) {
    sets.push("status = ?");
    values.push(updates.status);
  }
  if (updates.settings !== undefined) {
    sets.push("settings = ?");
    values.push(JSON.stringify(updates.settings));
  }
  if (updates.avatarUrl !== undefined) {
    sets.push("avatar_url = ?");
    values.push(updates.avatarUrl);
  }

  if (sets.length === 0) {
    const user = await getUserById(id);
    return user ? toSafeUser(user) : null;
  }

  values.push(id);
  sqliteQuery(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, values);

  const user = await getUserById(id);
  return user ? toSafeUser(user) : null;
}

export async function updateLastLogin(userId: string): Promise<void> {
  sqliteQuery("UPDATE users SET last_login_at = datetime('now') WHERE id = ?", [userId]);
}

export async function updateUserPassword(
  userId: string,
  newPassword: string,
  opts?: { keepForceFlag?: boolean },
): Promise<void> {
  const hash = await hashPassword(newPassword);
  if (opts?.keepForceFlag) {
    sqliteQuery(
      "UPDATE users SET password_hash = ?, password_changed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
      [hash, userId],
    );
  } else {
    sqliteQuery(
      "UPDATE users SET password_hash = ?, password_changed_at = datetime('now'), force_change_password = 0, updated_at = datetime('now') WHERE id = ?",
      [hash, userId],
    );
  }
}

export async function setForceChangePassword(userId: string, force: boolean): Promise<void> {
  sqliteQuery("UPDATE users SET force_change_password = ? WHERE id = ?", [force ? 1 : 0, userId]);
}

export async function deleteUser(id: string): Promise<boolean> {
  const result = sqliteQuery(
    "UPDATE users SET status = 'deleted' WHERE id = ? AND status != 'deleted'",
    [id],
  );
  return result.rowCount > 0;
}

export async function updateDisplayNameByOpenId(
  openId: string,
  displayName: string,
): Promise<void> {
  sqliteQuery(
    `UPDATE users SET display_name = ?, updated_at = datetime('now')
     WHERE status = 'active'
       AND (display_name IS NULL OR display_name LIKE 'ou_%' OR display_name LIKE 'on_%')
       AND EXISTS (SELECT 1 FROM json_each(open_ids) WHERE json_each.value = ?)`,
    [displayName, openId],
  );
}

export async function findOrCreateUserByOpenId(
  tenantId: string,
  openId: string,
  displayName?: string,
  unionId?: string,
  channelId?: string,
): Promise<{ user: User; created: boolean }> {
  // Helper: lazily backfill channel_id on legacy records (NULL → current channel)
  function backfillChannelId(user: User): void {
    if (channelId && !user.channelId) {
      sqliteQuery("UPDATE users SET channel_id = ? WHERE id = ?", [channelId, user.id]);
      user.channelId = channelId;
    }
  }

  // 1. Try to find by union_id first
  if (unionId) {
    const byUnion = sqliteQuery(
      `SELECT * FROM users WHERE tenant_id = ? AND union_id = ?
         AND (channel_id = ? OR channel_id IS NULL)
       ORDER BY (status = 'active') DESC, channel_id IS NULL ASC LIMIT 1`,
      [tenantId, unionId, channelId ?? null],
    );
    if (byUnion.rows.length > 0) {
      const user = rowToUser(byUnion.rows[0]);
      if (user.status !== "active") {
        const { UserSuspendedError } = await import("../../models/user-suspended-error.js");
        throw new UserSuspendedError(user.id, user.status);
      }
      backfillChannelId(user);
      // Append open_id to array if not already present
      if (openId && !user.openIds.includes(openId)) {
        const newOpenIds = [...user.openIds, openId];
        sqliteQuery("UPDATE users SET open_ids = ? WHERE id = ?", [
          JSON.stringify(newOpenIds),
          user.id,
        ]);
        user.openIds.push(openId);
      }
      // Update display_name if a real name is now available
      if (displayName && displayName !== user.displayName && !displayName.startsWith("ou_")) {
        if (
          !user.displayName ||
          user.displayName.startsWith("ou_") ||
          user.displayName.startsWith("on_")
        ) {
          sqliteQuery(
            "UPDATE users SET display_name = ?, updated_at = datetime('now') WHERE id = ?",
            [displayName, user.id],
          );
          user.displayName = displayName;
        }
      }
      return { user, created: false };
    }
  }

  // 2. Fallback: find by open_ids array containment using json_each
  const byOpenId = sqliteQuery(
    `SELECT u.* FROM users u
     WHERE u.tenant_id = ?
       AND EXISTS (SELECT 1 FROM json_each(u.open_ids) WHERE json_each.value = ?)
       AND (u.channel_id = ? OR u.channel_id IS NULL)
     ORDER BY (u.status = 'active') DESC, u.channel_id IS NULL ASC LIMIT 1`,
    [tenantId, openId, channelId ?? null],
  );
  if (byOpenId.rows.length > 0) {
    const user = rowToUser(byOpenId.rows[0]);
    if (user.status !== "active") {
      const { UserSuspendedError } = await import("../../models/user-suspended-error.js");
      throw new UserSuspendedError(user.id, user.status);
    }
    backfillChannelId(user);
    // Update union_id if missing
    if (unionId && !user.unionId) {
      sqliteQuery("UPDATE users SET union_id = ? WHERE id = ?", [unionId, user.id]);
      user.unionId = unionId;
    }
    // Update display_name if a real name is now available
    if (displayName && displayName !== user.displayName && !displayName.startsWith("ou_")) {
      if (
        !user.displayName ||
        user.displayName.startsWith("ou_") ||
        user.displayName.startsWith("on_")
      ) {
        sqliteQuery(
          "UPDATE users SET display_name = ?, updated_at = datetime('now') WHERE id = ?",
          [displayName, user.id],
        );
        user.displayName = displayName;
      }
    }
    return { user, created: false };
  }

  // 3. Create new user with channel_id — enforce maxUsers quota first.
  // Existing users (steps 1 and 2 above) are never blocked even after the
  // limit is reached; only NEW IM users get rejected.
  const userQuota = await checkTenantQuota(tenantId, "users");
  if (!userQuota.allowed) {
    throw new UserQuotaExceededError(userQuota.current, userQuota.max);
  }

  const id = generateUUID();
  try {
    sqliteQuery(
      `INSERT INTO users (id, tenant_id, channel_id, open_ids, union_id, display_name, role)
       VALUES (?, ?, ?, ?, ?, ?, 'member')`,
      [
        id,
        tenantId,
        channelId ?? null,
        JSON.stringify([openId]),
        unionId ?? null,
        displayName ?? openId,
      ],
    );
    const result = sqliteQuery("SELECT * FROM users WHERE id = ?", [id]);
    const user = rowToUser(result.rows[0]);

    // Initialize tenant-scoped directories
    const dirKey = user.unionId ?? openId;
    try {
      const dirs = [
        resolveTenantDevicesDir(user.tenantId, dirKey),
        resolveTenantCredentialsDir(user.tenantId, dirKey),
        resolveTenantCronDir(user.tenantId, dirKey),
      ];
      for (const dir of dirs) {
        fs.mkdirSync(dir, { recursive: true });
      }
    } catch {
      // Non-fatal
    }

    return { user, created: true };
  } catch {
    // Race condition fallback
    const fallback = sqliteQuery(
      `SELECT u.* FROM users u
       WHERE u.tenant_id = ?
         AND EXISTS (SELECT 1 FROM json_each(u.open_ids) WHERE json_each.value = ?)
         AND (u.channel_id = ? OR u.channel_id IS NULL)`,
      [tenantId, openId, channelId ?? null],
    );
    if (fallback.rows.length > 0) {
      return { user: rowToUser(fallback.rows[0]), created: false };
    }
    throw new Error(`Failed to find or create user for openId=${openId} unionId=${unionId}`);
  }
}

/**
 * Lightweight lookup: find a user's display_name by open_id (for session list display).
 */
export function findUserByOpenIdForDisplay(
  tenantId: string,
  openId: string,
): { rows: Array<Record<string, unknown>> } {
  // Case-insensitive: core canonicalizes session keys to lowercase (e.g. "liuyu"),
  // but users.open_ids may preserve the channel's original casing (e.g. "LiuYu").
  return sqliteQuery(
    `SELECT display_name FROM users
     WHERE tenant_id = ? AND status = 'active'
       AND EXISTS (SELECT 1 FROM json_each(open_ids) WHERE lower(json_each.value) = lower(?))
     LIMIT 1`,
    [tenantId, openId],
  );
}
