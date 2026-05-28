/**
 * Customer Service Widget visitor authentication.
 *
 * 客服 Widget 访客认证 — UUID + HMAC-SHA256。
 */

import crypto from "node:crypto";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("widget-auth");

/**
 * Resolve the HMAC secret from the environment variable.
 * Logs a warning if the env var is not set — the default must never be used in production.
 *
 * 从环境变量读取 HMAC secret。未配置时打印警告——生产环境必须设置。
 */
function resolveSecret(): string {
  const secret = process.env.ENCLAWS_CS_WIDGET_SECRET;
  if (!secret) {
    log.warn(
      "ENCLAWS_CS_WIDGET_SECRET is not set. " +
      "Widget visitor tokens are insecure. Set this env var before production deployment.",
    );
    // Use a per-process random fallback so each restart invalidates old tokens,
    // preventing hardcoded-default exploitation while keeping dev usable.
    // 每次重启生成新随机值，防止硬编码默认值被利用，同时不影响开发体验。
    return _devFallbackSecret;
  }
  return secret;
}

// Generated once per process — not persisted, so tokens expire on restart in dev.
// 每个进程生成一次，不持久化——开发环境重启后 token 自动失效。
const _devFallbackSecret = crypto.randomBytes(32).toString("hex");

/**
 * Generate a new visitor ID (UUID v4).
 *
 * 生成新的访客 ID。
 */
export function generateVisitorId(): string {
  return crypto.randomUUID();
}

/**
 * Generate a visitor token (HMAC-SHA256 of the visitor ID).
 *
 * 生成访客 token（对 visitor ID 做 HMAC-SHA256）。
 */
export function generateVisitorToken(visitorId: string, secret?: string): string {
  const hmac = crypto.createHmac("sha256", secret ?? resolveSecret());
  hmac.update(visitorId);
  return hmac.digest("hex");
}

/**
 * Verify a visitor token against the visitor ID.
 *
 * 验证访客 token。
 */
export function verifyVisitorToken(
  visitorId: string,
  token: string,
  secret?: string,
): boolean {
  const expected = generateVisitorToken(visitorId, secret ?? resolveSecret());
  // Constant-time comparison to prevent timing attacks
  // 常量时间比较，防止时序攻击
  if (expected.length !== token.length) {return false;}
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token));
}
