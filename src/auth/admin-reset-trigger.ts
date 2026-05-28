/**
 * Boot-time emergency rescue: when ENCLAWS_ADMIN_RESET=1 is set, generate a
 * fresh temporary password for the platform-admin account, mark it as
 * force-change-on-next-login, and print the temporary password to stdout
 * exactly once.
 *
 * Why a flag instead of `ENCLAWS_ADMIN_RESET_PASSWORD=plaintext`:
 *   The flag mode never lets the operator's chosen password leak through
 *   /proc/<pid>/environ, `docker inspect`, k8s ConfigMap manifests, CI
 *   logs, or shell history.  The system *generates* the password, so even
 *   if the env var is captured, no credentials are recoverable from it.
 *
 * Multiple platform-admin accounts: the rescue applies to ALL of them
 * (operators rarely have more than one — but if they do, all rescue
 * passwords are printed in order).
 */

import { isDbInitialized, query, getDbType, DB_SQLITE } from "../db/index.js";
import { generateTempPassword } from "./password-policy.js";
import { hashPassword } from "./password.js";
import { revokeAllUserTokens } from "./jwt.js";
import { createAuditLog } from "../db/models/audit-log.js";

export async function maybeRunAdminResetTrigger(): Promise<void> {
  if (process.env.ENCLAWS_ADMIN_RESET !== "1") {return;}
  if (!isDbInitialized()) {
    console.error("[admin-reset] ENCLAWS_ADMIN_RESET=1 but database is not configured; skipping.");
    return;
  }

  const result = await query(
    "SELECT id, tenant_id, email FROM users WHERE role = 'platform-admin' AND status = 'active'",
  );
  if (result.rows.length === 0) {
    console.error("[admin-reset] no active platform-admin account found; nothing to reset");
    return;
  }

  const isSqlite = getDbType() === DB_SQLITE;
  const nowExpr = isSqlite ? "datetime('now')" : "NOW()";

  for (const row of result.rows) {
    const userId = String(row.id);
    const tenantId = String(row.tenant_id);
    const email = (row.email as string | null) ?? "(no email)";

    const tempPassword = generateTempPassword();
    const hash = await hashPassword(tempPassword);
    await query(
      `UPDATE users SET password_hash = $1, password_changed_at = ${nowExpr}, force_change_password = 1, updated_at = ${nowExpr} WHERE id = $2`,
      [hash, userId],
    );
    await revokeAllUserTokens(userId);

    await createAuditLog({
      tenantId,
      userId,
      action: "user.password.env_reset",
      detail: { trigger: "ENCLAWS_ADMIN_RESET" },
    }).catch(() => undefined);

    // Stdout — printed exactly once at boot, never persisted.
    process.stdout.write(
      `\n` +
      `===========================================================\n` +
      ` ENCLAWS ADMIN RESCUE — temporary password generated\n` +
      `===========================================================\n` +
      `   email:    ${email}\n` +
      `   password: ${tempPassword}\n` +
      `   note:     you must change this password on first login.\n` +
      `   Unset ENCLAWS_ADMIN_RESET before the next start to avoid\n` +
      `   regenerating the password again.\n` +
      `===========================================================\n\n`,
    );
  }
}
