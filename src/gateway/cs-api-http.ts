/**
 * HTTP request router for /api/cs-api/* endpoints.
 *
 * Dispatches incoming requests to the appropriate cs-api handler.
 * Returns true if the request was handled, false to let the next handler try.
 *
 * /api/cs-api/* 路由分发器；已处理返回 true，未命中返回 false。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { sendError } from "./cs-api/http-helpers.js";
import {
  createObject,
  listObjects,
  getObject,
  patchObject,
  regenerateSecret,
  deleteObject,
} from "./cs-api/objects.js";
import { handleListSessions, handleGetSession, handleTranscript } from "./cs-api/queries.js";
import {
  handleMessages,
  handleHandoff,
  handleRelease,
  handleMarkNotifying,
  handleObserver,
  handleGetObject,
  handleReasoning,
} from "./cs-api/runtime.js";

const PREFIX = "/api/cs-api";

/**
 * Handle a cs-api HTTP request.
 * Called by server-http.ts after checking that the URL starts with PREFIX.
 */
export async function handleCsApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (!req.url?.startsWith(PREFIX)) {
    return false;
  }

  const url = new URL(req.url, "http://_");
  const path = url.pathname.slice(PREFIX.length);

  // POST /api/cs-api/objects
  if (path === "/objects" && req.method === "POST") {
    await createObject(req, res);
    return true;
  }

  // GET /api/cs-api/objects
  if (path === "/objects" && req.method === "GET") {
    await listObjects(req, res);
    return true;
  }

  // /api/cs-api/objects/:id
  const objMatch = path.match(/^\/objects\/([\w-]+)$/);
  if (objMatch) {
    const id = objMatch[1];
    if (req.method === "GET") {
      await getObject(req, res, id);
      return true;
    }
    if (req.method === "PATCH") {
      await patchObject(req, res, id);
      return true;
    }
    if (req.method === "DELETE") {
      await deleteObject(req, res, id);
      return true;
    }
  }

  // POST /api/cs-api/objects/:id/regenerate-secret
  const regenMatch = path.match(/^\/objects\/([\w-]+)\/regenerate-secret$/);
  if (regenMatch && req.method === "POST") {
    await regenerateSecret(req, res, regenMatch[1]);
    return true;
  }

  // ── Runtime endpoints (Bearer appSecret auth) ───────────────────────────────

  // POST /api/cs-api/{appId}/messages
  const msgMatch = path.match(/^\/([^/]+)\/messages$/);
  if (msgMatch && req.method === "POST") {
    await handleMessages(req, res, msgMatch[1]);
    return true;
  }

  // POST /api/cs-api/{appId}/sessions/{sessionId}/handoff-to-human
  const handoffMatch = path.match(/^\/([^/]+)\/sessions\/([^/]+)\/handoff-to-human$/);
  if (handoffMatch && req.method === "POST") {
    await handleHandoff(req, res, handoffMatch[1], handoffMatch[2]);
    return true;
  }

  // POST /api/cs-api/{appId}/sessions/{sessionId}/release-to-ai
  const releaseMatch = path.match(/^\/([^/]+)\/sessions\/([^/]+)\/release-to-ai$/);
  if (releaseMatch && req.method === "POST") {
    await handleRelease(req, res, releaseMatch[1], releaseMatch[2]);
    return true;
  }

  // POST /api/cs-api/{appId}/sessions/{sessionId}/mark-notifying
  const notifyingMatch = path.match(/^\/([^/]+)\/sessions\/([^/]+)\/mark-notifying$/);
  if (notifyingMatch && req.method === "POST") {
    await handleMarkNotifying(req, res, notifyingMatch[1], notifyingMatch[2]);
    return true;
  }

  // GET /api/cs-api/{appId}/sessions/{sessionId}/messages/{messageId}/reasoning (P7-B2)
  // IMPORTANT: registered BEFORE messages/observer (more specific path — 4 segments vs 3).
  // GET 推理端点：比 messages/observer 路径更具体，必须优先注册。
  const reasoningMatch = path.match(
    /^\/([^/]+)\/sessions\/([^/]+)\/messages\/([^/]+)\/reasoning$/,
  );
  if (reasoningMatch && req.method === "GET") {
    await handleReasoning(req, res, reasoningMatch[1], reasoningMatch[2], reasoningMatch[3]);
    return true;
  }

  // POST /api/cs-api/{appId}/sessions/{sessionId}/messages/observer
  const observerMatch = path.match(/^\/([^/]+)\/sessions\/([^/]+)\/messages\/observer$/);
  if (observerMatch && req.method === "POST") {
    await handleObserver(req, res, observerMatch[1], observerMatch[2]);
    return true;
  }

  // ── §11.6 Query endpoints (GET) ─────────────────────────────────────────────

  // GET /api/cs-api/{appId}/sessions
  const listSessMatch = path.match(/^\/([^/]+)\/sessions$/);
  if (listSessMatch && req.method === "GET") {
    await handleListSessions(req, res, listSessMatch[1]);
    return true;
  }

  // GET /api/cs-api/{appId}/sessions/{sessionId}/transcript
  // IMPORTANT: transcript pattern MUST come before single-session pattern (more specific first)
  const transcriptMatch = path.match(/^\/([^/]+)\/sessions\/([^/]+)\/transcript$/);
  if (transcriptMatch && req.method === "GET") {
    await handleTranscript(req, res, transcriptMatch[1], transcriptMatch[2]);
    return true;
  }

  // GET /api/cs-api/{appId}/sessions/{sessionId}
  const getSessMatch = path.match(/^\/([^/]+)\/sessions\/([^/]+)$/);
  if (getSessMatch && req.method === "GET") {
    await handleGetSession(req, res, getSessMatch[1], getSessMatch[2]);
    return true;
  }

  // GET /api/cs-api/{appId} — service identity (name + agentName) for jiumi (需求3).
  // IMPORTANT: single-segment GET. Registered LAST among GET routes so it never
  // shadows the admin `/objects` list (also single-segment) — that route is
  // matched earlier above. Multi-segment `{appId}/...` routes are unaffected.
  // 单段 GET，注册在最后，避免吞掉 admin 的 /objects 列表；多段 {appId}/... 路由不受影响。
  const getObjMatch = path.match(/^\/([^/]+)$/);
  if (getObjMatch && req.method === "GET") {
    await handleGetObject(req, res, getObjMatch[1]);
    return true;
  }

  sendError(res, 404, "NOT_FOUND", `No route for ${req.method} ${path}`);
  return true;
}
