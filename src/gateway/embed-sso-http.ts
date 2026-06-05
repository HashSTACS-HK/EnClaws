import type { IncomingMessage, ServerResponse } from "node:http";
import { consumeEmbedSsoToken, issueEmbedSsoToken } from "../auth/embed-sso.js";
import { generateTokenPair } from "../auth/jwt.js";
import { parseUserAgent } from "../auth/user-agent-parser.js";
import { isDbInitialized } from "../db/index.js";
import { createAuditLog } from "../db/models/audit-log.js";
import { getTenantById } from "../db/models/tenant.js";
import type { JwtPayload } from "../db/types.js";
import { sendError, sendJson, readJsonBody } from "./cs-api/http-helpers.js";

const TOKEN_PATH = "/api/embed-sso/token";
const CONSUME_PATH = "/api/embed-sso/consume";

function extractBearer(req: IncomingMessage): string | null {
  const value = req.headers.authorization;
  if (typeof value !== "string") {
    return null;
  }
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function clientIp(req: IncomingMessage): string | undefined {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0]?.trim();
  }
  return req.socket.remoteAddress ?? undefined;
}

async function handleTokenRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    sendError(res, 405, "METHOD_NOT_ALLOWED", "Method Not Allowed");
    return;
  }

  const apiKey = extractBearer(req);
  if (!apiKey) {
    sendError(res, 401, "MISSING_AUTH", "Authorization Bearer header missing");
    return;
  }

  try {
    const body = await readJsonBody<Record<string, unknown>>(req);
    const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
    const externalUserId =
      typeof body.externalUserId === "string" ? body.externalUserId.trim() : "";
    if (!tenantId || !externalUserId) {
      sendError(res, 400, "INVALID_PARAMS", "tenantId and externalUserId are required");
      return;
    }
    const issued = await issueEmbedSsoToken({
      apiKey,
      tenantId,
      externalUserId,
      displayName: typeof body.displayName === "string" ? body.displayName : undefined,
      role:
        body.role === "owner" ||
        body.role === "admin" ||
        body.role === "member" ||
        body.role === "viewer"
          ? body.role
          : undefined,
      targetPath: typeof body.targetPath === "string" ? body.targetPath : undefined,
      ttlSeconds: typeof body.ttlSeconds === "number" ? body.ttlSeconds : undefined,
    });
    sendJson(res, 200, {
      ssoToken: issued.token,
      expiresAt: issued.expiresAt.toISOString(),
      targetPath: issued.targetPath,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed to issue embed sso token";
    const status = /invalid embed sso api key/i.test(message) ? 401 : 400;
    sendError(res, status, status === 401 ? "INVALID_API_KEY" : "INVALID_REQUEST", message);
  }
}

async function handleConsumeRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    sendError(res, 405, "METHOD_NOT_ALLOWED", "Method Not Allowed");
    return;
  }
  if (!isDbInitialized()) {
    sendError(
      res,
      400,
      "INVALID_REQUEST",
      "Multi-tenant mode not enabled. Set ENCLAWS_DB_URL to enable.",
    );
    return;
  }

  const ip = clientIp(req);
  const uaHeader = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null;

  try {
    const body = await readJsonBody<Record<string, unknown>>(req);
    const token =
      typeof body.ssoToken === "string"
        ? body.ssoToken.trim()
        : typeof body.token === "string"
          ? body.token.trim()
          : "";
    if (!token) {
      sendError(res, 400, "INVALID_PARAMS", "ssoToken is required");
      return;
    }

    const consumed = await consumeEmbedSsoToken(token);
    const tenant = await getTenantById(consumed.tenantId);
    if (!tenant || tenant.status !== "active") {
      sendError(res, 400, "INVALID_REQUEST", "Tenant is not active");
      return;
    }

    const payload: JwtPayload = {
      sub: consumed.user.id,
      tid: consumed.tenantId,
      email: consumed.user.email,
      role: consumed.user.role,
    };
    const uaParsed = parseUserAgent(uaHeader);
    const tokens = await generateTokenPair(payload, {
      ip,
      userAgent: uaHeader,
      label: uaParsed.label,
    });

    await createAuditLog({
      tenantId: consumed.tenantId,
      userId: consumed.user.id,
      action: "user.login.embed_sso",
      resource: `tenant:${consumed.tenantId}`,
      detail: { externalUserId: consumed.externalUserId, targetPath: consumed.targetPath },
      ipAddress: ip,
    }).catch(() => undefined);

    sendJson(res, 200, {
      user: {
        id: consumed.user.id,
        email: consumed.user.email,
        role: consumed.user.role,
        displayName: consumed.user.displayName,
        tenantId: consumed.tenantId,
        forceChangePassword: false,
        mfaEnabled: false,
      },
      tenant: { id: tenant.id, name: tenant.name, plan: tenant.plan },
      targetPath: consumed.targetPath,
      ...tokens,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid embed SSO token";
    console.warn("[embed-sso] http consume failed", {
      ip: ip ?? null,
      message,
    });
    sendError(res, 400, "INVALID_REQUEST", message);
  }
}

export async function handleEmbedSsoHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://_");
  if (url.pathname !== TOKEN_PATH && url.pathname !== CONSUME_PATH) {
    return false;
  }
  if (url.pathname === TOKEN_PATH) {
    await handleTokenRequest(req, res);
  } else {
    await handleConsumeRequest(req, res);
  }
  return true;
}
