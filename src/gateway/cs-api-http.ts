/**
 * HTTP request router for /api/cs-api/* endpoints.
 *
 * Dispatches incoming requests to the appropriate cs-api handler.
 * Returns true if the request was handled, false to let the next handler try.
 *
 * /api/cs-api/* 路由分发器；已处理返回 true，未命中返回 false。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createObject,
  listObjects,
  getObject,
  patchObject,
  regenerateSecret,
  deleteObject,
} from "./cs-api/objects.js";
import { sendError } from "./cs-api/http-helpers.js";

const PREFIX = "/api/cs-api";

/**
 * Handle a cs-api HTTP request.
 * Called by server-http.ts after checking that the URL starts with PREFIX.
 */
export async function handleCsApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (!req.url?.startsWith(PREFIX)) { return false; }

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

  sendError(res, 404, "NOT_FOUND", `No route for ${req.method} ${path}`);
  return true;
}
