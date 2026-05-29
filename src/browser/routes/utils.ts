import { parseBooleanValue } from "../../utils/boolean.js";
import type { BrowserRouteContext, ProfileContext } from "../server-context.js";
import { getSessionProfile } from "../session-profile-map.js";
import type { BrowserRequest, BrowserResponse } from "./types.js";

/**
 * Extract profile name from query string or body and get profile context.
 * Resolution order (first match wins):
 *   1. ?profile= query param
 *   2. body.profile field
 *   3. ?sessionName= query param → looks up session→profile map
 *   4. body.sessionName field → looks up session→profile map
 *   5. Default profile
 *
 * The sessionName resolution (3/4) enables persistent browser profiles per
 * agent session: once an agent logs in to Feishu/Douyin, subsequent runs
 * with the same sessionName reuse the same profile (cookies preserved).
 */
export function getProfileContext(
  req: BrowserRequest,
  ctx: BrowserRouteContext,
): ProfileContext | { error: string; status: number } {
  let profileName: string | undefined;

  // 1. Check query string ?profile= first (works for GET and POST)
  if (typeof req.query.profile === "string") {
    profileName = req.query.profile.trim() || undefined;
  }

  // 2. Fall back to body.profile for POST requests
  if (!profileName && req.body && typeof req.body === "object") {
    const body = req.body as Record<string, unknown>;
    if (typeof body.profile === "string") {
      profileName = body.profile.trim() || undefined;
    }
  }

  // 3-4. sessionName resolution: persistent profile per agent session.
  // Lets agents reuse browser state (cookies, localStorage) across runs.
  if (!profileName) {
    let sessionName: string | undefined;
    if (typeof req.query.sessionName === "string") {
      sessionName = req.query.sessionName.trim() || undefined;
    }
    if (!sessionName && req.body && typeof req.body === "object") {
      const body = req.body as Record<string, unknown>;
      if (typeof body.sessionName === "string") {
        sessionName = body.sessionName.trim() || undefined;
      }
    }
    if (sessionName) {
      const mapped = getSessionProfile(sessionName);
      if (mapped) {
        profileName = mapped;
      }
    }
  }

  try {
    return ctx.forProfile(profileName);
  } catch (err) {
    return { error: String(err), status: 404 };
  }
}

export function jsonError(res: BrowserResponse, status: number, message: string) {
  res.status(status).json({ error: message });
}

export function toStringOrEmpty(value: unknown) {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value).trim();
  }
  return "";
}

export function toNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function toBoolean(value: unknown) {
  return parseBooleanValue(value, {
    truthy: ["true", "1", "yes"],
    falsy: ["false", "0", "no"],
  });
}

export function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.map((v) => toStringOrEmpty(v)).filter(Boolean);
  return strings.length ? strings : undefined;
}
