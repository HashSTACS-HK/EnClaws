/**
 * Graphic captcha for human-facing auth forms (login / register /
 * forgot-password).
 *
 * - Generates a 5-character alphanumeric SVG challenge via `svg-captcha`.
 * - Stores answers in an in-process `Map` with a short TTL; each entry
 *   is single-use (verify consumes it).
 * - A periodic cleanup interval prunes expired entries.
 *
 * Multi-process gateways: the current store is per-process. When a
 * challenge is issued by one process, it can only be verified by the
 * same process. Single-process deployments are unaffected. If/when
 * EnClaws is deployed behind a non-sticky load balancer, move the
 * store to Redis or the DB — see TODO(captcha-scale) below.
 */

import crypto from "node:crypto";
import svgCaptcha from "svg-captcha";

interface CaptchaEntry {
  answer: string;
  expiresAt: number;
}

const TTL_MS = 3 * 60_000;
const CLEANUP_INTERVAL_MS = 60_000;
const CODE_LENGTH = 5;
/** Exclude visually ambiguous characters. svg-captcha treats this as a blocklist. */
const IGNORE_CHARS = "0o1iIlL";

// TODO(captcha-scale): swap for a shared store (Redis/DB) when gateway
// needs horizontal scaling without sticky sessions.
const store = new Map<string, CaptchaEntry>();

let cleanupTimer: ReturnType<typeof setInterval> | undefined;
function ensureCleanupStarted(): void {
  if (cleanupTimer) {
    return;
  }
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of store) {
      if (entry.expiresAt <= now) {
        store.delete(id);
      }
    }
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref?.();
}

export interface CaptchaChallenge {
  id: string;
  svg: string;
  expiresAt: number;
}

export function generateCaptcha(): CaptchaChallenge {
  ensureCleanupStarted();
  const captcha = svgCaptcha.create({
    size: CODE_LENGTH,
    noise: 3,
    color: true,
    background: "#f4f6f8",
    ignoreChars: IGNORE_CHARS,
    width: 160,
    height: 48,
    fontSize: 56,
  });
  const id = crypto.randomUUID();
  const expiresAt = Date.now() + TTL_MS;
  store.set(id, { answer: captcha.text.toLowerCase(), expiresAt });
  return { id, svg: captcha.data, expiresAt };
}

/**
 * One-shot verification. Returns true only if the id exists, has not
 * expired, and the answer matches (case-insensitive, trimmed). The
 * entry is deleted in every outcome — failed attempts cannot be reused.
 */
export function verifyCaptcha(id: string | undefined, answer: string | undefined): boolean {
  if (!id || typeof id !== "string") {
    return false;
  }
  if (!answer || typeof answer !== "string") {
    return false;
  }
  const entry = store.get(id);
  if (!entry) {
    return false;
  }
  store.delete(id);
  if (entry.expiresAt <= Date.now()) {
    return false;
  }
  return entry.answer === answer.trim().toLowerCase();
}

/** Test-only: wipe state and stop the cleanup timer. */
export function __resetCaptchaStoreForTest(): void {
  store.clear();
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = undefined;
  }
}
