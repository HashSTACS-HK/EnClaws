/**
 * CS API Mode view — AI Service CRUD for Agenora S2 integration.
 *
 * Allows tenant owners/admins to:
 *   - List all AI Services
 *   - Create a new AI Service (name, description, agentId)
 *   - Regenerate the app secret (one-time reveal)
 *   - Delete an AI Service (blocked if active sessions exist)
 *
 * All REST calls go to /api/cs-api/* with JWT Bearer auth.
 * Agent list is fetched via WebSocket RPC (tenant.agents.list).
 *
 * CS API 模式视图 — Agenora S2 集成凭据管理（增删查 + 密钥轮换）。
 * REST 调用使用 JWT Bearer 鉴权；Agent 列表通过 WebSocket RPC 获取。
 */

import { html, css, LitElement, nothing } from "lit";
import { customElement, state, property } from "lit/decorators.js";
import { I18nController, t } from "../../../i18n/index.ts";
import { getAccessToken } from "../../auth-store.ts";
import { showConfirm } from "../../components/confirm-dialog.ts";
import { showSecretReveal } from "../../components/secret-reveal-dialog.ts";
import { caretFix } from "../../shared-styles.ts";
import { loadSettings } from "../../storage.ts";
import { tenantRpc } from "./rpc.ts";
import { applyRecommendedPersona } from "../../lib/apply-recommended-persona.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ApiObject {
  id: string;
  name: string;
  agentId: string | null;
  appId: string;
  isActive: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

interface TenantAgent {
  agentId: string;
  name: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build the HTTP base URL from the stored gateway WebSocket URL.
 * wss://host/base → https://host/base
 * ws://host/base  → http://host/base
 *
 * 将 WebSocket 地址转换为 HTTP 地址，用于 REST 调用。
 */
function resolveHttpBase(): string {
  const ws = loadSettings().gatewayUrl || "";
  return ws.replace(/^wss?:\/\//, (m) => (m.startsWith("wss") ? "https://" : "http://"));
}

/**
 * Attach the current JWT as Authorization: Bearer <token>.
 * 附加 JWT Bearer 认证头。
 */
function authHeaders(): Record<string, string> {
  const token = getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const base = resolveHttpBase();
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
      ...(init.headers as Record<string, string> | undefined),
    },
    credentials: "same-origin",
  });
}

// ── Component ─────────────────────────────────────────────────────────────────

