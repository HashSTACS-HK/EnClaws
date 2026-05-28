/**
 * Audit log operations.
 */

import { query, getDbType, DB_SQLITE } from "../index.js";
import * as sqliteAudit from "../sqlite/models/audit-log.js";
import type { AuditLog } from "../types.js";

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
    detail: (row.detail ?? {}) as Record<string, unknown>,
    ipAddress: (row.ip_address as string) ?? null,
    userAgent: (row.user_agent as string) ?? null,
    createdAt: row.created_at as Date,
  };
}

/**
 * Create an audit log entry. Fire-and-forget safe — errors are logged, not thrown.
 */
export async function createAuditLog(input: CreateAuditLogInput): Promise<void> {
  if (getDbType() === DB_SQLITE) {return sqliteAudit.createAuditLog(input);}
  try {
    await query(
      `INSERT INTO audit_logs (tenant_id, user_id, action, resource, detail, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
      [
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
  if (getDbType() === DB_SQLITE) {return sqliteAudit.listAuditLogs(tenantId, opts);}
  const conditions: string[] = ["tenant_id = $1"];
  const values: unknown[] = [tenantId];
  let idx = 2;

  if (opts?.userId) {
    conditions.push(`user_id = $${idx++}`);
    values.push(opts.userId);
  }
  if (opts?.action) {
    conditions.push(`action = $${idx++}`);
    values.push(opts.action);
  }
  if (opts?.since) {
    conditions.push(`created_at >= $${idx++}`);
    values.push(opts.since);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const limit = opts?.limit ?? 50;
  const offset = opts?.offset ?? 0;

  const [dataResult, countResult] = await Promise.all([
    query(
      `SELECT * FROM audit_logs ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      [...values, limit, offset],
    ),
    query(`SELECT COUNT(*) as count FROM audit_logs ${where}`, values),
  ]);

  return {
    logs: dataResult.rows.map(rowToAuditLog),
    total: parseInt(countResult.rows[0].count as string, 10),
  };
}
