/**
 * Customer Service Widget WebSocket protocol types.
 *
 * 客服 Widget WebSocket 协议类型定义。
 * See design doc section 4.8.
 */

import type { CSMessage } from "../types.js";

// -- Client → Server messages --
// 客户端 → 服务端消息

export type CSWidgetClientMessage =
  | { type: "connect"; visitorId: string; visitorName?: string; metadata?: { url?: string; referrer?: string } }
  | { type: "send"; text: string }
  | { type: "feedback"; messageId: string; feedbackType: string; note?: string }
  | { type: "close" };

// -- Server → Client messages --
// 服务端 → 客户端消息

export type CSWidgetServerMessage =
  | { type: "connected"; sessionId: string; messages: CSMessage[] }
  | { type: "message"; role: "ai" | "boss"; text: string; messageId: string; roleLabel: string }
  | { type: "typing"; role: "ai" | "boss" }
  | { type: "state_change"; state: "ai_active" | "human_active" }
  | { type: "history"; messages: CSMessage[] }
  | { type: "error"; code: string; message: string };

/**
 * Serialize a server message for WebSocket transport.
 *
 * 序列化服务端消息。
 */
export function serializeServerMessage(msg: CSWidgetServerMessage): string {
  return JSON.stringify(msg);
}

/**
 * Parse a client message from WebSocket payload.
 * Returns null if the payload is invalid.
 *
 * 解析客户端消息。无效消息返回 null。
 */
export function parseClientMessage(data: string): CSWidgetClientMessage | null {
  try {
    const parsed = JSON.parse(data);
    if (!parsed || typeof parsed !== "object" || !parsed.type) {return null;}
    return parsed as CSWidgetClientMessage;
  } catch {
    return null;
  }
}
