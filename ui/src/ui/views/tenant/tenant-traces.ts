/**
 * Tenant LLM interaction traces view.
 *
 * Shows a list of user turns (grouped by question) with drill-down
 * into individual LLM interaction rounds.
 */

import { html, css, LitElement, nothing } from "lit";
import { customElement, state, property } from "lit/decorators.js";
import { t, i18n, I18nController } from "../../../i18n/index.ts";
import { caretFix } from "../../shared-styles.ts";
import "../../components/date-picker.ts";
import { tenantRpc } from "./rpc.ts";

interface TurnSummary {
  turnId: string;
  userInput: string | null;
  agentId: string | null;
  agentName: string | null;
  channel: string | null;
  userId: string | null;
  sessionKey: string | null;
  provider: string | null;
  model: string | null;
  interactionCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalDurationMs: number;
  createdAt: string;
  /** Display name resolved from sessions.json (authoritative source). */
  sessionDisplayName: string | null;
  /** Channel resolved from sessions.json. */
  sessionChannel: string | null;
}

interface InteractionTrace {
  id: string;
  turnId: string;
  turnIndex: number;
  userInput: string | null;
  provider: string | null;
  model: string | null;
  systemPrompt: string | null;
  messages: unknown[];
  tools: unknown[] | null;
  requestParams: Record<string, unknown> | null;
  response: unknown;
  stopReason: string | null;
  errorMessage: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  durationMs: number | null;
  createdAt: string;
}

@customElement("tenant-traces-view")
export class TenantTracesView extends LitElement {
  private i18nCtrl = new I18nController(this);

