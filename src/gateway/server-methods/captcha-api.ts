/**
 * RPC endpoint that issues a graphic captcha challenge.
 *
 *   captcha.challenge — returns { id, svg, expiresAt }
 *
 * The id is later submitted alongside the user's answer in auth.login,
 * auth.register and auth.forgotPassword, where the handler calls
 * `verifyCaptcha` before any other validation.
 *
 * This endpoint is public (no auth). An IP-scoped rate limit prevents
 * it from being used to flood the in-memory captcha store.
 */

import { generateCaptcha } from "../../auth/captcha.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers, GatewayRequestHandlerOptions } from "./types.js";

const WINDOW_MS = 10_000;
const MAX_PER_WINDOW = 5;

interface IpWindow {
  windowStart: number;
  count: number;
}
const ipWindows = new Map<string, IpWindow>();

function resolveIp(client: GatewayRequestHandlerOptions["client"]): string {
  return client?.rawClientIp ?? client?.clientIp ?? "unknown";
}

function allowed(ip: string): boolean {
  const now = Date.now();
  const w = ipWindows.get(ip);
  if (!w || now - w.windowStart >= WINDOW_MS) {
    ipWindows.set(ip, { windowStart: now, count: 1 });
    return true;
  }
  if (w.count >= MAX_PER_WINDOW) {
    return false;
  }
  w.count += 1;
  return true;
}

export const captchaHandlers: GatewayRequestHandlers = {
  "captcha.challenge": ({ client, respond }: GatewayRequestHandlerOptions) => {
    const ip = resolveIp(client);
    if (!allowed(ip)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.RATE_LIMITED,
          "Too many captcha requests. Please wait a few seconds.",
          { retryable: true, retryAfterMs: WINDOW_MS },
        ),
      );
      return;
    }
    const challenge = generateCaptcha();
    respond(true, challenge);
  },
};

/** Test-only: reset the per-IP window table. */
export function __resetCaptchaRateLimitForTest(): void {
  ipWindows.clear();
}
