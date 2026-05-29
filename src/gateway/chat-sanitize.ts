import { stripInboundMetadata } from "../auto-reply/reply/strip-inbound-meta.js";
import { stripEnvelope, stripMessageIdHints } from "../shared/chat-envelope.js";

export { stripEnvelope };

/**
 * Strip "System: ..." event lines that are prepended to user messages
 * by the auto-reply system (session-updates.ts).
 * These lines appear at the top of the message content before the actual body.
 */
const SYSTEM_EVENT_LINE = /^System:\s+.+$/;

function stripSystemEventLines(text: string): string {
  const lines = text.split(/\r?\n/);
  // Drop leading System: lines and any blank lines immediately following them.
  let i = 0;
  while (i < lines.length) {
    if (SYSTEM_EVENT_LINE.test(lines[i])) {
      i++;
      continue;
    }
    if (lines[i].trim() === "" && i > 0) {
      // Skip blank separator between system events block and message body.
      i++;
      continue;
    }
    break;
  }
  if (i === 0) {
    return text;
  }
  return lines.slice(i).join("\n");
}

/**
 * Strip sender prefix patterns like "senderName: message" or "ou_xxx: message"
 * that are added by channel bots (e.g. Feishu buildFeishuAgentBody).
 * Only strips the first line's prefix when the line matches the pattern.
 */
const SENDER_PREFIX = /^[^\n:]{1,80}:\s/;
const SYSTEM_HINT_BRACKET = /^\[System:.*?\]\s*/s;

function stripSenderPrefix(text: string): string {
  // Strip inline [System: ...] hints first
  let result = text.replace(SYSTEM_HINT_BRACKET, "").trim();
  const match = result.match(SENDER_PREFIX);
  if (match) {
    result = result.slice(match[0].length);
  }
  return result;
}

function stripFullUserEnvelope(text: string): string {
  let result = stripSystemEventLines(text);
  result = stripEnvelope(result);
  result = stripMessageIdHints(result);
  result = stripSenderPrefix(result);
  return result.trim();
}

function stripEnvelopeFromContentWithRole(
  content: unknown[],
  stripUserEnvelope: boolean,
): { content: unknown[]; changed: boolean } {
  let changed = false;
  const next = content.map((item) => {
    if (!item || typeof item !== "object") {
      return item;
    }
    const entry = item as Record<string, unknown>;
    if (entry.type !== "text" || typeof entry.text !== "string") {
      return item;
    }
    const inboundStripped = stripInboundMetadata(entry.text);
    const stripped = stripUserEnvelope ? stripFullUserEnvelope(inboundStripped) : inboundStripped;
    if (stripped === entry.text) {
      return item;
    }
    changed = true;
    return {
      ...entry,
      text: stripped,
    };
  });
  return { content: next, changed };
}

export function stripEnvelopeFromMessage(message: unknown): unknown {
  if (!message || typeof message !== "object") {
    return message;
  }
  const entry = message as Record<string, unknown>;
  const role = typeof entry.role === "string" ? entry.role.toLowerCase() : "";
  const stripUserEnvelope = role === "user";

  let changed = false;
  const next: Record<string, unknown> = { ...entry };

  if (typeof entry.content === "string") {
    const inboundStripped = stripInboundMetadata(entry.content);
    const stripped = stripUserEnvelope ? stripFullUserEnvelope(inboundStripped) : inboundStripped;
    if (stripped !== entry.content) {
      next.content = stripped;
      changed = true;
    }
  } else if (Array.isArray(entry.content)) {
    const updated = stripEnvelopeFromContentWithRole(entry.content, stripUserEnvelope);
    if (updated.changed) {
      next.content = updated.content;
      changed = true;
    }
  } else if (typeof entry.text === "string") {
    const inboundStripped = stripInboundMetadata(entry.text);
    const stripped = stripUserEnvelope ? stripFullUserEnvelope(inboundStripped) : inboundStripped;
    if (stripped !== entry.text) {
      next.text = stripped;
      changed = true;
    }
  }

  return changed ? next : message;
}

export function stripEnvelopeFromMessages(messages: unknown[]): unknown[] {
  if (messages.length === 0) {
    return messages;
  }
  let changed = false;
  const next = messages.map((message) => {
    const stripped = stripEnvelopeFromMessage(message);
    if (stripped !== message) {
      changed = true;
    }
    return stripped;
  });
  return changed ? next : messages;
}
