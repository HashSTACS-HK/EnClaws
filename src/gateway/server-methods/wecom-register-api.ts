/**
 * Gateway RPC handlers for WeCom bot registration via QR code.
 *
 * Methods:
 *   tenant.wecom.register.begin  - Start registration, returns QR code URL
 *   tenant.wecom.register.poll   - Poll for registration result (botId, secret)
 *
 * Backed by work.weixin.qq.com/ai/qc — the same flow used by
 * @wecom/wecom-openclaw-cli.
 */

import type { TenantContext } from "../../auth/middleware.js";
import { assertPermission, RbacError } from "../../auth/rbac.js";
import { isDbInitialized } from "../../db/index.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers, GatewayRequestHandlerOptions } from "./types.js";

const QR_GENERATE_URL = "https://work.weixin.qq.com/ai/qc/generate";
const QR_QUERY_URL = "https://work.weixin.qq.com/ai/qc/query_result";
const QR_PAGE_URL = "https://work.weixin.qq.com/ai/qc/gen";
const SOURCE = "wecom-cli";
const POLL_INTERVAL_SEC = 3;
const POLL_TIMEOUT_SEC = 300;

function getTenantCtx(
  client: GatewayRequestHandlerOptions["client"],
  respond: GatewayRequestHandlerOptions["respond"],
): TenantContext | null {
  if (!isDbInitialized()) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "Multi-tenant mode not enabled"),
    );
    return null;
  }
  const tenant = (client as unknown as { tenant?: TenantContext })?.tenant;
  if (!tenant) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Authentication required"));
    return null;
  }
  return tenant;
}

async function httpGetJson(url: string, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    return (await res.json()) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

export const wecomRegisterHandlers: GatewayRequestHandlers = {
  /**
   * Begin WeCom bot registration.
   *
   * Returns:
   *   { scode, authUrl, qrPageUrl, interval, expireIn }
   */
  "tenant.wecom.register.begin": async ({ client, respond }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {
      return;
    }

    try {
      assertPermission(ctx.role, "channel.create");
    } catch (err) {
      if (err instanceof RbacError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
        return;
      }
      throw err;
    }

    try {
      const url = `${QR_GENERATE_URL}?source=${SOURCE}&plat=0`;
      const resp = await httpGetJson(url);
      const data = resp.data as Record<string, unknown> | undefined;
      const scode = data?.scode as string | undefined;
      const authUrl = data?.auth_url as string | undefined;
      if (!scode || !authUrl) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "Failed to fetch WeCom QR code"),
        );
        return;
      }
      respond(true, {
        scode,
        authUrl,
        qrPageUrl: `${QR_PAGE_URL}?source=${SOURCE}&scode=${encodeURIComponent(scode)}`,
        interval: POLL_INTERVAL_SEC,
        expireIn: POLL_TIMEOUT_SEC,
      });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `WeCom register begin failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  },

  /**
   * Poll WeCom bot registration result.
   *
   * Params:
   *   scode: string (from begin response)
   *
   * Returns on success: { status: "completed", botId, secret }
   * Returns when pending: { status: "pending" }
   * Returns on error:   { status: "error", error }
   */
  "tenant.wecom.register.poll": async ({
    params,
    client,
    respond,
  }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {
      return;
    }

    try {
      assertPermission(ctx.role, "channel.create");
    } catch (err) {
      if (err instanceof RbacError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
        return;
      }
      throw err;
    }

    const scode = typeof params.scode === "string" ? params.scode : "";
    if (!scode) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "scode is required"));
      return;
    }

    try {
      const url = `${QR_QUERY_URL}?scode=${encodeURIComponent(scode)}`;
      const resp = await httpGetJson(url);
      const data = resp.data as Record<string, unknown> | undefined;
      const status = data?.status as string | undefined;

      if (status === "success") {
        const info = data?.bot_info as Record<string, unknown> | undefined;
        const botId = info?.botid as string | undefined;
        const secret = info?.secret as string | undefined;
        if (!botId || !secret) {
          respond(true, { status: "error", error: "missing_bot_info" });
          return;
        }
        respond(true, { status: "completed", botId, secret });
        return;
      }

      if (status === "expired" || status === "cancelled" || status === "canceled") {
        respond(true, { status: "error", error: status });
        return;
      }

      respond(true, { status: "pending" });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `WeCom register poll failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  },
};