  static styles = [
    caretFix,
    css`
      :host {
        display: block;
        padding: 1.5rem;
        color: var(--text);
        font-family: var(--font-sans, system-ui, sans-serif);
      }
      .header {
        display: flex;
        justify-content: flex-end;
        align-items: center;
        margin-bottom: 1.5rem;
      }
      h2 {
        margin: 0;
        font-size: 1.1rem;
        font-weight: 600;
      }
      .btn {
        padding: 0.45rem 0.9rem;
        border: none;
        border-radius: var(--radius-md);
        font-size: 0.85rem;
        cursor: pointer;
        transition: opacity 0.15s;
      }
      .btn:hover {
        opacity: 0.85;
      }
      .btn-outline {
        background: transparent;
        border: 1px solid var(--border);
        color: var(--text);
      }
      .btn-primary {
        background: var(--accent);
        color: var(--accent-foreground);
        border: none;
      }
      .btn-sm {
        padding: 0.3rem 0.6rem;
        font-size: 0.78rem;
      }
      .filters {
        display: flex;
        gap: 0.5rem;
        align-items: center;
        margin-bottom: 1rem;
        flex-wrap: wrap;
      }
      .filters input,
      .filters select {
        padding: 0.35rem 0.5rem;
        background: var(--input-bg);
        border: 1px solid var(--input-border);
        border-radius: var(--radius-md);
        color: var(--text);
        font-size: 0.8rem;
        outline: none;
      }
      .filters input:focus,
      .filters select:focus {
        border-color: var(--accent);
      }
      .filters label {
        font-size: 0.8rem;
        color: var(--text-2);
      }
      .error-msg {
        background: var(--danger-subtle);
        border: 1px solid var(--danger);
        border-radius: var(--radius-md);
        color: var(--danger);
        padding: 0.5rem 0.75rem;
        font-size: 0.8rem;
        margin-bottom: 1rem;
      }
      .loading {
        text-align: center;
        padding: 2rem;
        color: var(--muted);
      }
      .empty {
        text-align: center;
        padding: 2rem;
        color: var(--muted);
        font-size: 0.85rem;
      }

      /* Turn list */
      .turn-list {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }
      .turn-card {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        padding: 1rem;
        cursor: pointer;
        transition: border-color 0.15s;
      }
      .turn-card:hover {
        border-color: var(--accent);
      }
      .turn-card.expanded {
        border-color: var(--accent);
      }
      .turn-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 1rem;
      }
      .turn-input {
        font-size: 0.9rem;
        font-weight: 500;
        flex: 1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .turn-meta {
        display: flex;
        gap: 0.75rem;
        font-size: 0.75rem;
        color: var(--text-2);
        margin-top: 0.35rem;
        flex-wrap: wrap;
      }
      .turn-meta span {
        white-space: nowrap;
      }
      .badge {
        display: inline-block;
        padding: 0.15rem 0.5rem;
        border-radius: 10px;
        font-size: 0.7rem;
        font-weight: 600;
      }
      .badge-rounds {
        background: var(--accent-light);
        color: var(--accent);
      }
      .badge-tokens {
        background: var(--ok-subtle);
        color: var(--ok);
      }
      .badge-time {
        background: var(--warn-subtle);
        color: var(--warn);
      }
      .badge-error {
        background: var(--danger-subtle);
        color: var(--danger);
      }
      .badge-platform {
        display: inline-block;
        padding: 1px 6px;
        border-radius: 9999px;
        border: 1px solid;
        font-size: 10px;
        font-weight: 500;
      }
      .badge-platform--WeCom {
        background: #0d3b1f;
        color: #6ee7b7;
        border-color: #0d3b1f;
      }
      .badge-platform--DingTalk {
        background: #0b2a4a;
        color: #7dd3fc;
        border-color: #0b2a4a;
      }
      .badge-platform--Feishu {
        background: #2d1b4e;
        color: #c4b5fd;
        border-color: #2d1b4e;
      }
      .badge-platform--Telegram {
        background: #0c3547;
        color: #67d4f1;
        border-color: #0c3547;
      }
      .badge-platform--Slack {
        background: #1a2e1a;
        color: #86efac;
        border-color: #1a2e1a;
      }
      .badge-platform--WhatsApp {
        background: #1a2e1a;
        color: #86efac;
        border-color: #1a2e1a;
      }
      .badge-platform--Discord {
        background: #272060;
        color: #a8a1f6;
        border-color: #272060;
      }
      .badge-platform--Signal {
        background: #1e3a5f;
        color: #93c5fd;
        border-color: #1e3a5f;
      }
      .badge-platform--WebChat {
        background: #1e3a5f;
        color: #93c5fd;
        border-color: #1e3a5f;
      }
      .badge-user {
        background: var(--accent-light);
        color: var(--accent);
      }
      .badge-system {
        background: var(--border, #e5e7eb);
        color: var(--muted, #6b7280);
        border: 1px solid var(--border, #e5e7eb);
      }

      .turn-user-line {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        margin-bottom: 0.25rem;
      }
      .turn-user-name {
        font-weight: 600;
        font-size: 0.85rem;
      }
      .turn-content {
        font-size: 0.88rem;
        color: var(--text);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .turn-content.empty {
        color: var(--muted);
        font-style: italic;
      }
      .turn-content.system-event {
        color: var(--muted);
        font-style: italic;
        font-size: 0.8rem;
      }
      .turn-session-id {
        font-size: 0.7rem;
        color: var(--muted);
        font-family: var(--font-mono, monospace);
        max-width: 180px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      /* Interaction detail (expanded turn) */
      .interactions {
        margin-top: 0.75rem;
        border-top: 1px solid var(--border);
        padding-top: 0.75rem;
      }
      .interaction {
        background: var(--surface-2);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: 0.75rem;
        margin-bottom: 0.5rem;
      }
      .interaction-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 0.8rem;
        font-weight: 600;
        margin-bottom: 0.5rem;
      }
      .interaction-stats {
        display: flex;
        gap: 0.5rem;
        font-size: 0.7rem;
        color: var(--text-2);
      }
      .collapsible-section {
        margin-top: 0.5rem;
      }
      .collapsible-toggle {
        background: none;
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        color: var(--text-2);
        padding: 0.25rem 0.6rem;
        font-size: 0.75rem;
        cursor: pointer;
        margin-right: 0.35rem;
        margin-bottom: 0.35rem;
      }
      .collapsible-toggle:hover {
        color: var(--text);
        border-color: var(--accent);
      }
      .collapsible-toggle.active {
        color: var(--accent);
        border-color: var(--accent);
      }
      .code-block {
        background: var(--surface-2);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: 0.75rem;
        font-family: var(--font-mono, "SF Mono", "Consolas", monospace);
        font-size: 0.75rem;
        line-height: 1.5;
        overflow-x: auto;
        max-height: 400px;
        overflow-y: auto;
        white-space: pre-wrap;
        word-break: break-all;
        margin-top: 0.35rem;
        color: var(--text);
      }
      .stop-reason {
        display: inline-block;
        padding: 0.1rem 0.4rem;
        border-radius: 4px;
        font-size: 0.7rem;
        font-weight: 500;
      }
      .stop-reason.tool_use {
        background: var(--accent-light);
        color: var(--accent);
      }
      .stop-reason.end_turn {
        background: var(--ok-subtle);
        color: var(--ok);
      }
      .stop-reason.error {
        background: var(--danger-subtle);
        color: var(--danger);
      }

      /* Chat-style message bubbles */
      .chat-timeline {
        margin-top: 0.35rem;
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
        max-height: 500px;
        overflow-y: auto;
      }
      .chat-msg {
        padding: 0.5rem 0.75rem;
        border-radius: var(--radius-md);
        font-size: 0.8rem;
        line-height: 1.5;
        max-width: 85%;
      }
      .chat-msg.user {
        background: var(--accent-light);
        color: var(--text);
        align-self: flex-end;
        border-bottom-right-radius: 2px;
        border: 1px solid var(--accent-light-border);
      }
      .chat-msg.assistant {
        background: var(--ok-subtle);
        color: var(--text);
        align-self: flex-start;
        border-bottom-left-radius: 2px;
        border: 1px solid var(--border);
      }
      .chat-msg.system {
        background: var(--warn-subtle);
        color: var(--text);
        align-self: center;
        font-size: 0.75rem;
        max-width: 95%;
        border: 1px solid var(--border);
      }
      .chat-msg.tool {
        background: var(--surface-2);
        color: var(--accent-2);
        align-self: flex-start;
        font-size: 0.75rem;
        border: 1px solid var(--border);
      }
      .chat-role {
        font-size: 0.65rem;
        font-weight: 600;
        opacity: 0.7;
        margin-bottom: 0.15rem;
        text-transform: uppercase;
      }
      .chat-text {
        white-space: pre-wrap;
        word-break: break-word;
      }
      .tool-call-inline {
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
        padding: 0.15rem 0.4rem;
        background: var(--accent-light);
        border-radius: 4px;
        font-size: 0.7rem;
        color: var(--accent);
        margin: 0.15rem 0;
      }

      /* Tool list (friendly view) */
      .tool-list {
        margin-top: 0.35rem;
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        max-height: 300px;
        overflow-y: auto;
      }
      .tool-item {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.35rem 0.6rem;
        background: var(--surface-2);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        font-size: 0.78rem;
      }
      .tool-name {
        font-weight: 600;
        color: var(--accent);
      }
      .tool-desc {
        color: var(--text-2);
        font-size: 0.72rem;
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      /* Response friendly view */
      .response-text {
        margin-top: 0.35rem;
        padding: 0.75rem;
        background: var(--surface-2);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        font-size: 0.8rem;
        line-height: 1.6;
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 400px;
        overflow-y: auto;
      }

      /* Section footer with raw JSON toggle */
      .section-footer {
        display: flex;
        justify-content: flex-end;
        margin-top: 0.25rem;
      }
      .raw-toggle {
        background: none;
        border: none;
        color: var(--muted);
        font-size: 0.68rem;
        cursor: pointer;
        padding: 0.15rem 0;
      }
      .raw-toggle:hover {
        color: var(--text-2);
      }

      /* History context collapse */
      .history-toggle {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        width: 100%;
        background: none;
        border: none;
        border-top: 1px dashed var(--border);
        border-bottom: 1px dashed var(--border);
        color: var(--muted);
        font-size: 0.72rem;
        cursor: pointer;
        padding: 0.3rem 0;
        margin: 0.2rem 0;
        text-align: left;
      }
      .history-toggle:hover {
        color: var(--text-2);
      }
      .history-msgs {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
        opacity: 0.55;
      }
      .history-msgs .chat-msg {
        border-style: dashed;
      }
      .history-label {
        font-size: 0.65rem;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        padding: 0.1rem 0.35rem;
        border: 1px dashed var(--border);
        border-radius: 3px;
        align-self: center;
        margin: 0.1rem 0;
      }

      /* Pagination */
      .pagination {
        display: flex;
        justify-content: center;
        align-items: center;
        gap: 0.75rem;
        margin-top: 1rem;
        font-size: 0.8rem;
        color: var(--text-secondary, #a3a3a3);
      }
    `,
  ];

