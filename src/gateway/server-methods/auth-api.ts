/**
 * Gateway RPC handlers for authentication (login, register, refresh, etc.).
 *
 * Methods:
 *   auth.register              - Register a new tenant + owner user
 *   auth.login                 - Login with email + password
 *   auth.refresh               - Refresh access token
 *   auth.logout                - Revoke refresh token
 *   auth.me                    - Get current user info
 *   auth.changePassword        - Self-service password change
 *   auth.capabilities          - Detect SMTP availability (forgot-password flow)
 *   auth.forgotPassword        - Request a password-reset email
 *   auth.forgotPassword.verify - Consume a reset token + set new password
 *   auth.adminResetPassword    - platform-admin reset for an owner (one-time link)
 *   auth.viewTempPassword      - One-time view of an admin-issued temp password
 *   auth.sessions              - List active sessions
 *   auth.revokeSession         - Revoke a single session
 *   auth.revokeAllOtherSessions - Revoke all sessions except current
 *   auth.verifyEmail           - Consume email verification token
 *   auth.resendVerifyEmail     - Resend email verification
 *   auth.mfa.setup.begin       - Start MFA setup (returns QR + backup codes)
 *   auth.mfa.setup.verify      - Verify first TOTP code to complete setup
 *   auth.mfa.disable           - Disable MFA
 *   auth.mfa.verify            - Second factor during login
 */

import { installSkillPack } from "../../agents/skill-pack-installer.js";
import { ensureTenantDirFiles } from "../../agents/workspace.js";
import { verifyCaptcha } from "../../auth/captcha.js";
import {
  isEmailVerificationRequired,
  issueVerifyEmailToken,
  consumeVerifyEmailToken,
  shouldThrottleResend,
  noteResendIssued,
} from "../../auth/email-verification.js";
import { generateTokenPair, verifyRefreshToken, revokeAllUserTokens } from "../../auth/jwt.js";
import { recordLoginAttempt } from "../../auth/login-attempts.js";
import { loginRateLimiter, retryAfterSeconds } from "../../auth/login-rate-limit.js";
import {
  beginMfaSetup,
  completeMfaSetup,
  disableMfa,
  verifyUserTotp,
  tryBackupCode,
  issueMfaChallenge,
  consumeMfaChallenge,
} from "../../auth/mfa.js";
import type { TenantContext } from "../../auth/middleware.js";
import { computePasswordExpiresAt, isPasswordExpired } from "../../auth/password-expiry.js";
import { archivePasswordHash, isPasswordInHistory } from "../../auth/password-history.js";
import { validatePasswordStrength, generateTempPassword } from "../../auth/password-policy.js";
import {
  issueResetToken,
  issueViewTempToken,
  findResetToken,
  consumeResetToken,
  decryptTempPasswordPayload,
  revokeAllResetTokens,
  shouldThrottleForgot,
  noteForgotIssued,
} from "../../auth/password-reset.js";
import { verifyPassword } from "../../auth/password.js";
import {
  listUserSessions,
  revokeSession as revokeSessionById,
  revokeOtherSessions,
  touchSession,
} from "../../auth/sessions.js";
import {
  hasEmailCapability,
  sendPasswordResetEmail,
  sendVerifyEmail,
} from "../../auth/smtp-capability.js";
import { parseUserAgent } from "../../auth/user-agent-parser.js";
import { resolveTenantDir } from "../../config/sessions/tenant-paths.js";
import { isDbInitialized } from "../../db/index.js";
import { createAuditLog } from "../../db/models/audit-log.js";
import { createTenant, getTenantById } from "../../db/models/tenant.js";
import {
  createUser,
  getUserById,
  findUserByEmail,
  findUserByEmailAnyTenant,
  getUserByEmail,
  updateLastLogin,
  updateUserPassword,
  setForceChangePassword,
  toSafeUser,
} from "../../db/models/user.js";
import type { JwtPayload } from "../../db/types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers, GatewayRequestHandlerOptions } from "./types.js";

/**
 * Verify the graphic captcha attached to public auth forms. Runs
 * before any other validation so that a wrong captcha cannot increment
 * login-attempt counters or enumerate accounts. Returns `true` when
 * the caller should continue; `false` means a response has already
 * been sent and the handler must bail out.
 */
function requireCaptcha(
  params: Record<string, unknown>,
  respond: GatewayRequestHandlerOptions["respond"],
): boolean {
  const captchaId = typeof params.captchaId === "string" ? params.captchaId : undefined;
  const captchaAnswer = typeof params.captchaAnswer === "string" ? params.captchaAnswer : undefined;
  if (!captchaId || !captchaAnswer) {
    respond(false, undefined, errorShape(ErrorCodes.CAPTCHA_REQUIRED, "缺少图形验证码"));
    return false;
  }
  if (!verifyCaptcha(captchaId, captchaAnswer)) {
    respond(false, undefined, errorShape(ErrorCodes.CAPTCHA_INVALID, "图形验证码错误或已过期"));
    return false;
  }
  return true;
}

