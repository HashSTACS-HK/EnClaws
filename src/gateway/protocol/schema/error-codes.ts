import type { ErrorShape } from "./types.js";

export const ErrorCodes = {
  NOT_LINKED: "NOT_LINKED",
  NOT_PAIRED: "NOT_PAIRED",
  AGENT_TIMEOUT: "AGENT_TIMEOUT",
  INVALID_REQUEST: "INVALID_REQUEST",
  INVALID_PARAMS: "INVALID_PARAMS",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  UNAUTHORIZED: "UNAUTHORIZED",
  UNAVAILABLE: "UNAVAILABLE",
  /** Auth Phase 1: returned by auth.login when rate-limited / in backoff. */
  RATE_LIMITED: "RATE_LIMITED",
  /**
   * Tenant quota exceeded — returned by createAgent / createChannel /
   * inviteUser / onboarding setup when the tenant's plan limit is hit.
   * `details` carries `{ resource: "agents"|"channels"|"users"|"tokensPerMonth", current: number, max: number }`
   * so the frontend can render a localized message.
   */
  QUOTA_EXCEEDED: "QUOTA_EXCEEDED",
  /** Captcha answer missing/wrong/expired on login/register/forgotPassword. */
  CAPTCHA_INVALID: "CAPTCHA_INVALID",
  /** Captcha id or answer field absent in the request payload. */
  CAPTCHA_REQUIRED: "CAPTCHA_REQUIRED",
  /** App secret provided does not match the registered secret for the CS object. */
  INVALID_APP_SECRET: "INVALID_APP_SECRET",
  /** The requested resource (CS object, session, etc.) does not exist. */
  OBJECT_NOT_FOUND: "OBJECT_NOT_FOUND",
  /** The CS object exists but has been deactivated and cannot accept new sessions. */
  OBJECT_INACTIVE: "OBJECT_INACTIVE",
  /** Cannot delete/archive the CS object because it has one or more active sessions. */
  OBJECT_HAS_ACTIVE_SESSIONS: "OBJECT_HAS_ACTIVE_SESSIONS",
  /** A session mode change was attempted while a conflicting transition is in progress. */
  MODE_CHANGE_CONFLICT: "MODE_CHANGE_CONFLICT",
  /** The widget channel referenced by widgetId has been explicitly disabled and cannot accept messages. */
  WIDGET_DISABLED: "WIDGET_DISABLED",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export function errorShape(
  code: ErrorCode,
  message: string,
  opts?: { details?: unknown; retryable?: boolean; retryAfterMs?: number },
): ErrorShape {
  return {
    code,
    message,
    ...opts,
  };
}

/**
 * Read the configured "contact admin to upgrade plan" link from env.
 * Used by all QUOTA_EXCEEDED errors so the UI / IM channels can render
 * a clickable upgrade link. Returns undefined when unset so callers can
 * gracefully omit it from the message.
 */
export function getPlanUpgradeLink(): string | undefined {
  const v = process.env.ENCLAWS_PLAN_UPGRADE_LINK;
  return v && v.trim() ? v.trim() : undefined;
}