@customElement("cs-api-mode-view")
export class CsApiModeView extends LitElement {
  static styles = [
    caretFix,
    css`
      :host {
        display: block;
      }

      h2 {
        margin: 0 0 4px;
        font-size: 16px;
        font-weight: 600;
      }

      /* Error banner at the top of the view */
      .error-banner {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        background: rgba(127, 29, 29, 0.15);
        border: 1px solid var(--color-danger, #cf222e);
        border-radius: 8px;
        padding: 10px 14px;
        margin-bottom: 16px;
        font-size: 13px;
        color: var(--color-danger, #cf222e);
        line-height: 1.5;
      }

      /* Section header row */
      .header-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 16px;
        gap: 12px;
        flex-wrap: wrap;
      }

      /* Create form */
      .create-form {
        border: 1px solid var(--color-border, #e1e4e8);
        border-radius: 8px;
        padding: 16px 18px;
        margin-bottom: 20px;
        background: var(--color-bg-secondary, #f6f8fa);
      }

      .form-title {
        font-size: 14px;
        font-weight: 600;
        margin: 0 0 14px;
        color: var(--color-text, #1c1c1e);
      }

      .form-group {
        margin-bottom: 14px;
      }
      .form-group label {
        display: block;
        font-size: 13px;
        font-weight: 600;
        margin-bottom: 5px;
        color: var(--color-text, #1c1c1e);
      }

      .required-mark {
        color: var(--color-danger, #cf222e);
        margin-left: 2px;
      }

      input[type="text"],
      textarea,
      select {
        width: 100%;
        max-width: 480px;
        padding: 8px 10px;
        border: 1px solid var(--color-border, #e1e4e8);
        border-radius: 6px;
        font-size: 13px;
        font-family: inherit;
        outline: none;
        background: var(--color-bg, #fff);
        color: var(--color-text, #1c1c1e);
        box-sizing: border-box;
      }
      input[type="text"]:focus,
      textarea:focus,
      select:focus {
        border-color: var(--color-accent, #0969da);
      }

      textarea {
        resize: vertical;
        min-height: 70px;
      }

      .form-actions {
        display: flex;
        gap: 8px;
        margin-top: 4px;
      }

      /* Table */
      .table-wrap {
        border: 1px solid var(--color-border, #e1e4e8);
        border-radius: 8px;
        overflow: hidden;
      }

      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
      }

      thead {
        background: var(--color-bg-secondary, #f6f8fa);
      }
      th {
        text-align: left;
        padding: 9px 14px;
        font-weight: 600;
        font-size: 12px;
        color: var(--color-text-secondary, #6a737d);
        border-bottom: 1px solid var(--color-border, #e1e4e8);
      }
      td {
        padding: 10px 14px;
        border-bottom: 1px solid var(--color-border, #e1e4e8);
        color: var(--color-text, #1c1c1e);
        vertical-align: middle;
      }
      tr:last-child td {
        border-bottom: none;
      }
      tr:hover td {
        background: var(--color-bg-secondary, #f6f8fa);
      }

      .cell-mono {
        font-family: monospace;
        font-size: 12px;
        color: var(--color-text-secondary, #6a737d);
      }

      .cell-actions {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }

      /* Status badge */
      .badge {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 12px;
        font-size: 11px;
        font-weight: 600;
        white-space: nowrap;
      }
      .badge-enabled {
        background: rgba(26, 127, 55, 0.12);
        color: var(--color-success, #1a7f37);
      }
      .badge-disabled {
        background: rgba(106, 115, 125, 0.12);
        color: var(--color-text-secondary, #6a737d);
      }

      /* Disabled row dimming */
      tr.row-inactive td {
        opacity: 0.55;
      }
      tr.row-inactive td.cell-actions-col {
        opacity: 1;
      }

      .btn-toggle-enable {
        background: transparent;
        color: var(--color-success, #1a7f37);
        border-color: var(--color-success, #1a7f37);
      }
      .btn-toggle-disable {
        background: transparent;
        color: var(--color-text-secondary, #6a737d);
        border-color: var(--color-border, #e1e4e8);
      }

      /* Buttons */
      .btn {
        padding: 6px 14px;
        border-radius: 6px;
        font-size: 13px;
        cursor: pointer;
        border: 1px solid transparent;
        font-weight: 500;
        white-space: nowrap;
        font-family: inherit;
      }
      .btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .btn:hover:not(:disabled) {
        opacity: 0.85;
      }

      .btn-primary {
        background: var(--color-accent, #0969da);
        color: #fff;
        border-color: var(--color-accent, #0969da);
      }
      .btn-ghost {
        background: var(--color-bg-secondary, #f6f8fa);
        color: var(--color-text, #1c1c1e);
        border-color: var(--color-border, #e1e4e8);
      }
      .btn-danger-ghost {
        background: transparent;
        color: var(--color-danger, #cf222e);
        border-color: var(--color-danger, #cf222e);
      }

      /* Empty state */
      .empty {
        padding: 40px;
        text-align: center;
        color: var(--color-text-secondary, #6a737d);
        font-size: 13px;
      }

      /* Loading */
      .loading {
        padding: 32px;
        text-align: center;
        color: var(--color-text-secondary, #6a737d);
        font-size: 13px;
      }
    `,
  ];

  /** Gateway URL passed in from app-render. 从 app-render 传入的 Gateway 地址。 */
  @property({ type: String }) gatewayUrl = "";

  @state() private _objects: ApiObject[] = [];
  @state() private _agents: TenantAgent[] = [];
  @state() private _loading = true;
  @state() private _error = "";

  @state() private _showCreate = false;
  @state() private _submitting = false;
  @state() private _busyId: string | null = null;

  // Create form fields
  @state() private _createName = "";
  @state() private _createDescription = "";
  @state() private _createAgentId = "";

  // Persona shortcut state (apply recommended / navigate to persona tab)
  @state() private _personaApplying = false;
  @state() private _personaError = "";

  private _i18n = new I18nController(this);

  connectedCallback() {
    super.connectedCallback();
    void this._load();
  }

  // ── Data loading ────────────────────────────────────────────────────────────

  private async _load() {
    this._loading = true;
    this._error = "";
    try {
      await Promise.all([this._fetchObjects(), this._fetchAgents()]);
    } catch (err) {
      this._error = err instanceof Error ? err.message : t("cs.apiMode.loadError");
    } finally {
      this._loading = false;
    }
  }

