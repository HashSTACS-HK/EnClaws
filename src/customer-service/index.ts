/**
 * Customer Service module — barrel exports.
 *
 * 客服模块统一导出。
 */

// Types
export type {
  CSSession,
  CSMessage,
  CSSessionState,
  CSMessageRole,
  CSConfidence,
  CSConfidenceVerdict,
  CSEvent,
  CSAction,
  CSTransitionResult,
} from "./types.js";
export { CS_ROLE_LABELS } from "./types.js";

// State machine
export { transition } from "./session-state-machine.js";

// RAG agent
export { runCSAgentReply } from "./rag/cs-agent-runner.js";
export type { CSAgentReplyResult } from "./rag/cs-agent-runner.js";
export { buildCSSystemPrompt } from "./rag/cs-system-prompt.js";

// Widget
export { parseClientMessage, serializeServerMessage } from "./widget/widget-protocol.js";
export type { CSWidgetClientMessage, CSWidgetServerMessage } from "./widget/widget-protocol.js";
export {
  generateVisitorId,
  generateVisitorToken,
  verifyVisitorToken,
} from "./widget/widget-auth.js";
export { registerConnection, handleWidgetMessage } from "./widget/widget-gateway.js";

// Feishu notification
export { sendCSNotification } from "./feishu/notify.js";
