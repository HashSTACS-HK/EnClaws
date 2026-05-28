/**
 * Gateway RPC handlers for Feishu bot registration via QR code.
 *
 * Methods:
 *   tenant.feishu.register.begin  - Start registration, returns QR code URL
 *   tenant.feishu.register.poll   - Poll for registration result (client_id, client_secret)
 */

import type { GatewayRequestHandlers, GatewayRequestHandlerOptions } from "./types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { isDbInitialized } from "../../db/index.js";
import { assertPermission, RbacError } from "../../auth/rbac.js";
import type { TenantContext } from "../../auth/middleware.js";

// ---------------------------------------------------------------------------
// Feishu registration API base URLs
// ---------------------------------------------------------------------------

const FEISHU_ENV_URLS: Record<string, string> = {
  prod: "https://accounts.feishu.cn",
  boe: "https://accounts.feishu-boe.cn",
  pre: "https://accounts.feishu-pre.cn",
};

const LARK_ENV_URLS: Record<string, string> = {
  prod: "https://accounts.larksuite.com",
  boe: "https://accounts.larksuite-boe.com",
  pre: "https://accounts.larksuite-pre.com",
};

// Open API hosts for tenant_access_token + application info — different from
// the accounts host used for OAuth device registration.
const FEISHU_OPEN_API_URLS: Record<string, string> = {
  feishu: "https://open.feishu.cn",
  lark: "https://open.larksuite.com",
};

function resolveBaseUrl(domain?: string, env?: string): string {
  const e = env ?? "prod";
  if (domain === "lark") {
    return LARK_ENV_URLS[e] ?? LARK_ENV_URLS.prod;
  }
  return FEISHU_ENV_URLS[e] ?? FEISHU_ENV_URLS.prod;
}

function resolveOpenApiBase(domain?: string): string {
  return domain === "lark"
    ? FEISHU_OPEN_API_URLS.lark
    : FEISHU_OPEN_API_URLS.feishu;
}

/**
 * Fetch the application's display name using the freshly-issued credentials.
 *
 * Used after scan registration to auto-fill the botName input. Failures are
 * swallowed — the UI simply falls back to letting the user type the name.
 */
