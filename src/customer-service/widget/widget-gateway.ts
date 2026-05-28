/**
 * Customer Service Widget gateway — manages WebSocket connections and message flow.
 *
 * 客服 Widget 网关 — 管理 WebSocket 连接和消息流转。
 */

import type WebSocket from "ws";
import type { OpenClawConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createCSSession, findActiveCSSession, closeCSSession } from "../../db/models/cs-session.js";
import { createCSMessage, listCSMessages } from "../../db/models/cs-message.js";
import { transition } from "../session-state-machine.js";
import { runCSAgentReply } from "../rag/cs-agent-runner.js";
import { CS_ROLE_LABELS } from "../types.js";
import type { CSSession } from "../types.js";
import {
  parseClientMessage,
  serializeServerMessage,
  type CSWidgetServerMessage,
} from "./widget-protocol.js";

const log = createSubsystemLogger("cs-widget");

// -- Connection registry --
// 连接注册表
const connections = new Map<string, WebSocket>();

/**
 * Send a server message to a specific visitor.
 *
 * 向指定访客发送服务端消息。
 */
function sendToVisitor(visitorId: string, msg: CSWidgetServerMessage): void {
  const ws = connections.get(visitorId);
  if (ws && ws.readyState === 1 /* OPEN */) {
    ws.send(serializeServerMessage(msg));
  }
}

/**
 * Register a WebSocket connection for a visitor.
 *
 * 注册访客的 WebSocket 连接。
 */
export function registerConnection(visitorId: string, ws: WebSocket): void {
  // Close existing connection if any
  // 如果已有连接，先关闭
  const existing = connections.get(visitorId);
  if (existing && existing.readyState === 1) {
    existing.close(1000, "replaced");
  }
  connections.set(visitorId, ws);
  ws.on("close", () => {
    if (connections.get(visitorId) === ws) {
      connections.delete(visitorId);
    }
  });
}

/**
 * Handle an incoming WebSocket message from a visitor.
 *
 * 处理来自访客的 WebSocket 消息。
 */
export async function handleWidgetMessage(params: {
  visitorId: string;
  data: string;
  cfg: OpenClawConfig;
  tenantId: string;
  notifyBoss?: (params: {
    customerMessage: string;
    aiReply: string;
    sessionId: string;
    visitorName?: string;
  }) => Promise<void>;
}): Promise<void> {
  const { visitorId, data, cfg, tenantId, notifyBoss } = params;

  const msg = parseClientMessage(data);
  if (!msg) {
    sendToVisitor(visitorId, { type: "error", code: "INVALID_MESSAGE", message: "Invalid message format" });
    return;
  }

  switch (msg.type) {
    case "connect":
      await handleConnect({ visitorId, visitorName: msg.visitorName, metadata: msg.metadata, cfg, tenantId });
      break;

    case "send":
      await handleSend({ visitorId, text: msg.text, cfg, tenantId, notifyBoss });
      break;

    case "close":
      await handleClose({ visitorId, tenantId });
      break;

    case "feedback":
      // S4 implementation — placeholder
      // S4 实现 — 占位
      log.info(`feedback received from ${visitorId}: ${msg.feedbackType}`);
      break;
  }
}

// -- Connect: create or resume session --
// 连接：创建或恢复会话

async function handleConnect(params: {
  visitorId: string;
  visitorName?: string;
  metadata?: Record<string, unknown>;
  cfg: OpenClawConfig;
  tenantId: string;
}): Promise<void> {
  const { visitorId, visitorName, metadata, tenantId } = params;

  // Find or create session
  // 查找或创建会话
  let session: CSSession | null = await findActiveCSSession(tenantId, visitorId);
  if (!session) {
    session = await createCSSession({
      tenantId,
      visitorId,
      visitorName,
      metadata,
    });
    log.info(`created cs session ${session.id} for visitor ${visitorId}`);
  }

  // Load recent messages
  // 加载最近消息
  const messages = await listCSMessages(session.id, { limit: 50 });

  sendToVisitor(visitorId, {
    type: "connected",
    sessionId: session.id,
    messages,
  });
}

// -- Send: customer message → state machine → RAG → reply --
// 发送：客户消息 → 状态机 → RAG → 回复

async function handleSend(params: {
  visitorId: string;
  text: string;
  cfg: OpenClawConfig;
  tenantId: string;
  notifyBoss?: (params: {
    customerMessage: string;
    aiReply: string;
    sessionId: string;
    visitorName?: string;
  }) => Promise<void>;
}): Promise<void> {
  const { visitorId, text, cfg, tenantId, notifyBoss } = params;

  if (!text.trim()) {return;}

  // Find active session
  // 查找活跃会话
  const session = await findActiveCSSession(tenantId, visitorId);
  if (!session) {
    sendToVisitor(visitorId, { type: "error", code: "NO_SESSION", message: "No active session. Send connect first." });
    return;
  }

  // Save customer message
  // 保存客户消息
  await createCSMessage({
    sessionId: session.id,
    tenantId,
    role: "customer",
    content: text,
  });

  // State machine transition
  // 状态机转换
  const { action } = transition(session.state, { type: "customer_message", text });

  if (action === "run_rag") {
    // Show typing indicator
    // 显示正在输入指示
    sendToVisitor(visitorId, { type: "typing", role: "ai" });

    // Run RAG agent
    // 运行 RAG Agent
    const { reply, sourceChunks } = await runCSAgentReply({
      tenantId,
      sessionId: session.id,
      customerMessage: text,
      visitorName: session.visitorName ?? undefined,
      cfg,
    });

    // Save AI reply
    // 保存 AI 回复
    const aiMessage = await createCSMessage({
      sessionId: session.id,
      tenantId,
      role: "ai",
      content: reply,
      sourceChunks,
    });

    // Send reply to customer
    // 发送回复给客户
    sendToVisitor(visitorId, {
      type: "message",
      role: "ai",
      text: reply,
      messageId: aiMessage.id,
      roleLabel: CS_ROLE_LABELS.ai,
    });

    // Notify boss via Feishu
    // 通过飞书通知老板
    if (notifyBoss) {
      try {
        await notifyBoss({
          customerMessage: text,
          aiReply: reply,
          sessionId: session.id,
          visitorName: session.visitorName ?? undefined,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`failed to notify boss: ${message}`);
      }
    }
  } else if (action === "forward_to_boss") {
    // HUMAN_ACTIVE: forward to boss without LLM (S3 implementation)
    // HUMAN_ACTIVE：转发给老板，不调 LLM（S3 实现）
    log.info(`forwarding message to boss for session ${session.id}`);
  }
}

// -- Close session --
// 关闭会话

async function handleClose(params: {
  visitorId: string;
  tenantId: string;
}): Promise<void> {
  const { visitorId, tenantId } = params;
  const session = await findActiveCSSession(tenantId, visitorId);
  if (session) {
    await closeCSSession(session.id);
    log.info(`closed cs session ${session.id}`);
  }
}
