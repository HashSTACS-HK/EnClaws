/**
 * 会话管理模块
 * 构建 OpenClaw 标准会话上下文
 */

import { NEW_SESSION_COMMANDS } from "./constants.ts";

/** OpenClaw 标准会话上下文 */
export interface SessionContext {
  channel: "dingtalk";
  accountId: string;
  chatType: "direct" | "group";
  /**
   * 真实的 peer 标识，不受任何会话隔离配置影响。
   * 群聊为 conversationId，单聊为 senderId。
   * 与配置中 match.peer.id 语义一致，专用于 bindings 路由匹配。
   */
  peerId: string;
  /**
   * 用于 session/memory 隔离的 peer 标识（session 键的一部分）。
   * 受 sharedMemoryAcrossConversations、separateSessionByConversation、groupSessionScope 等配置影响，
   * 可能与 peerId 不同（如 sharedMemoryAcrossConversations=true 时被设为 accountId）。
   * 注意：不要用此字段做 binding 路由匹配，应使用 peerId。
   */
  sessionPeerId: string;
  conversationId?: string;
  senderName?: string;
  groupSubject?: string;
}

/**
 * 构建 OpenClaw 标准会话上下文
 * 遵循 OpenClaw session.dmScope 机制，让 Gateway 根据配置自动处理会话隔离
 *
 * @param sharedMemoryAcrossConversations - 是否在不同会话间共享记忆（默认 false）
 *   - true: 所有会话共享记忆，使用 accountId 作为记忆标识
 *   - false: 不同会话独立记忆，使用完整的 sessionContext 作为记忆标识
 */
export function buildSessionContext(params: {
  accountId: string;
  senderId: string;
  senderName?: string;
  conversationType: string;
  conversationId?: string;
  groupSubject?: string;
  separateSessionByConversation?: boolean;
  groupSessionScope?: "group" | "group_sender";
  sharedMemoryAcrossConversations?: boolean;
}): SessionContext {
  const {
    accountId,
    senderId,
    senderName,
    conversationType,
    conversationId,
    groupSubject,
    separateSessionByConversation,
    groupSessionScope,
    sharedMemoryAcrossConversations,
  } = params;
  const isDirect = conversationType === "1";

  // peerId：真实的 peer 标识，不受任何会话隔离配置影响，专用于 bindings 路由匹配
  // 群聊为 conversationId，单聊为 senderId，与配置中 match.peer.id 语义一致
  const peerId = isDirect ? senderId : conversationId || senderId;

  // sharedMemoryAcrossConversations=true 时，所有会话共享记忆
  // sessionPeerId 被设为 accountId 以合并记忆，peerId 仍保留真实 peer，供路由匹配使用
  if (sharedMemoryAcrossConversations === true) {
    return {
      channel: "dingtalk",
      accountId,
      chatType: isDirect ? "direct" : "group",
      peerId,
      sessionPeerId: accountId, // 使用 accountId 作为 sessionPeerId，实现跨会话记忆共享
      conversationId: isDirect ? undefined : conversationId,
      senderName,
      groupSubject: isDirect ? undefined : groupSubject,
    };
  }

  // separateSessionByConversation=false 时，不区分单聊/群聊，按用户维度维护 session
  if (separateSessionByConversation === false) {
    return {
      channel: "dingtalk",
      accountId,
      chatType: isDirect ? "direct" : "group",
      peerId,
      sessionPeerId: senderId, // 只用 senderId，不区分会话
      conversationId: isDirect ? undefined : conversationId,
      senderName,
      groupSubject: isDirect ? undefined : groupSubject,
    };
  }

  // 以下是 separateSessionByConversation=true（默认）的逻辑
  if (isDirect) {
    // 单聊：sessionPeerId 为发送者 ID，由 OpenClaw Gateway 根据 dmScope 配置处理
    return {
      channel: "dingtalk",
      accountId,
      chatType: "direct",
      peerId,
      sessionPeerId: senderId,
      senderName,
    };
  }

  // Group chat: session isolation strategy driven by groupSessionScope.
  // Default 'group_sender': each user in the group gets an isolated session
  // (avoids context bleed and session write contention when multiple users @bot).
  // Only when explicitly set to 'group' does the whole group share one session.
  if (groupSessionScope === "group") {
    return {
      channel: "dingtalk",
      accountId,
      chatType: "group",
      peerId,
      sessionPeerId: conversationId || senderId,
      conversationId,
      senderName,
      groupSubject,
    };
  }

  return {
    channel: "dingtalk",
    accountId,
    chatType: "group",
    peerId,
    // Use the `:sender:` marker to match Feishu/WeCom session-key naming,
    // so core can parse it with the same pattern (e.g. resolveGroupSessionKey's sender detection).
    sessionPeerId: `${conversationId}:sender:${senderId}`,
    conversationId,
    senderName,
    groupSubject,
  };
}

/**
 * 检查消息是否是新会话命令
 */
export function normalizeSlashCommand(text: string): string {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  if (NEW_SESSION_COMMANDS.some((cmd) => lower === cmd.toLowerCase())) {
    return "/new";
  }
  return text;
}