async function fetchFeishuAppName(
  appId: string,
  appSecret: string,
  domain: string,
): Promise<string | null> {
  const base = resolveOpenApiBase(domain);
  try {
    const tokenRes = await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
    const tokenJson = (await tokenRes.json()) as {
      code?: number;
      tenant_access_token?: string;
    };
    if (tokenJson.code !== 0 || !tokenJson.tenant_access_token) {return null;}

    const infoRes = await fetch(
      `${base}/open-apis/application/v6/applications/${appId}?lang=zh_cn`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${tokenJson.tenant_access_token}` },
      },
    );
    const infoJson = (await infoRes.json()) as {
      code?: number;
      data?: { app?: { app_name?: string } };
    };
    if (infoJson.code !== 0) {return null;}
    return infoJson.data?.app?.app_name ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getTenantCtx(
  client: GatewayRequestHandlerOptions["client"],
  respond: GatewayRequestHandlerOptions["respond"],
): TenantContext | null {
  if (!isDbInitialized()) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Multi-tenant mode not enabled"));
    return null;
  }
  const tenant = (client as unknown as { tenant?: TenantContext })?.tenant;
  if (!tenant) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Authentication required"));
    return null;
  }
  return tenant;
}

async function postRegistration(
  baseUrl: string,
  body: URLSearchParams,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/oauth/v1/app/registration`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: controller.signal,
    });
    return (await res.json()) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export const feishuRegisterHandlers: GatewayRequestHandlers = {
  /**
   * Begin Feishu bot registration.
   *
   * Params:
   *   domain?: "feishu" | "lark"  (default: "feishu")
   *   env?: "prod" | "boe" | "pre" (default: "prod")
   *
   * Returns:
   *   { deviceCode, verificationUrl, interval, expireIn }
   */
  "tenant.feishu.register.begin": async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {return;}

    try {
      assertPermission(ctx.role, "channel.create");
    } catch (err) {
      if (err instanceof RbacError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
        return;
      }
      throw err;
    }

    const domain = typeof params.domain === "string" ? params.domain : "feishu";
    const env = typeof params.env === "string" ? params.env : "prod";
    const baseUrl = resolveBaseUrl(domain, env);

    try {
      // Step 1: init — check supported auth methods
      const initRes = await postRegistration(baseUrl, new URLSearchParams({ action: "init" }));
      const methods = initRes.supported_auth_methods;
      if (!Array.isArray(methods) || !methods.includes("client_secret")) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Current environment does not support client_secret auth"));
        return;
      }

      // Step 2: begin — get device_code and verification URL
      const beginRes = await postRegistration(
        baseUrl,
        new URLSearchParams({
          action: "begin",
          archetype: "PersonalAgent",
          auth_method: "client_secret",
          request_user_info: "open_id",
        }),
      );

      const deviceCode = beginRes.device_code as string | undefined;
      const verificationUrl = beginRes.verification_uri_complete as string | undefined;
      const interval = (beginRes.interval as number) ?? 5;
      const expireIn = (beginRes.expire_in as number) ?? 600;

      if (!deviceCode || !verificationUrl) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Failed to begin registration"));
        return;
      }

      respond(true, {
        deviceCode,
        verificationUrl,
        interval,
        expireIn,
        domain,
        env,
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, `Registration begin failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  },

  /**
   * Poll Feishu bot registration result.
   *
   * Params:
   *   deviceCode: string   (from begin response)
   *   domain?: "feishu" | "lark"
   *   env?: "prod" | "boe" | "pre"
   *
   * Returns on success:
   *   { status: "completed", appId, appSecret, openId?, domain }
   *
   * Returns when pending:
   *   { status: "pending" }
   *
   * Returns on error:
   *   { status: "error", error, errorDescription? }
   */
  "tenant.feishu.register.poll": async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {return;}

    try {
      assertPermission(ctx.role, "channel.create");
    } catch (err) {
      if (err instanceof RbacError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
        return;
      }
      throw err;
    }

    const deviceCode = typeof params.deviceCode === "string" ? params.deviceCode : "";
    if (!deviceCode) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "deviceCode is required"));
      return;
    }

    const domain = typeof params.domain === "string" ? params.domain : "feishu";
    const env = typeof params.env === "string" ? params.env : "prod";
    let effectiveDomain = domain;
    let baseUrl = resolveBaseUrl(domain, env);

    try {
      const pollRes = await postRegistration(
        baseUrl,
        new URLSearchParams({ action: "poll", device_code: deviceCode }),
      );

      // Check if domain needs switching (lark tenant)
      const userInfo = pollRes.user_info as Record<string, unknown> | undefined;
      if (userInfo?.tenant_brand === "lark" && domain !== "lark") {
        effectiveDomain = "lark";
        baseUrl = resolveBaseUrl("lark", env);
        // Re-poll with correct domain
        const retryRes = await postRegistration(
          baseUrl,
          new URLSearchParams({ action: "poll", device_code: deviceCode }),
        );
        Object.assign(pollRes, retryRes);
      }

      const clientId = pollRes.client_id as string | undefined;
      const clientSecret = pollRes.client_secret as string | undefined;

      if (clientId && clientSecret) {
        const openId = (pollRes.user_info as Record<string, unknown> | undefined)?.open_id as string | undefined;
        // Best-effort: fetch the app's display name so the UI can pre-fill botName.
        const botName = await fetchFeishuAppName(clientId, clientSecret, effectiveDomain);
        respond(true, {
          status: "completed",
          appId: clientId,
          appSecret: clientSecret,
          openId,
          domain: effectiveDomain,
          botName: botName ?? undefined,
        });
        return;
      }

      const error = pollRes.error as string | undefined;
      if (!error || error === "authorization_pending") {
        respond(true, { status: "pending" });
        return;
      }

      if (error === "slow_down") {
        respond(true, { status: "pending", slowDown: true });
        return;
      }

      // expired_token, access_denied, or other errors
      respond(true, {
        status: "error",
        error,
        errorDescription: pollRes.error_description as string | undefined,
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, `Registration poll failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  },
};
