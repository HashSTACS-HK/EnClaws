/**
 * Tenant settings view — manage enterprise name and identity prompt.
 */

import { html, css, LitElement, nothing } from "lit";
import { customElement, state, property } from "lit/decorators.js";
import { t, I18nController } from "../../../i18n/index.ts";
import { loadAuth } from "../../auth-store.ts";
import { caretFix } from "../../shared-styles.ts";
import { tenantRpc } from "./rpc.ts";

@customElement("tenant-settings-view")
export class TenantSettingsView extends LitElement {
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
      h2 {
        margin: 0 0 1.5rem;
        font-size: 1.1rem;
        font-weight: 600;
      }
      .card {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        padding: 1.25rem;
        margin-bottom: 1.5rem;
      }
      .form-field {
        margin-bottom: 1rem;
      }
      .form-field label {
        display: block;
        font-size: 0.8rem;
        margin-bottom: 0.3rem;
        color: var(--text-2);
      }
      .form-field input,
      .form-field textarea {
        width: 100%;
        padding: 0.45rem 0.65rem;
        background: var(--input-bg);
        border: 1px solid var(--input-border);
        border-radius: var(--radius-md);
        color: var(--text);
        font-size: 0.85rem;
        outline: none;
        box-sizing: border-box;
        font-family: inherit;
      }
      .form-field input:focus,
      .form-field textarea:focus {
        border-color: var(--accent);
      }
      .form-field textarea {
        min-height: 120px;
        resize: vertical;
      }
      .form-field .hint {
        font-size: 0.75rem;
        color: var(--text-3);
        margin-top: 0.25rem;
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
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .btn-primary {
        background: var(--accent);
        color: var(--accent-foreground);
      }
      .btn-secondary {
        background: var(--input-bg);
        border: 1px solid var(--input-border);
        color: var(--text);
      }
      .btn-danger {
        background: var(--danger);
        color: var(--danger-foreground, white);
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
      .success-msg {
        background: var(--ok-subtle);
        border: 1px solid var(--ok);
        border-radius: var(--radius-md);
        color: var(--ok);
        padding: 0.5rem 0.75rem;
        font-size: 0.8rem;
        margin-bottom: 1rem;
      }
      .loading {
        text-align: center;
        padding: 2rem;
        color: var(--muted);
      }
      .actions {
        margin-top: 1rem;
        display: flex;
        gap: 0.75rem;
        flex-wrap: wrap;
      }
      .form-field.readonly {
        display: block;
      }
      .form-field.readonly label {
        margin-bottom: 0.3rem;
      }
      .tenant-id-row {
        display: flex;
        align-items: center;
        gap: 0.5rem;
      }
      .tenant-id-value {
        font-family: var(--font-mono, monospace);
        font-size: 0.85rem;
        color: var(--text);
        flex: 1;
        word-break: break-all;
        min-height: 2.4rem;
        padding: 0.45rem 0.65rem;
        background: var(--input-bg);
        border: 1px solid var(--input-border);
        border-radius: var(--radius-md);
        box-sizing: border-box;
        display: flex;
        align-items: center;
      }
      .btn-copy {
        padding: 0.3rem 0.65rem;
        border: 1px solid var(--input-border);
        border-radius: var(--radius-md);
        background: var(--input-bg);
        color: var(--text-2);
        font-size: 0.8rem;
        cursor: pointer;
        white-space: nowrap;
        transition: opacity 0.15s;
      }
      .btn-copy:hover {
        opacity: 0.8;
      }
      .embed-details {
        margin-top: 1.5rem;
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        background: var(--card);
        overflow: hidden;
      }
      .embed-summary {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        padding: 1rem 1.25rem;
        cursor: pointer;
        user-select: none;
      }
      .embed-summary-title {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
      }
      .embed-summary-title strong {
        font-size: 1rem;
      }
      .embed-summary-title span {
        color: var(--text-3);
        font-size: 0.8rem;
      }
      .embed-summary-meta {
        flex-shrink: 0;
        color: var(--text-2);
        font-size: 0.8rem;
      }
      .embed-details-body {
        border-top: 1px solid var(--border);
        padding: 1.25rem;
      }
      .embed-row {
        display: grid;
        grid-template-columns: minmax(140px, 1fr) minmax(120px, 0.8fr) minmax(120px, 0.8fr);
        gap: 0.75rem;
        padding: 0.75rem 0;
        border-bottom: 1px solid var(--border);
        font-size: 0.85rem;
      }
      .embed-row:last-child {
        border-bottom: 0;
      }
      .embed-label {
        color: var(--text-3);
        font-size: 0.78rem;
        margin-bottom: 0.25rem;
      }
      .embed-value {
        color: var(--text);
        font-family: var(--font-mono, monospace);
        word-break: break-all;
      }
      .status-pill {
        display: inline-flex;
        align-items: center;
        width: fit-content;
        padding: 0.18rem 0.55rem;
        border: 1px solid var(--border);
        border-radius: 999px;
        font-size: 0.78rem;
      }
      .status-pill.active {
        color: var(--ok);
        background: var(--ok-subtle);
        border-color: var(--ok);
      }
      .one-time-key {
        margin-top: 1rem;
        padding: 0.9rem;
        border: 1px solid var(--warn, #f59e0b);
        border-radius: var(--radius-md);
        background: var(--warn-subtle, rgba(245, 158, 11, 0.12));
      }
      .one-time-key textarea {
        margin-top: 0.5rem;
        width: 100%;
        min-height: 4.5rem;
        resize: vertical;
        font-family: var(--font-mono, monospace);
      }
    `,
  ];

  @property({ type: String }) gatewayUrl = "";
  @state() private loading = false;
  @state() private saving = false;
  /** Stores i18n key or raw server message; translated at render time. */
  @state() private errorKey = "";
  @state() private successKey = "";
  private msgTimer?: ReturnType<typeof setTimeout>;
  @state() private name = "";
  @state() private identityPrompt = "";
  @state() private memoryContent = "";
  @state() private memorySaving = false;
  @state() private memorySuccess = "";
  @state() private _copiedTenantId = false;
  @state() private embedSsoKeys: Array<{
    id: string;
    keyPrefix: string;
    isActive: boolean;
    usageCount: number;
    lastUsedAt?: string | null;
    createdAt?: string;
  }> = [];
  @state() private embedSsoRawKey = "";
  @state() private embedSsoBusy = false;
  @state() private _copiedEmbedKey = false;
  @state() private showAllEmbedSsoKeys = false;
  @state() private embedSsoDetailsOpen = false;
  private _copyTimer?: ReturnType<typeof setTimeout>;

  connectedCallback() {
    super.connectedCallback();
    this.loadSettings();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    clearTimeout(this._copyTimer);
  }

  private async _copyTenantId(id: string) {
    try {
      await navigator.clipboard.writeText(id);
      this._copiedTenantId = true;
      clearTimeout(this._copyTimer);
      this._copyTimer = setTimeout(() => {
        this._copiedTenantId = false;
      }, 2000);
    } catch {
      // Clipboard not available in non-secure context — ignore.
    }
  }

  private async _copyEmbedKey(key: string) {
    try {
      await navigator.clipboard.writeText(key);
      this._copiedEmbedKey = true;
      clearTimeout(this._copyTimer);
      this._copyTimer = setTimeout(() => {
        this._copiedEmbedKey = false;
      }, 2000);
    } catch {
      // Clipboard not available in non-secure context.
    }
  }

  private rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return tenantRpc(method, params, this.gatewayUrl);
  }

  private showError(key: string) {
    this.errorKey = key;
    this.successKey = "";
    if (this.msgTimer) {
      clearTimeout(this.msgTimer);
    }
    this.msgTimer = setTimeout(() => (this.errorKey = ""), 5000);
  }

  private showSuccess(key: string) {
    this.successKey = key;
    this.errorKey = "";
    if (this.msgTimer) {
      clearTimeout(this.msgTimer);
    }
    this.msgTimer = setTimeout(() => (this.successKey = ""), 5000);
  }

  /** Translate key at render time; map known server errors, otherwise return as-is. */
  private tr(key: string): string {
    const result = t(key);
    return result === key ? key : result;
  }

  private async loadSettings() {
    this.loading = true;
    this.errorKey = "";
    try {
      const result = (await this.rpc("tenant.settings.get")) as {
        name: string;
        identityPrompt: string;
      };
      this.name = result.name ?? "";
      this.identityPrompt = result.identityPrompt ?? "";
      // Load memory content
      try {
        const memResult = (await this.rpc("tenant.memory.get")) as { content: string };
        this.memoryContent = memResult.content ?? "";
      } catch {
        // Memory may not be available yet
      }
      await this.loadEmbedSsoStatus();
    } catch (err) {
      this.showError(err instanceof Error ? err.message : "tenantSettings.loadFailed");
    } finally {
      this.loading = false;
    }
  }

  private async loadEmbedSsoStatus() {
    const result = (await this.rpc("tenant.embedSso.status")) as {
      keys?: typeof this.embedSsoKeys;
    };
    this.embedSsoKeys = result.keys ?? [];
  }

  private async rotateEmbedSsoKey() {
    const ok = window.confirm(
      "将生成新的免登嵌入 API Key，并停用当前已启用的 Key。请确认九米后台更新保存后再关闭本窗口。",
    );
    if (!ok) {
      return;
    }
    this.embedSsoBusy = true;
    this.errorKey = "";
    this.embedSsoRawKey = "";
    try {
      const result = (await this.rpc("tenant.embedSso.rotate")) as {
        key: string;
        record: (typeof this.embedSsoKeys)[number];
      };
      this.embedSsoRawKey = result.key;
      await this.loadEmbedSsoStatus();
      this.showSuccess("免登嵌入 API Key 已生成。");
    } catch (err) {
      this.showError(err instanceof Error ? err.message : "免登嵌入 API Key 生成失败。");
    } finally {
      this.embedSsoBusy = false;
    }
  }

  private async revokeEmbedSsoKey(keyId: string) {
    const ok = window.confirm("停用后，使用该 Key 的外部系统将无法再生成免登令牌。确定停用吗？");
    if (!ok) {
      return;
    }
    this.embedSsoBusy = true;
    this.errorKey = "";
    try {
      await this.rpc("tenant.embedSso.revoke", { keyId });
      await this.loadEmbedSsoStatus();
      this.showSuccess("免登嵌入 API Key 已停用。");
    } catch (err) {
      this.showError(err instanceof Error ? err.message : "免登嵌入 API Key 停用失败。");
    } finally {
      this.embedSsoBusy = false;
    }
  }

  private async handleSave(e: Event) {
    e.preventDefault();
    if (!this.name.trim()) {
      this.showError("tenantSettings.nameRequired");
      return;
    }
    this.saving = true;
    this.errorKey = "";
    this.successKey = "";
    try {
      await this.rpc("tenant.settings.update", {
        name: this.name.trim(),
        identityPrompt: this.identityPrompt,
      });
      this.showSuccess("tenantSettings.saved");
    } catch (err) {
      this.showError(err instanceof Error ? err.message : "tenantSettings.saveFailed");
    } finally {
      this.saving = false;
    }
  }

  private async handleMemorySave() {
    this.memorySaving = true;
    this.errorKey = "";
    this.memorySuccess = "";
    try {
      await this.rpc("tenant.memory.update", { content: this.memoryContent });
      this.showSuccess("tenantSettings.memorySaved");
    } catch (err) {
      this.showError(err instanceof Error ? err.message : "tenantSettings.memorySaveFailed");
    } finally {
      this.memorySaving = false;
    }
  }

  private renderEmbedSsoSection() {
    const visibleKeys = this.showAllEmbedSsoKeys
      ? this.embedSsoKeys
      : this.embedSsoKeys.slice(0, 5);
    const hiddenCount = Math.max(0, this.embedSsoKeys.length - visibleKeys.length);
    const hasActiveKey = this.embedSsoKeys.some((key) => key.isActive);

    return html`
      <details
        class="embed-details"
        ?open=${this.embedSsoDetailsOpen || Boolean(this.embedSsoRawKey)}
        @toggle=${(e: Event) => {
          this.embedSsoDetailsOpen = (e.currentTarget as HTMLDetailsElement).open;
        }}
      >
        <summary class="embed-summary">
          <span class="embed-summary-title">
            <strong>嵌入与免登</strong>
            <span>系统间登录 API Key，用于外部系统免登嵌入 Agenora 页面。</span>
          </span>
          <span class="embed-summary-meta">${hasActiveKey ? "已配置" : "未配置"}</span>
        </summary>
        <div class="embed-details-body">
          <div class="form-field">
            <label>系统间登录 API Key</label>
            <div class="hint">由 Agenora 生成。仅在生成时显示明文，请保存到九米后端配置中。</div>
          </div>
          ${
            visibleKeys.length
              ? visibleKeys.map(
                  (key) => html`
                  <div class="embed-row">
                    <div>
                      <div class="embed-label">Key 前缀</div>
                      <div class="embed-value">${key.keyPrefix || "-"}</div>
                    </div>
                    <div>
                      <div class="embed-label">状态</div>
                      <span class=${`status-pill ${key.isActive ? "active" : ""}`}>
                        ${key.isActive ? "已启用" : "已停用"}
                      </span>
                    </div>
                    <div>
                      <div class="embed-label">使用次数</div>
                      <div>${key.usageCount ?? 0}</div>
                    </div>
                    <div>
                      <div class="embed-label">最近使用</div>
                      <div>${key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : "未使用"}</div>
                    </div>
                    <div>
                      <div class="embed-label">创建时间</div>
                      <div>${key.createdAt ? new Date(key.createdAt).toLocaleString() : "-"}</div>
                    </div>
                    <div>
                      ${
                        key.isActive
                          ? html`<button
                            class="btn btn-danger"
                            type="button"
                            ?disabled=${this.embedSsoBusy}
                            @click=${() => this.revokeEmbedSsoKey(key.id)}
                          >
                            停用
                          </button>`
                          : nothing
                      }
                    </div>
                  </div>
                `,
                )
              : html`<div class="hint">尚未生成免登嵌入 API Key。</div>`
          }
          ${
            this.embedSsoKeys.length > 5
              ? html`<div class="actions">
                <button
                  class="btn btn-secondary"
                  type="button"
                  @click=${() => {
                    this.showAllEmbedSsoKeys = !this.showAllEmbedSsoKeys;
                  }}
                >
                  ${this.showAllEmbedSsoKeys ? "收起历史 Key" : `显示全部 ${this.embedSsoKeys.length} 条`}
                </button>
                ${hiddenCount ? html`<span class="embed-summary-meta">另有 ${hiddenCount} 条已隐藏</span>` : nothing}
              </div>`
              : nothing
          }
          ${
            this.embedSsoRawKey
              ? html`<div class="one-time-key">
                <strong>请立即保存该 Key，关闭后将无法再次查看。</strong>
                <textarea readonly .value=${this.embedSsoRawKey}></textarea>
                <button
                  class="btn btn-secondary"
                  type="button"
                  @click=${() => this._copyEmbedKey(this.embedSsoRawKey)}
                >
                  ${this._copiedEmbedKey ? "已复制" : "复制 Key"}
                </button>
              </div>`
              : nothing
          }
          <div class="actions">
            <button
              class="btn btn-primary"
              type="button"
              ?disabled=${this.embedSsoBusy}
              @click=${() => this.rotateEmbedSsoKey()}
            >
              ${hasActiveKey ? "轮换 Key" : "生成 Key"}
            </button>
          </div>
        </div>
      </details>
    `;
  }

  render() {
    if (this.loading) {
      return html`<div class="loading">${t("tenantSettings.loading")}</div>`;
    }

    return html`
      <h2>${t("tenantSettings.title")}</h2>

      ${this.errorKey ? html`<div class="error-msg">${this.tr(this.errorKey)}</div>` : nothing}
      ${this.successKey ? html`<div class="success-msg">${this.tr(this.successKey)}</div>` : nothing}

      <form @submit=${this.handleSave}>
        <div class="card">
          <div class="form-field">
            <label>${t("tenantSettings.name")}</label>
            <input type="text"
              placeholder=${t("tenantSettings.namePlaceholder")}
              .value=${this.name}
              @input=${(e: InputEvent) => (this.name = (e.target as HTMLInputElement).value)} />
          </div>
          <div class="form-field">
            <label>${t("tenantSettings.identityPrompt")}</label>
            <textarea
              placeholder=${t("tenantSettings.identityPromptPlaceholder")}
              .value=${this.identityPrompt}
              @input=${(e: InputEvent) => (this.identityPrompt = (e.target as HTMLTextAreaElement).value)}
            ></textarea>
            <div class="hint">${t("tenantSettings.identityPromptHint")}</div>
          </div>
          ${(() => {
            const tenantId = loadAuth()?.tenant?.id;
            return tenantId
              ? html`
          <div class="form-field readonly">
            <label>${t("tenantSettings.tenantIdLabel")}</label>
            <div class="tenant-id-row">
              <span class="tenant-id-value">${tenantId}</span>
              <button class="btn-copy" type="button"
                @click=${() => this._copyTenantId(tenantId)}>
                ${this._copiedTenantId ? t("tenantSettings.tenantIdCopied") : t("tenantSettings.tenantIdCopy")}
              </button>
            </div>
          </div>
          `
              : nothing;
          })()}
        </div>
        <div class="actions">
          <button class="btn btn-primary" type="submit" ?disabled=${this.saving}>
            ${this.saving ? t("tenantSettings.saving") : t("tenantSettings.save")}
          </button>
        </div>
      </form>

      ${this.renderEmbedSsoSection()}

      ${
        /* 企业记忆配置入口暂时隐藏，后端功能保留 */ false
          ? html`
      <h2>${t("tenantSettings.memory")}</h2>
      ${this.memorySuccess ? html`<div class="success-msg">${this.memorySuccess}</div>` : nothing}
      <div class="card">
        <div class="form-field">
          <label>MEMORY.md</label>
          <textarea
            style="min-height: 200px; font-family: monospace; font-size: 0.8rem;"
            .value=${this.memoryContent}
            @input=${(e: InputEvent) => (this.memoryContent = (e.target as HTMLTextAreaElement).value)}
          ></textarea>
          <div class="hint">${t("tenantSettings.memoryHint")}</div>
        </div>
        <div class="actions">
          <button class="btn btn-primary" type="button" ?disabled=${this.memorySaving}
            @click=${this.handleMemorySave}>
            ${this.memorySaving ? t("tenantSettings.memorySaving") : t("tenantSettings.memorySave")}
          </button>
        </div>
      </div>
      `
          : nothing
      }
    `;
  }
}
