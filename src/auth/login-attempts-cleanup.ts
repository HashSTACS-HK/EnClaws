/**
 * Periodic cleanup task for login_attempts (Phase 2, §8).
 *
 * Runs `cleanupOldLoginAttempts()` once at boot (catches anything missed
 * during downtime), then on a 24-hour interval.  The timer is unref'd so
 * the node process can still exit cleanly.
 */

import { cleanupOldLoginAttempts } from "./login-attempts.js";

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

let cleanupTimer: NodeJS.Timeout | null = null;

export function startLoginAttemptsCleanup(): void {
  if (cleanupTimer) {
    return;
  }

  // Run once at startup (don't await — fire-and-forget).
  void cleanupOldLoginAttempts().then((n) => {
    if (n > 0) {
      console.log(`[login-attempts] cleaned up ${n} expired row(s) on boot`);
    }
  });

  cleanupTimer = setInterval(() => {
    void cleanupOldLoginAttempts().then((n) => {
      if (n > 0) {
        console.log(`[login-attempts] scheduled cleanup removed ${n} row(s)`);
      }
    });
  }, CLEANUP_INTERVAL_MS);

  if (cleanupTimer.unref) {
    cleanupTimer.unref();
  }
}

export function stopLoginAttemptsCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}