function requireDb(respond: GatewayRequestHandlerOptions["respond"]): boolean {
  if (!isDbInitialized()) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Multi-tenant mode not enabled. Set ENCLAWS_DB_URL to enable.",
      ),
    );
    return false;
  }
  return true;
}

export const authHandlers: GatewayRequestHandlers = {
  /**
   * Register a new tenant with an owner account.
   *
   * Params:
   *   tenantName: string
   *   email: string
   *   password: string
   *   displayName?: string
   */
  "auth.register": async ({ params, respond }: GatewayRequestHandlerOptions) => {
    if (!requireCaptcha(params, respond)) {
      return;
    }
    if (!requireDb(respond)) {
      return;
    }

    const { tenantName, email, password, displayName } = params as {
      tenantName: string;
      email: string;
      password: string;
      displayName?: string;
    };

    if (!tenantName || !email || !password) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_PARAMS,
          "Missing required fields: tenantName, email, password",
        ),
      );
      return;
    }

    // Validate password strength (Phase 1 — policy + weak-password blacklist)
    const policy = validatePasswordStrength(password, email);
    if (!policy.ok) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_PARAMS, policy.message ?? "密码不符合安全策略"),
      );
      return;
    }

    // Check global email uniqueness
    const existingUser = await findUserByEmail(email);
    if (existingUser) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "该邮箱已注册"));
      return;
    }

    try {
      // Create tenant
      const tenant = await createTenant({
        name: tenantName,
      });

      // Seed tenant-level directory files immediately after creation
      try {
        await ensureTenantDirFiles(resolveTenantDir(tenant.id));
      } catch (dirErr: unknown) {
        console.warn(
          `[auth.register] Failed to seed tenant dir files for ${tenant.id}: ${dirErr instanceof Error ? dirErr.message : "unknown"}`,
        );
      }

      // Auto-install skill pack (fire-and-forget, don't block registration)
      installSkillPack(tenant.id)
        .then((packResult) => {
          if (packResult.skipped) {
            console.error(`[skill-pack] tenant ${tenant.id}: skipped — ${packResult.skipped}`);
          } else if (packResult.ok) {
            console.error(
              `[skill-pack] tenant ${tenant.id}: installed ${packResult.installed.length} skills from ${packResult.source}`,
            );
          } else {
            console.error(
              `[skill-pack] tenant ${tenant.id}: partial — ok: ${packResult.installed.join(", ")}; errors: ${packResult.errors.map((e) => e.skill).join(", ")}`,
            );
          }
        })
        .catch((err) => {
          console.error(`[skill-pack] tenant ${tenant.id}: unexpected error —`, err);
        });

      // Create owner user (skip user-level directory init for page registration;
      // directories will be created on-demand when the user actually starts a session)
      const user = await createUser(
        {
          tenantId: tenant.id,
          email,
          password,
          displayName,
          role: "owner",
        },
        { skipDirInit: true },
      );

      // Phase 3: if email verification is required AND SMTP is available,
      // set the user to 'invited' status and send a verification email
      // instead of issuing tokens immediately.
      const requireVerify = isEmailVerificationRequired() && hasEmailCapability();
      if (requireVerify) {
        // Set status to 'invited' (pending verification)
        const { query: dbQuery, getDbType: gdt, DB_SQLITE: sq } = await import("../../db/index.js");
        const nowExpr = gdt() === sq ? "datetime('now')" : "NOW()";
        await dbQuery(
          `UPDATE users SET status = 'invited', updated_at = ${nowExpr} WHERE id = $1`,
          [user.id],
        );
        const issued = await issueVerifyEmailToken(user.id, 24 * 60);
        const baseUrl = process.env.ENCLAWS_PUBLIC_BASE_URL ?? "";
        const verifyUrl = `${baseUrl.replace(/\/$/, "")}/#/auth/verify-email?token=${encodeURIComponent(issued.token)}`;
        await sendVerifyEmail({ to: email, verifyUrl, expiresInHours: 24 }).catch(() => undefined);

        await createAuditLog({
          tenantId: tenant.id,
          userId: user.id,
          action: "tenant.register",
          resource: `tenant:${tenant.id}`,
          detail: { pendingVerification: true },
        });

        respond(true, {
          tenant: { id: tenant.id, name: tenant.name },
          user: { id: user.id, email: user.email, role: user.role, displayName: user.displayName },
          pendingVerification: true,
        });
        return;
      }

      // Normal path: generate tokens immediately
      const payload: JwtPayload = {
        sub: user.id,
        tid: tenant.id,
        email: user.email,
        role: "owner",
      };
      const tokens = await generateTokenPair(payload);

      await createAuditLog({
        tenantId: tenant.id,
        userId: user.id,
        action: "tenant.register",
        resource: `tenant:${tenant.id}`,
      });

      respond(true, {
        tenant: { id: tenant.id, name: tenant.name },
        user: { id: user.id, email: user.email, role: user.role, displayName: user.displayName },
        ...tokens,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Registration failed";
      if (msg.includes("duplicate key") || msg.includes("unique constraint")) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "该邮箱已注册"));
      } else {
        respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, msg));
      }
    }
  },

  /**
   * Login with email + password.
   *
   * Email is globally unique across tenants, so no tenant disambiguation
   * is needed.
   *
   * Params:
   *   email: string
   *   password: string
   */
  "auth.login": async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
    // Captcha first — a wrong answer must NOT reach login-attempts or
    // the rate-limit counter, otherwise attackers could lock real users
    // out by spraying bogus credentials with random captchas.
    if (!requireCaptcha(params, respond)) {
      return;
    }
    if (!requireDb(respond)) {
      return;
    }

    const { email, password } = params as {
      email: string;
      password: string;
    };

    if (!email || !password) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_PARAMS, "Missing email or password"));
      return;
    }

    // Prefer rawClientIp (always populated, even for loopback) over
    // clientIp (undefined for localhost) so rate limiting and audit
    // logging work correctly during local development.
    const clientIp =
      (client as unknown as { rawClientIp?: string })?.rawClientIp ?? client?.clientIp;

    // Phase 1 RPC-layer rate limit: compound (ip+email) sliding window
    // + exponential backoff. Returns 429 with retryAfterMs when blocked.
    const gate = loginRateLimiter.check(clientIp, email);
    if (!gate.allowed) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.RATE_LIMITED,
          `登录尝试过于频繁，请 ${retryAfterSeconds(gate.retryAfterMs)} 秒后重试`,
          { retryAfterMs: gate.retryAfterMs },
        ),
      );
      return;
    }

    // findUserByEmail JOINs tenants WHERE t.status='active', so suspended
    // tenant users get null. We need a separate check to distinguish
    // "wrong password" from "tenant suspended".
    let user = await findUserByEmail(email);
    if (!user) {
      // Try to find the user ignoring tenant status to detect suspension
      const userAnyStatus = await findUserByEmailAnyTenant(email);
      if (userAnyStatus) {
        const tenant = await getTenantById(userAnyStatus.tenantId);
        if (tenant && tenant.status === "suspended") {
          respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Tenant is suspended"));
          return;
        }
      }
    }

    // Phase 3: handle pending email verification separately so the
    // frontend can show the "verify your email first" page.
    if (user && user.status === "invited" && isEmailVerificationRequired()) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "Please verify your email address before signing in",
          { details: { pendingVerification: true, email: user.email } } as unknown as {
            retryAfterMs?: number;
          },
        ),
      );
      return;
    }

    if (!user || user.status !== "active") {
      const after = loginRateLimiter.recordFailure(clientIp, email);
      // Phase 2: persist failure row
      void recordLoginAttempt({
        ip: clientIp ?? "unknown",
        email,
        success: false,
      });
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Invalid credentials", {
          retryAfterMs: after.retryAfterMs || undefined,
        }),
      );
      return;
    }

    const valid = user.passwordHash ? await verifyPassword(password, user.passwordHash) : false;
    if (!valid) {
      const after = loginRateLimiter.recordFailure(clientIp, email);
      // Phase 2: always persist failed attempts (not just platform-admin/owner)
      void recordLoginAttempt({
        ip: clientIp ?? "unknown",
        email,
        success: false,
      });
      // Audit failed login attempts for platform-admin / owner
      if (user.role === "platform-admin" || user.role === "owner") {
        await createAuditLog({
          tenantId: user.tenantId,
          userId: user.id,
          action: "user.login.failed",
          detail: { ip: clientIp ?? null },
        }).catch(() => undefined);
      }
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Invalid credentials", {
          retryAfterMs: after.retryAfterMs || undefined,
        }),
      );
      return;
    }

    // Successful authentication — clear the (ip, email) backoff
    loginRateLimiter.recordSuccess(clientIp, email);

    // Phase 2: password expiry check — flip fcp on the user record if
    // the configured max-age has elapsed. This means the JWT issued
    // below will carry fcp:true even though the DB flag wasn't set yet.
    let mustChangePassword = user.forceChangePassword;
    if (!mustChangePassword && isPasswordExpired(user.passwordChangedAt)) {
      mustChangePassword = true;
      await setForceChangePassword(user.id, true).catch(() => undefined);
      await createAuditLog({
        tenantId: user.tenantId,
        userId: user.id,
        action: "user.password.expired",
      }).catch(() => undefined);
    }

    await updateLastLogin(user.id);

    // Phase 2: persist success row
    void recordLoginAttempt({
      ip: clientIp ?? "unknown",
      email,
      success: true,
    });

    const payload: JwtPayload = {
      sub: user.id,
      tid: user.tenantId,
      email: user.email,
      role: user.role,
    };
    if (mustChangePassword) {
      payload.fcp = true;
    }
    // Phase 2: include password expiry timestamp when the policy is enabled
    const pwExp = computePasswordExpiresAt(user.passwordChangedAt);
    if (pwExp !== null) {
      payload.pwExp = pwExp;
    }

    // Phase 3: MFA two-phase flow — if user has MFA enabled, return a
    // short-lived challenge token instead of real JWT tokens.  The
    // client must call auth.mfa.verify with this token + a TOTP code.
    if (user.mfaEnabled && !mustChangePassword) {
      const challengeToken = issueMfaChallenge({
        userId: user.id,
        tenantId: user.tenantId,
        email: user.email,
        role: user.role,
      });
      await createAuditLog({
        tenantId: user.tenantId,
        userId: user.id,
        action: "user.login.mfa_required",
      });
      respond(true, {
        mfaRequired: true,
        mfaChallengeToken: challengeToken,
      });
      return;
    }

    // Phase 3: capture device info for the sessions UI
    const uaHeader = (client as unknown as { userAgent?: string })?.userAgent ?? null;
    const uaParsed = parseUserAgent(uaHeader);
    const deviceInfo = {
      ip: clientIp,
      userAgent: uaHeader,
      label: uaParsed.label,
    };

    const tokens = await generateTokenPair(payload, deviceInfo);

    await createAuditLog({
      tenantId: user.tenantId,
      userId: user.id,
      action: "user.login",
    });

    respond(true, {
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        displayName: user.displayName,
        tenantId: user.tenantId,
        forceChangePassword: mustChangePassword,
        mfaEnabled: user.mfaEnabled,
      },
      pwExp: pwExp ?? undefined,
      ...tokens,
    });
  },

  /**
   * Refresh access token using a refresh token.
   *
   * Params:
   *   refreshToken: string
   */
  "auth.refresh": async ({ params, respond }: GatewayRequestHandlerOptions) => {
    if (!requireDb(respond)) {
      return;
    }

    const { refreshToken } = params as { refreshToken: string };
    if (!refreshToken) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_PARAMS, "Missing refreshToken"));
      return;
    }

    const result = await verifyRefreshToken(refreshToken);
    if (!result) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Invalid or expired refresh token"),
      );
      return;
    }

    const user = await getUserById(result.userId);
    if (!user || user.status !== "active") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "User account is not active"),
      );
      return;
    }

    const payload: JwtPayload = {
      sub: user.id,
      tid: user.tenantId,
      email: user.email,
      role: user.role,
    };
    // Phase 3: bump last_used_at on the old session so the sessions UI
    // tracks recency even across access-token refreshes.
    void touchSession(refreshToken);

    const tokens = await generateTokenPair(payload);

    respond(true, tokens);
  },

  /**
   * Logout — revoke all refresh tokens for the current user.
   */
  "auth.logout": async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
    if (!requireDb(respond)) {
      return;
    }

    const tenant = (client as unknown as { tenant?: TenantContext })?.tenant;
    if (!tenant) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Not authenticated"));
      return;
    }

    await revokeAllUserTokens(tenant.userId);

    await createAuditLog({
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      action: "user.logout",
    });

    respond(true, { ok: true });
  },

  /**
   * Get current authenticated user info.
   */
  "auth.me": async ({ client, respond }: GatewayRequestHandlerOptions) => {
    if (!requireDb(respond)) {
      return;
    }

    const tenant = (client as unknown as { tenant?: TenantContext })?.tenant;
    if (!tenant) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Not authenticated"));
      return;
    }

    const user = await getUserById(tenant.userId);
    if (!user) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "User not found"));
      return;
    }

    const tenantInfo = await import("../../db/models/tenant.js").then((m) =>
      m.getTenantById(tenant.tenantId),
    );

    respond(true, {
      user: toSafeUser(user),
      tenant: tenantInfo
        ? { id: tenantInfo.id, name: tenantInfo.name, plan: tenantInfo.plan }
        : null,
      permissions: await import("../../auth/rbac.js").then((m) =>
        m.getPermissionsForRole(user.role),
      ),
    });
  },

  // ==========================================================================
  // Auth Phase 1 — self-service password change
  // ==========================================================================

  /**
   * Change the current user's password.
   *
   * Params: { currentPassword: string, newPassword: string }
   *
   * On success: revokes all refresh tokens (forces re-login on every device).
   */
  "auth.changePassword": async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
    if (!requireDb(respond)) {
      return;
    }

    const ctx = (client as unknown as { tenant?: TenantContext })?.tenant;
    if (!ctx) {
      respond(false, undefined, errorShape(ErrorCodes.UNAUTHORIZED, "Not authenticated"));
      return;
    }

    const { currentPassword, newPassword } = params as {
      currentPassword: string;
      newPassword: string;
    };
    if (!currentPassword || !newPassword) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_PARAMS, "Missing currentPassword or newPassword"),
      );
      return;
    }

    const user = await getUserById(ctx.userId);
    if (!user || !user.passwordHash) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "User has no password set"));
      return;
    }

    const ok = await verifyPassword(currentPassword, user.passwordHash);
    if (!ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "当前密码不正确"));
      return;
    }

    if (currentPassword === newPassword) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_PARAMS, "新密码不能与当前密码相同"));
      return;
    }

    const policy = validatePasswordStrength(newPassword, user.email);
    if (!policy.ok) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_PARAMS, policy.message ?? "密码不符合安全策略"),
      );
      return;
    }

    // Phase 2: reject reuse of any of the last N passwords
    if (await isPasswordInHistory(user.id, newPassword)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_PARAMS, "不能与最近 5 次使用过的密码相同"),
      );
      return;
    }

    // Archive the CURRENT hash before overwriting it
    if (user.passwordHash) {
      await archivePasswordHash(user.id, user.passwordHash);
    }
    await updateUserPassword(user.id, newPassword);
    await revokeAllUserTokens(user.id);
    await revokeAllResetTokens(user.id);

    await createAuditLog({
      tenantId: user.tenantId,
      userId: user.id,
      action: "user.password.changed",
    });

    respond(true, { ok: true });
  },

  // ==========================================================================
  // Auth Phase 1 — capability discovery (used by forgot-password page)
  // ==========================================================================

  /**
   * Tell the client whether the deployment can send password-reset emails.
   *
   * Returns: { email: boolean }
   *
   * Public + IP-rate-limited (reuses login limiter under a synthetic email).
   */
  "auth.capabilities": async ({ client, respond }: GatewayRequestHandlerOptions) => {
    const clientIp =
      (client as unknown as { rawClientIp?: string })?.rawClientIp ?? client?.clientIp;
    const gate = loginRateLimiter.check(clientIp, "__capabilities__");
    if (!gate.allowed) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.RATE_LIMITED, "Too many requests", {
          retryAfterMs: gate.retryAfterMs,
        }),
      );
      return;
    }
    // Count this call against the IP bucket regardless of success.
    loginRateLimiter.recordFailure(clientIp, "__capabilities__");
    respond(true, { email: hasEmailCapability() });
  },

  // ==========================================================================
  // Auth Phase 1 — forgot password (path A: email)
  // ==========================================================================

  /**
   * Begin a forgot-password flow.  Always responds with `ok: true` regardless
   * of whether the email exists, to avoid user enumeration.
   *
   * Params: { email: string }
   */
  "auth.forgotPassword": async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
    if (!requireCaptcha(params, respond)) {
      return;
    }
    if (!requireDb(respond)) {
      return;
    }

    const { email } = params as { email: string };
    if (!email) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_PARAMS, "Missing email"));
      return;
    }

    // Capability + per-email throttle BEFORE any DB lookup, so cost is bounded.
    if (!hasEmailCapability()) {
      // Respond truthfully so the UI knows to show "contact admin" copy.
      respond(true, { ok: true, email: false });
      return;
    }

    if (shouldThrottleForgot(email)) {
      // Pretend success — don't leak that an in-flight token exists.
      respond(true, { ok: true, email: true });
      return;
    }

    const user = await findUserByEmail(email);
    // Only console-login roles can use forgot-password
    const eligible =
      user && user.status === "active" && (user.role === "platform-admin" || user.role === "owner");

    console.log(
      `[auth.forgotPassword] email=${email} userFound=${!!user} role=${user?.role ?? "n/a"} status=${user?.status ?? "n/a"} eligible=${!!eligible}`,
    );

    if (eligible && user) {
      const issued = await issueResetToken(user.id, 30);
      const baseUrl = process.env.ENCLAWS_PUBLIC_BASE_URL ?? "";
      const resetUrl = `${baseUrl.replace(/\/$/, "")}/#/auth/reset-password?token=${encodeURIComponent(issued.token)}`;
      console.log(
        `[auth.forgotPassword] issuing reset token for userId=${user.id} to=${user.email ?? email} url=${resetUrl}`,
      );
      const sent = await sendPasswordResetEmail({
        to: user.email ?? email,
        resetUrl,
        expiresInMinutes: 30,
      }).catch((err) => {
        console.error("[auth.forgotPassword] sendPasswordResetEmail failed:", err);
        return false;
      });
      console.log(`[auth.forgotPassword] sendPasswordResetEmail result=${sent}`);
      noteForgotIssued(email);
      await createAuditLog({
        tenantId: user.tenantId,
        userId: user.id,
        action: "user.password.reset.requested",
        ipAddress: client?.clientIp,
      }).catch(() => undefined);
    } else {
      console.log(
        `[auth.forgotPassword] skipped — user not eligible for reset (not found or not owner/platform-admin)`,
      );
    }

    respond(true, { ok: true, email: true });
  },

  /**
   * Consume a reset token and set a new password.
   *
   * Params: { token: string, newPassword: string }
   */
  "auth.forgotPassword.verify": async ({
    params,
    client,
    respond,
  }: GatewayRequestHandlerOptions) => {
    if (!requireDb(respond)) {
      return;
    }

    const { token, newPassword } = params as { token: string; newPassword: string };
    if (!token || !newPassword) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_PARAMS, "Missing token or newPassword"),
      );
      return;
    }

    const found = await findResetToken(token, "reset");
    if (!found) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "重置链接无效或已过期"));
      return;
    }

    const user = await getUserById(found.userId);
    if (!user) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "User not found"));
      return;
    }

    const policy = validatePasswordStrength(newPassword, user.email);
    if (!policy.ok) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_PARAMS, policy.message ?? "密码不符合安全策略"),
      );
      return;
    }

    // Bug fix: reject newPassword === current password.  The current hash
    // is NOT in password_history (history only contains *prior* hashes
    // that were rotated away), so the history check below wouldn't catch
    // this on its own — especially for fresh accounts where history is
    // empty.  Compare new plaintext against the stored current hash.
    if (user.passwordHash && (await verifyPassword(newPassword, user.passwordHash))) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_PARAMS, "新密码不能与当前密码相同"));
      return;
    }

    // Phase 2: reject reuse of any of the last N passwords
    if (await isPasswordInHistory(user.id, newPassword)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_PARAMS, "不能与最近 5 次使用过的密码相同"),
      );
      return;
    }

    if (user.passwordHash) {
      await archivePasswordHash(user.id, user.passwordHash);
    }
    await updateUserPassword(user.id, newPassword);
    await consumeResetToken(found.id);
    await revokeAllUserTokens(user.id);
    await revokeAllResetTokens(user.id);

    await createAuditLog({
      tenantId: user.tenantId,
      userId: user.id,
      action: "user.password.reset.completed",
      ipAddress: client?.clientIp,
    }).catch(() => undefined);

    respond(true, { ok: true });
  },

  // ==========================================================================
  // Auth Phase 1 — admin reset (path B: one-time view link)
  // ==========================================================================

  /**
   * platform-admin generates a temporary password + one-time view link
   * for an owner who has lost access.
   *
   * Params: { userId: string }
   *
   * Returns: { viewToken, viewUrl, expiresAt }
   *           — the admin sends this URL to the owner via any channel.
   */
  "auth.adminResetPassword": async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
    if (!requireDb(respond)) {
      return;
    }

    const ctx = (client as unknown as { tenant?: TenantContext })?.tenant;
    if (!ctx || ctx.role !== "platform-admin") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAUTHORIZED, "Only platform-admin can perform this action"),
      );
      return;
    }

    const { userId } = params as { userId: string };
    if (!userId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_PARAMS, "Missing userId"));
      return;
    }

    const target = await getUserById(userId);
    if (!target) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "User not found"));
      return;
    }
    if (target.role !== "owner" && target.role !== "platform-admin") {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "Admin reset is only available for owner / platform-admin accounts",
        ),
      );
      return;
    }

    const tempPassword = generateTempPassword();
    await updateUserPassword(target.id, tempPassword, { keepForceFlag: true });
    await setForceChangePassword(target.id, true);
    await revokeAllUserTokens(target.id);
    await revokeAllResetTokens(target.id);

    const issued = await issueViewTempToken(target.id, tempPassword, 24 * 60);
    const baseUrl = process.env.ENCLAWS_PUBLIC_BASE_URL ?? "";
    const viewUrl = `${baseUrl.replace(/\/$/, "")}/#/auth/temp-password?token=${encodeURIComponent(issued.token)}`;

    await createAuditLog({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: "user.password.admin_reset",
      resource: `user:${target.id}`,
      detail: { targetUserId: target.id },
      ipAddress: client?.clientIp,
    }).catch(() => undefined);

    respond(true, {
      viewToken: issued.token,
      viewUrl,
      expiresAt: issued.expiresAt.toISOString(),
    });
  },

  /**
   * One-time view of an admin-issued temporary password.
   *
   * Params: { token: string }
   *
   * The first successful read marks the token consumed; subsequent reads
   * return 404.
   */
  "auth.viewTempPassword": async ({ params, respond }: GatewayRequestHandlerOptions) => {
    if (!requireDb(respond)) {
      return;
    }

    const { token } = params as { token: string };
    if (!token) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_PARAMS, "Missing token"));
      return;
    }

    const found = await findResetToken(token, "view-temp");
    if (!found) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "链接无效或已过期"));
      return;
    }

    const tempPassword = decryptTempPasswordPayload(found.payload);
    if (!tempPassword) {
      // Payload missing or undecryptable — consume to prevent replay and bail.
      await consumeResetToken(found.id);
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, "无法解密临时密码（密钥已变更）"),
      );
      return;
    }

    // Mark consumed BEFORE responding so a network retry can't read it twice.
    await consumeResetToken(found.id);

    respond(true, { tempPassword });
  },

  // ==========================================================================
  // Phase 3 — Session management
  // ==========================================================================

  "auth.sessions": async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
    if (!requireDb(respond)) {
      return;
    }
    const ctx = (client as unknown as { tenant?: TenantContext })?.tenant;
    if (!ctx) {
      respond(false, undefined, errorShape(ErrorCodes.UNAUTHORIZED, "Not authenticated"));
      return;
    }
    const { currentRefreshToken } = (params ?? {}) as { currentRefreshToken?: string };
    const sessions = await listUserSessions(ctx.userId, currentRefreshToken);
    respond(true, { sessions });
  },

  "auth.revokeSession": async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
    if (!requireDb(respond)) {
      return;
    }
    const ctx = (client as unknown as { tenant?: TenantContext })?.tenant;
    if (!ctx) {
      respond(false, undefined, errorShape(ErrorCodes.UNAUTHORIZED, "Not authenticated"));
      return;
    }
    const { sessionId } = params as { sessionId: string };
    if (!sessionId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_PARAMS, "Missing sessionId"));
      return;
    }
    const ok = await revokeSessionById(ctx.userId, sessionId);
    if (!ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Session not found"));
      return;
    }
    await createAuditLog({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: "user.session.revoked",
      detail: { sessionId },
    }).catch(() => undefined);
    respond(true, { ok: true });
  },

  "auth.revokeAllOtherSessions": async ({
    params,
    client,
    respond,
  }: GatewayRequestHandlerOptions) => {
    if (!requireDb(respond)) {
      return;
    }
    const ctx = (client as unknown as { tenant?: TenantContext })?.tenant;
    if (!ctx) {
      respond(false, undefined, errorShape(ErrorCodes.UNAUTHORIZED, "Not authenticated"));
      return;
    }
    const { currentRefreshToken } = params as { currentRefreshToken: string };
    if (!currentRefreshToken) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_PARAMS, "Missing currentRefreshToken"),
      );
      return;
    }
    const count = await revokeOtherSessions(ctx.userId, currentRefreshToken);
    await createAuditLog({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: "user.sessions.revoked_others",
      detail: { count },
    }).catch(() => undefined);
    respond(true, { revoked: count });
  },

  // ==========================================================================
  // Phase 3 — Email verification
  // ==========================================================================

  "auth.verifyEmail": async ({ params, respond }: GatewayRequestHandlerOptions) => {
    if (!requireDb(respond)) {
      return;
    }
    const { token } = params as { token: string };
    if (!token) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_PARAMS, "Missing token"));
      return;
    }
    const userId = await consumeVerifyEmailToken(token);
    if (!userId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Invalid or expired verification link"),
      );
      return;
    }
    // Activate the user
    const { query: dbQuery, getDbType: gdt, DB_SQLITE: sq } = await import("../../db/index.js");
    const nowExpr = gdt() === sq ? "datetime('now')" : "NOW()";
    await dbQuery(
      `UPDATE users SET status = 'active', updated_at = ${nowExpr} WHERE id = $1 AND status = 'invited'`,
      [userId],
    );
    respond(true, { ok: true });
  },

  "auth.resendVerifyEmail": async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
    if (!requireDb(respond)) {
      return;
    }
    const { email } = params as { email: string };
    if (!email) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_PARAMS, "Missing email"));
      return;
    }
    if (!hasEmailCapability()) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Email not configured"));
      return;
    }
    if (shouldThrottleResend(email)) {
      respond(true, { ok: true });
      return;
    }
    const user = await findUserByEmail(email);
    if (user && user.status === "invited") {
      const issued = await issueVerifyEmailToken(user.id, 24 * 60);
      const baseUrl = process.env.ENCLAWS_PUBLIC_BASE_URL ?? "";
      const verifyUrl = `${baseUrl.replace(/\/$/, "")}/#/auth/verify-email?token=${encodeURIComponent(issued.token)}`;
      await sendVerifyEmail({ to: email, verifyUrl, expiresInHours: 24 }).catch(() => undefined);
      noteResendIssued(email);
    }
    // Always respond ok to prevent enumeration
    respond(true, { ok: true });
  },

  // ==========================================================================
  // Phase 3 — MFA (TOTP)
  // ==========================================================================

  "auth.mfa.setup.begin": async ({ client, respond }: GatewayRequestHandlerOptions) => {
    if (!requireDb(respond)) {
      return;
    }
    const ctx = (client as unknown as { tenant?: TenantContext })?.tenant;
    if (!ctx) {
      respond(false, undefined, errorShape(ErrorCodes.UNAUTHORIZED, "Not authenticated"));
      return;
    }
    const user = await getUserById(ctx.userId);
    if (!user) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "User not found"));
      return;
    }
    if (user.mfaEnabled) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "MFA is already enabled"));
      return;
    }
    const result = beginMfaSetup(user.email ?? ctx.userId);
    respond(true, result);
  },

  "auth.mfa.setup.verify": async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
    if (!requireDb(respond)) {
      return;
    }
    const ctx = (client as unknown as { tenant?: TenantContext })?.tenant;
    if (!ctx) {
      respond(false, undefined, errorShape(ErrorCodes.UNAUTHORIZED, "Not authenticated"));
      return;
    }
    const { secret, code, backupCodes } = params as {
      secret: string;
      code: string;
      backupCodes: string[];
    };
    if (!secret || !code || !Array.isArray(backupCodes)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_PARAMS, "Missing secret, code, or backupCodes"),
      );
      return;
    }
    // Verify the TOTP code against the secret to prove the user scanned the QR
    const { verifyTOTP } = await import("../../auth/mfa-totp.js");
    if (!verifyTOTP(secret, code)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Invalid TOTP code"));
      return;
    }
    await completeMfaSetup(ctx.userId, secret, backupCodes);
    await createAuditLog({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: "user.mfa.enabled",
    }).catch(() => undefined);
    respond(true, { ok: true });
  },

  "auth.mfa.disable": async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
    if (!requireDb(respond)) {
      return;
    }
    const ctx = (client as unknown as { tenant?: TenantContext })?.tenant;
    if (!ctx) {
      respond(false, undefined, errorShape(ErrorCodes.UNAUTHORIZED, "Not authenticated"));
      return;
    }
    const { currentPassword } = params as { currentPassword: string };
    if (!currentPassword) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_PARAMS, "Missing currentPassword"));
      return;
    }
    const user = await getUserById(ctx.userId);
    if (!user || !user.passwordHash) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "User not found"));
      return;
    }
    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Wrong password"));
      return;
    }
    await disableMfa(ctx.userId);
    await createAuditLog({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: "user.mfa.disabled",
    }).catch(() => undefined);
    respond(true, { ok: true });
  },

  "auth.mfa.verify": async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
    if (!requireDb(respond)) {
      return;
    }
    const { challengeToken, code } = params as { challengeToken: string; code: string };
    if (!challengeToken || !code) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_PARAMS, "Missing challengeToken or code"),
      );
      return;
    }
    const challenge = consumeMfaChallenge(challengeToken);
    if (!challenge) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "MFA challenge expired or invalid"),
      );
      return;
    }
    const user = await getUserById(challenge.userId);
    if (!user) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "User not found"));
      return;
    }

    // Try TOTP code first, then backup code
    let ok = verifyUserTotp(user, code);
    if (!ok) {
      ok = await tryBackupCode(user.id, user.mfaBackupCodes, code);
    }
    if (!ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Invalid MFA code"));
      return;
    }

    // MFA passed — issue real tokens
    const payload: JwtPayload = {
      sub: user.id,
      tid: challenge.tenantId,
      email: user.email,
      role: user.role,
    };
    const pwExp = computePasswordExpiresAt(user.passwordChangedAt);
    if (pwExp !== null) {
      payload.pwExp = pwExp;
    }

    const clientIp =
      (client as unknown as { rawClientIp?: string })?.rawClientIp ?? client?.clientIp;
    const uaParsed = parseUserAgent(null);
    const tokens = await generateTokenPair(payload, {
      ip: clientIp,
      userAgent: null,
      label: uaParsed.label,
    });

    await createAuditLog({
      tenantId: challenge.tenantId,
      userId: user.id,
      action: "user.login.mfa_verified",
    });

    respond(true, {
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        displayName: user.displayName,
        tenantId: challenge.tenantId,
        forceChangePassword: user.forceChangePassword,
        mfaEnabled: true,
      },
      pwExp: pwExp ?? undefined,
      ...tokens,
    });
  },
};
