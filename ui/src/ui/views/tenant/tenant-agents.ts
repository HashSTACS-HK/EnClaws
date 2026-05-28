/**
 * Tenant agent management view.
 *
 * Create, edit, and delete AI agents independently from channels.
 * Configure name, system prompt, model binding, and tool permissions.
 *
 * Layout: sidebar (agent list) + main (detail / edit form), matching the
 * global agents page style.
 */

import { html, css, LitElement, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { customElement, state, property } from "lit/decorators.js";
import { t, i18n, I18nController } from "../../../i18n/index.ts";
import { tenantRpc, quotaErrorKey } from "./rpc.ts";
import { pathForTab, inferBasePathFromPathname } from "../../navigation.ts";
import { invalidateTenantAgentsCache } from "../../app-render.ts";
import { showConfirm } from "../../components/confirm-dialog.ts";
import { CHANNEL_ICON_MAP } from "../../../constants/channels.ts";
import { DEFAULT_CRON_FORM } from "../../app-defaults.ts";
import {
  buildCronSchedule,
  buildCronPayload,
  buildFailureAlert,
  validateCronForm,
  hasCronFormErrors,
  normalizeCronFormState,
} from "../../controllers/cron.ts";
import type { CronFieldErrors } from "../../controllers/cron.ts";
import type { CronFormState } from "../../ui-types.ts";
import type { CronJob } from "../../types.ts";
import { formatRelativeTimestamp } from "../../format.ts";
import { formatCronSchedule, formatNextRun } from "../../presenter.ts";
import { caretFix } from "../../shared-styles.ts";
import {
  TOOL_GROUP_DEFS,
  ALL_TOOL_IDS,
  GROUP_LABEL_KEY,
  TOOL_LABEL_KEY,
  TOOL_DESC_KEY,
} from "../tool-group-defs.ts";
import { SKILL_LABEL_KEY, SKILL_DESC_KEY } from "../skill-defs.ts";
import { renderAgentKnowledge } from "../agents-panels-knowledge.ts";
import type {
  AgentFileEntry,
  AgentsMemoryGetResult,
  AgentsMemoryListResult,
  AgentsMemorySetResult,
  AgentsMemoryStatusResult,
} from "../../types.ts";


interface ModelConfigEntry {
  providerId: string;
  modelId: string;
  isDefault: boolean;
}

interface FlatModelOption {
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
}

interface TenantModelOption {
  id: string;
  providerType: string;
  providerName: string;
  models: Array<{ id: string; name: string }>;
}

interface TenantAgent {
  agentId: string;
  name: string | null;
  config: Record<string, unknown>;
  modelConfig?: ModelConfigEntry[];
  channelAppId?: string | null;
  isActive: boolean;
  createdAt: string;
}

interface ToolDef {
  id: string;
  label: string;
  description: string;
}

interface ToolGroup {
  id: string;
  label: string;
  tools: ToolDef[];
}

interface AgentChannelInfo {
  channelType: string;
  channelName: string | null;
  appId: string;
  botName: string;
  isActive: boolean;
  connected: boolean;
}

const DEFAULT_SYSTEM_PROMPT = "";

type SkillEntry = { name: string; description: string; emoji?: string; source: string; disabled: boolean; always: boolean };
type SkillCategory = { label: string; skills: SkillEntry[] };

function bundledSkillCategories(skills: SkillEntry[]): SkillCategory[] {
  const defs: Array<{ labelKey: string; match: (n: string) => boolean }> = [
    { labelKey: "tenantSkills.skillCatFeishu",     match: (n) => n.startsWith("feishu-") },
    { labelKey: "tenantSkills.skillCatMemory",     match: (n) => n === "memory-manager" },
    { labelKey: "tenantSkills.skillCatSessions",   match: (n) => n === "session-logs" },
    { labelKey: "tenantSkills.skillCatRuntime",    match: (n) => ["coding-agent", "healthcheck", "pingtest"].includes(n) },
    { labelKey: "tenantSkills.skillCatAutomation", match: (n) => ["skill-creator", "mcporter"].includes(n) },
    { labelKey: "tenantSkills.skillCatWeb",        match: (n) => n === "weather" },
  ];
  const groups = defs.map((d) => ({ label: t(d.labelKey), skills: [] as SkillEntry[], match: d.match }));
  const other: SkillCategory = { label: t("tenantSkills.skillCatOther"), skills: [] };
  for (const s of skills) {
    const g = groups.find((x) => x.match(s.name));
    (g ?? other).skills.push(s);
  }
  return [...groups.filter((g) => g.skills.length > 0), ...(other.skills.length ? [other] : [])];
}

@customElement("tenant-agents-view")
export class TenantAgentsView extends LitElement {
  private i18nCtrl = new I18nController(this);

  static styles = [caretFix, css`
    :host {
      display: block; padding: 1.5rem; color: var(--text, #e5e5e5);
      font-family: var(--font-sans, system-ui, sans-serif);
    }

    /* ── Layout: sidebar + main ── */
    .layout {
      display: grid;
      grid-template-columns: minmax(220px, 280px) minmax(0, 1fr);
      gap: 1rem;
    }
    .sidebar {
      align-self: start;
      background: var(--card, #141414);
      border: 1px solid var(--border, #262626);
      border-radius: var(--radius, 8px);
      padding: 1.25rem;
    }
    .sidebar-header {
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 1rem;
    }
    .sidebar-count { font-size: 0.82rem; color: var(--text-secondary, #a3a3a3); }
    .main { display: grid; gap: 1rem; align-self: start; }

    /* ── Agent list ── */
    .agent-list { display: grid; gap: 0.6rem; }
    .agent-row {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center; gap: 12px;
      width: 100%; text-align: left;
      border: 1px solid var(--border, #262626);
      border-radius: var(--radius-md, 6px);
      background: var(--card, #141414);
      padding: 10px 12px;
      cursor: pointer;
      transition: border-color 0.15s;
    }
    .agent-row:hover { border-color: var(--text-muted, #525252); }
    .agent-row.active { border-color: var(--accent, #3b82f6); box-shadow: 0 0 0 1px rgba(59,130,246,0.3); }
    .agent-avatar {
      width: 32px; height: 32px; border-radius: 50%;
      background: var(--bg, #1a1a1a);
      display: grid; place-items: center;
      font-weight: 600;
    }
    .agent-info { display: grid; gap: 2px; min-width: 0; }
    .agent-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .agent-sub { color: var(--text-muted, #525252); font-size: 12px; font-family: monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .status-dot {
      display: inline-block; width: 7px; height: 7px;
      border-radius: 50%; flex-shrink: 0;
    }
    .status-dot.active { background: #22c55e; box-shadow: 0 0 6px #22c55e88; }
    .status-dot.inactive { background: #525252; }

    /* ── Buttons ── */
    .btn {
      padding: 0.45rem 0.9rem; border: none; border-radius: var(--radius-md, 6px);
      font-size: 0.85rem; cursor: pointer; transition: opacity 0.15s;
    }
    .btn:hover { opacity: 0.85; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-primary { background: var(--accent, #3b82f6); color: white; }
    .btn-danger { background: var(--bg-destructive, #7f1d1d); color: var(--text-destructive, #fca5a5); }
    .btn-outline { background: transparent; border: 1px solid var(--border, #262626); color: var(--text, #e5e5e5); }
    .btn-sm { padding: 0.3rem 0.6rem; font-size: 0.8rem; }
    .btn-full { width: 100%; }

    /* ── Tabs ── */
    .agent-tabs {
      display: flex; gap: 0.5rem; flex-wrap: wrap;
      margin-bottom: 1rem;
    }
    .agent-tab {
      border: 1px solid var(--border, #262626);
      border-radius: 9999px;
      padding: 0.35rem 0.85rem;
      font-size: 0.75rem; font-weight: 600;
      background: var(--bg, #0a0a0a);
      color: var(--text, #e5e5e5);
      cursor: pointer;
      transition: border-color 0.15s, background 0.15s;
    }
    .agent-tab:hover { border-color: var(--accent, #3b82f6); }
    .agent-tab.active {
      background: var(--accent, #3b82f6);
      border-color: var(--accent, #3b82f6);
      color: white;
    }

    /* ── Detail panel ── */
    .detail-card {
      background: var(--card, #141414); border: 1px solid var(--border, #262626);
      border-radius: var(--radius, 8px); padding: 1.25rem;
    }
    .card {
      background: var(--card, #141414); border: 1px solid var(--border, #262626);
      border-radius: var(--radius, 8px); padding: 1.25rem;
    }
    .card-title { font-size: 15px; font-weight: 600; color: var(--text, #e5e5e5); }
    .card-sub { color: var(--text-muted, #525252); font-size: 13px; line-height: 1.5; }
    .row { display: flex; align-items: center; gap: 8px; }
    .muted { color: var(--text-muted, #525252); }
    .mono { font-family: monospace; }
    .btn--sm { padding: 0.3rem 0.6rem; font-size: 0.8rem; }
    .btn--primary { background: var(--accent, #3b82f6); color: white; }
    .btn--icon {
      width: 32px; height: 32px; padding: 0; display: inline-grid; place-items: center;
    }
    .danger { color: var(--text-destructive, #fca5a5); }
    .input {
      width: 100%; padding: 0.45rem 0.65rem; background: var(--bg, #0a0a0a);
      border: 1px solid var(--border, #262626); border-radius: var(--radius-md, 6px);
      color: var(--text, #e5e5e5); font-size: 0.85rem; outline: none; box-sizing: border-box;
    }
    .list { display: grid; gap: 8px; }
    .list-item {
      display: flex; justify-content: space-between; gap: 12px;
      padding: 0.7rem 0.8rem; border: 1px solid var(--border, #262626);
      border-radius: var(--radius-md, 6px); background: var(--bg, #0a0a0a);
    }
    .list-item.clickable { cursor: pointer; }
    .list-item.clickable:hover, .list-item.active { border-color: var(--accent, #3b82f6); }
    .list-main { min-width: 0; display: grid; gap: 2px; }
    .list-title { font-size: 0.85rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .list-sub { font-size: 0.75rem; color: var(--text-muted, #525252); }
    .stat-grid { display: grid; gap: 0.85rem; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
    .stat { padding: 0.75rem; background: var(--bg, #0a0a0a); border: 1px solid var(--border, #262626); border-radius: var(--radius-md, 6px); }
    .stat-label { color: var(--text-muted, #525252); font-size: 0.75rem; }
    .stat-value { margin-top: 4px; font-size: 1.1rem; font-weight: 600; }
    .callout { padding: 0.65rem 0.75rem; border-radius: var(--radius-md, 6px); font-size: 0.85rem; }
    .callout.danger { background: var(--bg-destructive, #2d1215); border: 1px solid var(--border-destructive, #7f1d1d); }
    .detail-header {
      display: flex; justify-content: space-between; align-items: center;
    }
    .detail-header-left { display: flex; align-items: center; gap: 0.75rem; }
    .detail-name { font-size: 1.05rem; font-weight: 600; }
    .detail-id { font-size: 0.75rem; color: var(--text-muted, #525252); font-family: monospace; margin-top: 2px; }
    .detail-actions { display: flex; align-items: center; gap: 0.5rem; }
    .agent-avatar-lg {
      width: 48px; height: 48px; border-radius: 50%;
      background: var(--bg, #0a0a0a);
      display: grid; place-items: center;
      font-weight: 600; font-size: 1.2rem;
    }

    /* ── KV grid (matches agents page) ── */
    .overview-grid {
      display: grid; gap: 0.85rem;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      margin-bottom: 1rem;
    }
    .kv { display: grid; gap: 0.3rem; min-width: 0; }
    .kv .label { font-size: 0.75rem; color: var(--text-muted, #525252); }
    .kv .value { font-size: 0.85rem; overflow-wrap: anywhere; word-break: break-word; }
    .kv .value.mono { font-family: monospace; font-size: 0.8rem; }

    /* ── Model select section ── */
    .model-section { display: grid; gap: 0.75rem; }
    .model-section .label { font-size: 0.75rem; color: var(--text-muted, #525252); font-weight: 600; }
    /* ── Channel list ── */
    .channel-list {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 0.6rem;
    }
    .channel-item {
      display: grid; grid-template-columns: auto 1fr auto;
      align-items: center; gap: 0.75rem;
      padding: 0.75rem 0.85rem;
      background: var(--bg, #0a0a0a);
      border: 1px solid var(--border, #262626);
      border-radius: var(--radius-md, 6px);
    }
    .channel-item.channel-link { cursor: pointer; }
    .channel-item.channel-link:hover { border-color: var(--accent, #3b82f6); }
    .channel-type-icon {
      display: flex; align-items: center; flex-shrink: 0;
    }
    .channel-type-icon img { width: 24px; height: 24px; object-fit: contain; }
    .channel-type-letter {
      width: 24px; height: 24px; border-radius: 50%;
      background: var(--border, #262626); color: var(--text-secondary, #a3a3a3);
      display: grid; place-items: center; font-size: 0.7rem; font-weight: 600;
    }
    .channel-item-info { display: grid; gap: 3px; min-width: 0; }
    .channel-item-row1 { display: flex; align-items: center; gap: 0.4rem; font-size: 0.82rem; }
    .channel-item-type { font-weight: 600; }
    .channel-item-name { color: var(--text-secondary, #a3a3a3); }
    .channel-item-row2 { font-size: 0.75rem; color: var(--text-muted, #525252); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .conn-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .conn-dot.online { background: #22c55e; box-shadow: 0 0 6px #22c55e88; }
    .conn-dot.offline { background: #525252; }

    /* ── Help icon tooltip ── */
    .help-icon {
      display: inline-flex; align-items: center; justify-content: center;
      width: 14px; height: 14px; border-radius: 50%;
      border: 1px solid var(--text-muted, #525252);
      font-size: 0.6rem; color: var(--text-muted, #525252);
      cursor: default;
    }
    .help-icon:hover { color: var(--text, #e5e5e5); border-color: var(--text, #e5e5e5); }

    /* ── Model cards ── */
    .model-cards {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 0.6rem;
    }
    .model-card {
      display: flex; align-items: center; gap: 0.6rem;
      padding: 0.6rem 0.75rem;
      background: var(--bg, #0a0a0a);
      border: 1px solid var(--border, #262626);
      border-radius: var(--radius-md, 6px);
      cursor: pointer; transition: border-color 0.15s, background 0.15s;
      user-select: none;
    }
    .model-card:hover { border-color: var(--text-muted, #525252); }
    .model-card.selected {
      border-color: var(--accent, #3b82f6);
      background: rgba(59, 130, 246, 0.06);
    }
    .model-card-check {
      width: 16px; height: 16px; border-radius: 3px;
      border: 1.5px solid var(--border, #262626);
      display: grid; place-items: center; flex-shrink: 0;
      font-size: 0.65rem; color: transparent;
      transition: all 0.15s;
    }
    .model-card.selected .model-card-check {
      background: var(--accent, #3b82f6);
      border-color: var(--accent, #3b82f6);
      color: white;
    }
    .model-card-info { flex: 1; min-width: 0; }
    .model-card-name {
      font-size: 0.82rem; font-weight: 500;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .model-card-provider {
      font-size: 0.7rem; color: var(--text-muted, #525252);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .model-card-badge {
      font-size: 0.65rem; padding: 0.15rem 0.45rem;
      border-radius: 9999px; flex-shrink: 0;
      background: transparent; border: 1px solid var(--border, #262626);
      color: var(--text-muted, #525252); cursor: pointer;
      transition: all 0.15s;
    }
    .model-card-badge.is-default {
      background: var(--accent, #3b82f6);
      border-color: var(--accent, #3b82f6);
      color: white;
    }
    .model-card-badge.is-fallback {
      background: rgba(255,255,255,0.06);
      border-color: var(--text-muted, #525252);
      color: var(--text-secondary, #a3a3a3);
      cursor: pointer;
    }
    .model-card-badge.is-fallback:hover {
      border-color: var(--accent, #3b82f6);
      color: var(--accent, #3b82f6);
    }
    .model-actions {
      display: flex; justify-content: flex-end; gap: 0.5rem;
    }

    /* ── Messages ── */
    .error-msg {
      background: var(--bg-destructive, #2d1215); border: 1px solid var(--border-destructive, #7f1d1d);
      border-radius: var(--radius-md, 6px); color: var(--text-destructive, #fca5a5);
      padding: 0.5rem 0.75rem; font-size: 0.8rem; margin-bottom: 1rem;
    }
    .error-msg a { color: inherit; text-decoration: underline; font-weight: 600; }
    .error-msg a:hover { opacity: 0.85; }
    .success-msg {
      background: #052e16; border: 1px solid #166534; border-radius: var(--radius-md, 6px);
      color: #86efac; padding: 0.5rem 0.75rem; font-size: 0.8rem; margin-bottom: 1rem;
    }

    /* ── Form ── */
    .form-row { display: flex; gap: 0.75rem; margin-bottom: 0.75rem; }
    .form-field { flex: 1; }
    .form-field label { display: block; font-size: 0.8rem; margin-bottom: 0.3rem; color: var(--text-secondary, #a3a3a3); }
    .form-field input, .form-field select, .form-field textarea {
      width: 100%; padding: 0.45rem 0.65rem; background: var(--bg, #0a0a0a);
      border: 1px solid var(--border, #262626); border-radius: var(--radius-md, 6px);
      color: var(--text, #e5e5e5); font-size: 0.85rem; outline: none; box-sizing: border-box;
    }
    .form-field textarea { min-height: 80px; resize: vertical; font-family: inherit; }
    .form-field input:focus, .form-field select:focus, .form-field textarea:focus { border-color: var(--accent, #3b82f6); }
    .form-hint { font-size: 0.72rem; color: var(--text-muted, #525252); margin-top: 0.25rem; }
    .divider {
      display: flex; align-items: center; margin: 1rem 0; font-size: 0.75rem;
      color: var(--text-muted, #525252);
    }
    .divider::before, .divider::after { content: ""; flex: 1; border-top: 1px solid var(--border, #262626); }
    .divider span { padding: 0 0.75rem; }

    /* ── Model table ── */
    .model-select-table { width: 100%; border-collapse: collapse; font-size: 0.82rem; margin-top: 0.4rem; }
    .model-select-table th, .model-select-table td {
      text-align: left; padding: 0.35rem 0.45rem;
      border-bottom: 1px solid var(--border, #262626);
    }
    .model-select-table th { color: var(--text-secondary, #a3a3a3); font-weight: 500; }

    /* ── Tools section ── */
    .tools-section {
      margin-top: 0.75rem; border: 1px solid var(--border, #262626);
      border-radius: var(--radius-md, 6px); overflow: hidden;
    }
    .tools-header {
      display: flex; justify-content: space-between; align-items: center;
      padding: 0.5rem 0.65rem; background: var(--card, #141414); cursor: pointer;
      user-select: none; font-size: 0.8rem;
    }
    .tools-header:hover { background: var(--border, #262626); }
    .tools-header-left { display: flex; align-items: center; gap: 0.4rem; }
    .tools-header-arrow { font-size: 0.65rem; transition: transform 0.15s; }
    .tools-header-arrow.open { transform: rotate(90deg); }
    /* ── Tools & Skills panels (copied from platform agent) ── */
    .panel-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; flex-wrap: wrap; gap: 0.5rem; }
    .panel-header-left { display: flex; flex-direction: column; gap: 0.25rem; }
    .panel-title { font-size: 15px; font-weight: 600; letter-spacing: -0.02em; color: var(--text, #e5e5e5); }
    .panel-sub { color: var(--text-muted, #525252); font-size: 13px; line-height: 1.5; }
    .panel-sub .mono { font-family: monospace; }
    .panel-actions { display: flex; gap: 0.4rem; align-items: center; }
    .panel-filter { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem; }
    .panel-filter--inline { flex: 1 1 220px; min-width: 180px; margin-bottom: 0; }
    .panel-filter input {
      flex: 1; padding: 6px 10px; background: var(--bg, #0a0a0a);
      border: 1px solid var(--border, #262626); border-radius: var(--radius-md, 6px);
      color: var(--text, #e5e5e5); font-size: 13px; outline: none;
    }
    .panel-filter input:focus { border-color: var(--accent, #3b82f6); }
    .panel-filter .count { font-size: 13px; color: var(--text-muted, #525252); white-space: nowrap; }

    /* Tool grid (matches .agent-tools-grid / .agent-tools-section / .agent-tool-row) */
    .tools-grid { display: grid; gap: 16px; }
    .tools-section {
      border: 1px solid var(--border, #262626); border-radius: var(--radius-md, 6px);
      padding: 10px; background: var(--bg, #0a0a0a);
    }
    details.tools-section > summary { list-style: none; cursor: pointer; }
    details.tools-section > summary::-webkit-details-marker { display: none; }
    details.tools-section > summary::marker { content: ""; }
    details.tools-section[open] > .tools-list { margin-top: 10px; }
    .tools-section-header {
      font-weight: 600; font-size: 13px;
      display: flex; align-items: center; gap: 8px;
    }
    details.tools-section > .tools-section-header .tool-row-source { margin-left: auto; }
    details.tools-section > .tools-section-header .section-actions { display: inline-flex; gap: 6px; }
    .btn.btn-xs { padding: 2px 8px; font-size: 11px; line-height: 1.4; }
    details.tools-section > .tools-section-header::after {
      content: "\u25B8"; font-size: 12px; color: var(--text-muted, #525252);
      transition: transform 0.15s ease;
    }
    details.tools-section[open] > .tools-section-header::after { transform: rotate(90deg); }
    .tools-list { display: grid; gap: 8px 12px; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); }
    .tools-list--wide { grid-template-columns: 1fr; }
    .tools-list--wide .tool-row-desc { -webkit-line-clamp: unset; line-clamp: unset; display: block; white-space: normal; overflow: visible; text-overflow: clip; }
    .tool-row {
      display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 12px;
      padding: 8px 10px; border: 1px solid var(--border, #262626);
      border-radius: var(--radius-md, 6px); background: var(--card, #141414);
    }
    .tool-row-info { display: grid; gap: 2px; min-width: 0; }
    .tool-row-name { font-weight: 600; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tool-row-source { font-size: 11px; color: var(--text-muted, #525252); margin-left: 6px; opacity: 0.8; }
    .tool-row-desc {
      color: var(--text-muted, #525252); font-size: 12px; margin-top: 2px; line-height: 1.4;
      word-break: break-word;
      display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; line-clamp: 3;
      overflow: hidden; text-overflow: ellipsis;
    }

    /* Toggle switch (matches .cfg-toggle) */
    .cfg-toggle { position: relative; flex-shrink: 0; }
    .cfg-toggle input { position: absolute; opacity: 0; width: 0; height: 0; }
    .cfg-toggle__track {
      display: block; width: 50px; height: 28px;
      background: var(--bg-elevated); border: 1px solid var(--border-strong);
      border-radius: var(--radius-full); position: relative; cursor: pointer;
      transition: background var(--duration-normal) ease, border-color var(--duration-normal) ease;
    }
    .cfg-toggle__track::after {
      content: ""; position: absolute; top: 3px; left: 3px;
      width: 20px; height: 20px; border-radius: var(--radius-full);
      background: var(--text); box-shadow: var(--shadow-sm);
      transition: transform var(--duration-normal) var(--ease-out), background var(--duration-normal) ease;
    }
    .cfg-toggle input:checked + .cfg-toggle__track { background: var(--ok-subtle); border-color: rgba(34,197,94,0.4); }
    .cfg-toggle input:checked + .cfg-toggle__track::after { transform: translateX(22px); background: var(--ok); }
    .cfg-toggle--disabled { opacity: 0.45; cursor: not-allowed; }
    .cfg-toggle--disabled .cfg-toggle__track { cursor: not-allowed; }
    .tool-badge-platform-denied {
      display: inline-block; font-size: 11px; font-weight: 600; line-height: 1;
      padding: 2px 7px; border-radius: 3px; margin-left: 8px;
      color: var(--destructive, #ff4d4f); background: rgba(255,77,79,0.1); border: 1px solid rgba(255,77,79,0.25);
    }

    /* Skills groups — mirrors .tools-section / .tools-section-header style */
    /* Match the tool-panel style: flat details (no box), nesting conveyed
       purely by indentation, so top-level and sub-groups stay readable. */
    .skills-groups { display: grid; gap: 14px; }
    .skills-group { border: none; background: transparent; padding: 0; border-radius: 0; }
    .skills-group summary { list-style: none; cursor: pointer; }
    .skills-group summary::-webkit-details-marker { display: none; }
    .skills-group summary::marker { content: ""; }
    .skills-header {
      display: flex; align-items: center; gap: 8px;
      font-weight: 600; font-size: 13px; cursor: pointer;
    }
    .skills-header .skills-count { margin-left: auto; font-weight: 400; color: var(--text-muted, #525252); font-size: 11px; }
    .skills-header .section-actions { display: inline-flex; gap: 6px; }
    .skills-header::after {
      content: "\u25B8"; font-size: 12px; color: var(--text-muted, #525252);
      transition: transform 0.15s ease;
    }
    .skills-group[open] > .skills-header::after { transform: rotate(90deg); }
    /* Skill rows (matches .list-item / .list-main / .list-title / .list-sub) */
    .skills-grid { display: grid; grid-template-columns: 1fr; gap: 8px; }
    .skill-row {
      display: grid; grid-template-columns: minmax(0, 1fr) auto;
      gap: 16px; align-items: flex-start;
      border: 1px solid var(--border, #262626); border-radius: var(--radius-md, 6px);
      padding: 12px; background: var(--card, #141414);
      transition: border-color 0.15s;
    }
    .skill-row:hover { border-color: var(--border, #333); }
    .skill-info { display: grid; gap: 4px; min-width: 0; }
    .skill-name { font-weight: 500; font-size: 13px; }
    .skill-desc { color: var(--text-muted, #525252); font-size: 12px; }
    .chip-row { display: flex; gap: 6px; flex-wrap: wrap; }
    .chip {
      font-size: 11px; padding: 2px 8px; border-radius: 4px;
      background: var(--border, #262626); color: var(--text-secondary, #a3a3a3);
    }
    .chip-ok { background: rgba(34,197,94,0.15); color: #22c55e; }
    .chip-warn { background: rgba(239,68,68,0.15); color: #ef4444; }

    /* Form tools (edit mode) */
    .tools-body { padding: 0.5rem 0.65rem; }
    .tools-actions { display: flex; gap: 0.4rem; margin-bottom: 0.5rem; }
    .tools-form-group {
      margin: 0.5rem 0 0;
      border-top: 1px solid var(--border, #262626);
      padding-top: 0.35rem;
    }
    .tools-form-group:first-of-type { border-top: none; margin-top: 0; padding-top: 0; }
    .tools-form-group > summary { list-style: none; cursor: pointer; }
    .tools-form-group > summary::-webkit-details-marker { display: none; }
    .tools-form-group > summary::marker { content: ""; }
    .tools-form-group-body { display: grid; gap: 6px; margin-top: 6px; }
    .tools-group-header {
      display: flex; align-items: center; gap: 0.4rem;
    }
    .tools-group-header-label {
      font-size: 0.72rem; font-weight: 500; color: var(--text-secondary, #a3a3a3); flex: 1;
    }
    .tools-group-header-count { font-size: 0.68rem; color: var(--text-muted, #525252); }
    .tools-group-header::after {
      content: "\u25B8"; font-size: 11px; color: var(--text-muted, #525252);
      transition: transform 0.15s ease;
    }
    .tools-form-group[open] > .tools-group-header::after { transform: rotate(90deg); }
    .tools-group-checkbox { width: 13px; height: 13px; cursor: pointer; accent-color: var(--accent, #3b82f6); }
    .tool-toggle { width: 14px; height: 14px; cursor: pointer; accent-color: var(--accent, #3b82f6); }

    .empty { text-align: center; padding: 2rem; color: var(--text-muted, #525252); font-size: 0.85rem; }
    .loading { text-align: center; padding: 2rem; color: var(--text-muted, #525252); }

    /* ── Prompt preview ── */
    .prompt-preview {
      font-size: 0.8rem; color: var(--text-secondary, #a3a3a3);
      background: var(--bg, #0a0a0a); border-radius: var(--radius-md, 6px);
      padding: 0.75rem; margin-top: 0.5rem; white-space: pre-wrap;
      max-height: 120px; overflow-y: auto; line-height: 1.5;
    }
  `];

  @property({ type: String }) gatewayUrl = "";
  @state() private agents: TenantAgent[] = [];
  @state() private loading = false;
  @state() private errorKey = "";
  @state() private successKey = "";
  private msgParams: Record<string, string> = {};
  private msgTimer?: ReturnType<typeof setTimeout>;
  @property({ type: String, attribute: "initial-agent-id" }) initialAgentId: string | null = null;
  @property({ type: String, attribute: "initial-panel" }) initialPanel: string | null = null;
  @state() private selectedAgentId: string | null = null;
  @state() private activePanel: "overview" | "persona" | "files" | "tools" | "skills" | "channels" | "cron" | "knowledge" = "overview";
  @state() private showForm = false;
  @state() private inlineModelConfig: ModelConfigEntry[] | null = null;
  @state() private inlineModelSaving = false;
  @state() private agentChannels: AgentChannelInfo[] = [];
  @state() private channelsLoading = false;
  @state() private agentSkills: Array<{ name: string; description: string; emoji?: string; source: string; disabled: boolean; always: boolean }> = [];
  @state() private skillsLoading = false;
  @state() private toolsCatalogGroups: ToolGroup[] | null = null;
  @state() private toolsCatalogLoading = false;
  @state() private systemDenySet: Set<string> = new Set();
  @state() private editingAgentId: string | null = null;
  @state() private saving = false;
  @state() private availableModels: TenantModelOption[] = [];

  // Form fields
  @state() private formAgentId = "";
  @state() private formName = "";
  @state() private formSystemPrompt = DEFAULT_SYSTEM_PROMPT;
  @state() private formModelConfig: ModelConfigEntry[] = [];
  @state() private formToolsDeny: string[] = [];
  @state() private formToolsExpanded = false;
  @state() private formTimeoutMinutes: number | null = null;
  @state() private toolsFilter = "";
  @state() private toolsPendingDeny: string[] | null = null;
  @state() private toolsSaving = false;
  @state() private skillsFilter = "";
  @state() private skillsPendingEnabled: string[] | null = null;
  @state() private skillsSaving = false;
  @state() private formAgentIdManuallyEdited = false;

  // Persona file management state
  @state() private personaFilesLoading = false;
  @state() private personaFilesError: string | null = null;
  @state() private personaFilesList: Array<{ name: string; path: string; missing: boolean; size?: number; updatedAtMs?: number; defaultContent?: string }> = [];
  @state() private personaFilesWorkspace: string | null = null;
  @state() private personaFileActive: string | null = null;
  @state() private personaFileContents: Record<string, string> = {};
  @state() private personaFileDrafts: Record<string, string> = {};
  @state() private personaFileSaving = false;

  // Agent knowledge base state
  @state() private agentKnowledgeLoading = false;
  @state() private agentKnowledgeError: string | null = null;
  @state() private agentKnowledgeList: AgentsMemoryListResult | null = null;
  @state() private agentKnowledgeStatus: AgentsMemoryStatusResult | null = null;
  @state() private agentKnowledgeFileContents: Record<string, string> = {};
  @state() private agentKnowledgeFileDrafts: Record<string, string> = {};
  @state() private agentKnowledgeFileActive: string | null = null;
  @state() private agentKnowledgeSaving = false;

  // Cron panel state
  @state() private cronJobs: CronJob[] = [];
  @state() private cronLoading = false;
  @state() private cronLoaded = false;
  @state() private cronBusy = false;
  @state() private cronError: string | null = null;
  /** When true, render cronError via unsafeHTML (e.g. quota errors with upgrade links). */
  @state() private cronErrorIsHtml = false;
  @state() private cronModalVisible = false;
  @state() private cronModalEditingJobId: string | null = null;
  @state() private cronForm: CronFormState = { ...DEFAULT_CRON_FORM };
  @state() private cronFieldErrors: CronFieldErrors = {};
  @state() private cronRunLogExpanded = false;

  connectedCallback() {
    super.connectedCallback();
    this.loadAgents();
    this.loadModels();
    this.loadToolsCatalog();
  }

  private showError(key: string, params?: Record<string, string>) {
    this.errorKey = key;
    this.successKey = "";
    this.msgParams = params ?? {};
    if (this.msgTimer) {clearTimeout(this.msgTimer);}
    this.msgTimer = setTimeout(() => (this.errorKey = ""), 5000);
  }

  private showSuccess(key: string, params?: Record<string, string>) {
    this.successKey = key;
    this.errorKey = "";
    this.msgParams = params ?? {};
    if (this.msgTimer) {clearTimeout(this.msgTimer);}
    this.msgTimer = setTimeout(() => (this.successKey = ""), 5000);
  }

  private tr(key: string): string {
    const result = t(key, this.msgParams);
    return result === key ? key : result;
  }

  private rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return tenantRpc(method, params, this.gatewayUrl);
  }

  private toSlug(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "";
  }

  private async loadModels() {
    try {
      const result = await this.rpc("tenant.models.list") as { models: TenantModelOption[] };
      this.availableModels = (result.models ?? []).filter((m: any) => m.isActive !== false);
    } catch { /* non-critical */ }
  }

  private async loadToolsCatalog() {
    this.toolsCatalogLoading = true;
    try {
      const [catalogResult, sysToolsResult] = await Promise.all([
        this.rpc("tools.catalog", { includePlugins: true }) as Promise<{
          groups?: Array<{ id: string; label: string; tools: Array<{ id: string; label: string; description: string }> }>;
        }>,
        this.rpc("sys.tools.get").catch(() => ({ deny: [] })) as Promise<{ deny?: string[] }>,
      ]);
      if (catalogResult.groups?.length) {
        this.toolsCatalogGroups = catalogResult.groups.map((g) => ({
          id: g.id,
          label: g.label,
          tools: g.tools.map((tl) => ({ id: tl.id, label: tl.label, description: tl.description })),
        }));
      }
      this.systemDenySet = new Set(sysToolsResult.deny ?? []);
    } catch { /* fallback to hardcoded TOOL_GROUP_DEFS */ }
    finally { this.toolsCatalogLoading = false; }
  }

  private async loadSkillsForAgent(agentId: string) {
    this.skillsLoading = true;
    this.agentSkills = [];
    try {
      const result = await this.rpc("skills.status", { agentId }) as {
        skills: Array<{ name: string; description: string; emoji?: string; source: string; disabled: boolean; always: boolean }>;
      };
      this.agentSkills = result.skills ?? [];
    } catch { /* non-critical */ }
    finally { this.skillsLoading = false; }
  }

  private async loadChannelsForAgent(agentId: string) {
    this.channelsLoading = true;
    this.agentChannels = [];
    try {
      const result = await this.rpc("tenant.channels.list") as {
        channels: Array<{
          channelType: string;
          channelName: string | null;
          isActive: boolean;
          apps: Array<Record<string, any>>;
        }>;
      };
      const list: AgentChannelInfo[] = [];
      for (const ch of result.channels ?? []) {
        for (const app of ch.apps ?? []) {
          const appAgentId = app.agent?.agentId ?? app.agentId ?? null;
          if (appAgentId === agentId) {
            list.push({
              channelType: ch.channelType,
              channelName: ch.channelName,
              appId: app.appId ?? "",
              botName: (app.botName as string) ?? "",
              isActive: (app.isActive ?? true) && ch.isActive,
              connected: app.connectionStatus?.connected ?? false,
            });
          }
        }
      }
      this.agentChannels = list;
    } catch { /* non-critical */ }
    finally { this.channelsLoading = false; }
  }

  private async loadPersonaFiles(agentId: string) {
    this.personaFilesLoading = true;
    this.personaFilesError = null;
    try {
      const result = await this.rpc("agents.files.list", { agentId }) as {
        agentId: string; workspace: string;
        files: Array<{ name: string; path: string; missing: boolean; size?: number; updatedAtMs?: number }>;
      };
      this.personaFilesList = result.files ?? [];
      this.personaFilesWorkspace = result.workspace ?? null;
    } catch (err) {
      this.personaFilesError = String(err);
    } finally {
      this.personaFilesLoading = false;
    }
  }

  private resetKnowledgeState() {
    this.agentKnowledgeLoading = false;
    this.agentKnowledgeError = null;
    this.agentKnowledgeList = null;
    this.agentKnowledgeStatus = null;
    this.agentKnowledgeFileActive = null;
    this.agentKnowledgeFileContents = {};
    this.agentKnowledgeFileDrafts = {};
  }

  private normalizeKnowledgeFileName(raw: string): string | null {
    const clean = raw.trim().replace(/\\/g, "/");
    if (!clean) {return null;}
    if (clean === "MEMORY.md" || clean === "memory.md") {
      return clean;
    }
    const withoutPrefix = clean.startsWith("memory/") ? clean.slice("memory/".length) : clean;
    const safeName = withoutPrefix
      .split("/")
      .filter(Boolean)
      .map((part) => part.replace(/[^a-zA-Z0-9\-_.]/g, ""))
      .filter(Boolean)
      .join("/");
    if (!safeName) {return null;}
    const supported = [".md", ".txt", ".csv", ".docx", ".xlsx", ".pdf"];
    const hasSupportedExt = supported.some((ext) => safeName.toLowerCase().endsWith(ext));
    return `memory/${hasSupportedExt ? safeName : `${safeName}.md`}`;
  }

  private isEditableKnowledgeFile(name: string): boolean {
    const lower = name.toLowerCase();
    return lower.endsWith(".md") || lower.endsWith(".txt") || lower.endsWith(".csv");
  }

  private async fileToBase64(file: File): Promise<string> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i] ?? 0);
    }
    return btoa(binary);
  }

  private mergeKnowledgeFileEntry(entry: AgentFileEntry) {
    if (!this.agentKnowledgeList) {return;}
    const files = this.agentKnowledgeList.files.some((file) => file.name === entry.name)
      ? this.agentKnowledgeList.files.map((file) => (file.name === entry.name ? entry : file))
      : [...this.agentKnowledgeList.files, entry];
    this.agentKnowledgeList = { ...this.agentKnowledgeList, files };
  }

  private async loadAgentKnowledge(agentId: string) {
    if (this.agentKnowledgeLoading) {return;}
    this.agentKnowledgeLoading = true;
    this.agentKnowledgeError = null;
    try {
      const result = await this.rpc("agents.memory.list", { agentId }) as AgentsMemoryListResult | null;
      if (result) {
        this.agentKnowledgeList = result;
        if (this.agentKnowledgeFileActive && !result.files.some((file) => file.name === this.agentKnowledgeFileActive)) {
          this.agentKnowledgeFileActive = null;
        }
      }
    } catch (err) {
      this.agentKnowledgeError = String(err);
    } finally {
      this.agentKnowledgeLoading = false;
    }
  }

  private async loadAgentKnowledgeStatus(agentId: string) {
    try {
      const result = await this.rpc("agents.memory.status", { agentId }) as AgentsMemoryStatusResult | null;
      if (result) {
        this.agentKnowledgeStatus = result;
      }
    } catch {
      // Status is supplemental; keep the editor usable if the index probe fails.
    }
  }

  private async loadAgentKnowledgeFileContent(agentId: string, name: string) {
    if (this.agentKnowledgeLoading || Object.hasOwn(this.agentKnowledgeFileContents, name)) {return;}
    this.agentKnowledgeLoading = true;
    this.agentKnowledgeError = null;
    try {
      const result = await this.rpc("agents.memory.get", { agentId, name }) as AgentsMemoryGetResult | null;
      if (result?.file) {
        const content = result.file.content ?? "";
        this.mergeKnowledgeFileEntry(result.file);
        this.agentKnowledgeFileContents = { ...this.agentKnowledgeFileContents, [name]: content };
        this.agentKnowledgeFileDrafts = { ...this.agentKnowledgeFileDrafts, [name]: content };
      }
    } catch (err) {
      this.agentKnowledgeError = String(err);
    } finally {
      this.agentKnowledgeLoading = false;
    }
  }

  private async saveAgentKnowledgeFile(agentId: string, name: string) {
    const content = this.agentKnowledgeFileDrafts[name] ?? this.agentKnowledgeFileContents[name] ?? "";
    this.agentKnowledgeSaving = true;
    this.agentKnowledgeError = null;
    try {
      const result = await this.rpc("agents.memory.set", { agentId, name, content }) as AgentsMemorySetResult | null;
      if (result?.file) {
        this.mergeKnowledgeFileEntry(result.file);
        this.agentKnowledgeFileContents = { ...this.agentKnowledgeFileContents, [name]: content };
        this.agentKnowledgeFileDrafts = { ...this.agentKnowledgeFileDrafts, [name]: content };
        void this.loadAgentKnowledgeStatus(agentId);
      }
    } catch (err) {
      this.agentKnowledgeError = String(err);
    } finally {
      this.agentKnowledgeSaving = false;
    }
  }

  private async deleteAgentKnowledgeFile(agentId: string, name: string) {
    this.agentKnowledgeSaving = true;
    this.agentKnowledgeError = null;
    try {
      await this.rpc("agents.memory.delete", { agentId, name });
      if (this.agentKnowledgeList) {
        this.agentKnowledgeList = {
          ...this.agentKnowledgeList,
          files: this.agentKnowledgeList.files.filter((file) => file.name !== name),
        };
      }
      if (this.agentKnowledgeFileActive === name) {
        this.agentKnowledgeFileActive = null;
      }
      void this.loadAgentKnowledgeStatus(agentId);
    } catch (err) {
      this.agentKnowledgeError = String(err);
    } finally {
      this.agentKnowledgeSaving = false;
    }
  }

  private async uploadAgentKnowledgeFiles(agentId: string, fileList: FileList | File[]) {
    const files = Array.from(fileList).filter((file) =>
      [".md", ".txt", ".csv", ".docx", ".xlsx", ".pdf"].some((ext) =>
        file.name.toLowerCase().endsWith(ext),
      ),
    );
    if (files.length === 0) {
      this.agentKnowledgeError = "Only .md, .txt, .csv, .docx, .xlsx, and .pdf files are supported";
      return;
    }
    this.agentKnowledgeSaving = true;
    this.agentKnowledgeError = null;
    try {
      for (const file of files) {
        const normalized = this.normalizeKnowledgeFileName(file.name);
        if (!normalized) {
          continue;
        }
        const content = this.isEditableKnowledgeFile(normalized) ? await file.text() : "";
        const result = await this.rpc("agents.memory.set", {
          agentId,
          name: normalized,
          content,
          ...(this.isEditableKnowledgeFile(normalized)
            ? {}
            : { contentBase64: await this.fileToBase64(file) }),
        }) as AgentsMemorySetResult | null;
        if (result?.file) {
          this.mergeKnowledgeFileEntry(result.file);
          this.agentKnowledgeFileContents = {
            ...this.agentKnowledgeFileContents,
            [normalized]: content,
          };
          this.agentKnowledgeFileDrafts = {
            ...this.agentKnowledgeFileDrafts,
            [normalized]: content,
          };
        }
      }
      void this.loadAgentKnowledgeStatus(agentId);
    } catch (err) {
      this.agentKnowledgeError = String(err);
    } finally {
      this.agentKnowledgeSaving = false;
    }
  }

  private async downloadAgentKnowledgeFile(agentId: string, name: string) {
    try {
      if (!Object.hasOwn(this.agentKnowledgeFileContents, name)) {
        await this.loadAgentKnowledgeFileContent(agentId, name);
      }
      const content = this.agentKnowledgeFileDrafts[name] ?? this.agentKnowledgeFileContents[name] ?? "";
      const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name.split("/").pop() || "knowledge.md";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err) {
      this.agentKnowledgeError = String(err);
    }
  }

  private async loadPersonaFileContent(agentId: string, name: string) {
    if (Object.hasOwn(this.personaFileContents, name)) { return; }
    this.personaFilesLoading = true;
    this.personaFilesError = null;
    try {
      const locale = localStorage.getItem("enclaws.i18n.locale") || "en";
      const result = await this.rpc("agents.files.get", { agentId, name, locale }) as {
        file: { name: string; path: string; missing: boolean; content?: string; defaultContent?: string; size?: number; updatedAtMs?: number };
      };
      if (result?.file) {
        const content = result.file.content ?? "";
        const effectiveDraft = content || result.file.defaultContent || "";
        this.personaFileContents = { ...this.personaFileContents, [name]: content };
        this.personaFileDrafts = { ...this.personaFileDrafts, [name]: effectiveDraft };
        // Update file entry with defaultContent for UI hints
        this.personaFilesList = this.personaFilesList.map((f) =>
          f.name === name ? { ...f, ...result.file } : f,
        );
      }
    } catch (err) {
      this.personaFilesError = String(err);
    } finally {
      this.personaFilesLoading = false;
    }
  }

  private async savePersonaFile(agentId: string, name: string) {
    const content = this.personaFileDrafts[name] ?? this.personaFileContents[name] ?? "";
    this.personaFileSaving = true;
    this.personaFilesError = null;
    try {
      const result = await this.rpc("agents.files.set", { agentId, name, content }) as {
        file: { name: string; path: string; missing: boolean; size?: number; updatedAtMs?: number };
      };
      if (result?.file) {
        this.personaFileContents = { ...this.personaFileContents, [name]: content };
        this.personaFileDrafts = { ...this.personaFileDrafts, [name]: content };
        this.personaFilesList = this.personaFilesList.map((f) =>
          f.name === name ? { ...f, ...result.file, missing: false } : f,
        );
      }
    } catch (err) {
      this.personaFilesError = String(err);
    } finally {
      this.personaFileSaving = false;
    }
  }

  private async loadAgents() {
    this.loading = true;
    this.errorKey = "";
    try {
      const result = await this.rpc("tenant.agents.list") as { agents: TenantAgent[] };
      this.agents = result.agents ?? [];
      // Invalidate the chat page's tenant agents cache so navigating to
      // chat after creating/deleting an agent picks up the latest list.
      invalidateTenantAgentsCache();
      if (!this.selectedAgentId && this.agents.length > 0) {
        if (this.initialAgentId && this.agents.some(a => a.agentId === this.initialAgentId)) {
          this.selectedAgentId = this.initialAgentId;
          if (this.initialPanel) {
            this.activePanel = this.initialPanel as typeof this.activePanel;
            if (this.activePanel === "channels") {
              void this.loadChannelsForAgent(this.selectedAgentId);
            } else if (this.activePanel === "skills") {
              void this.loadSkillsForAgent(this.selectedAgentId);
            } else if (this.activePanel === "persona") {
              this.personaFileActive = null;
              this.personaFileContents = {};
              this.personaFileDrafts = {};
              void this.loadPersonaFiles(this.selectedAgentId);
            } else if (this.activePanel === "knowledge") {
              this.resetKnowledgeState();
              void this.loadAgentKnowledge(this.selectedAgentId);
              void this.loadAgentKnowledgeStatus(this.selectedAgentId);
            }
          }
          this.initialAgentId = null;
          this.initialPanel = null;
        } else {
          this.selectedAgentId = this.agents[0].agentId;
        }
      }
    } catch (err) {
      this.showError(err instanceof Error ? err.message : "tenantAgents.loadFailed");
    } finally {
      this.loading = false;
    }
  }

  private get flatModels(): FlatModelOption[] {
    const list: FlatModelOption[] = [];
    for (const mc of this.availableModels) {
      for (const m of mc.models) {
        list.push({ providerId: mc.id, providerName: mc.providerName, modelId: m.id, modelName: m.name });
      }
    }
    return list;
  }

  private get toolGroups(): ToolGroup[] {
    // 统一转换：凡是在 TOOL_GROUP_DEFS 里有声明 key 的 id 就走 i18n，其余用原值。
    // 翻译缺失时 t() 会原样返回 key，视作未命中、fall back 到原始 label/description。
    const translated = (key: string | undefined, raw: string) => {
      if (!key) {return raw;}
      const v = t(key);
      return v === key ? raw : v;
    };
    if (this.toolsCatalogGroups) {
      return this.toolsCatalogGroups.map((g) => ({
        id: g.id,
        label: translated(GROUP_LABEL_KEY[g.id], g.label),
        tools: g.tools.map((tl) => ({
          id: tl.id,
          label: translated(TOOL_LABEL_KEY[tl.id], tl.label),
          description: translated(TOOL_DESC_KEY[tl.id], tl.description),
        })),
      }));
    }
    return TOOL_GROUP_DEFS.map((g) => ({
      id: g.id,
      label: t(g.labelKey),
      tools: g.tools.map((td) => ({
        id: td.id,
        label: "labelKey" in td ? translated(td.labelKey, td.label) : td.label,
        description: t(td.descKey),
      })),
    }));
  }

  private get allToolIds(): string[] {
    return this.toolGroups.flatMap((g) => g.tools.map((t) => t.id));
  }

  private get modelManagePath() {
    return pathForTab("tenant-models", inferBasePathFromPathname(window.location.pathname));
  }

  private get selectedAgent(): TenantAgent | null {
    return this.agents.find((a) => a.agentId === this.selectedAgentId) ?? null;
  }

  // ── Form actions ──

  private startCreate() {
    this.editingAgentId = null;
    this.formAgentId = "";
    this.formName = "";
    this.formSystemPrompt = DEFAULT_SYSTEM_PROMPT;
    this.formModelConfig = [];
    this.formToolsDeny = [];
    this.formToolsExpanded = false;
    this.formTimeoutMinutes = null;
    this.formAgentIdManuallyEdited = false;
    this.showForm = true;
  }

  private startEdit(agent: TenantAgent) {
    this.editingAgentId = agent.agentId;
    this.formAgentId = agent.agentId;
    this.formName = (agent.config?.displayName as string) ?? agent.name ?? "";
    this.formSystemPrompt = (agent.config?.systemPrompt as string) || DEFAULT_SYSTEM_PROMPT;
    this.formModelConfig = [...(agent.modelConfig ?? [])];
    this.formToolsDeny = Array.isArray((agent as any).tools?.deny) && (agent as any).tools.deny.length > 0
      ? [...(agent as any).tools.deny]
      : Array.isArray((agent.config?.tools as { deny?: string[] })?.deny)
        ? [...((agent.config.tools as { deny: string[] }).deny)]
        : [];
    this.formToolsExpanded = false;
    const storedTimeout = agent.config?.timeoutSeconds;
    this.formTimeoutMinutes = typeof storedTimeout === "number" ? Math.round(storedTimeout / 60) : null;
    this.formAgentIdManuallyEdited = false;
    this.showForm = true;
  }

  private isModelSelected(providerId: string, modelId: string): boolean {
    return this.formModelConfig.some((e) => e.providerId === providerId && e.modelId === modelId);
  }

  private isModelDefault(providerId: string, modelId: string): boolean {
    return this.formModelConfig.some((e) => e.providerId === providerId && e.modelId === modelId && e.isDefault);
  }

  private toggleModel(providerId: string, modelId: string) {
    const config = [...this.formModelConfig];
    const idx = config.findIndex((e) => e.providerId === providerId && e.modelId === modelId);
    if (idx >= 0) {
      const wasDefault = config[idx].isDefault;
      config.splice(idx, 1);
      if (wasDefault && config.length > 0) {config[0] = { ...config[0], isDefault: true };}
    } else {
      config.push({ providerId, modelId, isDefault: config.length === 0 });
    }
    this.formModelConfig = config;
  }

  private setDefaultModel(providerId: string, modelId: string) {
    this.formModelConfig = this.formModelConfig.map((e) => ({
      ...e,
      isDefault: e.providerId === providerId && e.modelId === modelId,
    }));
  }

  private toggleTool(toolId: string, enabled: boolean) {
    if (this.systemDenySet.has(toolId)) {return;}
    const deny = new Set(this.formToolsDeny);
    if (enabled) {deny.delete(toolId);} else {deny.add(toolId);}
    this.formToolsDeny = Array.from(deny);
  }

  private toggleGroupTools(groupId: string, enabled: boolean) {
    const group = this.toolGroups.find((g) => g.id === groupId);
    if (!group) {return;}
    const deny = new Set(this.formToolsDeny);
    for (const tool of group.tools) {
      if (this.systemDenySet.has(tool.id)) {continue;}
      if (enabled) {deny.delete(tool.id);} else {deny.add(tool.id);}
    }
    this.formToolsDeny = Array.from(deny);
  }

  private toggleAllTools(enabled: boolean) {
    this.formToolsDeny = enabled ? [] : this.allToolIds.filter((id) => !this.systemDenySet.has(id));
  }

  // ── Inline model config ──

  private getInlineModelConfig(agent: TenantAgent): ModelConfigEntry[] {
    return this.inlineModelConfig ?? [...(agent.modelConfig ?? [])];
  }

  private inlineToggleModel(agent: TenantAgent, providerId: string, modelId: string) {
    const config = [...this.getInlineModelConfig(agent)];
    const idx = config.findIndex((e) => e.providerId === providerId && e.modelId === modelId);
    if (idx >= 0) {
      const wasDefault = config[idx].isDefault;
      config.splice(idx, 1);
      if (wasDefault && config.length > 0) {config[0] = { ...config[0], isDefault: true };}
    } else {
      config.push({ providerId, modelId, isDefault: config.length === 0 });
    }
    this.inlineModelConfig = config;
  }

  private inlineSetDefault(agent: TenantAgent, providerId: string, modelId: string) {
    const config = this.getInlineModelConfig(agent);
    this.inlineModelConfig = config.map((e) => ({
      ...e,
      isDefault: e.providerId === providerId && e.modelId === modelId,
    }));
  }

  private async inlineSaveModelConfig(agent: TenantAgent) {
    if (!this.inlineModelConfig) {return;}
    this.inlineModelSaving = true;
    try {
      await this.rpc("tenant.agents.update", {
        agentId: agent.agentId,
        modelConfig: this.inlineModelConfig,
      });
      this.inlineModelConfig = null;
      this.showSuccess("tenantAgents.agentUpdated");
      await this.loadAgents();
    } catch (err) {
      this.showError(err instanceof Error ? err.message : "tenantAgents.saveFailed");
    } finally {
      this.inlineModelSaving = false;
    }
  }

  // ── Save / Delete ──

  private async handleSave(e: Event) {
    e.preventDefault();
    if (!this.formName) { this.showError("tenantAgents.nameRequired"); return; }
    if (!this.formAgentId) { this.showError("tenantAgents.agentIdRequired"); return; }
    if (this.formModelConfig.length === 0) { this.showError("tenantAgents.modelRequired"); return; }

    this.saving = true;
    this.errorKey = "";
    this.successKey = "";

    const config: Record<string, unknown> = {
      displayName: this.formName,
      systemPrompt: this.formSystemPrompt,
    };
    if (this.formTimeoutMinutes != null) {
      config.timeoutSeconds = this.formTimeoutMinutes * 60;
    }
    const deny = this.formToolsDeny.filter(Boolean);
    if (deny.length > 0) {config.tools = { deny };}

    try {
      if (this.editingAgentId) {
        await this.rpc("tenant.agents.update", {
          agentId: this.editingAgentId,
          name: this.formName,
          config,
          modelConfig: this.formModelConfig,
        });
        this.showSuccess("tenantAgents.agentUpdated");
      } else {
        await this.rpc("tenant.agents.create", {
          agentId: this.formAgentId,
          name: this.formName,
          config,
          modelConfig: this.formModelConfig,
          locale: i18n.getLocale(),
        });
        this.selectedAgentId = this.formAgentId;
        this.showSuccess("tenantAgents.agentCreated");
      }
      this.showForm = false;
      await this.loadAgents();
    } catch (err) {
      const q = quotaErrorKey(err);
      if (q) {
        this.showError(q.key, q.params);
      } else {
        this.showError(err instanceof Error ? err.message : "tenantAgents.saveFailed");
      }
    } finally {
      this.saving = false;
    }
  }

  private async handleDelete(agent: TenantAgent) {
    const name = (agent.config?.displayName as string) || agent.name || agent.agentId;
    const ok = await showConfirm({
      title: t("tenantAgents.delete"),
      message: t("tenantAgents.confirmDelete").replace("{name}", name),
      confirmText: t("tenantAgents.delete"),
      cancelText: t("tenantAgents.cancel"),
      danger: true,
    });
    if (!ok) {return;}
    this.errorKey = "";
    try {
      await this.rpc("tenant.agents.delete", { agentId: agent.agentId });
      this.showSuccess("tenantAgents.agentDeleted", { name });
      if (this.selectedAgentId === agent.agentId) {this.selectedAgentId = null;}
      await this.loadAgents();
    } catch (err: any) {
      this.showError(err?.message ?? "tenantAgents.deleteFailed", err?.details);
    }
  }

  // ── Render ──

  render() {
    return html`
      ${this.errorKey
        ? html`<div class="error-msg">${
            this.errorKey.startsWith("errors.quotaExceeded.")
              ? unsafeHTML(this.tr(this.errorKey))
              : this.tr(this.errorKey)
          }</div>`
        : nothing}
      ${this.successKey ? html`<div class="success-msg">${this.tr(this.successKey)}</div>` : nothing}

      <div class="layout">
        ${this.renderSidebar()}
        <div class="main">
          ${this.showForm ? this.renderForm() : this.renderDetail()}
        </div>
      </div>
    `;
  }

  private renderSidebar() {
    return html`
      <div class="sidebar">
        <div class="sidebar-header">
          <span class="sidebar-count">${t("tenantAgents.configuredCount", { count: String(this.agents.length) })}</span>
          <button class="btn btn-outline btn-sm" @click=${() => this.loadAgents()}>${t("tenantAgents.refresh")}</button>
        </div>
        <button class="btn btn-primary btn-full" style="margin-bottom:0.75rem;padding:0.55rem 0"
          @click=${() => this.startCreate()}>+ ${t("tenantAgents.createAgent")}</button>
        ${this.loading ? html`<div class="loading">${t("tenantAgents.loading")}</div>` : html`
          <div class="agent-list">
            ${this.agents.length === 0
              ? html`<div class="empty">${t("tenantAgents.empty")}</div>`
              : this.agents.map((a) => this.renderAgentRow(a))
            }
          </div>
        `}
      </div>
    `;
  }

  private renderAgentRow(agent: TenantAgent) {
    const displayName = (agent.config?.displayName as string) || agent.name || agent.agentId;
    const initial = displayName.slice(0, 1).toUpperCase();
    const isSelected = this.selectedAgentId === agent.agentId;
    return html`
      <button type="button" class="agent-row ${isSelected ? "active" : ""}"
        @click=${() => { this.selectedAgentId = agent.agentId; this.activePanel = "overview"; this.showForm = false; this.inlineModelConfig = null; this.toolsPendingDeny = null; this.skillsPendingEnabled = null; this.cronLoaded = false; this.resetKnowledgeState(); }}>
        <div class="agent-avatar">${initial}</div>
        <div class="agent-info">
          <div class="agent-title">${displayName}</div>
          <div class="agent-sub">${agent.agentId}</div>
        </div>
        <span class="status-dot ${agent.isActive ? "active" : "inactive"}"></span>
      </button>
    `;
  }

  private renderDetail() {
    const agent = this.selectedAgent;
    if (!agent) {
      return html`
        <div class="detail-card">
          <div class="empty">${t("tenantAgents.selectToView")}</div>
        </div>
      `;
    }

    const displayName = (agent.config?.displayName as string) || agent.name || agent.agentId;
    const initial = displayName.slice(0, 1).toUpperCase();

    return html`
      <div class="detail-card">
        <div class="detail-header">
          <div class="detail-header-left">
            <div class="agent-avatar-lg">${initial}</div>
            <div>
              <div class="detail-name">${displayName}</div>
              <div class="detail-id">${agent.agentId}</div>
            </div>
          </div>
          <div class="detail-actions">
            <span class="status-dot ${agent.isActive ? "active" : "inactive"}"></span>
            <button class="btn btn-outline btn-sm" @click=${() => this.startEdit(agent)}>${t("tenantAgents.edit")}</button>
            <button class="btn btn-danger btn-sm" @click=${() => this.handleDelete(agent)}>${t("tenantAgents.delete")}</button>
          </div>
        </div>
      </div>

      ${this.renderTabs()}

      <div class="detail-card">
        ${this.activePanel === "overview" ? this.renderPanelOverview(agent) : nothing}
        ${this.activePanel === "persona" ? this.renderPanelPersona(agent) : nothing}
        ${this.activePanel === "tools" ? this.renderPanelTools(agent) : nothing}
        ${this.activePanel === "skills" ? this.renderPanelSkills(agent) : nothing}
        ${this.activePanel === "channels" ? this.renderPanelChannels() : nothing}
        ${this.activePanel === "cron" ? this.renderPanelCron(agent) : nothing}
        ${this.activePanel === "knowledge" ? this.renderPanelKnowledge(agent) : nothing}
      </div>
    `;
  }

  private renderTabs() {
    type Panel = "overview" | "persona" | "files" | "tools" | "skills" | "channels" | "cron" | "knowledge";
    const tabs: Array<{ id: Panel; label: string }> = [
      { id: "overview", label: t("tenantAgents.panelOverview") },
      { id: "persona", label: t("tabs.persona") },
      { id: "channels", label: t("tabs.channels") },
      { id: "tools", label: t("tabs.tools") },
      { id: "skills", label: t("tabs.skills") },
      { id: "cron", label: t("tabs.cron") },
      { id: "knowledge", label: t("tabs.knowledge") },
    ];
    return html`
      <div class="agent-tabs">
        ${tabs.map((tab) => html`
          <button type="button" class="agent-tab ${this.activePanel === tab.id ? "active" : ""}"
            @click=${() => {
              this.activePanel = tab.id;
              if (tab.id === "persona" && this.selectedAgentId) {
                this.personaFileActive = null;
                this.personaFileContents = {};
                this.personaFileDrafts = {};
                void this.loadPersonaFiles(this.selectedAgentId);
              }
              if (tab.id === "channels" && this.selectedAgentId) {
                void this.loadChannelsForAgent(this.selectedAgentId);
              }
              if (tab.id === "skills" && this.selectedAgentId) {
                void this.loadSkillsForAgent(this.selectedAgentId);
              }
              if (tab.id === "knowledge" && this.selectedAgentId) {
                if (this.agentKnowledgeList?.agentId !== this.selectedAgentId) {
                  this.resetKnowledgeState();
                  void this.loadAgentKnowledge(this.selectedAgentId);
                  void this.loadAgentKnowledgeStatus(this.selectedAgentId);
                }
              }
            }}>
            ${tab.label}
          </button>
        `)}
      </div>
    `;
  }

  private renderPanelOverview(agent: TenantAgent) {
    const denySet = new Set(Array.isArray((agent.config?.tools as { deny?: string[] })?.deny)
      ? (agent.config.tools as { deny: string[] }).deny : []);
    const toolsEnabled = this.allToolIds.filter((id) => !denySet.has(id) && !this.systemDenySet.has(id)).length;
    const systemPrompt = (agent.config?.systemPrompt as string) || "";
    const currentConfig = this.getInlineModelConfig(agent);
    const isDirty = this.inlineModelConfig !== null;
    // Saved values for KV display (from agent data, not inline edits)
    const savedConfig = agent.modelConfig ?? [];
    const savedDefault = savedConfig.find(e => e.isDefault);
    const savedDefaultLabel = savedDefault
      ? (() => { const fm = this.flatModels.find(m => m.providerId === savedDefault.providerId && m.modelId === savedDefault.modelId); return fm ? `${fm.modelName} (${fm.providerName})` : savedDefault.modelId; })()
      : "-";
    // Inline editing values for the model select section
    const defaultEntry = currentConfig.find((e) => e.isDefault);
    const fallbacks = currentConfig.filter(e => !e.isDefault);

    return html`
      <div class="overview-grid">
        <div class="kv">
          <div class="label">Agent ID</div>
          <div class="value mono">${agent.agentId}</div>
        </div>
        <div class="kv">
          <div class="label">${t("tenantAgents.defaultLabel")}</div>
          <div class="value mono">${savedDefaultLabel}</div>
        </div>
        <div class="kv">
          <div class="label">${t("tenantAgents.tools")}</div>
          <div class="value">${toolsEnabled}/${this.allToolIds.length} ${t("tenantAgents.enabled")}</div>
        </div>
        <div class="kv">
          <div class="label">${t("tenantAgents.createdAt")}</div>
          <div class="value">${new Date(agent.createdAt).toLocaleString()}</div>
        </div>
      </div>

      ${(() => {
        const timeoutSec = agent.config?.timeoutSeconds;
        if (typeof timeoutSec !== "number") {return nothing;}
        const mins = Math.round(timeoutSec / 60);
        return html`
          <div class="kv" style="margin:1rem 0">
            <div class="label">${t("tenantAgents.timeoutMinutes")}</div>
            <div class="value">${mins}</div>
          </div>
        `;
      })()}

      ${nothing /* systemPrompt moved to Persona & Standards tab */}

      <div class="model-section">
        <div class="label" style="display:flex;align-items:center;gap:0.4rem">
          ${t("tenantAgents.modelBinding")}
          <span class="help-icon" title="${t("tenantAgents.fallbackExplain")}">?</span>
        </div>
        ${this.flatModels.length === 0 ? html`
          <div class="form-hint">${t("tenantAgents.noModelsAvailable").split(t("tenantAgents.addModelLink"))[0]}<a href=${this.modelManagePath} style="color:var(--accent,#3b82f6);text-decoration:underline;cursor:pointer">${t("tenantAgents.addModelLink")}</a></div>
        ` : html`
          <div class="model-cards">
            ${this.flatModels.map(m => {
              const isSelected = currentConfig.some(c => c.providerId === m.providerId && c.modelId === m.modelId);
              const isDef = currentConfig.some(c => c.providerId === m.providerId && c.modelId === m.modelId && c.isDefault);
              const fallbackIdx = isSelected && !isDef
                ? fallbacks.findIndex(f => f.providerId === m.providerId && f.modelId === m.modelId)
                : -1;
              return html`
                <div class="model-card ${isSelected ? "selected" : ""}"
                  @click=${() => this.inlineToggleModel(agent, m.providerId, m.modelId)}>
                  <div class="model-card-check">${isSelected ? "✓" : ""}</div>
                  <div class="model-card-info">
                    <div class="model-card-name">${m.modelName}</div>
                    <div class="model-card-provider">${m.providerName}</div>
                  </div>
                  ${isDef ? html`
                    <span class="model-card-badge is-default">${t("tenantAgents.default")}</span>
                  ` : fallbackIdx >= 0 ? html`
                    <span class="model-card-badge is-fallback"
                      @click=${(e: Event) => {
                        e.stopPropagation();
                        this.inlineSetDefault(agent, m.providerId, m.modelId);
                      }}>
                      ${t("tenantAgents.fallbackN", { n: String(fallbackIdx + 1) })}
                    </span>
                  ` : nothing}
                </div>
              `;
            })}
          </div>
          ${isDirty ? html`
            <div class="model-actions" style="margin-top:0.75rem">
              <button class="btn btn-outline btn-sm" @click=${() => { this.inlineModelConfig = null; }}>
                ${t("tenantAgents.cancel")}
              </button>
              <button class="btn btn-primary btn-sm" ?disabled=${this.inlineModelSaving || currentConfig.length === 0}
                @click=${() => this.inlineSaveModelConfig(agent)}>
                ${this.inlineModelSaving ? t("tenantAgents.saving") : t("tenantAgents.save")}
              </button>
            </div>
          ` : nothing}
        `}
      </div>
    `;
  }

  private renderPanelPersona(agent: TenantAgent) {
    const cards = [
      { id: "IDENTITY.md", icon: "\u{1F4CB}", titleKey: "agents.persona.identity.title", fileKey: "agents.persona.identity.file", descKey: "agents.persona.identity.desc" },
      { id: "SOUL.md", icon: "\u{1F6E1}\uFE0F", titleKey: "agents.persona.soul.title", fileKey: "agents.persona.soul.file", descKey: "agents.persona.soul.desc" },
      { id: "AGENTS.md", icon: "\u{1F4D0}", titleKey: "agents.persona.agents.title", fileKey: "agents.persona.agents.file", descKey: "agents.persona.agents.desc" },
    ];

    return html`
      ${this.personaFilesError
        ? html`<div style="color: var(--danger, #ef4444); font-size: 0.85rem; margin-bottom: 1rem; padding: 0.5rem; border: 1px solid var(--danger, #ef4444); border-radius: 4px;">${this.personaFilesError}</div>`
        : nothing}
      <div style="display: flex; flex-direction: column; gap: 0.75rem;">
        ${cards.map((card) => {
          const fileEntry = this.personaFilesList.find((f) => f.name === card.id);
          const isActive = this.personaFileActive === card.id;
          const baseContent = this.personaFileContents[card.id] ?? "";
          const draft = this.personaFileDrafts[card.id] ?? baseContent;
          const isDirty = draft !== baseContent;

          return html`
            <div style="border: 1px solid ${isActive ? "var(--accent, #3b82f6)" : "var(--border, #262626)"}; border-radius: 8px; overflow: hidden;">
              <button type="button" style="
                display: flex; align-items: center; gap: 0.75rem; width: 100%;
                padding: 0.75rem 1rem; background: transparent; border: none;
                cursor: pointer; text-align: left; color: inherit; font: inherit;
              " @click=${() => {
                if (isActive) {
                  this.personaFileActive = null;
                } else {
                  this.personaFileActive = card.id;
                  void this.loadPersonaFileContent(agent.agentId, card.id);
                }
              }}>
                <span style="font-size: 1.3em; flex-shrink: 0;">${card.icon}</span>
                <div style="flex: 1; min-width: 0;">
                  <div style="font-weight: 600; font-size: 0.85rem; display: flex; align-items: center; gap: 0.5rem;">
                    ${t(card.titleKey)}
                    <span style="font-size: 0.75em; opacity: 0.5; font-weight: normal; font-family: var(--mono-font, monospace);">${t(card.fileKey)}</span>
                  </div>
                  <div style="font-size: 0.78rem; color: var(--text-muted, #525252); margin-top: 1px;">${t(card.descKey)}</div>
                </div>
                <span style="font-size: 0.8em; opacity: 0.4; transition: transform 0.2s; ${isActive ? "transform: rotate(180deg);" : ""}">▼</span>
              </button>
              ${isActive ? html`
                <div style="padding: 0 1rem 1rem; border-top: 1px solid var(--border, #262626);">
                  <div style="margin-top: 0.75rem; display: flex; justify-content: flex-end; gap: 0.5rem;">
                    <button class="btn btn-outline btn-sm" ?disabled=${!isDirty} @click=${() => {
                      this.personaFileDrafts = { ...this.personaFileDrafts, [card.id]: baseContent || ((fileEntry as any)?.defaultContent ?? "") };
                    }}>${t("agents.persona.reset")}</button>
                    <button class="btn btn-primary btn-sm" ?disabled=${this.personaFileSaving || !isDirty} @click=${() => {
                      void this.savePersonaFile(agent.agentId, card.id);
                    }}>${this.personaFileSaving ? t("agents.persona.saving") : t("agents.persona.save")}</button>
                  </div>
                  <textarea style="
                    width: 100%; min-height: 280px; margin-top: 0.5rem;
                    font-family: var(--mono-font, monospace); font-size: 0.8rem;
                    background: var(--bg, #0a0a0a); color: inherit;
                    border: 1px solid var(--border, #262626); border-radius: 6px;
                    padding: 0.75rem; resize: vertical; line-height: 1.5;
                  " .value=${draft} @input=${(e: Event) => {
                    this.personaFileDrafts = { ...this.personaFileDrafts, [card.id]: (e.target as HTMLTextAreaElement).value };
                  }}></textarea>
                </div>
              ` : nothing}
            </div>
          `;
        })}
      </div>
    `;
  }

  // ── Cron panel methods ──

  private async loadCronJobs() {
    const agent = this.agents.find(a => a.agentId === this.selectedAgentId);
    if (!agent) {return;}
    this.cronLoading = true;
    this.cronError = null;
    this.cronErrorIsHtml = false;
    try {
      const res = await this.rpc("cron.list", {
        _agentId: agent.agentId,
        includeDisabled: true,
      }) as { jobs?: CronJob[]; total?: number };
      this.cronJobs = res.jobs ?? [];
    } catch (err) {
      this.cronError = String(err);
      this.cronErrorIsHtml = false;
    } finally {
      this.cronLoading = false;
      this.cronLoaded = true;
    }
  }

  private openCronNewModal(agentId: string) {
    this.cronModalEditingJobId = null;
    this.cronForm = { ...DEFAULT_CRON_FORM, agentId };
    this.cronFieldErrors = {};
    this.cronModalVisible = true;
  }

  private openCronEditModal(job: CronJob) {
    this.cronModalEditingJobId = job.id;
    // Convert job to form state
    const form: CronFormState = {
      ...DEFAULT_CRON_FORM,
      name: job.name,
      description: job.description ?? "",
      agentId: job.agentId ?? "",
      enabled: job.enabled,
      deleteAfterRun: job.deleteAfterRun ?? false,
      sessionTarget: job.sessionTarget,
      wakeMode: job.wakeMode,
      payloadKind: job.payload.kind,
      payloadText: job.payload.kind === "systemEvent" ? job.payload.text : job.payload.message,
      payloadModel: job.payload.kind === "agentTurn" ? (job.payload.model ?? "") : "",
      payloadThinking: job.payload.kind === "agentTurn" ? (job.payload.thinking ?? "") : "",
      deliveryMode: job.delivery?.mode ?? "none",
      deliveryChannel: job.delivery?.channel ?? "last",
      deliveryTo: job.delivery?.to ?? "",
      deliveryBestEffort: job.delivery?.bestEffort ?? false,
      timeoutSeconds: job.payload.kind === "agentTurn" && typeof job.payload.timeoutSeconds === "number"
        ? String(job.payload.timeoutSeconds) : "",
      scheduleKind: job.schedule.kind,
      scheduleAt: job.schedule.kind === "at" ? job.schedule.at : "",
      everyAmount: job.schedule.kind === "every" ? String(job.schedule.everyMs / 60000) : DEFAULT_CRON_FORM.everyAmount,
      everyUnit: "minutes",
      cronExpr: job.schedule.kind === "cron" ? job.schedule.expr : DEFAULT_CRON_FORM.cronExpr,
      cronTz: job.schedule.kind === "cron" ? (job.schedule.tz ?? "") : "",
    };
    if (job.schedule.kind === "every") {
      const ms = job.schedule.everyMs;
      if (ms % 86_400_000 === 0) { form.everyAmount = String(ms / 86_400_000); form.everyUnit = "days"; }
      else if (ms % 3_600_000 === 0) { form.everyAmount = String(ms / 3_600_000); form.everyUnit = "hours"; }
      else { form.everyAmount = String(ms / 60_000); form.everyUnit = "minutes"; }
    }
    const fa = job.failureAlert;
    if (fa === false) { form.failureAlertMode = "disabled"; }
    else if (fa && typeof fa === "object") {
      form.failureAlertMode = "custom";
      form.failureAlertAfter = typeof fa.after === "number" ? String(fa.after) : DEFAULT_CRON_FORM.failureAlertAfter;
      form.failureAlertCooldownSeconds = typeof fa.cooldownMs === "number" ? String(Math.floor(fa.cooldownMs / 1000)) : DEFAULT_CRON_FORM.failureAlertCooldownSeconds;
      form.failureAlertChannel = fa.channel ?? "last";
      form.failureAlertTo = fa.to ?? "";
    }
    this.cronForm = normalizeCronFormState(form);
    this.cronFieldErrors = {};
    this.cronModalVisible = true;
  }

  private closeCronModal() {
    this.cronModalVisible = false;
    this.cronModalEditingJobId = null;
  }

  private async saveCronJob() {
    const errors = validateCronForm(this.cronForm);
    if (hasCronFormErrors(errors)) {
      this.cronFieldErrors = errors;
      return;
    }
    this.cronBusy = true;
    this.cronError = null;
    this.cronErrorIsHtml = false;
    try {
      const schedule = buildCronSchedule(this.cronForm);
      const payload = buildCronPayload(this.cronForm);
      const failureAlert = buildFailureAlert(this.cronForm);
      const delivery = this.cronForm.deliveryMode !== "none" ? {
        mode: this.cronForm.deliveryMode,
        channel: this.cronForm.deliveryChannel || undefined,
        to: this.cronForm.deliveryTo.trim() || undefined,
        bestEffort: this.cronForm.deliveryBestEffort || undefined,
      } : undefined;
      if (this.cronModalEditingJobId) {
        await this.rpc("cron.update", {
          _agentId: this.cronForm.agentId,
          id: this.cronModalEditingJobId,
          patch: {
            name: this.cronForm.name,
            description: this.cronForm.description || undefined,
            enabled: this.cronForm.enabled,
            deleteAfterRun: this.cronForm.deleteAfterRun,
            schedule,
            sessionTarget: this.cronForm.sessionTarget,
            wakeMode: this.cronForm.wakeMode,
            payload,
            delivery,
            failureAlert,
          },
        });
      } else {
        await this.rpc("cron.add", {
          _agentId: this.cronForm.agentId,
          name: this.cronForm.name,
          description: this.cronForm.description || undefined,
          agentId: this.cronForm.agentId,
          enabled: this.cronForm.enabled,
          deleteAfterRun: this.cronForm.deleteAfterRun,
          schedule,
          sessionTarget: this.cronForm.sessionTarget,
          wakeMode: this.cronForm.wakeMode,
          payload,
          delivery,
          failureAlert,
        });
      }
      this.closeCronModal();
      await this.loadCronJobs();
    } catch (err) {
      const q = quotaErrorKey(err);
      if (q) {
        this.cronError = t(q.key, q.params);
        this.cronErrorIsHtml = true;
      } else {
        this.cronError = err instanceof Error ? err.message : String(err);
        this.cronErrorIsHtml = false;
      }
    } finally {
      this.cronBusy = false;
    }
  }

  private async toggleCronJob(job: CronJob, enabled: boolean) {
    this.cronBusy = true;
    try {
      await this.rpc("cron.update", {
        _agentId: job.agentId,
        id: job.id,
        patch: { enabled },
      });
      await this.loadCronJobs();
    } catch (err) {
      this.cronError = String(err);
      this.cronErrorIsHtml = false;
    } finally {
      this.cronBusy = false;
    }
  }

  private async runCronJob(job: CronJob) {
    this.cronBusy = true;
    try {
      await this.rpc("cron.run", { _agentId: job.agentId, id: job.id });
      await this.loadCronJobs();
    } catch (err) {
      this.cronError = String(err);
      this.cronErrorIsHtml = false;
    } finally {
      this.cronBusy = false;
    }
  }

  private async removeCronJob(job: CronJob) {
    const confirmed = await showConfirm({
      title: t("cron.remove.confirmTitle"),
      message: t("cron.remove.confirmMessage", { name: job.name }),
      confirmText: t("cron.remove.confirmButton"),
      cancelText: t("cron.remove.cancelButton"),
      danger: true,
    });
    if (!confirmed) {return;}
    this.cronBusy = true;
    try {
      await this.rpc("cron.remove", { _agentId: job.agentId, id: job.id });
      await this.loadCronJobs();
    } catch (err) {
      this.cronError = String(err);
      this.cronErrorIsHtml = false;
    } finally {
      this.cronBusy = false;
    }
  }

  private renderPanelCron(agent: TenantAgent) {
    // Auto-load on first render
    if (!this.cronLoaded && !this.cronLoading) {
      this.loadCronJobs();
    }
    const enabledCount = this.cronJobs.filter(j => j.enabled).length;
    const disabledCount = this.cronJobs.length - enabledCount;
    const nextRunJob = this.cronJobs
      .filter(j => j.enabled && j.state?.nextRunAtMs)
      .toSorted((a, b) => (a.state?.nextRunAtMs ?? 0) - (b.state?.nextRunAtMs ?? 0))[0];
    const nextRunText = nextRunJob?.state?.nextRunAtMs
      ? formatRelativeTimestamp(nextRunJob.state.nextRunAtMs)
      : "--";

    return html`
      ${this.cronModalVisible ? this.renderCronModal(agent) : nothing}

      <div style="margin-bottom: 16px; padding: 12px 16px; background: var(--surface-2, #f8fcfd); border-radius: var(--radius-md, 6px); display: flex; align-items: center; gap: 24px; flex-wrap: wrap;">
        <div>
          <span style="color: var(--muted, #7ea5b2); font-size: 0.8rem;">${t("cron.summary.jobs")}</span>
          <div style="font-size: 1.1rem; font-weight: 600;">${this.cronJobs.length}</div>
        </div>
        <div>
          <span style="color: var(--muted, #7ea5b2); font-size: 0.8rem;">${t("cron.summary.enabled")}</span>
          <div style="font-size: 1.1rem; font-weight: 600;">${enabledCount}</div>
        </div>
        <div>
          <span style="color: var(--muted, #7ea5b2); font-size: 0.8rem;">${t("cron.jobList.disabled")}</span>
          <div style="font-size: 1.1rem; font-weight: 600;">${disabledCount}</div>
        </div>
        <div>
          <span style="color: var(--muted, #7ea5b2); font-size: 0.8rem;">${t("cron.summary.nextWake")}</span>
          <div style="font-size: 1.1rem; font-weight: 600;">${nextRunText}</div>
        </div>
        <div style="margin-left: auto; display: flex; gap: 8px;">
          <button class="btn" ?disabled=${this.cronLoading} @click=${() => this.loadCronJobs()}>
            ${this.cronLoading ? t("cron.summary.refreshing") : t("cron.summary.refresh")}
          </button>
          <button class="btn btn-primary" @click=${() => this.openCronNewModal(agent.agentId)}>
            + ${t("cron.form.addJob")}
          </button>
        </div>
      </div>

      ${this.cronError ? html`<div class="form-error" style="margin-bottom: 12px;">${this.cronErrorIsHtml ? unsafeHTML(this.cronError) : this.cronError}</div>` : nothing}

      ${this.cronLoading && this.cronJobs.length === 0
        ? html`<div class="loading">${t("cron.jobs.loading")}</div>`
        : this.cronJobs.length === 0
          ? html`<div class="empty">${t("cron.agentPanel.noJobs")}</div>`
          : html`
            <div style="display: flex; flex-direction: column; gap: 8px;">
              ${this.cronJobs.map(job => this.renderCronJobRow(job))}
            </div>
          `
      }
    `;
  }

  private renderCronJobRow(job: CronJob) {
    const status = job.state?.lastRunStatus ?? job.state?.lastStatus;
    const statusIcon = status === "ok" ? "\u2705" : status === "error" ? "\u274C" : status === "skipped" ? "\u23ED" : "";
    const lastRunText = job.state?.lastRunAtMs ? formatRelativeTimestamp(job.state.lastRunAtMs) : "";
    const nextRunText = job.state?.nextRunAtMs ? formatRelativeTimestamp(job.state.nextRunAtMs) : "--";
    const scheduleText = formatCronSchedule(job);
    const createdByName = job.createdBy?.displayName ?? job.createdBy?.userId;

    return html`
      <div style="padding: 12px 16px; background: var(--surface-2, #f8fcfd); border-radius: var(--radius-md, 6px); border: 1px solid var(--border, #e2eef2);">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 12px;">
          <div style="flex: 1; min-width: 0;">
            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
              <span style="font-weight: 600;">${job.name}</span>
              <span class=${`chip ${job.enabled ? "chip-ok" : "chip-muted"}`} style="font-size: 0.75rem;">
                ${job.enabled ? t("cron.jobList.enabled") : t("cron.jobList.disabled")}
              </span>
            </div>
            <div style="font-size: 0.8rem; color: var(--muted, #7ea5b2); margin-top: 4px; display: flex; gap: 16px; flex-wrap: wrap;">
              <span>${scheduleText}</span>
              <span>${t("cron.summary.nextWake")}: ${nextRunText}</span>
              ${lastRunText ? html`<span>${statusIcon} ${lastRunText}</span>` : nothing}
              ${createdByName ? html`<span style="opacity: 0.7;">${t("cron.agentPanel.createdBy")}: ${createdByName}</span>` : nothing}
            </div>
            ${job.description ? html`<div style="font-size: 0.8rem; color: var(--muted, #7ea5b2); margin-top: 2px;">${job.description}</div>` : nothing}
          </div>
          <div style="display: flex; gap: 6px; flex-shrink: 0;">
            <button class="btn btn-sm" ?disabled=${this.cronBusy} @click=${() => this.runCronJob(job)}>
              ${t("cron.jobList.run")}
            </button>
            <button class="btn btn-sm" @click=${() => this.openCronEditModal(job)}>
              ${t("cron.jobList.edit")}
            </button>
            <button class="btn btn-sm" ?disabled=${this.cronBusy}
              @click=${() => this.toggleCronJob(job, !job.enabled)}>
              ${job.enabled ? t("cron.jobList.disable") : t("cron.jobList.enable")}
            </button>
            <button class="btn btn-sm btn-danger" ?disabled=${this.cronBusy}
              @click=${() => this.removeCronJob(job)}>
              ${t("cron.jobList.remove")}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private renderCronModal(agent: TenantAgent) {
    const isEditing = Boolean(this.cronModalEditingJobId);
    const title = isEditing ? t("cron.form.editJob") : t("cron.form.addJob");
    const form = this.cronForm;
    const errors = this.cronFieldErrors;

    return html`
      <div style="position: fixed; inset: 0; z-index: 9999; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; padding: 24px;"
        @click=${(e: Event) => { if (e.target === e.currentTarget) {this.closeCronModal();} }}>
        <div style="background: var(--card, #ffffff); border: 1px solid var(--border, #e2eef2); border-radius: var(--radius, 8px); width: 90%; max-width: 960px; max-height: 90vh; overflow-y: auto; padding: 24px;"
          @click=${(e: Event) => e.stopPropagation()}>

          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
            <h3 style="margin: 0;">${title}</h3>
            <button class="btn btn-sm" @click=${() => this.closeCronModal()}>\u2715</button>
          </div>

          <div style="margin-bottom: 16px; padding: 8px 12px; background: var(--surface-2, #f8fcfd); border-radius: var(--radius-md, 6px); color: var(--muted, #7ea5b2); font-size: 0.85rem;">
            Agent: <strong style="color: var(--text, #0c1a1f);">${agent.name ?? agent.agentId}</strong>
          </div>

          <!-- Basic info -->
          <fieldset style="border: 1px solid var(--border, #e2eef2); border-radius: 6px; padding: 16px; margin-bottom: 16px;">
            <legend style="font-size: 0.85rem; color: var(--muted, #7ea5b2); padding: 0 4px;">${t("cron.form.basics")}</legend>
            <div style="display: flex; flex-direction: column; gap: 12px;">
              <div>
                <div style="font-size: 0.8rem; color: var(--muted, #7ea5b2); margin-bottom: 4px;">${t("cron.form.fieldName")} *</div>
                <input style="width: 100%; padding: 6px 10px; border: 1px solid var(--border, #e2eef2); border-radius: 4px; background: var(--input-bg, #f8fcfd); color: inherit; box-sizing: border-box;"
                  .value=${form.name} @input=${(e: Event) => this.updateCronForm({ name: (e.target as HTMLInputElement).value })} />
                ${errors.name ? html`<div style="font-size: 0.75rem; color: var(--danger, #ef4444); margin-top: 2px;">${t(errors.name)}</div>` : nothing}
              </div>
              <div>
                <div style="font-size: 0.8rem; color: var(--muted, #7ea5b2); margin-bottom: 4px;">${t("cron.form.description")}</div>
                <input style="width: 100%; padding: 6px 10px; border: 1px solid var(--border, #e2eef2); border-radius: 4px; background: var(--input-bg, #f8fcfd); color: inherit; box-sizing: border-box;"
                  .value=${form.description} @input=${(e: Event) => this.updateCronForm({ description: (e.target as HTMLInputElement).value })} />
              </div>
              <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                <input type="checkbox" .checked=${form.enabled} @change=${(e: Event) => this.updateCronForm({ enabled: (e.target as HTMLInputElement).checked })} />
                <span style="font-size: 0.85rem;">${t("cron.summary.enabled")}</span>
              </label>
            </div>
          </fieldset>

          <!-- Schedule -->
          <fieldset style="border: 1px solid var(--border, #e2eef2); border-radius: 6px; padding: 16px; margin-bottom: 16px;">
            <legend style="font-size: 0.85rem; color: var(--muted, #7ea5b2); padding: 0 4px;">${t("cron.form.schedule")}</legend>
            <div style="display: flex; gap: 16px; margin-bottom: 12px;">
              <label style="display: flex; align-items: center; gap: 4px; cursor: pointer;">
                <input type="radio" name="cronScheduleKind" value="at" .checked=${form.scheduleKind === "at"}
                  @change=${() => this.updateCronForm({ scheduleKind: "at" })} />
                ${t("cron.form.at")}
              </label>
              <label style="display: flex; align-items: center; gap: 4px; cursor: pointer;">
                <input type="radio" name="cronScheduleKind" value="every" .checked=${form.scheduleKind === "every"}
                  @change=${() => this.updateCronForm({ scheduleKind: "every" })} />
                ${t("cron.form.every")}
              </label>
              <label style="display: flex; align-items: center; gap: 4px; cursor: pointer;">
                <input type="radio" name="cronScheduleKind" value="cron" .checked=${form.scheduleKind === "cron"}
                  @change=${() => this.updateCronForm({ scheduleKind: "cron" })} />
                ${t("cron.form.cronOption")}
              </label>
            </div>
            ${form.scheduleKind === "at" ? html`
              <div style="display: flex; flex-direction: column; gap: 10px;">
                <div>
                  <div style="font-size: 0.8rem; color: var(--muted, #7ea5b2); margin-bottom: 4px;">${t("cron.form.runAt")}</div>
                  <input type="datetime-local" style="width: 100%; padding: 6px 10px; border: 1px solid var(--border, #e2eef2); border-radius: 4px; background: var(--input-bg, #f8fcfd); color: inherit; box-sizing: border-box;"
                    .value=${form.scheduleAt}
                    @input=${(e: Event) => this.updateCronForm({ scheduleAt: (e.target as HTMLInputElement).value })} />
                  ${errors.scheduleAt ? html`<div style="font-size: 0.75rem; color: var(--danger, #ef4444); margin-top: 2px;">${t(errors.scheduleAt)}</div>` : nothing}
                </div>
                <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                  <input type="checkbox" .checked=${form.deleteAfterRun}
                    @change=${(e: Event) => this.updateCronForm({ deleteAfterRun: (e.target as HTMLInputElement).checked })} />
                  <span style="font-size: 0.85rem;">${t("cron.form.deleteAfterRun")}</span>
                </label>
              </div>
            ` : nothing}
            ${form.scheduleKind === "every" ? html`
              <div style="display: flex; gap: 10px; align-items: flex-end;">
                <div style="flex: 1;">
                  <div style="font-size: 0.8rem; color: var(--muted, #7ea5b2); margin-bottom: 4px;">${t("cron.form.every")}</div>
                  <input type="number" min="1" style="width: 100%; padding: 6px 10px; border: 1px solid var(--border, #e2eef2); border-radius: 4px; background: var(--input-bg, #f8fcfd); color: inherit; box-sizing: border-box;"
                    .value=${form.everyAmount}
                    @input=${(e: Event) => this.updateCronForm({ everyAmount: (e.target as HTMLInputElement).value })} />
                  ${errors.everyAmount ? html`<div style="font-size: 0.75rem; color: var(--danger, #ef4444); margin-top: 2px;">${t(errors.everyAmount)}</div>` : nothing}
                </div>
                <select style="padding: 6px 10px; border: 1px solid var(--border, #e2eef2); border-radius: 4px; background: var(--input-bg, #f8fcfd); color: inherit;"
                  .value=${form.everyUnit} @change=${(e: Event) => this.updateCronForm({ everyUnit: (e.target as HTMLSelectElement).value as "minutes" | "hours" | "days" })}>
                  <option value="minutes">${t("cron.form.minutes")}</option>
                  <option value="hours">${t("cron.form.hours")}</option>
                  <option value="days">${t("cron.form.days")}</option>
                </select>
              </div>
            ` : nothing}
            ${form.scheduleKind === "cron" ? html`
              <div style="display: flex; flex-direction: column; gap: 10px;">
                <div>
                  <div style="font-size: 0.8rem; color: var(--muted, #7ea5b2); margin-bottom: 4px;">${t("cron.form.expression")}</div>
                  <input style="width: 100%; padding: 6px 10px; border: 1px solid var(--border, #e2eef2); border-radius: 4px; background: var(--input-bg, #f8fcfd); color: inherit; box-sizing: border-box;"
                    .value=${form.cronExpr} placeholder="0 9 * * *"
                    @input=${(e: Event) => this.updateCronForm({ cronExpr: (e.target as HTMLInputElement).value })} />
                  ${errors.cronExpr ? html`<div style="font-size: 0.75rem; color: var(--danger, #ef4444); margin-top: 2px;">${t(errors.cronExpr)}</div>` : nothing}
                </div>
                <div>
                  <div style="font-size: 0.8rem; color: var(--muted, #7ea5b2); margin-bottom: 4px;">${t("cron.form.timezoneOptional")}</div>
                  <input style="width: 100%; padding: 6px 10px; border: 1px solid var(--border, #e2eef2); border-radius: 4px; background: var(--input-bg, #f8fcfd); color: inherit; box-sizing: border-box;"
                    .value=${form.cronTz} placeholder="Asia/Shanghai"
                    @input=${(e: Event) => this.updateCronForm({ cronTz: (e.target as HTMLInputElement).value })} />
                </div>
              </div>
            ` : nothing}
          </fieldset>

          <!-- Execution settings -->
          <fieldset style="border: 1px solid var(--border, #e2eef2); border-radius: 6px; padding: 16px; margin-bottom: 16px;">
            <legend style="font-size: 0.85rem; color: var(--muted, #7ea5b2); padding: 0 4px;">${t("cron.form.execution")}</legend>
            <div style="display: flex; flex-direction: column; gap: 12px;">
              <div>
                <div style="font-size: 0.8rem; color: var(--muted, #7ea5b2); margin-bottom: 6px;">${t("cron.form.session")}</div>
                <div style="display: flex; gap: 16px;">
                  <label style="display: flex; align-items: center; gap: 4px; cursor: pointer;">
                    <input type="radio" name="cronSessionTarget" value="isolated" .checked=${form.sessionTarget === "isolated"}
                      @change=${() => this.updateCronForm({ sessionTarget: "isolated" })} />
                    ${t("cron.form.isolated")}
                  </label>
                  <label style="display: flex; align-items: center; gap: 4px; cursor: pointer;">
                    <input type="radio" name="cronSessionTarget" value="main" .checked=${form.sessionTarget === "main"}
                      @change=${() => this.updateCronForm({ sessionTarget: "main" })} />
                    ${t("cron.form.main")}
                  </label>
                </div>
                <div style="font-size: 0.75rem; color: var(--muted, #7ea5b2); margin-top: 4px;">
                  ${form.sessionTarget === "isolated"
                    ? t("cron.agentPanel.sessionIsolatedHelp")
                    : t("cron.agentPanel.sessionMainHelp")}
                </div>
              </div>
              <div>
                <div style="font-size: 0.8rem; color: var(--muted, #7ea5b2); margin-bottom: 4px;">
                  ${t("cron.agentPanel.messageContent")} *
                </div>
                <textarea rows="3" style="width: 100%; padding: 6px 10px; border: 1px solid var(--border, #e2eef2); border-radius: 4px; background: var(--input-bg, #f8fcfd); color: inherit; box-sizing: border-box; font-family: inherit; resize: vertical;"
                  .value=${form.payloadText}
                  @input=${(e: Event) => this.updateCronForm({ payloadText: (e.target as HTMLTextAreaElement).value })}></textarea>
                ${errors.payloadText ? html`<div style="font-size: 0.75rem; color: var(--danger, #ef4444); margin-top: 2px;">${t(errors.payloadText)}</div>` : nothing}
              </div>
              ${form.payloadKind === "agentTurn" ? html`
                <div style="display: flex; gap: 12px;">
                  <div style="flex: 1;">
                    <div style="font-size: 0.8rem; color: var(--muted, #7ea5b2); margin-bottom: 4px;">${t("cron.form.model")}</div>
                    <input style="width: 100%; padding: 6px 10px; border: 1px solid var(--border, #e2eef2); border-radius: 4px; background: var(--input-bg, #f8fcfd); color: inherit; box-sizing: border-box;"
                      .value=${form.payloadModel} placeholder=${t("cron.form.modelPlaceholder")}
                      @input=${(e: Event) => this.updateCronForm({ payloadModel: (e.target as HTMLInputElement).value })} />
                  </div>
                  <div style="width: 120px;">
                    <div style="font-size: 0.8rem; color: var(--muted, #7ea5b2); margin-bottom: 4px;">${t("cron.form.timeoutSeconds")}</div>
                    <input type="number" style="width: 100%; padding: 6px 10px; border: 1px solid var(--border, #e2eef2); border-radius: 4px; background: var(--input-bg, #f8fcfd); color: inherit; box-sizing: border-box;"
                      .value=${form.timeoutSeconds} placeholder="300"
                      @input=${(e: Event) => this.updateCronForm({ timeoutSeconds: (e.target as HTMLInputElement).value })} />
                  </div>
                </div>
              ` : nothing}
            </div>
          </fieldset>

          <!-- Delivery -->
          <fieldset style="border: 1px solid var(--border, #e2eef2); border-radius: 6px; padding: 16px; margin-bottom: 16px;">
            <legend style="font-size: 0.85rem; color: var(--muted, #7ea5b2); padding: 0 4px;">${t("cron.form.deliverySection")}</legend>
            <div style="display: flex; gap: 16px; margin-bottom: 10px;">
              <label style="display: flex; align-items: center; gap: 4px; cursor: pointer;">
                <input type="radio" name="cronDeliveryMode" value="none" .checked=${form.deliveryMode === "none"}
                  @change=${() => this.updateCronForm({ deliveryMode: "none" })} />
                ${t("cron.form.noneInternal")}
              </label>
              <label style="display: flex; align-items: center; gap: 4px; cursor: pointer;">
                <input type="radio" name="cronDeliveryMode" value="announce" .checked=${form.deliveryMode === "announce"}
                  @change=${() => this.updateCronForm({ deliveryMode: "announce" })} />
                ${t("cron.form.announceDefault")}
              </label>
            </div>
            ${form.deliveryMode !== "none" ? html`
              <div>
                <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 4px;">
                  <span style="font-size: 0.8rem; color: var(--muted, #7ea5b2);">${t("cron.form.to")}</span>
                  <span .title=${t("cron.agentPanel.deliveryToHelp")} style="display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; border-radius: 50%; border: 1px solid var(--border, #e2eef2); font-size: 0.6rem; color: var(--muted, #7ea5b2); cursor: help;">?</span>
                </div>
                <input style="width: 100%; padding: 6px 10px; border: 1px solid var(--border, #e2eef2); border-radius: 4px; background: var(--input-bg, #f8fcfd); color: inherit; box-sizing: border-box;"
                  .value=${form.deliveryTo} placeholder="ou_xxx / oc_xxx"
                  @input=${(e: Event) => this.updateCronForm({ deliveryTo: (e.target as HTMLInputElement).value })} />
              </div>
            ` : nothing}
          </fieldset>

          <!-- Failure alert -->
          <fieldset style="border: 1px solid var(--border, #e2eef2); border-radius: 6px; padding: 16px; margin-bottom: 20px;">
            <legend style="font-size: 0.85rem; color: var(--muted, #7ea5b2); padding: 0 4px;">${t("cron.form.advanced")}</legend>
            <div style="display: flex; gap: 16px; margin-bottom: 10px;">
              <label style="display: flex; align-items: center; gap: 4px; cursor: pointer;">
                <input type="radio" name="cronFailureAlertMode" value="inherit" .checked=${form.failureAlertMode === "inherit"}
                  @change=${() => this.updateCronForm({ failureAlertMode: "inherit" })} />
                ${t("cron.agentPanel.alertInherit")}
              </label>
              <label style="display: flex; align-items: center; gap: 4px; cursor: pointer;">
                <input type="radio" name="cronFailureAlertMode" value="disabled" .checked=${form.failureAlertMode === "disabled"}
                  @change=${() => this.updateCronForm({ failureAlertMode: "disabled" })} />
                ${t("cron.agentPanel.alertDisabled")}
              </label>
              <label style="display: flex; align-items: center; gap: 4px; cursor: pointer;">
                <input type="radio" name="cronFailureAlertMode" value="custom" .checked=${form.failureAlertMode === "custom"}
                  @change=${() => this.updateCronForm({ failureAlertMode: "custom" })} />
                ${t("cron.agentPanel.alertCustom")}
              </label>
            </div>
            ${form.failureAlertMode === "custom" ? html`
              <div style="display: flex; gap: 12px;">
                <div style="flex: 1;">
                  <div style="font-size: 0.8rem; color: var(--muted, #7ea5b2); margin-bottom: 4px;">${t("cron.agentPanel.alertAfter")}</div>
                  <input type="number" min="1" style="width: 100%; padding: 6px 10px; border: 1px solid var(--border, #e2eef2); border-radius: 4px; background: var(--input-bg, #f8fcfd); color: inherit; box-sizing: border-box;"
                    .value=${form.failureAlertAfter}
                    @input=${(e: Event) => this.updateCronForm({ failureAlertAfter: (e.target as HTMLInputElement).value })} />
                </div>
                <div style="flex: 1;">
                  <div style="font-size: 0.8rem; color: var(--muted, #7ea5b2); margin-bottom: 4px;">${t("cron.agentPanel.alertCooldown")}</div>
                  <input type="number" min="0" style="width: 100%; padding: 6px 10px; border: 1px solid var(--border, #e2eef2); border-radius: 4px; background: var(--input-bg, #f8fcfd); color: inherit; box-sizing: border-box;"
                    .value=${form.failureAlertCooldownSeconds}
                    @input=${(e: Event) => this.updateCronForm({ failureAlertCooldownSeconds: (e.target as HTMLInputElement).value })} />
                </div>
              </div>
            ` : nothing}
          </fieldset>

          ${this.cronError ? html`<div class="form-error" style="margin-bottom: 12px;">${this.cronErrorIsHtml ? unsafeHTML(this.cronError) : this.cronError}</div>` : nothing}

          <div style="display: flex; justify-content: flex-end; gap: 8px;">
            <button class="btn" @click=${() => this.closeCronModal()}>${t("cron.form.cancel")}</button>
            <button class="btn btn-primary" ?disabled=${this.cronBusy} @click=${() => this.saveCronJob()}>
              ${this.cronBusy ? t("cron.form.saving") : (isEditing ? t("cron.form.saveChanges") : t("cron.form.addJob"))}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private updateCronForm(patch: Partial<CronFormState>) {
    const merged = { ...this.cronForm, ...patch };
    // payloadKind is fully derived from sessionTarget (no separate selector)
    merged.payloadKind = merged.sessionTarget === "main" ? "systemEvent" : "agentTurn";
    // deleteAfterRun only makes sense for one-shot "at" schedule
    if (patch.scheduleKind && patch.scheduleKind !== "at") {
      merged.deleteAfterRun = false;
    }
    this.cronForm = normalizeCronFormState(merged);
    this.cronFieldErrors = validateCronForm(this.cronForm);
  }

  private renderPanelEmpty() {
    return html`<div class="empty">${t("common.comingSoon")}</div>`;
  }

  private renderPanelKnowledge(agent: TenantAgent) {
    return renderAgentKnowledge({
      agentId: agent.agentId,
      agentKnowledgeList: this.agentKnowledgeList,
      agentKnowledgeStatus: this.agentKnowledgeStatus,
      agentKnowledgeLoading: this.agentKnowledgeLoading,
      agentKnowledgeError: this.agentKnowledgeError,
      agentKnowledgeFileActive: this.agentKnowledgeFileActive,
      agentKnowledgeFileContents: this.agentKnowledgeFileContents,
      agentKnowledgeFileDrafts: this.agentKnowledgeFileDrafts,
      agentKnowledgeSaving: this.agentKnowledgeSaving,
      onLoadFiles: (agentId) => {
        void this.loadAgentKnowledge(agentId);
        void this.loadAgentKnowledgeStatus(agentId);
      },
      onSelectFile: (name) => {
        const normalized = this.normalizeKnowledgeFileName(name);
        if (!normalized) {
          this.agentKnowledgeError = "Invalid memory file path";
          return;
        }
        this.agentKnowledgeFileActive = normalized;
        if (!Object.hasOwn(this.agentKnowledgeFileContents, normalized)) {
          this.agentKnowledgeFileDrafts = { ...this.agentKnowledgeFileDrafts, [normalized]: "" };
          void this.loadAgentKnowledgeFileContent(agent.agentId, normalized);
        }
      },
      onFileDraftChange: (name, content) => {
        this.agentKnowledgeFileDrafts = { ...this.agentKnowledgeFileDrafts, [name]: content };
      },
      onFileReset: (name) => {
        this.agentKnowledgeFileDrafts = {
          ...this.agentKnowledgeFileDrafts,
          [name]: this.agentKnowledgeFileContents[name] ?? "",
        };
      },
      onFileSave: (name) => void this.saveAgentKnowledgeFile(agent.agentId, name),
      onFileDelete: (name) => void this.deleteAgentKnowledgeFile(agent.agentId, name),
      onFileUpload: (files) => void this.uploadAgentKnowledgeFiles(agent.agentId, files),
      onFileDownload: (name) => void this.downloadAgentKnowledgeFile(agent.agentId, name),
    });
  }

  private async saveSkillsDisabled(agent: TenantAgent, disabled: string[]) {
    this.skillsSaving = true;
    try {
      await this.rpc("tenant.agents.update", { agentId: agent.agentId, skills: disabled });
      this.skillsPendingEnabled = null;
      this.showSuccess("tenantAgents.agentUpdated");
      await this.loadAgents();
    } catch (err) {
      this.showError(err instanceof Error ? err.message : "tenantAgents.saveFailed");
    } finally {
      this.skillsSaving = false;
    }
  }

  private renderPanelSkills(agent: TenantAgent) {
    const translated = (key: string | undefined, raw: string) => { if (!key) {return raw;} const v = t(key); return v === key ? raw : v; };
    const allSkills = this.agentSkills;
    const allSkillNames = allSkills.map((s) => s.name);
    // skills field is now a denylist — names in the array are DISABLED
    const savedDisabled: string[] = Array.isArray((agent as any).skills) ? (agent as any).skills
      : Array.isArray(agent.config?.skills) ? agent.config.skills as string[] : [];
    const disabledSet = new Set(this.skillsPendingEnabled ?? savedDisabled);
    const isDirty = this.skillsPendingEnabled !== null;
    const enabledCount = allSkillNames.length - disabledSet.size;
    const filter = this.skillsFilter.trim().toLowerCase();

    const toggleSkill = (name: string, checked: boolean) => {
      const next = new Set(disabledSet);
      // checked = enable → remove from denylist; unchecked = disable → add to denylist
      checked ? next.delete(name) : next.add(name);
      this.skillsPendingEnabled = [...next];
    };

    const setSkillGroupEnabled = (names: string[], enable: boolean) => {
      const next = new Set(disabledSet);
      for (const n of names) {
        enable ? next.delete(n) : next.add(n);
      }
      this.skillsPendingEnabled = [...next];
    };

    // Group by source
    const allGrouped = new Map<string, typeof allSkills>();
    for (const s of allSkills) {
      const key = s.source || "other";
      if (!allGrouped.has(key)) {allGrouped.set(key, []);}
      allGrouped.get(key)!.push(s);
    }
    const filteredGroups = [...allGrouped.entries()].map(([source, skills]) => ({
      source,
      skills: filter ? skills.filter((s) => [translated(SKILL_LABEL_KEY[s.name], s.name), translated(SKILL_DESC_KEY[s.name], s.description)].join(" ").toLowerCase().includes(filter)) : skills,
    })).filter((g) => g.skills.length > 0);
    const shownCount = filteredGroups.reduce((s, g) => s + g.skills.length, 0);

    return html`
      <div class="panel-header">
        <div class="panel-header-left">
          <div class="panel-title">${t("tenantSkills.skillAccess")} &nbsp;<span style="font-weight:400;font-size:13px;color:var(--text-muted,#525252)"><span class="mono">${enabledCount}/${allSkillNames.length}</span> ${t("tenantAgents.enabled")}</span></div>
        </div>
        <div class="panel-filter panel-filter--inline">
          <input .placeholder=${t("tenantSkills.searchPlaceholder")} .value=${this.skillsFilter}
            @input=${(e: Event) => { this.skillsFilter = (e.target as HTMLInputElement).value; }} />
          <span class="count">${filter ? t("tenantAgents.toolsShown").replace("{count}", String(shownCount)) : ""}</span>
        </div>
        <div class="panel-actions">
          <button class="btn btn-outline btn-sm" ?disabled=${this.skillsSaving}
            @click=${() => { this.skillsPendingEnabled = []; }}>${t("tenantAgents.enableAll")}</button>
          <button class="btn btn-outline btn-sm" ?disabled=${this.skillsSaving}
            @click=${() => { this.skillsPendingEnabled = [...allSkillNames]; }}>${t("tenantAgents.disableAll")}</button>
          <button class="btn btn-outline btn-sm" ?disabled=${!isDirty || this.skillsSaving}
            @click=${() => { this.skillsPendingEnabled = null; }}>${t("tenantAgents.toolsReset")}</button>
          <button class="btn btn-primary btn-sm" ?disabled=${!isDirty || this.skillsSaving}
            @click=${() => this.saveSkillsDisabled(agent, [...disabledSet])}>
            ${this.skillsSaving ? t("tenantAgents.saving") : t("tenantAgents.save")}
          </button>
        </div>
      </div>

      ${this.skillsLoading && allSkills.length === 0 ? html`<div class="loading">${t("tenantSkills.loading")}</div>` : html`

        <div class="skills-groups">
          ${filteredGroups.map(({ source, skills }) => {
            const groupEnabled = skills.filter((s) => !disabledSet.has(s.name)).length;
            const collapsedByDefault = true;
            const groupLabel = source === "enclaws-bundled" ? t("tenantSkills.sourceBundled")
              : source === "enclaws-tenant" ? t("tenantSkills.sourceTenant")
              : source;
            const renderSkillRow = (s: typeof skills[0]) => {
              const allowed = !disabledSet.has(s.name);
              return html`
                <div class="tool-row">
                  <div class="tool-row-info">
                    <div class="tool-row-name">${s.emoji ? `${s.emoji} ` : ""}${translated(SKILL_LABEL_KEY[s.name], s.name)}</div>
                    <div class="tool-row-desc" title=${translated(SKILL_DESC_KEY[s.name], s.description)}>${translated(SKILL_DESC_KEY[s.name], s.description)}</div>
                  </div>
                  <label class="cfg-toggle">
                    <input type="checkbox" .checked=${allowed} ?disabled=${this.skillsSaving}
                      @change=${(e: Event) => toggleSkill(s.name, (e.target as HTMLInputElement).checked)} />
                    <span class="cfg-toggle__track"></span>
                  </label>
                </div>
              `;
            };
            const groupNames = skills.map((s) => s.name);
            return html`
              <details class="skills-group" ?open=${!collapsedByDefault || !!filter}>
                <summary class="skills-header">
                  <span>${groupLabel}</span>
                  <span class="skills-count">${groupEnabled}/${skills.length}</span>
                  <span class="section-actions" @click=${(e: Event) => e.preventDefault()}>
                    <button type="button" class="btn btn-outline btn-xs" ?disabled=${this.skillsSaving}
                      @click=${(e: Event) => { e.stopPropagation(); setSkillGroupEnabled(groupNames, true); }}>
                      ${t("tenantAgents.enableAll")}
                    </button>
                    <button type="button" class="btn btn-outline btn-xs" ?disabled=${this.skillsSaving}
                      @click=${(e: Event) => { e.stopPropagation(); setSkillGroupEnabled(groupNames, false); }}>
                      ${t("tenantAgents.disableAll")}
                    </button>
                  </span>
                </summary>
                ${source === "enclaws-bundled"
                  ? html`<div class="skills-groups" style="padding-left:12px;margin-top:10px;">
                      ${bundledSkillCategories(skills).map((cat) => {
                        const catNames = cat.skills.map((s) => s.name);
                        return html`
                        <details class="skills-group" ?open=${!!filter}>
                          <summary class="skills-header">
                            <span>${cat.label}</span>
                            <span class="skills-count">${cat.skills.filter((s) => !disabledSet.has(s.name)).length}/${cat.skills.length}</span>
                            <span class="section-actions" @click=${(e: Event) => e.preventDefault()}>
                              <button type="button" class="btn btn-outline btn-xs" ?disabled=${this.skillsSaving}
                                @click=${(e: Event) => { e.stopPropagation(); setSkillGroupEnabled(catNames, true); }}>
                                ${t("tenantAgents.enableAll")}
                              </button>
                              <button type="button" class="btn btn-outline btn-xs" ?disabled=${this.skillsSaving}
                                @click=${(e: Event) => { e.stopPropagation(); setSkillGroupEnabled(catNames, false); }}>
                                ${t("tenantAgents.disableAll")}
                              </button>
                            </span>
                          </summary>
                          <div class="tools-list" style="grid-template-columns:1fr;margin-top:10px">
                            ${cat.skills.map(renderSkillRow)}
                          </div>
                        </details>
                      `;
                      })}
                    </div>`
                  : html`<div class="tools-list" style="grid-template-columns:1fr;margin-top:10px">
                      ${skills.map(renderSkillRow)}
                    </div>`
                }
              </details>
            `;
          })}
        </div>
      `}
    `;
  }

  private renderPanelChannels() {
    if (this.channelsLoading) {
      return html`<div class="loading">${t("tenantAgents.loading")}</div>`;
    }
    if (this.agentChannels.length === 0) {
      return html`<div class="empty">${t("tenantAgents.noChannels")}</div>`;
    }
    const iconMap = CHANNEL_ICON_MAP;
    return html`
      <div class="channel-list">
        ${this.agentChannels.map(ch => html`
          <div class="channel-item channel-link" @click=${() => {
            this.dispatchEvent(new CustomEvent("navigate-to-channel", {
              detail: { channelType: ch.channelType },
              bubbles: true, composed: true,
            }));
          }}>
            <span class="channel-type-icon">
              ${iconMap[ch.channelType]
                ? html`<img src="${iconMap[ch.channelType]}" alt="${ch.channelType}" />`
                : html`<span class="channel-type-letter">${ch.channelType.slice(0, 1).toUpperCase()}</span>`}
            </span>
            <div class="channel-item-info">
              <div class="channel-item-row1">
                <span class="channel-item-type">${ch.channelType}</span>
                ${ch.botName ? html`<span class="channel-item-name">${ch.botName}</span>` : nothing}
              </div>
              <div class="channel-item-row2">${ch.appId}</div>
            </div>
            <span class="conn-dot ${ch.connected ? "online" : "offline"}" title="${ch.connected ? t("tenantAgents.channelOnline") : t("tenantAgents.channelOffline")}"></span>
          </div>
        `)}
      </div>
    `;
  }

  private async saveToolsDeny(agent: TenantAgent, deny: string[]) {
    this.toolsSaving = true;
    try {
      const config: Record<string, unknown> = { ...agent.config };
      config.tools = { deny };
      await this.rpc("tenant.agents.update", { agentId: agent.agentId, config });
      this.toolsPendingDeny = null;
      this.showSuccess("tenantAgents.agentUpdated");
      await this.loadAgents();
    } catch (err) {
      this.showError(err instanceof Error ? err.message : "tenantAgents.saveFailed");
    } finally {
      this.toolsSaving = false;
    }
  }

  private renderPanelTools(agent: TenantAgent) {
    const savedDeny: string[] = Array.isArray((agent as any).tools?.deny) && (agent as any).tools.deny.length > 0
      ? (agent as any).tools.deny
      : Array.isArray((agent.config?.tools as { deny?: string[] })?.deny)
        ? (agent.config.tools as { deny: string[] }).deny : [];
    const denySet = new Set(this.toolsPendingDeny ?? savedDeny);
    const isDirty = this.toolsPendingDeny !== null;
    const allIds = this.allToolIds;
    const enabled = allIds.filter((id) => !denySet.has(id) && !this.systemDenySet.has(id)).length;
    const filter = this.toolsFilter.trim().toLowerCase();

    const toggleTool = (id: string, checked: boolean) => {
      if (this.systemDenySet.has(id)) {return;}
      const next = new Set(denySet);
      checked ? next.delete(id) : next.add(id);
      this.toolsPendingDeny = [...next];
    };

    const setGroupEnabled = (ids: string[], enable: boolean) => {
      const next = new Set(denySet);
      for (const id of ids) {
        // System-denied tools stay denied regardless of the bulk action.
        if (this.systemDenySet.has(id)) {continue;}
        enable ? next.delete(id) : next.add(id);
      }
      this.toolsPendingDeny = [...next];
    };

    const filteredGroups = this.toolGroups.map((group) => ({
      ...group,
      tools: filter ? group.tools.filter((tl) => tl.label.toLowerCase().includes(filter) || tl.description.toLowerCase().includes(filter)) : group.tools,
    })).filter((g) => g.tools.length > 0);
    const shownCount = filteredGroups.reduce((s, g) => s + g.tools.length, 0);

    return html`
      <div class="panel-header">
        <div class="panel-header-left">
          <div class="panel-title">${t("tenantAgents.toolAccess")} &nbsp;<span style="font-weight:400;font-size:13px;color:var(--text-muted,#525252)"><span class="mono">${enabled}/${allIds.length}</span> ${t("tenantAgents.enabled")}</span></div>
        </div>
        <div class="panel-filter panel-filter--inline">
          <input .placeholder=${t("tenantAgents.searchTools")} .value=${this.toolsFilter}
            @input=${(e: Event) => { this.toolsFilter = (e.target as HTMLInputElement).value; }} />
          <span class="count">${filter ? t("tenantAgents.toolsShown").replace("{count}", String(shownCount)) : ''}</span>
        </div>
        <div class="panel-actions">
          <button class="btn btn-outline btn-sm" ?disabled=${this.toolsSaving}
            @click=${() => { this.toolsPendingDeny = []; }}>${t("tenantAgents.enableAll")}</button>
          <button class="btn btn-outline btn-sm" ?disabled=${this.toolsSaving}
            @click=${() => { this.toolsPendingDeny = [...allIds]; }}>${t("tenantAgents.disableAll")}</button>
          <button class="btn btn-outline btn-sm" ?disabled=${!isDirty || this.toolsSaving}
            @click=${() => { this.toolsPendingDeny = null; }}>${t("tenantAgents.toolsReset")}</button>
          <button class="btn btn-primary btn-sm" ?disabled=${!isDirty || this.toolsSaving}
            @click=${() => this.saveToolsDeny(agent, [...denySet])}>
            ${this.toolsSaving ? t("tenantAgents.saving") : t("tenantAgents.save")}
          </button>
        </div>
      </div>
      <div class="tools-grid">
        ${filteredGroups.map((group) => {
          const enabledCount = group.tools.filter((tl) => !denySet.has(tl.id) && !this.systemDenySet.has(tl.id)).length;
          return html`
            <details class="tools-section" ?open=${!!filter}>
              <summary class="tools-section-header">
                <span>${group.label}</span>
                <span class="tool-row-source">${enabledCount}/${group.tools.length}</span>
                <span class="section-actions" @click=${(e: Event) => e.preventDefault()}>
                  <button type="button" class="btn btn-outline btn-xs" ?disabled=${this.toolsSaving}
                    @click=${(e: Event) => { e.stopPropagation(); setGroupEnabled(group.tools.map((tl) => tl.id), true); }}>
                    ${t("tenantAgents.enableAll")}
                  </button>
                  <button type="button" class="btn btn-outline btn-xs" ?disabled=${this.toolsSaving}
                    @click=${(e: Event) => { e.stopPropagation(); setGroupEnabled(group.tools.map((tl) => tl.id), false); }}>
                    ${t("tenantAgents.disableAll")}
                  </button>
                </span>
              </summary>
              <div class="tools-list tools-list--wide">
                ${group.tools.map((tool) => {
                  const sysDenied = this.systemDenySet.has(tool.id);
                  const allowed = !sysDenied && !denySet.has(tool.id);
                  return html`
                    <div class="tool-row">
                      <div class="tool-row-info">
                        <div class="tool-row-name" title=${tool.label}>${tool.label}${sysDenied ? html`<span class="tool-badge-platform-denied">${t("tenantAgents.toolSystemDisabled")}</span>` : nothing}</div>
                        <div class="tool-row-desc" title=${tool.description}>${tool.description}</div>
                      </div>
                      ${sysDenied ? html`
                        <label class="cfg-toggle cfg-toggle--disabled"
                          @click=${(e: Event) => { e.preventDefault(); this.showError("tenantAgents.toolSystemDisabled"); }}>
                          <input type="checkbox" .checked=${false} disabled style="pointer-events:none" />
                          <span class="cfg-toggle__track"></span>
                        </label>
                      ` : html`
                        <label class="cfg-toggle">
                          <input type="checkbox" .checked=${allowed} ?disabled=${this.toolsSaving}
                            @change=${(e: Event) => toggleTool(tool.id, (e.target as HTMLInputElement).checked)} />
                          <span class="cfg-toggle__track"></span>
                        </label>
                      `}
                    </div>
                  `;
                })}
              </div>
            </details>
          `;
        })}
      </div>
    `;
  }

  private renderForm() {
    const isEditing = !!this.editingAgentId;
    return html`
      <div class="detail-card">
        <div class="detail-header">
          <div class="detail-name">${isEditing ? t("tenantAgents.editAgent") : t("tenantAgents.createAgent")}</div>
          <button class="btn btn-outline btn-sm" @click=${() => { this.showForm = false; }}>${t("tenantAgents.cancel")}</button>
        </div>
        <form @submit=${this.handleSave}>
          <div class="form-row">
            <div class="form-field">
              <label>${t("tenantAgents.agentDisplayName")}</label>
              <input type="text" .placeholder=${t("tenantAgents.agentDisplayNamePlaceholder")}
                .value=${this.formName}
                @input=${(e: InputEvent) => {
                  this.formName = (e.target as HTMLInputElement).value;
                  if (!isEditing && !this.formAgentIdManuallyEdited) {
                    this.formAgentId = this.toSlug(this.formName);
                  }
                }} />
            </div>
            <div class="form-field">
              <label>Agent ID</label>
              <input type="text" .placeholder=${t("tenantAgents.agentIdPlaceholder")} ?disabled=${isEditing}
                pattern="^[a-z0-9]([a-z0-9_-]{0,62}[a-z0-9])?$"
                .title=${t("tenantAgents.agentIdPattern")}
                .value=${this.formAgentId}
                @input=${(e: InputEvent) => {
                  this.formAgentId = (e.target as HTMLInputElement).value;
                  this.formAgentIdManuallyEdited = true;
                }} />
              <div class="form-hint">
                ${isEditing ? t("tenantAgents.agentIdReadonly") : t("tenantAgents.agentIdHint")}
              </div>
            </div>
          </div>

          <div class="divider"><span>${t("tenantAgents.modelBinding")}</span></div>

          <div class="form-field" style="margin-bottom:0.75rem">
            <label style="display:flex;align-items:center;gap:0.4rem">${t("tenantAgents.modelBinding")} <span class="help-icon" title="${t("tenantAgents.fallbackExplain")}">?</span></label>
            ${this.flatModels.length === 0 ? html`
              <div class="form-hint" style="padding:0.3rem 0">${t("tenantAgents.noModelsAvailable").split(t("tenantAgents.addModelLink"))[0]}<a href=${this.modelManagePath} style="color:var(--accent,#3b82f6);text-decoration:underline;cursor:pointer">${t("tenantAgents.addModelLink")}</a></div>
            ` : html`
              <table class="model-select-table">
                <thead>
                  <tr>
                    <th style="width:2rem"></th>
                    <th>${t("tenantAgents.modelId")}</th>
                    <th>${t("tenantAgents.modelName")}</th>
                    <th>${t("tenantAgents.provider")}</th>
                    <th style="width:4.5rem;text-align:center">${t("tenantAgents.default")}</th>
                  </tr>
                </thead>
                <tbody>
                  ${this.flatModels.map((m) => {
                    const selected = this.isModelSelected(m.providerId, m.modelId);
                    const isDef = this.isModelDefault(m.providerId, m.modelId);
                    return html`
                      <tr>
                        <td><input type="checkbox" .checked=${selected}
                          @change=${() => this.toggleModel(m.providerId, m.modelId)} /></td>
                        <td>${m.modelId}</td>
                        <td>${m.modelName}</td>
                        <td style="color:var(--text-secondary,#a3a3a3)">${m.providerName}</td>
                        <td style="text-align:center">
                          ${selected ? html`<input type="radio" name="defaultModel" .checked=${isDef}
                            @change=${() => this.setDefaultModel(m.providerId, m.modelId)} />` : nothing}
                        </td>
                      </tr>
                    `;
                  })}
                </tbody>
              </table>
              ${this.formModelConfig.length > 0 ? html`
                <div class="form-hint">
                  ${t("tenantAgents.selectedCount").replace("{count}", String(this.formModelConfig.length)).replace("{default}", (() => {
                    const d = this.formModelConfig.find((e) => e.isDefault);
                    if (!d) {return t("tenantAgents.notSet");}
                    const fm = this.flatModels.find((m) => m.providerId === d.providerId && m.modelId === d.modelId);
                    return fm ? `${fm.modelName} (${fm.providerName})` : d.modelId;
                  })())}
                </div>
              ` : nothing}
            `}
          </div>

          <div class="divider"><span>${t("tenantAgents.toolAccess")}</span></div>

          ${this.renderToolsSection()}

          <div style="display:flex;gap:0.5rem;margin-top:1rem">
            <button class="btn btn-primary" type="submit" ?disabled=${this.saving}>
              ${this.saving ? t("tenantAgents.saving") : t("tenantAgents.save")}
            </button>
            <button class="btn btn-outline" type="button" @click=${() => { this.showForm = false; }}>${t("tenantAgents.cancel")}</button>
          </div>
        </form>
      </div>
    `;
  }

  private renderToolsSection() {
    const denySet = new Set(this.formToolsDeny);
    const allIds = this.allToolIds;
    const enabled = allIds.filter((id) => !denySet.has(id) && !this.systemDenySet.has(id)).length;
    return html`
      <div class="tools-section">
        <div class="tools-header" @click=${() => { this.formToolsExpanded = !this.formToolsExpanded; }}>
          <div class="tools-header-left">
            <span class="tools-header-arrow ${this.formToolsExpanded ? "open" : ""}">&#9654;</span>
            <span>${t("tenantAgents.toolAccess")}</span>
          </div>
          <span style="font-size:0.72rem;color:var(--text-muted,#525252)">
            ${t("tenantAgents.toolsEnabled").replace("{enabled}", String(enabled)).replace("{total}", String(allIds.length))}
          </span>
        </div>
        ${this.formToolsExpanded ? html`
          <div class="tools-body">
            <div class="form-hint" style="margin-bottom:0.4rem">${t("tenantAgents.toolsHint")}</div>
            <div class="tools-actions">
              <button type="button" class="btn btn-outline btn-sm" @click=${() => this.toggleAllTools(true)}>${t("tenantAgents.enableAll")}</button>
              <button type="button" class="btn btn-outline btn-sm" @click=${() => this.toggleAllTools(false)}>${t("tenantAgents.disableAll")}</button>
            </div>
            ${this.toolGroups.map((group) => {
              const enabledCount = group.tools.filter((tl) => !denySet.has(tl.id) && !this.systemDenySet.has(tl.id)).length;
              const nonSysDeniedCount = group.tools.filter((tl) => !this.systemDenySet.has(tl.id)).length;
              const allEnabled = enabledCount === nonSysDeniedCount && nonSysDeniedCount > 0;
              const someEnabled = enabledCount > 0 && enabledCount < group.tools.length;
              return html`
                <details class="tools-form-group">
                  <summary class="tools-group-header">
                    <input type="checkbox" class="tools-group-checkbox"
                      .checked=${allEnabled}
                      .indeterminate=${someEnabled}
                      @click=${(e: Event) => e.stopPropagation()}
                      @change=${(e: Event) => { e.stopPropagation(); this.toggleGroupTools(group.id, (e.target as HTMLInputElement).checked); }} />
                    <span class="tools-group-header-label">${group.label}</span>
                    <span class="tools-group-header-count">${enabledCount}/${group.tools.length}</span>
                  </summary>
                  <div class="tools-form-group-body">
                    ${group.tools.map((tool) => {
                      const sysDenied = this.systemDenySet.has(tool.id);
                      return html`
                      <div class="tool-row">
                        <div class="tool-row-info">
                          <span class="tool-row-name">${tool.label}${sysDenied ? html`<span class="tool-badge-platform-denied">${t("tenantAgents.toolSystemDisabled")}</span>` : nothing}</span>
                          <span class="tool-row-desc">${tool.description}</span>
                        </div>
                        ${sysDenied ? html`
                          <span style="position:relative;display:inline-block;cursor:not-allowed;opacity:0.45"
                            @click=${(e: Event) => { e.preventDefault(); this.showError("tenantAgents.toolSystemDisabled"); }}>
                            <input type="checkbox" class="tool-toggle"
                              .checked=${false} disabled
                              style="pointer-events:none"
                              title=${t("tenantAgents.toolSystemDisabled")} />
                          </span>
                        ` : html`
                          <input type="checkbox" class="tool-toggle"
                            .checked=${!denySet.has(tool.id)}
                            @change=${(e: Event) => this.toggleTool(tool.id, (e.target as HTMLInputElement).checked)} />
                        `}
                      </div>
                    `})}
                  </div>
                </details>
              `;
            })}
          </div>
        ` : nothing}
      </div>
    `;
  }
}