  private async _fetchObjects() {
    const res = await apiFetch("/api/cs-api/objects");
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      throw new Error(body.message ?? `HTTP ${res.status}`);
    }
    const data = (await res.json()) as { objects: ApiObject[] };
    this._objects = data.objects ?? [];
  }

  private async _fetchAgents() {
    try {
      const result = (await tenantRpc("tenant.agents.list", {}, this.gatewayUrl || undefined)) as {
        agents: TenantAgent[];
      };
      this._agents = result.agents ?? [];
    } catch {
      // Agents list is best-effort — if it fails, the select will just be empty.
      // Agent 列表失败不阻塞页面，select 为空即可。
      this._agents = [];
    }
  }

  // ── Create ──────────────────────────────────────────────────────────────────

  private async _submitCreate() {
    if (!this._createName.trim()) {
      this._error = t("cs.apiMode.create.nameRequired");
      return;
    }
    this._submitting = true;
    this._error = "";
    try {
      const body: Record<string, unknown> = { name: this._createName.trim() };
      if (this._createDescription.trim()) {
        body.description = this._createDescription.trim();
      }
      if (this._createAgentId) {
        body.agentId = this._createAgentId;
      }

      const res = await apiFetch("/api/cs-api/objects", {
        method: "POST",
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(errBody.message ?? `HTTP ${res.status}`);
      }

      const created = (await res.json()) as {
        id: string;
        appId: string;
        appSecret: string;
        endpointUrl: string;
      };

      // Reset form and hide
      this._createName = "";
      this._createDescription = "";
      this._createAgentId = "";
      this._showCreate = false;

      // Reveal one-time secret (must happen before refetch, which is fine)
      await showSecretReveal({
        appId: created.appId,
        appSecret: created.appSecret,
        endpointUrl: created.endpointUrl,
      });

      // Reload list
      await this._fetchObjects();
    } catch (err) {
      this._error = err instanceof Error ? err.message : t("cs.apiMode.create.error");
    } finally {
      this._submitting = false;
    }
  }

  private _cancelCreate() {
    this._showCreate = false;
    this._createName = "";
    this._createDescription = "";
    this._createAgentId = "";
    this._error = "";
    this._personaError = "";
  }

  // ── Persona shortcuts ────────────────────────────────────────────────────────

  /**
   * Apply the recommended CS persona to the currently selected agent in the create form.
   * 将推荐客服人设写入创建表单中选定的 agent。
   */
  private async _applyPersonaToCreate() {
    if (!this._createAgentId || this._personaApplying) {
      return;
    }
    this._personaApplying = true;
    this._personaError = "";
    try {
      const rpc = (method: string, params?: Record<string, unknown>) =>
        tenantRpc(method, params ?? {}, this.gatewayUrl || undefined);
      const result = await applyRecommendedPersona(this._createAgentId, rpc);
      if (!result.ok && result.error) {
        this._personaError = result.error;
      }
    } finally {
      this._personaApplying = false;
    }
  }

  /**
   * Navigate to the persona tab of the selected agent by dispatching navigate-to-agent.
   * 派发 navigate-to-agent 事件，跳转到选定 agent 的人设与规范标签页。
   */
  private _navigateToPersona() {
    if (!this._createAgentId) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent("navigate-to-agent", {
        bubbles: true,
        composed: true,
        detail: { agentId: this._createAgentId, panel: "persona" },
      }),
    );
  }

  // ── Regenerate secret ───────────────────────────────────────────────────────

  private async _handleRegenerate(obj: ApiObject) {
    if (this._busyId !== null) {
      return;
    }
    const confirmed = await showConfirm({
      title: t("cs.apiMode.regenerate.confirmTitle"),
      message: t("cs.apiMode.regenerate.confirmMessage"),
      confirmText: t("cs.apiMode.regenerate.confirmBtn"),
      danger: true,
    });
    if (!confirmed) {
      return;
    }

    this._busyId = obj.id;
    this._error = "";
    try {
      const res = await apiFetch(
        `/api/cs-api/objects/${encodeURIComponent(obj.id)}/regenerate-secret`,
        {
          method: "POST",
        },
      );
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(errBody.message ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { appSecret: string };

      // Derive endpoint URL same way as backend does
      const base = resolveHttpBase();
      const endpointUrl = `${base}/api/cs-api/${obj.appId}`;

      await showSecretReveal({
        appId: obj.appId,
        appSecret: data.appSecret,
        endpointUrl,
      });

      await this._fetchObjects();
    } catch (err) {
      this._error = err instanceof Error ? err.message : t("cs.apiMode.regenerate.error");
    } finally {
      this._busyId = null;
    }
  }

  // ── Delete ──────────────────────────────────────────────────────────────────

  private async _handleDelete(obj: ApiObject) {
    if (this._busyId !== null) {
      return;
    }
    const confirmed = await showConfirm({
      title: t("cs.apiMode.delete.confirmTitle"),
      message: t("cs.apiMode.delete.confirmMessage", { name: obj.name }),
      confirmText: t("cs.apiMode.delete.confirmBtn"),
      danger: true,
    });
    if (!confirmed) {
      return;
    }

    this._busyId = obj.id;
    this._error = "";
    try {
      const res = await apiFetch(`/api/cs-api/objects/${encodeURIComponent(obj.id)}`, {
        method: "DELETE",
      });
      if (res.status === 409) {
        this._error = t("cs.apiMode.delete.activeSessionsError");
        return;
      }
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(errBody.message ?? `HTTP ${res.status}`);
      }
      await this._fetchObjects();
    } catch (err) {
      if (!this._error) {
        this._error = err instanceof Error ? err.message : t("cs.apiMode.delete.error");
      }
    } finally {
      this._busyId = null;
    }
  }

  // ── Toggle active ───────────────────────────────────────────────────────────

  private async _toggleActive(obj: ApiObject) {
    if (this._busyId !== null) {
      return;
    }
    this._busyId = obj.id;
    this._error = "";
    try {
      const res = await apiFetch(`/api/cs-api/objects/${encodeURIComponent(obj.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !obj.isActive }),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(errBody.message ?? `HTTP ${res.status}`);
      }
      await this._fetchObjects();
    } catch (err) {
      this._error = err instanceof Error ? err.message : t("cs.apiMode.toggle.error");
    } finally {
      this._busyId = null;
    }
  }

  // ── Render helpers ──────────────────────────────────────────────────────────

  private _renderError() {
    if (!this._error) {
      return nothing;
    }
    return html`
      <div class="error-banner">
        <span>⚠ ${this._error}</span>
      </div>
    `;
  }

  private _renderCreateForm() {
    if (!this._showCreate) {
      return nothing;
    }
    return html`
      <div class="create-form">
        <div class="form-title">${t("cs.apiMode.create.title")}</div>

        <div class="form-group">
          <label>${t("cs.apiMode.create.nameLabel")}<span class="required-mark">*</span></label>
          <input
            type="text"
            placeholder=${t("cs.apiMode.create.namePlaceholder")}
            .value=${this._createName}
            @input=${(e: Event) => {
              this._createName = (e.target as HTMLInputElement).value;
            }}
          />
        </div>

        <div class="form-group">
          <label>${t("cs.apiMode.create.descLabel")}</label>
          <textarea
            placeholder=${t("cs.apiMode.create.descPlaceholder")}
            .value=${this._createDescription}
            @input=${(e: Event) => {
              this._createDescription = (e.target as HTMLTextAreaElement).value;
            }}
          ></textarea>
        </div>

        <div class="form-group">
          <label>${t("cs.apiMode.create.agentLabel")}</label>
          <select
            .value=${this._createAgentId}
            @change=${(e: Event) => {
              this._createAgentId = (e.target as HTMLSelectElement).value;
              this._personaError = "";
            }}
          >
            <option value="">${t("cs.apiMode.create.agentNone")}</option>
            ${this._agents.map(
              (a) => html`
              <option value=${a.agentId}>${a.name ?? a.agentId}</option>
            `,
            )}
          </select>
          <div style="display: flex; gap: 0.5rem; margin-top: 0.5rem; align-items: center; flex-wrap: wrap;">
            <button
              type="button"
              ?disabled=${!this._createAgentId || this._personaApplying}
              @click=${() => { void this._applyPersonaToCreate(); }}
              style="padding: 0.35rem 0.8rem; background: var(--accent, #3b82f6); color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 0.82rem; white-space: nowrap;"
            >
              ${this._personaApplying
                ? t("agents.persona.recommended.applying")
                : t("agents.persona.recommended.btn")}
            </button>
            <button
              type="button"
              ?disabled=${!this._createAgentId}
              @click=${() => { this._navigateToPersona(); }}
              style="padding: 0.35rem 0.8rem; background: transparent; color: var(--text-1, #e5e7eb); border: 1px solid var(--border, #374151); border-radius: 6px; cursor: pointer; font-size: 0.82rem; white-space: nowrap;"
            >
              ${t("agents.persona.recommended.manualEditBtn")}
            </button>
            ${this._personaError
              ? html`<span style="color: var(--danger, #ef4444); font-size: 0.8rem;">${this._personaError}</span>`
              : nothing}
          </div>
        </div>

        <div class="form-actions">
          <button
            class="btn btn-primary"
            ?disabled=${this._submitting}
            @click=${() => this._submitCreate()}
          >${this._submitting ? t("cs.apiMode.create.submitting") : t("cs.apiMode.create.submitBtn")}</button>
          <button
            class="btn btn-ghost"
            ?disabled=${this._submitting}
            @click=${() => this._cancelCreate()}
          >${t("cs.apiMode.create.cancelBtn")}</button>
        </div>
      </div>
    `;
  }

  private _formatDate(iso: string | null): string {
    if (!iso) {
      return "—";
    }
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }

  private _agentName(agentId: string | null): string {
    if (!agentId) {
      return "—";
    }
    const agent = this._agents.find((a) => a.agentId === agentId);
    return agent?.name ?? agentId;
  }

  private _renderTable() {
    if (this._objects.length === 0) {
      return html`
        <div class="table-wrap">
          <div class="empty">${t("cs.apiMode.emptyState")}</div>
        </div>
      `;
    }

    return html`
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>${t("cs.apiMode.table.name")}</th>
              <th>${t("cs.apiMode.table.agent")}</th>
              <th>${t("cs.apiMode.table.appId")}</th>
              <th>${t("cs.apiMode.table.status")}</th>
              <th>${t("cs.apiMode.table.lastUsed")}</th>
              <th>${t("cs.apiMode.table.actions")}</th>
            </tr>
          </thead>
          <tbody>
            ${this._objects.map(
              (obj) => html`
              <tr class=${obj.isActive ? "" : "row-inactive"}>
                <td>${obj.name}</td>
                <td>${this._agentName(obj.agentId)}</td>
                <td class="cell-mono">${obj.appId}</td>
                <td>
                  <span class=${obj.isActive ? "badge badge-enabled" : "badge badge-disabled"}>
                    ${obj.isActive ? t("cs.apiMode.table.statusEnabled") : t("cs.apiMode.table.statusDisabled")}
                  </span>
                </td>
                <td>${this._formatDate(obj.lastUsedAt)}</td>
                <td class="cell-actions-col">
                  <div class="cell-actions">
                    <button
                      class=${obj.isActive ? "btn btn-toggle-disable" : "btn btn-toggle-enable"}
                      ?disabled=${this._busyId !== null}
                      @click=${() => this._toggleActive(obj)}
                    >${obj.isActive ? t("cs.apiMode.table.toggleDisableBtn") : t("cs.apiMode.table.toggleEnableBtn")}</button>
                    <button
                      class="btn btn-ghost"
                      ?disabled=${this._busyId !== null}
                      @click=${() => this._handleRegenerate(obj)}
                    >${t("cs.apiMode.table.regenerateBtn")}</button>
                    <button
                      class="btn btn-danger-ghost"
                      ?disabled=${this._busyId !== null}
                      @click=${() => this._handleDelete(obj)}
                    >${t("cs.apiMode.table.deleteBtn")}</button>
                  </div>
                </td>
              </tr>
            `,
            )}
          </tbody>
        </table>
      </div>
    `;
  }

  render() {
    if (this._loading) {
      return html`<div class="loading">${t("cs.apiMode.loading")}</div>`;
    }

    return html`
      ${this._renderError()}

      <div class="header-row">
        <h2>${t("cs.apiMode.title")}</h2>
        <button
          class="btn btn-primary"
          @click=${() => {
            this._showCreate = !this._showCreate;
            this._error = "";
          }}
        >${t("cs.apiMode.newBtn")}</button>
      </div>

      ${this._renderCreateForm()}
      ${this._renderTable()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cs-api-mode-view": CsApiModeView;
  }
}
