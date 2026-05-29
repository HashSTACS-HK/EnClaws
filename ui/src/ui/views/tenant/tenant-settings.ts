/**
 * Tenant settings view — manage enterprise name and identity prompt.
 */

import { html, css, LitElement, nothing } from "lit";
import { customElement, state, property } from "lit/decorators.js";
import { t, I18nController } from "../../../i18n/index.ts";
import { loadAuth } from "../../auth-store.ts";
import { tenantRpc } from "./rpc.ts";
import { caretFix } from "../../shared-styles.ts";

@customElement("tenant-settings-view")
export class TenantSettingsView extends LitElement {
  private i18nCtrl = new I18nController(this);

  static styles = [caretFix, css`
    :host {
      display: block;
      padding: 1.5rem;
      color: var(--text);
      font-family: var(--font-sans, system-ui, sans-serif);
    }
    h2 { margin: 0 0 1.5rem; font-size: 1.1rem; font-weight: 600; }
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
    .form-field input, .form-field textarea {
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
    .form-field input:focus, .form-field textarea:focus { border-color: var(--accent); }
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
    .btn:hover { opacity: 0.85; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-primary { background: var(--accent); color: var(--accent-foreground); }
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
    .loading { text-align: center; padding: 2rem; color: var(--muted); }
    .actions { margin-top: 1rem; }
    .form-field.readonly { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
    .form-field.readonly label { margin-bottom: 0; white-space: nowrap; }
    .tenant-id-value {
      font-family: var(--font-mono, monospace);
      font-size: 0.85rem;
      color: var(--text);
      flex: 1;
      word-break: break-all;
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
    .btn-copy:hover { opacity: 0.8; }
  `];

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
      this._copyTimer = setTimeout(() => { this._copiedTenantId = false; }, 2000);
    } catch {
      // Clipboard not available in non-secure context — ignore.
    }
  }

  private rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return tenantRpc(method, params, this.gatewayUrl);
  }

  private showError(key: string) {
    this.errorKey = key;
    this.successKey = "";
    if (this.msgTimer) {clearTimeout(this.msgTimer);}
    this.msgTimer = setTimeout(() => (this.errorKey = ""), 5000);
  }

  private showSuccess(key: string) {
    this.successKey = key;
    this.errorKey = "";
    if (this.msgTimer) {clearTimeout(this.msgTimer);}
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
      const result = await this.rpc("tenant.settings.get") as {
        name: string;
        identityPrompt: string;
      };
      this.name = result.name ?? "";
      this.identityPrompt = result.identityPrompt ?? "";
      // Load memory content
      try {
        const memResult = await this.rpc("tenant.memory.get") as { content: string };
        this.memoryContent = memResult.content ?? "";
      } catch {
        // Memory may not be available yet
      }
    } catch (err) {
      this.showError(err instanceof Error ? err.message : "tenantSettings.loadFailed");
    } finally {
      this.loading = false;
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
          ${(() => { const tenantId = loadAuth()?.tenant?.id; return tenantId ? html`
          <div class="form-field readonly">
            <label>${t("tenantSettings.tenantIdLabel")}</label>
            <span class="tenant-id-value">${tenantId}</span>
            <button class="btn-copy" type="button"
              @click=${() => this._copyTenantId(tenantId)}>
              ${this._copiedTenantId ? t("tenantSettings.tenantIdCopied") : t("tenantSettings.tenantIdCopy")}
            </button>
          </div>
          ` : nothing; })()}
        </div>
        <div class="actions">
          <button class="btn btn-primary" type="submit" ?disabled=${this.saving}>
            ${this.saving ? t("tenantSettings.saving") : t("tenantSettings.save")}
          </button>
        </div>
      </form>

      ${/* 企业记忆配置入口暂时隐藏，后端功能保留 */ false ? html`
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
      ` : nothing}
    `;
  }
}
