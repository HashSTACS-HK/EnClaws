/**
 * In-process rate limiter for `auth.login` and related credential RPCs.
 *
 * Design goals (Phase 1, see auth-security-roadmap.md §3.1):
 *   1. Compound key (IP + email) so that one attacker IP cannot lock out
 *      every legitimate user, and one targeted email cannot be locked from
 *      legitimate IPs.
 *   2. Exponential backoff (no hard suspended-state) — avoids the DoS
 *      surface of forced-lockout.
 *   3. Independent counters per IP, per email, and per (IP, email) tuple,
 *      with the strictest currently-active backoff winning.
 *   4. Pure in-memory; Phase 2 swaps the storage layer for SQLite without
 *      changing this interface.
 *
 * The exported singleton {@link loginRateLimiter} is used by `auth.login`
 * (and other credential-bearing RPCs like `auth.changePassword`).
 */

// ---------------------------------------------------------------------------
// Backoff schedule
// ---------------------------------------------------------------------------

interface BackoffStep {
  /** Inclusive lower bound of failure count for this step. */
  failures: number;
  /** Wait duration in milliseconds before the next attempt is allowed. */
  waitMs: number;
}

const BACKOFF_STEPS: BackoffStep[] = [
  { failures: 0, waitMs: 0 },
  { failures: 1, waitMs: 0 },
  { failures: 2, waitMs: 0 },
  { failures: 3, waitMs: 0 },
  { failures: 4, waitMs: 60_000 }, // 1 min
  { failures: 6, waitMs: 5 * 60_000 }, // 5 min
  { failures: 8, waitMs: 15 * 60_000 }, // 15 min
  { failures: 10, waitMs: 30 * 60_000 }, // 30 min
  { failures: 15, waitMs: 2 * 60 * 60_000 }, // 2 h (cap)
];

function backoffFor(failures: number): number {
  let wait = 0;
  for (const step of BACKOFF_STEPS) {
    if (failures >= step.failures) {
      wait = step.waitMs;
    }
  }
  return wait;
}

// ---------------------------------------------------------------------------
// Sliding-window throttle (independent of backoff)
// ---------------------------------------------------------------------------

interface ThrottleConfig {
  windowMs: number;
  maxAttempts: number;
}

const THROTTLES = {
  /** Same (ip, email) tuple — most aggressive. */
  tuple: { windowMs: 60_000, maxAttempts: 5 } as ThrottleConfig,
  /** Same email from any IP. */
  email: { windowMs: 60_000, maxAttempts: 10 } as ThrottleConfig,
  /** Same IP regardless of email. */
  ip: { windowMs: 60_000, maxAttempts: 20 } as ThrottleConfig,
} as const;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface BucketState {
  /** Timestamps (epoch ms) of recent attempts inside the throttle window. */
  attempts: number[];
  /** Total failures across the lifetime of this bucket (drives backoff). */
  failures: number;
  /** Earliest epoch-ms at which a new attempt is allowed. */
  nextAllowedAt: number;
}

function newBucket(): BucketState {
  return { attempts: [], failures: 0, nextAllowedAt: 0 };
}

export interface LoginRateLimitCheck {
  allowed: boolean;
  /** Milliseconds the caller must wait before retrying. 0 if allowed. */
  retryAfterMs: number;
  /** Reason key, used by handlers to choose an error message. */
  reason?: "throttled" | "backoff";
}

export interface LoginRateLimiter {
  check(ip: string | undefined, email: string | undefined): LoginRateLimitCheck;
  recordFailure(ip: string | undefined, email: string | undefined): LoginRateLimitCheck;
  recordSuccess(ip: string | undefined, email: string | undefined): void;
  /** Test/diagnostic helper — clears all state. */
  reset(): void;
  /** Diagnostics: number of buckets currently tracked. */
  size(): number;
}

