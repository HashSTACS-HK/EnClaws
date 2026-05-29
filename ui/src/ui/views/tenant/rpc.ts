/**
 * Shared WebSocket RPC helper for tenant management views.
 *
 * Handles the mandatory connect handshake before sending the actual request.
 */

import { t } from "../../../i18n/index.ts";
import { clearAuth, getAccessToken, loadAuth, refreshAccessToken } from "../../auth-store.ts";
import { loadSettings } from "../../storage.ts";
import { generateUUID } from "../../uuid.ts";

export function resolveGatewayUrl(override?: string): string {
  return override || loadSettings().gatewayUrl;
}

function buildConnectParams(jwtToken: string | null) {
  const settings = loadSettings();
  const gatewayToken = settings.token || undefined;
  // Send gateway token for legacy connect auth, and JWT separately for tenant context
  const auth: Record<string, string> = {};
  if (gatewayToken) {auth.token = gatewayToken;}
  if (jwtToken) {auth.jwt = jwtToken;}
  return {
    minProtocol: 3,
    maxProtocol: 3,
    client: {
      id: "webchat",
      version: "dev",
      platform: navigator.platform ?? "web",
      mode: "webchat",
      instanceId: generateUUID(),
    },
    role: "operator",
    scopes: ["operator.admin"],
    caps: [],
    auth: Object.keys(auth).length > 0 ? auth : undefined,
  };
}

async function resolveToken(): Promise<string | null> {
  // Try cached access token first
  const token = getAccessToken();
  if (token) {return token;}
  // Access token expired — try refresh
  const auth = loadAuth();
  if (auth?.refreshToken) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {return refreshed.accessToken;}
  }
  return null;
}

export async function tenantRpc(
  method: string,
  params: Record<string, unknown> = {},
  gatewayUrl?: string,
): Promise<unknown> {
  const token = await resolveToken();
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(resolveGatewayUrl(gatewayUrl));
    let handshakeDone = false;

    ws.onopen = () => {
      // Gateway requires connect as the first message
      ws.send(JSON.stringify({
        type: "req",
        id: generateUUID(),
        method: "connect",
        params: buildConnectParams(token),
      }));
    };

    ws.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data);
        if (frame.type === "res" && !handshakeDone) {
          // Connect handshake response — now send the actual request
          handshakeDone = true;
          ws.send(JSON.stringify({
            type: "req",
            id: generateUUID(),
            method,
            params,
          }));
          return;
        }
        if (frame.type === "res" && handshakeDone) {
          ws.close();
          if (frame.ok) {
            resolve(frame.payload);
          } else {
            const msg = frame.error?.message ?? "请求失败";
            if (msg === "Authentication required") {
              clearAuth();
              window.location.reload();
            }
            const err = new Error(msg);
            // Preserve the structured error code so callers can branch on it
            // (e.g. translate QUOTA_EXCEEDED into a localized "upgrade" message).
            if (frame.error?.code) {
              (err as any).code = frame.error.code;
            }
            if (frame.error?.details && typeof frame.error.details === "object") {
              (err as any).details = frame.error.details;
            }
            reject(err);
          }
        }
      } catch (err) {
        reject(err);
      }
    };

    ws.onerror = () => reject(new Error(t("rpc.errors.connectionFailed")));
    setTimeout(() => { ws.close(); reject(new Error(t("rpc.errors.requestTimeout"))); }, 60_000);
  });
}

/**
 * Detect a structured QUOTA_EXCEEDED error returned by the gateway and
 * map it to an i18n key + params suitable for `showError(key, params)`.
 *
 * The optional `contactLink` from error.details is forwarded as a param
 * so the i18n string can render a clickable upgrade link.
 *
 * Returns null if the error is not a quota error, so callers can fall
 * back to their generic error handling.
 */
export function quotaErrorKey(
  err: unknown,
): { key: string; params: Record<string, string> } | null {
  const e = err as {
    code?: string;
    details?: { resource?: string; current?: number; max?: number; contactLink?: string };
  };
  if (e?.code !== "QUOTA_EXCEEDED") {return null;}
  const resource = String(e.details?.resource ?? "");
  const params: Record<string, string> = {
    current: String(e.details?.current ?? 0),
    max: String(e.details?.max ?? 0),
    contactLink: e.details?.contactLink ?? "",
  };
  const known = ["agents", "channels", "users", "tokensPerMonth", "cronJobs"];
  return {
    key: known.includes(resource)
      ? `errors.quotaExceeded.${resource}`
      : "errors.quotaExceeded.generic",
    params,
  };
}
