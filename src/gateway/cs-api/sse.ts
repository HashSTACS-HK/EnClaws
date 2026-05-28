/**
 * SSE (Server-Sent Events) helpers for cs-api runtime endpoints.
 *
 * SSE 响应工具函数，用于 cs-api 运行时端点。
 */

import type { ServerResponse } from "node:http";

/**
 * Start an SSE response: set headers and flush immediately.
 * Caller must not have written headers yet.
 *
 * 开始 SSE 响应：写入头部并立即 flush。
 */
export function startSse(res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
}

/**
 * Write a named SSE event with JSON data.
 *
 * 写入一条命名 SSE 事件，data 为 JSON 序列化结果。
 */
export function writeSseEvent(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * End the SSE stream.
 *
 * 结束 SSE 流。
 */
export function endSse(res: ServerResponse): void {
  res.end();
}
