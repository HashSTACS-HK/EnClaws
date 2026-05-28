import { html, css, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { t, I18nController } from "../../i18n/index.ts";
import { tenantRpc } from "./tenant/rpc.ts";
import { caretFix } from "../shared-styles.ts";
import {
  TOOL_GROUP_DEFS,
  GROUP_LABEL_KEY,
  TOOL_LABEL_KEY,
  TOOL_DESC_KEY,
} from "./tool-group-defs.ts";

// ── Types ──────────────────────────────────────────────────────────────

type ToolDef = { id: string; label: string; description: string };
type ToolGroup = { id: string; label: string; tools: ToolDef[] };

@customElement("platform-tools-view")
export class PlatformToolsView extends LitElement {
  private i18nCtrl = new I18nController(this);

  @state() private filter = "";
  @state() private savedDeny: string[] = [];
  @state() private pendingDeny: string[] | null = null;
  @state() private saving = false;
  @state() private loading = true;
  @state() private catalogGroups: ToolGroup[] | null = null;
  @state() private error = "";

  static styles = [caretFix, css`
    :host {
      display: block;
      font-family: var(--font-sans, system-ui, sans-serif);
      color: var(--text, #e5e5e5);
    }

    /* ── Page header ── */
    .page-header {
      display: flex; justify-content: space-between; align-items: flex-start;
      margin-bottom: 1.5rem; flex-wrap: wrap; gap: 0.75rem;
    }
    .page-title { font-size: 18px; font-weight: 600; letter-spacing: -0.02em; }
    .page-sub { font-size: 13px; color: var(--text-muted, #525252); margin-top: 4px; line-height: 1.5; }

    /* ── Info banner ── */
    .info-banner {
      display: flex; align-items: flex-start; gap: 10px;
      padding: 12px 14px; margin-bottom: 1.25rem;
      background: var(--bg-elevated, #1f1f1f);
      border: 1px solid var(--border, #303030);
      border-radius: var(--radius-md, 6px);
      font-size: 13px; color: var(--text-muted, #525252); line-height: 1.6;
    }
    .info-banner svg { flex-shrink: 0; margin-top: 2px; color: var(--accent, #3b82f6); }

    /* ── Toolbar ── */
    .toolbar {
      display: flex; align-items: center; gap: 0.5rem;
      margin-bottom: 1rem; flex-wrap: wrap;
    }
    .toolbar-left { display: flex; align-items: center; gap: 0.5rem; flex: 1; min-width: 0; }
    .toolbar input {
      flex: 1; min-width: 160px; padding: 6px 10px;
      background: var(--bg, #0a0a0a); border: 1px solid var(--border, #303030);
      border-radius: var(--radius-md, 6px); color: var(--text, #e5e5e5);
      font-size: 13px; outline: none;
      font-family: var(--font-sans, system-ui, sans-serif);
    }
    .toolbar input:focus { border-color: var(--accent, #3b82f6); }
    .count { font-size: 13px; color: var(--text-muted, #525252); white-space: nowrap; }
    .toolbar-actions { display: flex; gap: 0.4rem; align-items: center; flex-shrink: 0; }

    /* ── Stats strip ── */
    .stats-strip {
      display: flex; gap: 1.5rem; margin-bottom: 1.25rem;
      padding: 10px 14px;
      background: var(--bg-elevated, #1f1f1f);
      border: 1px solid var(--border, #303030);
      border-radius: var(--radius-md, 6px);
    }
    .stat { display: flex; flex-direction: column; gap: 2px; }
    .stat-value { font-size: 20px; font-weight: 700; letter-spacing: -0.03em; }
    .stat-label { font-size: 11px; color: var(--text-muted, #525252); }
    .stat-value.ok { color: var(--ok, #52c41a); }
    .stat-value.warn { color: var(--destructive, #ff4d4f); }

    /* ── Tool grid ── */
    .tools-grid { display: grid; gap: 16px; }
    .tools-section {
      border: 1px solid var(--border, #303030);
      border-radius: var(--radius-md, 6px);
      padding: 10px; background: var(--bg, #0a0a0a);
    }
    .tools-section > summary { list-style: none; cursor: pointer; }
    .tools-section > summary::-webkit-details-marker { display: none; }
    .tools-section > summary::marker { content: ""; }
    .tools-section[open] > .tools-list { margin-top: 10px; }
    .tools-section-header {
      font-weight: 600; font-size: 13px;
      display: flex; align-items: center; gap: 8px;
    }
    .tools-section-header > .section-count { margin-left: auto; }
    .section-actions { display: inline-flex; gap: 6px; }
    .btn.btn-xs { padding: 2px 8px; font-size: 11px; line-height: 1.4; }
    .tools-section-header::after {
      content: "\u25B8"; font-size: 12px; color: var(--text-muted, #525252);
      transition: transform 0.15s ease;
    }
    .tools-section[open] > .tools-section-header::after { transform: rotate(90deg); }
    .section-count { font-size: 11px; font-weight: 400; color: var(--text-muted, #525252); }
    .tools-list {
      display: grid; gap: 8px 12px;
      grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
    }
    /* 长描述组：改单列，描述完整展开不截断。 */
    .tools-list--wide { grid-template-columns: 1fr; }
    .tools-list--wide .tool-row-desc {
      display: block; -webkit-line-clamp: unset; line-clamp: unset;
      white-space: normal; overflow: visible; text-overflow: clip;
    }
    .tool-row {
      display: flex; justify-content: space-between; align-items: flex-start; gap: 12px;
      padding: 6px 8px; border: 1px solid var(--border, #303030);
      border-radius: var(--radius-md, 6px); background: var(--bg-elevated, #1f1f1f);
    }
    .tool-row-info { flex: 1; min-width: 0; overflow: hidden; }
    .tool-row-name {
      font-weight: 600; font-size: 13px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .tool-row-source {
      font-size: 11px; color: var(--text-muted, #525252);
      margin-left: 6px; opacity: 0.8;
    }
    .tool-row-desc {
      color: var(--text-muted, #525252); font-size: 11px; margin-top: 2px;
      display: -webkit-box; -webkit-box-orient: vertical;
      -webkit-line-clamp: 3; line-clamp: 3;
      overflow: hidden; text-overflow: ellipsis;
    }

    /* ── Toggle switch ── */
    .cfg-toggle { position: relative; flex-shrink: 0; }
    .cfg-toggle input { position: absolute; opacity: 0; width: 0; height: 0; }
    .cfg-toggle__track {
      display: block; width: 50px; height: 28px;
      background: var(--bg-elevated, #1f1f1f); border: 1px solid var(--border-strong, #424242);
      border-radius: var(--radius-full, 9999px); position: relative; cursor: pointer;
      transition: background var(--duration-normal, 200ms) ease,
                  border-color var(--duration-normal, 200ms) ease;
    }
    .cfg-toggle__track::after {
      content: ""; position: absolute; top: 3px; left: 3px;
      width: 20px; height: 20px; border-radius: var(--radius-full, 9999px);
      background: var(--text, #e5e5e5); box-shadow: var(--shadow-sm, 0 1px 2px rgba(0,0,0,.06));
      transition: transform var(--duration-normal, 200ms) var(--ease-out, cubic-bezier(.16,1,.3,1)),
                  background var(--duration-normal, 200ms) ease;
    }
    .cfg-toggle input:checked + .cfg-toggle__track { background: var(--ok-subtle); border-color: rgba(34,197,94,0.4); }
    .cfg-toggle input:checked + .cfg-toggle__track::after { transform: translateX(22px); background: var(--ok, #52c41a); }
    .cfg-toggle input:disabled + .cfg-toggle__track { cursor: not-allowed; }

    /* ── Buttons ── */
    .btn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px;
           border-radius: var(--radius-md, 6px); font-size: 13px; font-weight: 500;
           cursor: pointer; border: 1px solid transparent; transition: background 0.15s, border-color 0.15s;
           font-family: var(--font-sans, system-ui, sans-serif); }
    .btn:disabled { opacity: 0.45; cursor: not-allowed; }
    .btn-outline { background: transparent; border-color: var(--border-strong, #424242); color: var(--text, #e5e5e5); }
    .btn-outline:hover:not(:disabled) { background: var(--bg-hover, #2a2a2a); }
    .btn-primary { background: var(--accent, #3b82f6); color: #fff; border-color: var(--accent, #3b82f6); }
    .btn-primary:hover:not(:disabled) { filter: brightness(1.1); }
    .btn-sm { padding: 4px 10px; font-size: 12px; }

    /* ── Empty / unsaved indicator ── */
    .dirty-dot {
      display: inline-block; width: 7px; height: 7px; border-radius: 50%;
      background: var(--warning, #f59e0b); margin-left: 6px; vertical-align: middle;
    }
    .error-banner {
      padding: 10px 14px; margin-bottom: 1rem;
      background: var(--bg-destructive, #7f1d1d); color: var(--text-destructive, #fca5a5);
      border-radius: var(--radius-md, 6px); font-size: 13px;
    }
  `];

  connectedCallback() {
    super.connectedCallback();
    this.loadData();
  }

  private async loadData() {
    this.loading = true;
    this.error = "";
    try {
      const [catalogRes, toolsRes] = await Promise.all([
        tenantRpc("tools.catalog", { includePlugins: true }) as Promise<{
          groups?: Array<{ id: string; label: string; tools: Array<{ id: string; label: string; description: string }> }>;
        }>,
        tenantRpc("sys.tools.get") as Promise<{ deny?: string[] }>,
      ]);
      if (catalogRes.groups?.length) {
        this.catalogGroups = catalogRes.groups.map((g) => ({
          id: g.id,
          label: g.label,
          tools: g.tools.map((tl) => ({ id: tl.id, label: tl.label, description: tl.description })),
        }));
      }
      this.savedDeny = toolsRes.deny ?? [];
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
    }
  }

  private get toolGroups(): ToolGroup[] {
    const translated = (key: string | undefined, raw: string) => {
      if (!key) {return raw;}
      const v = t(key);
      return v === key ? raw : v;
    };
    if (this.catalogGroups) {
      return this.catalogGroups.map((g) => ({
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
        label: td.labelKey ? translated(td.labelKey, td.label) : td.label,
        description: t(td.descKey),
      })),
    }));
  }

  private get allToolIds(): string[] {
    return this.toolGroups.flatMap((g) => g.tools.map((tl) => tl.id));
  }

  private get effectiveDeny(): Set<string> {
    return new Set(this.pendingDeny ?? this.savedDeny);
  }

  private get isDirty(): boolean {
    return this.pendingDeny !== null;
  }

  private toggleTool(id: string, checked: boolean) {
    const next = new Set(this.effectiveDeny);
    checked ? next.delete(id) : next.add(id);
    this.pendingDeny = [...next];
  }

  private setGroupEnabled(ids: string[], enable: boolean) {
    const next = new Set(this.effectiveDeny);
    for (const id of ids) {
      enable ? next.delete(id) : next.add(id);
    }
    this.pendingDeny = [...next];
  }

  private async handleSave() {
    if (!this.pendingDeny) {return;}
    this.saving = true;
    this.error = "";
    try {
      const deny = [...this.pendingDeny];
      await tenantRpc("sys.tools.update", { deny });
      this.savedDeny = deny;
      this.pendingDeny = null;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.saving = false;
    }
  }

  render() {
    if (this.loading) {
      return html`<div style="padding:2rem;text-align:center;color:var(--text-muted,#525252)">Loading...</div>`;
    }

    const allIds = this.allToolIds;
    const denySet = this.effectiveDeny;
    const enabled = allIds.filter((id) => !denySet.has(id)).length;
    const denied = allIds.length - enabled;
    const filter = this.filter.trim().toLowerCase();

    const filteredGroups = this.toolGroups.map((g) => ({
      ...g,
      tools: filter
        ? g.tools.filter((tl) => tl.label.toLowerCase().includes(filter) || tl.description.toLowerCase().includes(filter))
        : g.tools,
    })).filter((g) => g.tools.length > 0);

    const shownCount = filteredGroups.reduce((s, g) => s + g.tools.length, 0);

    return html`
      ${this.error ? html`<div class="error-banner">${this.error}</div>` : nothing}

      <!-- Page header -->
      <div class="page-header">
        <div>
          <div class="page-title">
            ${t("tabs.platform-tools")}
            ${this.isDirty ? html`<span class="dirty-dot" title="Unsaved changes"></span>` : nothing}
          </div>
          <div class="page-sub">${t("subtitles.platform-tools")}</div>
        </div>
      </div>

      <!-- Info banner -->
      <div class="info-banner">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <span>
          ${t("platformTools.infoBanner")}
        </span>
      </div>

      <!-- Stats strip -->
      <div class="stats-strip">
        <div class="stat">
          <div class="stat-value">${allIds.length}</div>
          <div class="stat-label">${t("platformTools.statsTotal")}</div>
        </div>
        <div class="stat">
          <div class="stat-value ok">${enabled}</div>
          <div class="stat-label">${t("platformTools.statsEnabled")}</div>
        </div>
        <div class="stat">
          <div class="stat-value ${denied > 0 ? "warn" : ""}">${denied}</div>
          <div class="stat-label">${t("platformTools.statsDenied")}</div>
        </div>
      </div>

      <!-- Toolbar -->
      <div class="toolbar">
        <div class="toolbar-left">
          <input
            .placeholder=${t("tenantAgents.searchTools")}
            .value=${this.filter}
            @input=${(e: Event) => { this.filter = (e.target as HTMLInputElement).value; }}
          />
          <span class="count">${filter ? t("tenantAgents.toolsShown").replace("{count}", String(shownCount)) : ""}</span>
        </div>
        <div class="toolbar-actions">
          <button class="btn btn-outline btn-sm" ?disabled=${this.saving}
            @click=${() => { this.pendingDeny = []; }}>
            ${t("tenantAgents.enableAll")}
          </button>
          <button class="btn btn-outline btn-sm" ?disabled=${this.saving}
            @click=${() => { this.pendingDeny = [...allIds]; }}>
            ${t("tenantAgents.disableAll")}
          </button>
          <button class="btn btn-outline btn-sm" ?disabled=${!this.isDirty || this.saving}
            @click=${() => { this.pendingDeny = null; }}>
            ${t("tenantAgents.toolsReset")}
          </button>
          <button class="btn btn-primary btn-sm" ?disabled=${!this.isDirty || this.saving}
            @click=${() => this.handleSave()}>
            ${this.saving ? t("tenantAgents.saving") : t("tenantAgents.save")}
          </button>
        </div>
      </div>

      <!-- Tool grid -->
      <div class="tools-grid">
        ${filteredGroups.map((group) => {
          const groupEnabled = group.tools.filter((tl) => !denySet.has(tl.id)).length;
          return html`
            <details class="tools-section" ?open=${!!filter}>
              <summary class="tools-section-header">
                <span>${group.label}</span>
                <span class="section-count">${groupEnabled}/${group.tools.length}</span>
                <span class="section-actions" @click=${(e: Event) => e.preventDefault()}>
                  <button type="button" class="btn btn-outline btn-xs" ?disabled=${this.saving}
                    @click=${(e: Event) => { e.stopPropagation(); this.setGroupEnabled(group.tools.map((tl) => tl.id), true); }}>
                    ${t("tenantAgents.enableAll")}
                  </button>
                  <button type="button" class="btn btn-outline btn-xs" ?disabled=${this.saving}
                    @click=${(e: Event) => { e.stopPropagation(); this.setGroupEnabled(group.tools.map((tl) => tl.id), false); }}>
                    ${t("tenantAgents.disableAll")}
                  </button>
                </span>
              </summary>
              <div class="tools-list tools-list--wide">
                ${group.tools.map((tool) => {
                  const allowed = !denySet.has(tool.id);
                  return html`
                    <div class="tool-row">
                      <div class="tool-row-info">
                        <div class="tool-row-name" title=${tool.label}>
                          ${tool.label}
                        </div>
                        <div class="tool-row-desc" title=${tool.description}>${tool.description}</div>
                      </div>
                      <label class="cfg-toggle">
                        <input type="checkbox" .checked=${allowed} ?disabled=${this.saving}
                          @change=${(e: Event) => this.toggleTool(tool.id, (e.target as HTMLInputElement).checked)} />
                        <span class="cfg-toggle__track"></span>
                      </label>
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
}
