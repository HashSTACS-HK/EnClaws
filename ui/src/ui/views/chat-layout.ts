/* oxlint-disable typescript-eslint/no-unnecessary-boolean-literal-compare */
import { LitElement, html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { t, I18nController } from "../../i18n/index.ts";
import { icons } from "../icons.ts";
import { caretFix } from "../shared-styles.ts";
import type { ChatProps } from "./chat.ts";
import "../components/chat-input-area.ts";
import "../components/resizable-divider.ts";
import { renderMarkdownSidebar } from "./markdown-sidebar.ts";

export type ChatLayoutProps = ChatProps & {
  // Pass through props from the functional renderChat function
};

@customElement("chat-layout")
export class ChatLayout extends LitElement {
  private _i18n = new I18nController(this);
  @property({ type: Object }) props!: ChatLayoutProps;

  static styles = [
    caretFix,
    css`
      :host {
        display: flex;
        flex-direction: column;
        height: 100%;
        width: 100%;
        overflow: hidden;
      }

      .chat {
        display: flex;
        flex-direction: column;
        flex: 1;
        height: 100%;
        overflow: hidden;
        background: var(--bg-content);
        border-radius: var(--radius-lg);
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.05);
        border: 1px solid var(--border);
      }

      .chat-split-container {
        display: flex;
        flex: 1;
        overflow: hidden;
      }

      .chat-main {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-width: 0;
        position: relative;
      }

      .chat-thread {
        flex: 1;
        overflow-y: auto;
        padding: 24px;
        display: flex;
        flex-direction: column;
        gap: 16px;
        scroll-behavior: smooth;
      }

      .chat-sidebar {
        flex: 1;
        background: var(--bg-content);
        overflow-y: auto;
        border-left: 1px solid var(--border);
        display: flex;
        flex-direction: column;
        transition:
          transform 0.4s cubic-bezier(0.16, 1, 0.3, 1),
          opacity 0.4s ease;
      }
      .chat-sidebar[hidden] {
        /* Use hidden attribute or specific class for slide out */
        transform: translateX(20px);
        opacity: 0;
        pointer-events: none;
      }

      .callout {
        padding: 12px 16px;
        border-radius: 6px;
        background: var(--surface-2);
        border-left: 4px solid var(--primary-color);
        margin: 16px;
        font-size: 14px;
      }

      .callout.danger {
        border-left-color: var(--danger-color);
        background: rgba(239, 68, 68, 0.1);
        color: var(--danger-color);
      }

      .chat-focus-exit {
        position: absolute;
        top: 16px;
        right: 16px;
        z-index: 10;
        background: var(--surface-2);
        border: 1px solid var(--border-color);
        border-radius: 50%;
        width: 32px;
        height: 32px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        color: var(--text-color);
        opacity: 0.7;
        transition: all 0.2s;
      }

      .chat-focus-exit:hover {
        opacity: 1;
        background: var(--surface-3);
      }

      .chat-input-wrapper {
        padding: 0 24px 8px;
        background: var(--bg-content);
      }

      .chat-tagline {
        text-align: center;
        font-size: 12px;
        color: var(--muted-color, #94a3b8);
        padding: 8px 0 16px;
        letter-spacing: 0.01em;
      }

      /* ---- Empty state (CoPaw style) ---- */
      .chat-empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        text-align: center;
        flex: 1;
        padding: 60px 24px 24px;
      }

      /* Paw logo: 3 dots on top + circle body */
      .chat-empty-logo {
        margin-bottom: 20px;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 4px;
      }

      .chat-empty-logo-crown {
        display: flex;
        align-items: flex-end;
        gap: 5px;
      }

      .crown-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: var(--accent);
        display: block;
      }

      .crown-dot--mid {
        width: 12px;
        height: 12px;
        margin-bottom: 2px;
      }

      .chat-empty-logo-circle {
        width: 40px;
        height: 40px;
        border-radius: 50%;
        border: 3px solid var(--accent);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 0;
        background: transparent;
      }

      .chat-empty-title {
        font-size: 20px;
        font-weight: 600;
        color: var(--text-color, #1e293b);
        margin: 0 0 8px 0;
        letter-spacing: -0.02em;
        line-height: 1.3;
      }

      .chat-empty-subtitle {
        font-size: 13px;
        color: var(--muted-color, #64748b);
        margin: 0 0 28px 0;
        max-width: 360px;
        line-height: 1.5;
      }

      .chat-empty-actions {
        display: flex;
        flex-direction: column;
        gap: 8px;
        width: 100%;
        max-width: 480px;
      }

      .chat-empty-action {
        display: flex;
        align-items: center;
        gap: 12px;
        width: 100%;
        padding: 11px 16px;
        background: transparent;
        border: 1px solid var(--border-color, #e2e8f0);
        border-radius: 8px;
        color: var(--text-color, #334155);
        font-size: 13.5px;
        font-weight: 400;
        text-align: left;
        cursor: pointer;
        transition:
          background 0.15s ease,
          border-color 0.15s ease;
        font-family: inherit;
      }

      .chat-empty-action:hover {
        background: var(--surface-2, #f8fafc);
        border-color: var(--accent);
      }

      .chat-empty-action-icon {
        font-size: 13px;
        color: var(--accent);
        flex-shrink: 0;
      }

      .chat-empty-action-text {
        flex: 1;
      }

      .chat-empty-action-arrow {
        font-size: 14px;
        color: var(--muted-color, #94a3b8);
        transition: transform 0.15s ease;
      }

      .chat-empty-action:hover .chat-empty-action-arrow {
        transform: translateX(3px);
        color: var(--accent);
      }

      /* ---- Sticky Task Plan Bar ---- */
      .chat-plan-sticky {
        position: sticky;
        top: 0;
        z-index: 5;
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        background: var(--surface-1-glass, rgba(255, 255, 255, 0.75));
        border-bottom: 1px solid var(--border-color, rgba(226, 232, 240, 0.8));
        padding: 10px 18px;
        display: flex;
        align-items: center;
        gap: 12px;
        font-size: 13.5px;
        transition: all 0.3s ease;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.02);
      }
      :host-context([data-theme="dark"]) .chat-plan-sticky {
        background: rgba(30, 41, 59, 0.75);
        border-bottom-color: rgba(51, 65, 85, 0.8);
      }
      .chat-plan-sticky__icon {
        font-size: 16px;
        flex-shrink: 0;
      }
      .chat-plan-sticky__desc {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--text-color);
        font-weight: 500;
      }
      .chat-plan-sticky__stats {
        flex-shrink: 0;
        color: var(--muted-color, #64748b);
        font-variant-numeric: tabular-nums;
      }
      .chat-plan-sticky__bar {
        flex-shrink: 0;
        width: 80px;
        height: 6px;
        border-radius: 3px;
        background: var(--surface-3, #e2e8f0);
        overflow: hidden;
      }
      .chat-plan-sticky__fill {
        height: 100%;
        border-radius: 3px;
        background: linear-gradient(90deg, var(--accent-3, #22d3ee), var(--accent));
        transition: width 0.5s ease;
      }
      .chat-plan-sticky__fill--done {
        background: linear-gradient(90deg, var(--ok), var(--ok-muted, #6ee7b7));
      }

      /* ---- Phase Indicators ---- */
      .chat-plan-sticky__phases {
        display: flex;
        gap: 6px;
        flex-shrink: 0;
      }
      .chat-plan-phase {
        font-size: 11px;
        padding: 3px 8px;
        border-radius: 6px;
        background: var(--surface-2, rgba(241, 245, 249, 0.8));
        color: var(--muted-color, #64748b);
        white-space: nowrap;
        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        border: 1px solid transparent;
        font-weight: 500;
        letter-spacing: 0.02em;
      }
      .chat-plan-phase--active {
        background: linear-gradient(135deg, var(--accent), var(--accent-hover, #0e7490));
        color: var(--accent-foreground, #ffffff);
        font-weight: 600;
        border-color: rgba(255, 255, 255, 0.2);
        box-shadow: 0 2px 8px var(--accent-glow);
        transform: translateY(-1px);
      }

      /* ---- Plan Sidebar ---- */
      .plan-sidebar-panel {
        display: flex;
        flex-direction: column;
        height: 100%;
        padding: 24px 20px;
        gap: 16px;
        overflow-y: auto;
        background: var(--surface-1-glass, rgba(255, 255, 255, 0.6));
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        animation: slideInSidebar 0.5s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        transform: translateX(30px);
        opacity: 0;
      }
      @keyframes slideInSidebar {
        to {
          transform: translateX(0);
          opacity: 1;
        }
      }
      :host-context([data-theme="dark"]) .plan-sidebar-panel {
        background: rgba(15, 23, 42, 0.6);
      }
      .plan-sidebar-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .plan-sidebar-title {
        font-size: 16px;
        font-weight: 700;
        color: var(--text-color);
        letter-spacing: -0.01em;
      }
      .plan-sidebar-phase {
        font-size: 10.5px;
        font-weight: 800;
        padding: 4px 10px;
        border-radius: 6px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
      }
      .plan-sidebar-phase--planning {
        background: var(--warn-subtle);
        color: var(--warn);
        border: 1px solid var(--warn-muted);
      }
      .plan-sidebar-phase--execution {
        background: var(--accent-light);
        color: var(--accent);
        border: 1px solid var(--accent-light-border);
      }
      .plan-sidebar-phase--verification {
        background: var(--ok-subtle);
        color: var(--ok);
        border: 1px solid var(--ok-muted);
      }
      .plan-sidebar-phase--complete {
        background: var(--ok-subtle);
        color: var(--ok);
        border: 1px solid var(--ok-muted);
      }
      .plan-sidebar-desc {
        font-size: 13.5px;
        color: var(--text-color);
        line-height: 1.6;
        padding: 12px 16px;
        background: var(--surface-2, rgba(248, 250, 252, 0.7));
        border-radius: 8px;
        border-left: 4px solid var(--accent);
        box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.02);
      }
      :host-context([data-theme="dark"]) .plan-sidebar-desc {
        background: rgba(30, 41, 59, 0.5);
        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.02);
      }
      .plan-sidebar-progress {
        display: flex;
        flex-direction: column;
        gap: 6px;
        margin: 4px 0;
      }
      .plan-sidebar-progress-row {
        display: flex;
        justify-content: space-between;
        font-size: 12.5px;
        font-weight: 500;
        color: var(--muted-color, #64748b);
      }
      .plan-sidebar-bar {
        height: 8px;
        border-radius: 4px;
        background: var(--surface-3, rgba(226, 232, 240, 0.8));
        overflow: hidden;
        box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.05);
      }
      .plan-sidebar-fill {
        height: 100%;
        border-radius: 4px;
        transition: width 0.6s cubic-bezier(0.34, 1.56, 0.64, 1);
        background-size: 200% 100%;
      }
      .plan-sidebar-todos {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .plan-sidebar-todo {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 14px;
        border-radius: 8px;
        font-size: 13.5px;
        background: var(--surface-1, #ffffff);
        border: 1px solid var(--border-color, #e2e8f0);
        transition: all 0.25s ease;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.02);
      }
      .plan-sidebar-todo--done {
        opacity: 0.65;
        background: rgba(255, 255, 255, 0.5);
        border-color: rgba(16, 185, 129, 0.2);
      }
      .plan-sidebar-todo--done .plan-sidebar-todo-text {
        text-decoration: line-through;
        color: var(--muted-color);
      }
      .plan-sidebar-todo--in_progress {
        border-color: rgba(99, 102, 241, 0.5);
        background:
          linear-gradient(white, white) padding-box,
          linear-gradient(135deg, rgba(99, 102, 241, 0.1), rgba(99, 102, 241, 0.02)) border-box;
        box-shadow: 0 2px 8px rgba(99, 102, 241, 0.1);
        transform: translateY(-1px);
      }
      :host-context([data-theme="dark"]) .plan-sidebar-todo--in_progress {
        background: rgba(99, 102, 241, 0.05);
      }
      .plan-sidebar-todo-icon {
        flex-shrink: 0;
        font-size: 14px;
      }
      .plan-sidebar-todo-text {
        flex: 1;
        line-height: 1.4;
      }
      .plan-sidebar-todo-container {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .plan-sidebar-todo-result {
        margin-left: 24px;
        padding: 6px 8px;
        background: rgba(0, 0, 0, 0.03);
        border-radius: 6px;
        border-left: 2px solid var(--ok);
        font-size: 11px;
        color: var(--muted-color, #64748b);
        overflow-wrap: break-word;
        word-break: break-word;
        max-height: 200px;
        overflow-y: auto;
      }
      .plan-sidebar-todo-result-title {
        font-weight: 600;
        margin-bottom: 2px;
        color: #0f172a;
      }
      .plan-sidebar-todo-result-content {
        white-space: pre-wrap;
        display: -webkit-box;
        -webkit-line-clamp: 5;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .plan-sidebar-todo-result:hover .plan-sidebar-todo-result-content {
        -webkit-line-clamp: initial;
      }
      .plan-sidebar-actions {
        padding-top: 16px;
        margin-top: auto;
      }
      .plan-sidebar-complete {
        text-align: center;
        font-size: 16px;
        font-weight: 700;
        color: #059669;
        padding: 16px;
        background: linear-gradient(135deg, rgba(16, 185, 129, 0.15), rgba(16, 185, 129, 0.05));
        border-radius: 12px;
        border: 1px solid rgba(16, 185, 129, 0.3);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.4);
      }
      .plan-sidebar-approve-btn {
        width: 100%;
        padding: 14px 20px;
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 10px;
        background: linear-gradient(135deg, var(--ok) 0%, var(--ok-muted) 100%);
        color: #ffffff;
        font-size: 15px;
        font-weight: 700;
        cursor: pointer;
        transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
        letter-spacing: 0.02em;
        box-shadow:
          0 4px 15px rgba(16, 185, 129, 0.25),
          inset 0 1px 0 rgba(255, 255, 255, 0.2);
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
      }
      .plan-sidebar-approve-btn:hover {
        background: linear-gradient(135deg, #059669 0%, #047857 100%);
        box-shadow:
          0 6px 20px rgba(16, 185, 129, 0.35),
          inset 0 1px 0 rgba(255, 255, 255, 0.2);
        transform: translateY(-2px);
      }
      .plan-sidebar-approve-btn:active {
        transform: translateY(1px);
        box-shadow: 0 2px 8px rgba(16, 185, 129, 0.2);
      }
      .plan-sidebar-approve-btn::before {
        content: "⚡";
        font-size: 16px;
      }

      /* ---- Subagent Cards ---- */
      .subagent-list {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .subagent-card {
        position: relative;
        padding: 14px 16px;
        border-radius: 10px;
        border: 1px solid var(--border-color, rgba(226, 232, 240, 0.8));
        background: var(--surface-1, rgba(255, 255, 255, 0.9));
        transition: all 0.3s ease;
        overflow: hidden;
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.03);
      }
      :host-context([data-theme="dark"]) .subagent-card {
        background: rgba(30, 41, 59, 0.7);
        border-color: rgba(51, 65, 85, 0.8);
      }
      .subagent-card--active {
        border-color: rgba(99, 102, 241, 0.5);
        background: linear-gradient(to bottom right, rgba(255, 255, 255, 0.9), rgba(248, 250, 252, 0.9));
        box-shadow: 0 4px 12px rgba(99, 102, 241, 0.12);
        transform: translateY(-1px);
      }
      :host-context([data-theme="dark"]) .subagent-card--active {
        background: linear-gradient(to bottom right, rgba(30, 41, 59, 0.9), rgba(15, 23, 42, 0.9));
      }
      .subagent-card--idle {
        opacity: 0.8;
        background: var(--surface-2, rgba(248, 250, 252, 0.6));
      }
      .subagent-card__header {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 14px;
      }
      .subagent-card__icon {
        flex-shrink: 0;
        font-size: 16px;
      }
      .subagent-card__name {
        font-weight: 700;
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--text-color);
        letter-spacing: -0.01em;
      }
      .subagent-card__status {
        font-size: 11px;
        padding: 3px 8px;
        border-radius: 6px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .subagent-card--active .subagent-card__status {
        background: linear-gradient(135deg, rgba(99, 102, 241, 0.15), rgba(99, 102, 241, 0.05));
        color: #4f46e5;
        border: 1px solid rgba(99, 102, 241, 0.2);
      }
      :host-context([data-theme="dark"]) .subagent-card--active .subagent-card__status {
        color: #818cf8;
      }
      .subagent-card--idle .subagent-card__status {
        background: var(--surface-3, rgba(226, 232, 240, 0.6));
        color: var(--muted-color, #64748b);
        border: 1px solid transparent;
      }

      .subagent-card__task {
        font-size: 12px;
        color: var(--text-color);
        margin-top: 4px;
        line-height: 1.4;
      }
      .subagent-card__meta {
        display: flex;
        gap: 6px;
        margin-top: 6px;
        flex-wrap: wrap;
      }
      .subagent-card__chip {
        font-size: 10px;
        padding: 2px 6px;
        border-radius: 4px;
        background: var(--surface-2, #f1f5f9);
        color: var(--muted-color, #64748b);
      }
      .subagent-card__pulse {
        position: absolute;
        bottom: 0;
        left: 0;
        right: 0;
        height: 2px;
        background: linear-gradient(90deg, transparent, #818cf8, transparent);
        animation: subagentPulse 1.5s ease infinite;
      }
      @keyframes subagentPulse {
        0% {
          transform: translateX(-100%);
        }
        100% {
          transform: translateX(100%);
        }
      }

      /* ---- Completion Celebration ---- */
      .chat-plan-sticky--complete {
        border: 1px solid rgba(16, 185, 129, 0.4);
        animation: stickyGlow 2s ease infinite;
      }
      @keyframes stickyGlow {
        0%,
        100% {
          box-shadow:
            0 0 8px rgba(16, 185, 129, 0.25),
            inset 0 0 0 1px rgba(16, 185, 129, 0.2);
        }
        50% {
          box-shadow:
            0 0 20px rgba(16, 185, 129, 0.5),
            inset 0 0 0 1px rgba(16, 185, 129, 0.4);
        }
      }
      .chat-plan-confetti {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        height: 100%;
        pointer-events: none;
        overflow: hidden;
        border-radius: inherit;
      }
      .chat-confetti-piece {
        position: absolute;
        top: -10px;
        left: calc(var(--x, 50) * 1%);
        width: 8px;
        height: 8px;
        border-radius: 4px;
        background: var(--color, #818cf8);
        opacity: 0;
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
        animation: chatConfettiFall 2.5s cubic-bezier(0.25, 0.46, 0.45, 0.94) var(--delay, 0s) forwards;
      }
      @keyframes chatConfettiFall {
        0% {
          opacity: 0;
          transform: translateY(-10px) rotate(0deg) scale(0.5);
        }
        10% {
          opacity: 1;
          transform: translateY(10px) rotate(30deg) scale(1.2);
        }
        100% {
          opacity: 0;
          transform: translateY(80px) rotate(720deg) scale(0.8);
        }
      }

      /* ---- Message Animations ---- */
      .chat-bubble--anim-enter {
        animation: messagePop 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        opacity: 0;
        transform-origin: bottom left;
      }
      @keyframes messagePop {
        0% {
          opacity: 0;
          transform: translateY(12px) scale(0.98);
        }
        100% {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
      }

      /* ---- Tenant Agent Selector ---- */
      .agent-selector-bar {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.4rem 0.75rem;
        border-bottom: 1px solid var(--border, #262626);
        background: var(--bg-elevated, #141414);
        font-size: 0.8rem;
      }
      .agent-selector-bar label {
        color: var(--text-secondary, #a3a3a3);
        white-space: nowrap;
      }
      .agent-selector-bar select {
        flex: 1;
        max-width: 280px;
        padding: 0.3rem 0.5rem;
        background: var(--bg, #0a0a0a);
        border: 1px solid var(--border, #262626);
        border-radius: var(--radius-md, 6px);
        color: var(--text, #e5e5e5);
        font-size: 0.8rem;
        outline: none;
        cursor: pointer;
      }
      .agent-selector-bar select:focus {
        border-color: var(--accent, #3b82f6);
      }
    `,
  ];

  private _renderAgentSelector() {
    const agents = this.props?.tenantAgents;
    if (!agents || agents.length === 0) {
      return nothing;
    }

    // Extract current agent from sessionKey (format: "agent:{agentId}:{session}")
    const keyMatch = this.props.sessionKey?.match(/^agent:([^:]+)/);
    const currentAgentId = keyMatch?.[1] ?? "";

    return html`
      <div class="agent-selector-bar">
        <label>Agent:</label>
        <select
          .value=${currentAgentId}
          @change=${(e: Event) => {
            const agentId = (e.target as HTMLSelectElement).value;
            if (agentId) {
              this.props.onSessionKeyChange(`agent:${agentId}:chat`);
            }
          }}
        >
          <option value="" ?selected=${!currentAgentId}>选择 Agent...</option>
          ${agents.map(
            (a) => html`
              <option value=${a.agentId} ?selected=${a.agentId === currentAgentId}>
                ${a.name || a.agentId}
              </option>
            `,
          )}
        </select>
      </div>
    `;
  }

  private _renderStickyPlanBar() {
    const plan = this.props?.taskPlan;
    if (!plan || !plan.todos || plan.todos.length === 0) {
      return nothing;
    }
    const done = plan.todos.filter((t: { status: string }) => t.status === "done").length;
    const total = plan.todos.length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const allDone = done === total;
    const phase = plan.phase || "execution";

    const phaseSteps = [
      { key: "planning", icon: "📝", label: "PLANNING" },
      { key: "execution", icon: "🔄", label: "EXECUTION" },
      { key: "verification", icon: "✅", label: "VERIFICATION" },
    ];

    return html`
      <div class="chat-plan-sticky ${allDone ? "chat-plan-sticky--complete" : ""}">
        <span class="chat-plan-sticky__icon">${allDone ? "🎉" : "📋"}</span>
        <span class="chat-plan-sticky__desc">${plan.description || "Task Plan"}</span>
        <div class="chat-plan-sticky__phases">
          ${phaseSteps.map(
            (s) => html`
              <span class="chat-plan-phase ${phase === s.key ? "chat-plan-phase--active" : ""} ${phase === "complete" && s.key === "verification" ? "chat-plan-phase--active" : ""}">
                ${s.icon} ${s.label}
              </span>
            `,
          )}
        </div>
        <span class="chat-plan-sticky__stats">${done}/${total} (${pct}%)</span>
        <div class="chat-plan-sticky__bar">
          <div
            class="chat-plan-sticky__fill ${allDone ? "chat-plan-sticky__fill--done" : ""}"
            style="width: ${pct}%"
          ></div>
        </div>
        ${
          allDone
            ? html`
              <div class="chat-plan-confetti">
                ${Array.from(
                  { length: 12 },
                  (_, i) =>
                    html`<span class="chat-confetti-piece" style="--i:${i}; --x:${Math.random() * 100}; --delay:${Math.random() * 2}s; --color:${["#818cf8", "#10b981", "#f59e0b", "#ef4444", "#ec4899", "#06b6d4"][i % 6]}"></span>`,
                )}
              </div>
            `
            : nothing
        }
      </div>
    `;
  }

  /** Renders the plan sidebar when in PLANNING phase (or when plan data exists for review) */
  private _renderPlanSidebar() {
    const plan = this.props?.taskPlan;
    if (!plan || !plan.todos || plan.todos.length === 0) {
      return nothing;
    }
    const phase = plan.phase || "execution";
    const isPlanning = phase === "planning";
    const done = plan.todos.filter((t: { status: string }) => t.status === "done").length;
    const total = plan.todos.length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;

    return html`
      <div class="plan-sidebar-panel">
        <div class="plan-sidebar-header">
          <span class="plan-sidebar-title">📋 Implementation Plan</span>
          <span class="plan-sidebar-phase plan-sidebar-phase--${phase}">${phase.toUpperCase()}</span>
        </div>

        ${plan.description ? html`<div class="plan-sidebar-desc">${plan.description}</div>` : nothing}

        <div class="plan-sidebar-progress">
          <div class="plan-sidebar-progress-row">
            <span>Progress Execution</span>
            <span>${done}/${total} (${pct}%)</span>
          </div>
          <div class="plan-sidebar-bar">
            <div class="plan-sidebar-fill" style="width: ${pct}%; background: ${done === total && total > 0 ? "linear-gradient(90deg, var(--ok), var(--ok-muted, #6ee7b7))" : "linear-gradient(90deg, var(--accent), var(--accent-3, #22d3ee))"};"></div>
          </div>
        </div>

        <div class="plan-sidebar-todos">
          ${plan.todos.map(
            (t: { id: string; title: string; status: string; result?: string }) => html`
              <div class="plan-sidebar-todo-container">
                <div class="plan-sidebar-todo plan-sidebar-todo--${t.status}">
                  <span class="plan-sidebar-todo-icon">${t.status === "done" ? "✅" : t.status === "in_progress" ? "🔄" : "⏳"}</span>
                  <span class="plan-sidebar-todo-text">${t.title}</span>
                </div>
                ${
                  t.status === "done" && t.result
                    ? html`
                      <div class="plan-sidebar-todo-result">
                        <div class="plan-sidebar-todo-result-title">↳ 输出结果摘要</div>
                        <div class="plan-sidebar-todo-result-content">${t.result}</div>
                      </div>
                    `
                    : nothing
                }
              </div>
            `,
          )}
        </div>

        ${
          isPlanning && this.props.onApprovePlan
            ? html`
              <div class="plan-sidebar-actions">
                <button
                  class="plan-sidebar-approve-btn"
                  @click=${() => this.props.onApprovePlan?.()}
                >
                  Approve and Execute
                </button>
              </div>
            `
            : done === total && total > 0
              ? html`
                  <div class="plan-sidebar-actions plan-sidebar-complete">🎉 任务全部完成！</div>
                `
              : nothing
        }
      </div>
    `;
  }

  /** Renders subagent processing details during EXECUTION/VERIFICATION phases */
  private _renderSubagentPanel() {
    const sessions = this.props?.sandboxSessions;
    if (!sessions || sessions.length === 0) {
      return nothing;
    }
    const phase = this.props?.taskPlan?.phase || "execution";

    return html`
      <div class="plan-sidebar-panel">
        <div class="plan-sidebar-header">
          <span class="plan-sidebar-title">🦞 帝国花名册 (Lobster Roster)</span>
          <span class="plan-sidebar-phase plan-sidebar-phase--${phase}">${phase.toUpperCase()}</span>
        </div>

        <div class="subagent-list">
          ${sessions.map((row) => {
            const isWorking = Boolean(row.outputTokens && row.outputTokens > 0);
            const tokens = (row.totalTokens ?? 0).toLocaleString();
            const statusClass = isWorking ? "subagent-card--active" : "subagent-card--idle";
            const statusText = isWorking ? "🔥输出中" : "🏖️摸鱼中";
            const statusIcon = isWorking ? "🦞" : "💤";

            return html`
              <div class="subagent-card ${statusClass}">
                <div class="subagent-card__header">
                  <span class="subagent-card__icon">${statusIcon}</span>
                  <span class="subagent-card__name">${row.label || row.key.slice(0, 14)}</span>
                  <span class="subagent-card__status">${statusText}</span>
                </div>
                ${row.subject ? html`<div class="subagent-card__task">📋 ${row.subject}</div>` : nothing}
                <div class="subagent-card__meta">
                  ${row.model ? html`<span class="subagent-card__chip">🤖 ${row.model}</span>` : nothing}
                  ${row.outputTokens ? html`<span class="subagent-card__chip">⚡ ${tokens} tokens</span>` : nothing}
                </div>
                ${
                  isWorking
                    ? html`
                        <div class="subagent-card__pulse"></div>
                      `
                    : nothing
                }
              </div>
            `;
          })}
        </div>

        ${this._renderPlanSidebar()}
      </div>
    `;
  }

  render() {
    if (!this.props) {
      return nothing;
    }

    const toolSidebarOpen = Boolean(this.props.sidebarOpen && this.props.onCloseSidebar);
    const planPhase = this.props?.taskPlan?.phase;
    const hasPlanData = (this.props.taskPlan?.todos?.length ?? 0) > 0;

    // Determine active sessions, excluding the main orchestrator agent
    const activeWorkers = (this.props.sandboxSessions ?? []).filter(
      (r) => r.kind !== "global" && !r.systemSent,
    );

    // Sidebar conditions
    const hasPlanSidebar = planPhase === "planning" && hasPlanData;
    const hasSubagentSidebar =
      activeWorkers.length > 0 ||
      ((planPhase === "execution" || planPhase === "verification" || planPhase === "complete") &&
        hasPlanData);

    // Determine if sidebar should be open and what type
    const sidebarOpen = toolSidebarOpen || hasPlanSidebar || hasSubagentSidebar;
    const splitRatio = this.props.splitRatio ?? 0.6;

    return html`
      <section class="chat">
        ${this.props.error ? html`<div class="callout danger">${this.props.error}</div>` : nothing}

        ${
          this.props.focusMode
            ? html`
          <button
            class="chat-focus-exit"
            type="button"
            @click=${this.props.onToggleFocusMode}
            aria-label="Exit focus mode"
            title="Exit focus mode"
          >
            ${icons.x}
          </button>
        `
            : nothing
        }

        <div class="chat-split-container ${sidebarOpen ? "chat-split-container--open" : ""}">
          <div class="chat-main" style="flex: ${sidebarOpen ? `0 0 ${splitRatio * 100}%` : "1 1 100%"}">
            ${this._renderStickyPlanBar()}
            
            <div 
              class="chat-thread" 
              role="log" 
              aria-live="polite"
              @scroll=${this.props.onChatScroll}
            >
              ${
                this.props.messages && this.props.messages.length > 0
                  ? html`
                      <slot name="messages"></slot>
                    `
                  : this.props.disabledReason
                    ? html`
                    <div class="chat-empty-state">
                      <div class="chat-empty-logo">
                        <div class="chat-empty-logo-circle" style="background:var(--color-warning,#f59e0b);color:#fff">!</div>
                      </div>
                      <h2 class="chat-empty-title">暂无可用 Agent</h2>
                      <p class="chat-empty-subtitle">${this.props.disabledReason}</p>
                    </div>
                  `
                    : html`
                    <div class="chat-empty-state">
                      <div class="chat-empty-logo">
                        <div class="chat-empty-logo-crown">
                          <span class="crown-dot"></span>
                          <span class="crown-dot crown-dot--mid"></span>
                          <span class="crown-dot"></span>
                        </div>
                        <div class="chat-empty-logo-circle">O</div>
                      </div>
                      <h2 class="chat-empty-title">${t("chat.emptyTitle")}</h2>
                      <p class="chat-empty-subtitle">${t("chat.emptySubtitle")}</p>
                    </div>
                  `
              }
            </div>

            <div class="chat-input-wrapper">
              <chat-input-area
                .draft=${this.props.draft}
                .connected=${this.props.connected}
                .disabledHint=${this.props.disabledReason ?? ""}
                .sending=${this.props.sending}
                .canAbort=${Boolean(this.props.canAbort && this.props.onAbort)}
                .attachments=${this.props.attachments ?? []}
                @draft-change=${(e: CustomEvent) => this.props.onDraftChange(e.detail.draft)}
                @attachments-change=${(e: CustomEvent) => this.props.onAttachmentsChange?.(e.detail.attachments)}
                @send=${() => this.props.onSend()}
                @abort=${() => this.props.onAbort?.()}
                @new-session=${() => this.props.onNewSession()}
              ></chat-input-area>
            </div>
          </div>

          ${
            sidebarOpen
              ? html`
            <resizable-divider
              .splitRatio=${splitRatio}
              @resize=${(e: CustomEvent) => this.props.onSplitRatioChange?.(e.detail.splitRatio)}
            ></resizable-divider>
            <div class="chat-sidebar">
              ${
                toolSidebarOpen
                  ? renderMarkdownSidebar({
                      content: this.props.sidebarContent ?? null,
                      error: this.props.sidebarError ?? null,
                      onClose: this.props.onCloseSidebar ?? (() => {}),
                      onViewRawText: () => {
                        if (!this.props.sidebarContent || !this.props.onOpenSidebar) {
                          return;
                        }
                        this.props.onOpenSidebar(`\`\`\`\n${this.props.sidebarContent}\n\`\`\``);
                      },
                    })
                  : hasSubagentSidebar
                    ? this._renderSubagentPanel()
                    : this._renderPlanSidebar()
              }
            </div>
          `
              : nothing
          }
        </div>
      </section>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "chat-layout": ChatLayout;
  }
}