  @property({ type: String }) gatewayUrl = "";

  @state() private turns: TurnSummary[] = [];
  @state() private total = 0;
  @state() private loading = false;
  @state() private errorKey = "";
  private msgTimer?: ReturnType<typeof setTimeout>;
  @state() private page = 0;
  @state() private pageSize = 20;

  // Filters
  @state() private filterAgentId = "";
  @state() private filterSince = "";
  @state() private filterUntil = "";

  // Expanded turn detail
  @state() private expandedTurnId: string | null = null;
  @state() private expandedTraces: InteractionTrace[] = [];
  @state() private expandedLoading = false;

  // Active section per interaction: only one visible at a time per trace
  @state() private activeSection = new Map<string, string>();
  // Track which sections are showing raw JSON
  @state() private rawJsonSections = new Set<string>();
  // Track which interactions have history expanded
  @state() private expandedHistory = new Set<string>();

  private showError(key: string) {
    this.errorKey = key;
    if (this.msgTimer) {
      clearTimeout(this.msgTimer);
    }
    this.msgTimer = setTimeout(() => (this.errorKey = ""), 5000);
  }

  private tr(key: string): string {
    const result = t(key);
    return result === key ? key : result;
  }

  connectedCallback() {
    super.connectedCallback();
    void this.loadTurns();
  }

