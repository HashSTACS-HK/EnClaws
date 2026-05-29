/**
 * Shared HTTP helpers for cs-api handlers.
 *
 * cs-api 处理器共用的 HTTP 工具函数。
 */

import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Send a JSON response with the given status code.
 * 发送 JSON 响应。
 */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

/**
 * Send a standard error response: { error: { code, message } }.
 * 发送标准错误响应。
 */
export function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  sendJson(res, status, { error: { code, message } });
}

/**
 * Read the full request body as JSON.
 * Returns an empty object if the body is absent.
 *
 * 读取 request body 并解析为 JSON，body 为空时返回空对象。
 */
export async function readJsonBody<T = unknown>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const c of req) {
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as T) : ({} as T);
}