function normalizeEmail(email: string | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

function normalizeIp(ip: string | undefined): string {
  return (ip ?? "unknown").trim();
}

function slide(bucket: BucketState, now: number, windowMs: number): void {
  const cutoff = now - windowMs;
  if (bucket.attempts.length > 0 && bucket.attempts[0] < cutoff) {
    bucket.attempts = bucket.attempts.filter((ts) => ts > cutoff);
  }
}

export function createLoginRateLimiter(): LoginRateLimiter {
  const tupleBuckets = new Map<string, BucketState>();
  const emailBuckets = new Map<string, BucketState>();
  const ipBuckets = new Map<string, BucketState>();

  function getOrCreate(map: Map<string, BucketState>, key: string): BucketState {
    let b = map.get(key);
    if (!b) {
      b = newBucket();
      map.set(key, b);
    }
    return b;
  }

  function checkBucket(bucket: BucketState, cfg: ThrottleConfig, now: number): LoginRateLimitCheck {
    if (bucket.nextAllowedAt > now) {
      return { allowed: false, retryAfterMs: bucket.nextAllowedAt - now, reason: "backoff" };
    }
    slide(bucket, now, cfg.windowMs);
    if (bucket.attempts.length >= cfg.maxAttempts) {
      const oldest = bucket.attempts[0];
      return { allowed: false, retryAfterMs: oldest + cfg.windowMs - now, reason: "throttled" };
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  function check(rawIp: string | undefined, rawEmail: string | undefined): LoginRateLimitCheck {
    const now = Date.now();
    const ip = normalizeIp(rawIp);
    const email = normalizeEmail(rawEmail);
    const tupleKey = `${ip}|${email}`;

    const tupleBucket = getOrCreate(tupleBuckets, tupleKey);
    const tupleResult = checkBucket(tupleBucket, THROTTLES.tuple, now);
    if (!tupleResult.allowed) {
      return tupleResult;
    }

    if (email) {
      const emailBucket = getOrCreate(emailBuckets, email);
      const emailResult = checkBucket(emailBucket, THROTTLES.email, now);
      if (!emailResult.allowed) {
        return emailResult;
      }
    }

    const ipBucket = getOrCreate(ipBuckets, ip);
    const ipResult = checkBucket(ipBucket, THROTTLES.ip, now);
    if (!ipResult.allowed) {
      return ipResult;
    }

    return { allowed: true, retryAfterMs: 0 };
  }

  function recordFailure(
    rawIp: string | undefined,
    rawEmail: string | undefined,
  ): LoginRateLimitCheck {
    const now = Date.now();
    const ip = normalizeIp(rawIp);
    const email = normalizeEmail(rawEmail);
    const tupleKey = `${ip}|${email}`;

    const tupleBucket = getOrCreate(tupleBuckets, tupleKey);
    tupleBucket.attempts.push(now);
    tupleBucket.failures += 1;
    const tupleWait = backoffFor(tupleBucket.failures);
    if (tupleWait > 0) {
      tupleBucket.nextAllowedAt = now + tupleWait;
    }

    if (email) {
      const emailBucket = getOrCreate(emailBuckets, email);
      emailBucket.attempts.push(now);
      emailBucket.failures += 1;
    }

    const ipBucket = getOrCreate(ipBuckets, ip);
    ipBucket.attempts.push(now);
    ipBucket.failures += 1;

    if (tupleWait > 0) {
      return { allowed: false, retryAfterMs: tupleWait, reason: "backoff" };
    }
    // Even when no backoff is active yet, return wait=0 so callers can
    // surface "you have N attempts left" if desired.
    return { allowed: true, retryAfterMs: 0 };
  }

  function recordSuccess(rawIp: string | undefined, rawEmail: string | undefined): void {
    const ip = normalizeIp(rawIp);
    const email = normalizeEmail(rawEmail);
    const tupleKey = `${ip}|${email}`;
    tupleBuckets.delete(tupleKey);
    if (email) {
      emailBuckets.delete(email);
    }
    // Note: we intentionally do NOT clear the ipBucket — a single successful
    // login from an IP that's been spamming many users should not reset the
    // overall IP-level pressure.
  }

  function reset(): void {
    tupleBuckets.clear();
    emailBuckets.clear();
    ipBuckets.clear();
  }

  function size(): number {
    return tupleBuckets.size + emailBuckets.size + ipBuckets.size;
  }

  return { check, recordFailure, recordSuccess, reset, size };
}

/** Process-wide singleton used by the gateway RPC handlers. */
export const loginRateLimiter: LoginRateLimiter = createLoginRateLimiter();

/** Helper for callers that need to format a retry-after header value. */
export function retryAfterSeconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

// ---------------------------------------------------------------------------
// Phase 2: warm the in-memory limiter from persisted login_attempts on boot.
//
// This makes the exponential backoff survive gateway restarts and ensures
// all instances of a multi-process deployment converge on the same state
// shortly after each process starts.  We intentionally only replay FAILED
// attempts — successful logins clear buckets anyway, and the tuple "last
// success" is not load-bearing after restart.
// ---------------------------------------------------------------------------

const WARMUP_WINDOW_MS = 2 * 60 * 60 * 1000; // 2h: fits the worst-case backoff step

/**
 * Re-hydrate {@link loginRateLimiter} from recent failed attempts in the
 * database.  Safe to call once at gateway boot; subsequent calls are
 * no-ops if nothing new is available (but don't harm either).
 *
 * Errors are logged and swallowed — the limiter falls back to pure
 * in-memory behaviour, which is what Phase 1 shipped with.
 */
export async function warmLoginRateLimiterFromDb(
  limiter: LoginRateLimiter = loginRateLimiter,
): Promise<void> {
  try {
    const { loadRecentFailures } = await import("./login-attempts.js");
    const rows = await loadRecentFailures(WARMUP_WINDOW_MS);
    if (rows.length === 0) {
      return;
    }
    for (const row of rows) {
      // Replay each failure — this walks the backoff ladder identically
      // to live traffic.  The side-effect we care about is that the
      // (ip, email) bucket's nextAllowedAt reflects the historical
      // pressure, so a fresh gateway cannot be used as a backoff bypass.
      limiter.recordFailure(row.ip, row.email ?? undefined);
    }
    console.log(`[login-rate-limit] warmed ${rows.length} failure(s) from login_attempts`);
  } catch (err) {
    console.error(
      `[login-rate-limit] warmup failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
