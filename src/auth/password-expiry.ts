/**
 * Password expiry policy (Phase 2, §6).
 *
 * Compliance-driven: NIST SP 800-63B explicitly recommends NOT forcing
 * periodic changes.  This feature is OFF BY DEFAULT and intended for
 * deployments that must satisfy 等保 2.0 三级 (90-day rotation).
 *
 * Environment variables:
 *   PASSWORD_MAX_AGE_DAYS=0           # 0 = disabled (default)
 *   PASSWORD_WARN_DAYS_BEFORE=14      # days before expiry to start warning
 *
 * Behaviour when enabled (MAX_AGE > 0):
 *   - auth.login: if password_changed_at + MAX_AGE <= now → force_change_password = 1
 *   - JWT payload carries `pwExp` (epoch ms of expiry) so the UI can
 *     render a "password expires in X days" banner.
 *   - Banner is triggered client-side when (pwExp - now) <= WARN_DAYS.
 */

const DEFAULT_MAX_AGE_DAYS = 0;
const DEFAULT_WARN_DAYS = 14;

export interface PasswordExpiryConfig {
  /** 0 means "no expiry". */
  maxAgeDays: number;
  /** How many days before expiry to surface the warning banner. */
  warnDaysBefore: number;
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

export function loadPasswordExpiryConfig(): PasswordExpiryConfig {
  return {
    maxAgeDays: parseIntEnv("PASSWORD_MAX_AGE_DAYS", DEFAULT_MAX_AGE_DAYS),
    warnDaysBefore: parseIntEnv("PASSWORD_WARN_DAYS_BEFORE", DEFAULT_WARN_DAYS),
  };
}

export function isExpiryEnabled(): boolean {
  return loadPasswordExpiryConfig().maxAgeDays > 0;
}

/**
 * Compute the epoch-ms at which the user's current password will expire,
 * or `null` when expiry is disabled or the timestamp is missing.
 */
export function computePasswordExpiresAt(
  passwordChangedAt: Date | null,
  cfg: PasswordExpiryConfig = loadPasswordExpiryConfig(),
): number | null {
  if (cfg.maxAgeDays <= 0) {
    return null;
  }
  if (!passwordChangedAt) {
    return null;
  }
  const changedAtMs =
    passwordChangedAt instanceof Date
      ? passwordChangedAt.getTime()
      : Number(new Date(passwordChangedAt));
  if (!Number.isFinite(changedAtMs)) {
    return null;
  }
  return changedAtMs + cfg.maxAgeDays * 86400_000;
}

/**
 * Is the password currently expired? (i.e. we should force change on next login)
 */
export function isPasswordExpired(
  passwordChangedAt: Date | null,
  cfg: PasswordExpiryConfig = loadPasswordExpiryConfig(),
): boolean {
  const expiresAt = computePasswordExpiresAt(passwordChangedAt, cfg);
  if (expiresAt === null) {
    return false;
  }
  return Date.now() >= expiresAt;
}

/**
 * Remaining days until expiry (floored), or null when disabled.
 */
export function daysUntilExpiry(
  passwordChangedAt: Date | null,
  cfg: PasswordExpiryConfig = loadPasswordExpiryConfig(),
): number | null {
  const expiresAt = computePasswordExpiresAt(passwordChangedAt, cfg);
  if (expiresAt === null) {
    return null;
  }
  const diffMs = expiresAt - Date.now();
  return Math.floor(diffMs / 86400_000);
}

/**
 * Should the client show the "expiring soon" warning banner?
 */
export function shouldWarnExpiry(
  passwordChangedAt: Date | null,
  cfg: PasswordExpiryConfig = loadPasswordExpiryConfig(),
): boolean {
  const days = daysUntilExpiry(passwordChangedAt, cfg);
  if (days === null) {
    return false;
  }
  return days >= 0 && days <= cfg.warnDaysBefore;
}