  private rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return tenantRpc(method, params, this.gatewayUrl);
  }

  private async loadTurns() {
    this.loading = true;
    this.errorKey = "";
    try {
      const result = (await this.rpc("tenant.traces.turns", {
        agentId: this.filterAgentId || undefined,
        since: this.filterSince || undefined,
        until: this.filterUntil || undefined,
        limit: this.pageSize,
        offset: this.page * this.pageSize,
      })) as { turns: TurnSummary[]; total: number };
      this.turns = result.turns;
      this.total = result.total;
    } catch (err) {
      this.showError(err instanceof Error ? err.message : "tenantTraces.loadFailed");
    } finally {
      this.loading = false;
    }
  }

  private async toggleTurn(turnId: string) {
    if (this.expandedTurnId === turnId) {
      this.expandedTurnId = null;
      this.expandedTraces = [];
      return;
    }
    this.expandedTurnId = turnId;
    this.expandedLoading = true;
    this.activeSection = new Map();
    this.expandedHistory = new Set();
    try {
      const result = (await this.rpc("tenant.traces.turn", { turnId })) as {
        turnId: string;
        traces: InteractionTrace[];
      };
      this.expandedTraces = result.traces;
    } catch (err) {
      this.showError(err instanceof Error ? err.message : "tenantTraces.loadDetailFailed");
    } finally {
      this.expandedLoading = false;
    }
  }

  private toggleSection(traceId: string, section: string) {
    const current = new Map(this.activeSection);
    if (current.get(traceId) === section) {
      current.delete(traceId);
    } else {
      current.set(traceId, section);
    }
    this.activeSection = current;
  }

  private isSectionVisible(traceId: string, section: string): boolean {
    return this.activeSection.get(traceId) === section;
  }

  private get currentLocaleTag(): string {
    const loc = i18n.getLocale();
    if (loc === "zh-CN") {
      return "zh-CN";
    }
    if (loc === "zh-TW") {
      return "zh-TW";
    }
    if (loc === "de") {
      return "de-DE";
    }
    if (loc === "pt-BR") {
      return "pt-BR";
    }
    return "en-US";
  }

  private formatTime(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleString(this.currentLocaleTag, {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  private formatTokens(n: number): string {
    if (n >= 1_000_000) {
      return `${(n / 1_000_000).toFixed(1)}M`;
    }
    if (n >= 1_000) {
      return `${(n / 1_000).toFixed(1)}K`;
    }
    return String(n);
  }

  private formatDuration(ms: number): string {
    if (ms >= 60000) {
      return `${(ms / 60000).toFixed(1)}m`;
    }
    if (ms >= 1000) {
      return `${(ms / 1000).toFixed(1)}s`;
    }
    return `${ms}ms`;
  }

  private formatJson(data: unknown): string {
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  }

  private truncate(text: string | null, max = 80): string {
    if (!text) {
      return t("tenantTraces.noInput");
    }
    // Collapse actual and escaped newlines/tabs to spaces for single-line preview
    const clean = text
      .replace(/\r?\n|\t/g, " ")
      .replace(/\\n|\\t/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
    return clean.length > max ? clean.slice(0, max) + "..." : clean;
  }

  /**
   * Parse platform system message to extract platform, user name, and actual content.
   * Handles multiple formats:
   * - "System: [time] Feishu[id] group id | UserName (uid)\nContent"
   * - Prefixed with "System: [time] Reasoning STREAM ..." before the Feishu block
   * - "Replied message (untrusted, for context): ```...```" blocks stripped
   */
  private parsePlatformMessage(raw: string | null): {
    platform: string;
    userName: string;
    userId: string;
    content: string;
  } | null {
    if (!raw) {
      return null;
    }

    // Primary: match "System: [...] Platform[...] ... | UserName (uid)"
    const m = raw.match(
      /System:\s*\[.*?\]\s*([A-Za-z][A-Za-z0-9_-]*)\[.*?\][\s\S]*?\|\s*(.+?)\s*\(([\w_-]+)\.{0,3}\)/,
    );

    let platform: string;
    let userName: string;
    let userId: string;

    if (m) {
      platform = m[1];
      userName = m[2].trim();
      userId = m[3];
    } else {
      // Fallback: extract platform from "Feishu[...]" and username from Sender JSON
      const platformM = raw.match(/([A-Za-z][A-Za-z0-9_-]*)\[[\w-]+\]/);
      if (!platformM) {
        return null;
      }
      platform = platformM[1];
      // Try to extract display name from Sender metadata JSON block
      const senderM = raw.match(/Sender[^\n]*\n```[\s\S]*?"(?:label|name)"\s*:\s*"([^"]+)"/);
      if (!senderM) {
        return null;
      }
      const candidate = senderM[1];
      // Skip if it looks like a raw user ID (e.g. ou_xxx, oc_xxx, cli_xxx)
      if (/^[a-z]{2,4}_[0-9a-f]{8,}$/i.test(candidate)) {
        return null;
      }
      userName = candidate;
      userId = "";
    }

    // Content = everything after the matched header's line
    // When m is null (fallback path), use the full raw string for content extraction
    const headerEnd = m ? (m.index ?? 0) + m[0].length : 0;
    const afterHeader = raw.slice(headerEnd);
    const nlIdx = afterHeader.indexOf("\n");
    const rest = nlIdx >= 0 ? afterHeader.slice(nlIdx + 1) : afterHeader;

    // Strip inbound-meta metadata blocks — handles both P1=true (compact JSON, no fence)
    // and P1=false (code-fenced pretty JSON) formats.
    const stripped = this.stripMetadataBlocks(rest);

    // Split by residual code-fenced blocks; the user's actual input is the last
    // non-empty plain-text segment (not inside ```...```)
    const segments = stripped.split(/```[\s\S]*?```/g);
    let content = "";
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i].trim();
      if (seg) {
        content = seg;
        break;
      }
    }

    // Strip leading "System:" prefix from content if present
    const cleanContent = content.replace(/^System:\s*/i, "").trim();

    return { platform, userName, userId, content: cleanContent };
  }

  /**
   * Strip inbound-meta "untrusted metadata" label blocks from the raw user_input
   * so only the user's actual message remains. Handles both formats emitted by
   * src/auto-reply/reply/inbound-meta.ts:
   *
   *   P1=true (ENCLAWS_TOKEN_OPT_P1 not "false", default):
   *     Conversation:
   *     {"is_group_chat":true}
   *
   *   P1=false:
   *     Conversation info (untrusted metadata):
   *     ```json
   *     {
   *       "is_group_chat": true
   *     }
   *     ```
   *
   * Label base words: Conversation, Sender, Thread starter, Replied message,
   *                   Forwarded, Chat history (each with optional suffix / parenthetical).
   */
  private stripMetadataBlocks(text: string): string {
    // Strip inbound-meta label blocks (see method docstring above)
    const METADATA_LABEL_RE =
      /^\s*(Conversation(?:\s+info)?|Sender|Thread\s+starter|Replied\s+message|Forwarded(?:\s+message\s+context)?|Chat\s+history(?:\s+since\s+last\s+reply)?)\s*(?:\([^)]*\))?\s*:\s*$/i;

    const lines = text.split("\n");
    const out: string[] = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (METADATA_LABEL_RE.test(line)) {
        i += 1;
        // Skip the payload that follows the label:
        //   - a code-fenced block (P1=false)
        //   - a single-line compact JSON (P1=true)
        if (i < lines.length && lines[i].trim().startsWith("```")) {
          i += 1;
          while (i < lines.length && !lines[i].trim().startsWith("```")) {
            i += 1;
          }
          if (i < lines.length) {
            i += 1;
          }
        } else if (i < lines.length) {
          const t = lines[i].trim();
          if (t.startsWith("{") && t.endsWith("}")) {
            i += 1;
          }
        }
        continue;
      }
      out.push(line);
      i += 1;
    }
    let result = out.join("\n");

    // Strip cron task scaffolding injected by src/cron/isolated-agent/run.ts:
    //   [Scheduled Task Context] + 3 instruction lines + blank line  (preamble)
    //   [Delivery Instructions] + trailing paragraph                 (epilogue)
    // Keep the actual task content in between (the [cron:uuid name] line + body).
    result = result
      .replace(/^\s*\[Scheduled Task Context\][\s\S]*?(?:\n\s*\n|\n$|$)/, "")
      .replace(/\n+\[Delivery Instructions\][\s\S]*$/, "");

    // Strip IM channel "System" envelope line injected per-message. Example:
    //   System: [2026-04-18 16:08:32 GMT+8] Feishu[cli_xxx] group oc_xxx | 刘昱 (ou_xxx) [msg:om_xxx, @bot]
    // Match in multi-line mode; require bracketed timestamp and "| name (uid)" segments
    // to avoid accidental matches against generic "System: Model switched." lines.
    result = result.replace(/^System:\s*\[[^\]]+\][^\n]*\|[^\n]*\([^)]+\)[^\n]*\n?/m, "");

    return result;
  }

  /** Extract user content or a short friendly label from a raw system message. */
  private extractSystemEventLabel(raw: string): string {
    // Classify well-known system-internal patterns first
    if (/pre-compaction memory flush/i.test(raw)) {
      return "[系统: 记忆整理]";
    }
    if (/reasoning\s*stream/i.test(raw)) {
      return "[系统: 推理流]";
    }
    if (/\[cron:[^\]]+\]/i.test(raw)) {
      return "[系统: 定时任务]";
    }
    if (/^IMPORTANT:/m.test(raw) && !/Feishu|WeChat|Telegram/i.test(raw)) {
      return "[系统事件]";
    }

    // Strip inbound-meta label blocks (both P1=true and P1=false formats),
    // then try to find clean user text: last non-empty segment outside code blocks.
    const stripped = this.stripMetadataBlocks(raw);
    const segments = stripped.split(/```[\s\S]*?```/g);
    const SYSTEM_LINE = /^\s*(System:|<think>|IMPORTANT:)/i;
    for (let i = segments.length - 1; i >= 0; i--) {
      const lines = segments[i].split("\n").filter((l) => l.trim() && !SYSTEM_LINE.test(l));
      const text = lines.join(" ").trim();
      if (text) {
        return text;
      }
    }
    return "[系统事件]";
  }

  private isRawJson(traceId: string, section: string): boolean {
    return this.rawJsonSections.has(`${traceId}:${section}`);
  }

  private toggleRawJson(traceId: string, section: string) {
    const key = `${traceId}:${section}`;
    const next = new Set(this.rawJsonSections);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    this.rawJsonSections = next;
  }

  /** Extract readable text from a message content field (string or content blocks array). */
  private extractContentText(content: unknown): string {
    if (typeof content === "string") {
      return content;
    }
    if (!Array.isArray(content)) {
      return "";
    }
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block);
        continue;
      }
      if (!block || typeof block !== "object") {
        continue;
      }
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        parts.push(b.text);
      } else if (b.type === "tool_use") {
        parts.push(`[Tool: ${typeof b.name === "string" ? b.name : "unknown"}]`);
      } else if (b.type === "tool_result") {
        const resultText = this.extractContentText(b.content);
        parts.push(resultText ? `[Tool Result] ${resultText.slice(0, 200)}` : "[Tool Result]");
      } else if (b.type === "image" || b.type === "image_url") {
        parts.push("[Image]");
      }
    }
    return parts.join("\n");
  }

  /** Extract the tool name list from the tools definition array. */
  private extractToolNames(tools: unknown[]): Array<{ name: string; desc: string }> {
    const result: Array<{ name: string; desc: string }> = [];
    for (const tool of tools) {
      if (!tool || typeof tool !== "object") {
        continue;
      }
      const t = tool as Record<string, unknown>;
      // Anthropic format: { name, description, ... }
      if (typeof t.name === "string") {
        result.push({ name: t.name, desc: typeof t.description === "string" ? t.description : "" });
        continue;
      }
      // OpenAI format: { type: "function", function: { name, description } }
      if (t.type === "function" && t.function && typeof t.function === "object") {
        const fn = t.function as Record<string, unknown>;
        if (typeof fn.name === "string") {
          result.push({
            name: fn.name,
            desc: typeof fn.description === "string" ? fn.description : "",
          });
        }
      }
    }
    return result;
  }

  /** Derive a display platform name from channel field (reliable) or parsed header fallback. */
  private resolvePlatform(channel: string | null, parsedPlatform?: string): string | null {
    if (channel) {
      const c = channel.toLowerCase();
      if (c.includes("feishu") || c.includes("lark")) {
        return "Feishu";
      }
      if (c.includes("wechat") || c.includes("wecom")) {
        return "WeCom";
      }
      if (c === "webchat") {
        return "WebChat";
      }
      if (c.includes("telegram")) {
        return "Telegram";
      }
      if (c.includes("slack")) {
        return "Slack";
      }
      if (c.includes("dingtalk") || c.includes("dingding")) {
        return "DingTalk";
      }
      if (c === "whatsapp") {
        return "WhatsApp";
      }
      if (c === "discord") {
        return "Discord";
      }
      if (c === "googlechat") {
        return "Google Chat";
      }
      if (c === "signal") {
        return "Signal";
      }
      if (c === "imessage") {
        return "iMessage";
      }
      if (c === "irc") {
        return "IRC";
      }
      // Fallback: return raw channel value capitalised
      return channel.charAt(0).toUpperCase() + channel.slice(1);
    }
    return parsedPlatform ?? null;
  }

  private renderTurnCard(turn: TurnSummary) {
    const isExpanded = this.expandedTurnId === turn.turnId;
    const totalTokens = turn.totalInputTokens + turn.totalOutputTokens;
    const parsed = this.parsePlatformMessage(turn.userInput);

    // Platform: session channel (authoritative) > trace channel > parsed header
    const platform = this.resolvePlatform(turn.sessionChannel ?? turn.channel, parsed?.platform);
    // Username: session displayName (authoritative) > parsed header > turn.userId
    const userName = turn.sessionDisplayName ?? parsed?.userName ?? turn.userId ?? null;
    const content = parsed?.content
      ? this.truncate(parsed.content, 120)
      : this.extractSystemEventLabel(turn.userInput ?? "");
    // System badge: only when content is a recognised system event label (e.g. [系统: 记忆整理])
    const isSystemEvent = content.startsWith("[系统");

    const mainContent = html`
      <div class="turn-user-line">
        ${
          isSystemEvent
            ? html`
                <span class="badge badge-system">System</span>
              `
            : html`
              ${platform ? html`<span class="badge badge-platform badge-platform--${platform}">${platform}</span>` : nothing}
              ${userName ? html`<span class="turn-user-name">${userName}</span>` : nothing}
            `
        }
      </div>
      <div class="turn-content">${content}</div>`;

    return html`
      <div class="turn-card ${isExpanded ? "expanded" : ""}" @click=${() => this.toggleTurn(turn.turnId)}>
        <div class="turn-header">
          <div style="flex:1;min-width:0">
            ${mainContent}
            <div class="turn-meta">
              <span>${this.formatTime(turn.createdAt)}</span>
              ${turn.agentName || turn.agentId ? html`<span>Agent: ${turn.agentName || turn.agentId}</span>` : nothing}
              ${turn.model ? html`<span>Model: ${turn.model}</span>` : nothing}
            </div>
          </div>
          <div style="display:flex;gap:0.35rem;flex-shrink:0;align-items:flex-start">
            <span class="badge badge-rounds">${t("tenantTraces.rounds", { count: String(turn.interactionCount) })}</span>
            <span class="badge badge-tokens">${this.formatTokens(totalTokens)} tokens</span>
            <span class="badge badge-time">${this.formatDuration(turn.totalDurationMs)}</span>
          </div>
        </div>

        ${isExpanded ? this.renderExpandedTurn() : nothing}
      </div>
    `;
  }

  private renderExpandedTurn() {
    if (this.expandedLoading) {
      return html`<div class="interactions"><div class="loading">${t("tenantTraces.loading")}</div></div>`;
    }
    if (this.expandedTraces.length === 0) {
      return html`<div class="interactions"><div class="empty">${t("tenantTraces.noRecords")}</div></div>`;
    }
    return html`
      <div class="interactions" @click=${(e: Event) => e.stopPropagation()}>
        ${this.expandedTraces.map((trace, i) => {
          const prevCount =
            i > 0 && Array.isArray(this.expandedTraces[i - 1].messages)
              ? this.expandedTraces[i - 1].messages.length
              : 0;
          return this.renderInteraction(trace, prevCount);
        })}
      </div>
    `;
  }

  private renderInteraction(trace: InteractionTrace, historyCount = 0) {
    const stopClass = trace.errorMessage
      ? "error"
      : trace.stopReason === "tool_use"
        ? "tool_use"
        : "end_turn";
    const messagesCount = Array.isArray(trace.messages) ? trace.messages.length : 0;
    const toolsCount = Array.isArray(trace.tools) ? trace.tools.length : 0;

    return html`
      <div class="interaction">
        <div class="interaction-header">
          <div>
            <span style="color:var(--accent,#3b82f6)">[${t("tenantTraces.turnIndex", { index: String(trace.turnIndex) })}]</span>
            ${trace.provider ? html`<span style="margin-left:0.5rem;color:var(--text-secondary)">${trace.provider}/${trace.model}</span>` : nothing}
            ${
              trace.stopReason || trace.errorMessage
                ? html`<span class="stop-reason ${stopClass}" style="margin-left:0.5rem">${trace.errorMessage ? "error" : trace.stopReason}</span>`
                : nothing
            }
          </div>
          <div class="interaction-stats">
            <span>In: ${this.formatTokens(trace.inputTokens)}</span>
            <span>Out: ${this.formatTokens(trace.outputTokens)}</span>
            ${trace.cacheReadTokens > 0 ? html`<span>Cache: ${this.formatTokens(trace.cacheReadTokens)}</span>` : nothing}
            ${trace.durationMs != null ? html`<span>${this.formatDuration(trace.durationMs)}</span>` : nothing}
          </div>
        </div>

        <div style="display:flex;flex-wrap:wrap;gap:0.25rem;margin-top:0.25rem">
          <button class="collapsible-toggle ${this.isSectionVisible(trace.id, "messages") ? "active" : ""}"
            @click=${() => this.toggleSection(trace.id, "messages")}>
            ${t("tenantTraces.messages")} (${messagesCount})
          </button>
          <button class="collapsible-toggle ${this.isSectionVisible(trace.id, "response") ? "active" : ""}"
            @click=${() => this.toggleSection(trace.id, "response")}>
            ${t("tenantTraces.response")}
          </button>
          ${
            toolsCount > 0
              ? html`
            <button class="collapsible-toggle ${this.isSectionVisible(trace.id, "tools") ? "active" : ""}"
              @click=${() => this.toggleSection(trace.id, "tools")}>
              ${t("tenantTraces.tools")} (${toolsCount})
            </button>
          `
              : nothing
          }
          <button class="collapsible-toggle ${this.isSectionVisible(trace.id, "system") ? "active" : ""}"
            @click=${() => this.toggleSection(trace.id, "system")}>
            ${t("tenantTraces.systemPrompt")}
          </button>
          ${
            trace.errorMessage
              ? html`
            <button class="collapsible-toggle ${this.isSectionVisible(trace.id, "error") ? "active" : ""}"
              @click=${() => this.toggleSection(trace.id, "error")}>
              ${t("tenantTraces.error")}
            </button>
          `
              : nothing
          }
        </div>

        ${
          this.isSectionVisible(trace.id, "messages")
            ? this.renderMessagesSection(trace.id, trace.messages, historyCount)
            : nothing
        }
        ${
          this.isSectionVisible(trace.id, "response")
            ? this.renderResponseSection(trace.id, trace.response)
            : nothing
        }
        ${
          this.isSectionVisible(trace.id, "tools")
            ? this.renderToolsSection(trace.id, trace.tools)
            : nothing
        }
        ${
          this.isSectionVisible(trace.id, "system")
            ? html`<div class="code-block">${trace.systemPrompt ?? t("tenantTraces.none")}</div>`
            : nothing
        }
        ${
          this.isSectionVisible(trace.id, "error")
            ? html`<div class="code-block" style="color:#fca5a5">${trace.errorMessage}</div>`
            : nothing
        }
      </div>
    `;
  }

  /** Render messages as a chat timeline with raw JSON toggle. */
  private renderMessagesSection(traceId: string, messages: unknown[], historyCount = 0) {
    if (this.isRawJson(traceId, "messages")) {
      return html`
        <div class="code-block">${this.formatJson(messages)}</div>
        <div class="section-footer">
          <button class="raw-toggle" @click=${() => this.toggleRawJson(traceId, "messages")}>${t("tenantTraces.friendlyView")}</button>
        </div>`;
    }

    const renderMsg = (msg: unknown) => {
      if (!msg || typeof msg !== "object") {
        return nothing;
      }
      const m = msg as Record<string, unknown>;
      const role = (m.role as string) ?? "unknown";
      const rawText = this.extractContentText(m.content);
      // Only strip inbound-meta blocks from user messages; other roles don't carry them.
      // Users wanting the full raw prompt can toggle to the JSON view.
      const text = role === "user" ? this.stripMetadataBlocks(rawText).trim() : rawText;
      const roleClass =
        role === "user"
          ? "user"
          : role === "assistant"
            ? "assistant"
            : role === "system"
              ? "system"
              : "tool";
      const roleLabel =
        role === "user"
          ? "User"
          : role === "assistant"
            ? "AI"
            : role === "system"
              ? "System"
              : "Tool";
      if (!text && role !== "system") {
        return nothing;
      }
      return html`
        <div class="chat-msg ${roleClass}">
          <div class="chat-role">${roleLabel}</div>
          <div class="chat-text">${text || t("tenantTraces.none")}</div>
        </div>`;
    };

    const histMsgs = historyCount > 0 ? messages.slice(0, historyCount) : [];
    const newMsgs = historyCount > 0 ? messages.slice(historyCount) : messages;
    const isHistExpanded = this.expandedHistory.has(traceId);

    return html`
      <div class="chat-timeline">
        ${
          histMsgs.length > 0
            ? html`
          <button class="history-toggle" @click=${() => {
            const next = new Set(this.expandedHistory);
            if (next.has(traceId)) {
              next.delete(traceId);
            } else {
              next.add(traceId);
            }
            this.expandedHistory = next;
          }}>
            ${isHistExpanded ? "▾" : "▸"} 历史上下文 (${histMsgs.length} 条)
          </button>
          ${isHistExpanded ? html`<div class="history-msgs">${histMsgs.map(renderMsg)}</div>` : nothing}
          ${
            newMsgs.length > 0
              ? html`
                  <div class="history-label">本轮新增</div>
                `
              : nothing
          }
        `
            : nothing
        }
        ${newMsgs.map(renderMsg)}
      </div>
      <div class="section-footer">
        <button class="raw-toggle" @click=${() => this.toggleRawJson(traceId, "messages")}>JSON</button>
      </div>`;
  }

  /** Render response as readable text with raw JSON toggle. */
  private renderResponseSection(traceId: string, response: unknown) {
    if (this.isRawJson(traceId, "response")) {
      return html`
        <div class="code-block">${this.formatJson(response)}</div>
        <div class="section-footer">
          <button class="raw-toggle" @click=${() => this.toggleRawJson(traceId, "response")}>${t("tenantTraces.friendlyView")}</button>
        </div>`;
    }
    const text = this.extractContentText(response);
    return html`
      <div class="response-text">${text || t("tenantTraces.none")}</div>
      <div class="section-footer">
        <button class="raw-toggle" @click=${() => this.toggleRawJson(traceId, "response")}>JSON</button>
      </div>`;
  }

  /** Render tools as a name list with raw JSON toggle. */
  private renderToolsSection(traceId: string, tools: unknown[] | null) {
    if (!tools || tools.length === 0) {
      return html`<div class="response-text">${t("tenantTraces.none")}</div>`;
    }
    if (this.isRawJson(traceId, "tools")) {
      return html`
        <div class="code-block">${this.formatJson(tools)}</div>
        <div class="section-footer">
          <button class="raw-toggle" @click=${() => this.toggleRawJson(traceId, "tools")}>${t("tenantTraces.friendlyView")}</button>
        </div>`;
    }
    const toolNames = this.extractToolNames(tools);
    return html`
      <div class="tool-list">
        ${toolNames.map(
          (tool) => html`
          <div class="tool-item">
            <span class="tool-name">${tool.name}</span>
            ${tool.desc ? html`<span class="tool-desc">${tool.desc}</span>` : nothing}
          </div>`,
        )}
      </div>
      <div class="section-footer">
        <button class="raw-toggle" @click=${() => this.toggleRawJson(traceId, "tools")}>JSON</button>
      </div>`;
  }

  render() {
    return html`
      ${this.errorKey ? html`<div class="error-msg">${this.tr(this.errorKey)}</div>` : nothing}

      <div class="filters">
        <label>${t("tenantTraces.filterAgent")}</label>
        <input type="text" .placeholder=${t("tenantTraces.filterAgentPlaceholder")} .value=${this.filterAgentId}
          @change=${(e: Event) => {
            this.filterAgentId = (e.target as HTMLInputElement).value;
            this.page = 0;
            void this.loadTurns();
          }} />
        <label>${t("tenantTraces.filterSince")}</label>
        <date-picker .value=${this.filterSince} .locale=${this.currentLocaleTag}
          .max=${this.filterUntil} .placeholder=${t("tenantTraces.filterSince").replace(":", "")}
          @change=${(e: CustomEvent) => {
            this.filterSince = e.detail.value;
            this.page = 0;
            void this.loadTurns();
          }}></date-picker>
        <label>${t("tenantTraces.filterUntil")}</label>
        <date-picker .value=${this.filterUntil} .locale=${this.currentLocaleTag}
          .min=${this.filterSince} .placeholder=${t("tenantTraces.filterUntil").replace(":", "")}
          @change=${(e: CustomEvent) => {
            this.filterUntil = e.detail.value;
            this.page = 0;
            void this.loadTurns();
          }}></date-picker>
        <button class="btn btn-outline" @click=${() => this.loadTurns()}>${t("tenantTraces.refresh")}</button>
      </div>

      ${
        this.loading
          ? html`<div class="loading">${t("tenantTraces.loading")}</div>`
          : this.turns.length === 0
            ? html`<div class="empty">${t("tenantTraces.empty")}</div>`
            : html`
              <div class="turn-list">
                ${this.turns.map((turn) => this.renderTurnCard(turn))}
              </div>
              ${
                this.total > this.pageSize
                  ? html`
                <div class="pagination">
                  <button class="btn btn-sm btn-outline" ?disabled=${this.page === 0}
                    @click=${() => {
                      this.page--;
                      this.expandedTurnId = null;
                      void this.loadTurns();
                    }}>${t("tenantTraces.prevPage")}</button>
                  <span>${this.page * this.pageSize + 1}-${Math.min((this.page + 1) * this.pageSize, this.total)} / ${this.total}</span>
                  <button class="btn btn-sm btn-outline" ?disabled=${(this.page + 1) * this.pageSize >= this.total}
                    @click=${() => {
                      this.page++;
                      this.expandedTurnId = null;
                      void this.loadTurns();
                    }}>${t("tenantTraces.nextPage")}</button>
                </div>
              `
                  : nothing
              }
            `
      }
    `;
  }
}
