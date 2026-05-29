/**
 * Audit log operations — SQLite implementation.
 */

import type { AuditLog } from "../../types.js";
import { sqliteQuery, generateUUID } from "../index.js";

export interface CreateAuditLogInput {
  tenantId: string;
  userId?: string;
  action: string;
  resource?: string;
  detail?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

function rowToAuditLog(row: Record<string, unknown>): AuditLog {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    userId: (row.user_id as string) ?? null,
    action: row.action as string,
    resource: (row.resource as string) ?? null,
    detail: (typeof row.detail === "string"
      ? JSON.parse(row.detail)
      : (row.detail ?? {})) as Record<string, unknown>,
    ipAddress: (row.ip_address as string) ?? null,
    userAgent: (row.user_agent as string) ?? null,
    createdAt: new Date(row.created_at as string),
  };
}

export async function createAuditLog(input: CreateAuditLogInput): Promise<void> {
  try {
    const id = generateUUID();
    sqliteQuery(
      `INSERT INTO audit_logs (id, tenant_id, user_id, action, resource, detail, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.tenantId,
        input.userId ?? null,
        input.action,
        input.resource ?? null,
        JSON.stringify(input.detail ?? {}),
        input.ipAddress ?? null,
        input.userAgent ?? null,
      ],
    );
  } catch (err) {
    console.error("[audit] Failed to write audit log:", err);
  }
}

export async function listAuditLogs(
  tenantId: string,
  opts?: {
    userId?: string;
    action?: string;
    limit?: number;
    offset?: number;
    since?: Date;
  },
): Promise<{ logs: AuditLog[]; total: number }> {
  const conditions: string[] = ["tenant_id = ?"];
  const values: unknown[] = [tenantId];

  if (opts?.userId) {
    conditions.push("user_id = ?");
    values.push(opts.userId);
  }
  if (opts?.action) {
    conditions.push("action = ?");
    values.push(opts.action);
  }
  if (opts?.since) {
    conditions.push("created_at >= ?");
    values.push(opts.since);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const limit = opts?.limit ?? 50;
  const offset = opts?.offset ?? 0;

  const dataResult = sqliteQuery(
    `SELECT * FROM audit_logs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...values, limit, offset],
  );
  const countResult = sqliteQuery(`SELECT COUNT(*) as count FROM audit_logs ${where}`, values);

  return {
    logs: dataResult.rows.map(rowToAuditLog),
    total: Number(countResult.rows[0].count),
  };
}
