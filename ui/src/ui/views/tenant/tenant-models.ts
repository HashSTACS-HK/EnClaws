/**
 * Tenant model management view.
 *
 * Create, edit, and delete LLM provider/model configs scoped to the current tenant.
 * Supports different provider types with dynamic form fields.
 */

import { html, css, LitElement, nothing } from "lit";
import { customElement, state, property } from "lit/decorators.js";
import {
  PROVIDER_TYPES as SHARED_PROVIDERS,
  API_PROTOCOLS as SHARED_PROTOCOLS,
} from "../../../constants/providers.ts";
import { t } from "../../../i18n/index.ts";
import { I18nController } from "../../../i18n/lib/lit-controller.ts";
import { showConfirm } from "../../components/confirm-dialog.ts";
import { caretFix } from "../../shared-styles.ts";
import { tenantRpc } from "./rpc.ts";

interface ModelDefinition {
  id: string;
  name: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

interface TenantModelConfig {
  id: string;
  providerType: string;
  providerName: string;
  baseUrl: string | null;
  apiProtocol: string;
  authMode: string;
  hasApiKey: boolean;
  extraHeaders: Record<string, string>;
  extraConfig: Record<string, unknown>;
  models: ModelDefinition[];
  visibility?: string;
  isActive: boolean;
  createdAt: string;
}

const PROVIDER_TYPES = SHARED_PROVIDERS;
const API_PROTOCOLS = SHARED_PROTOCOLS;

@customElement("tenant-models-view")
export class TenantModelsView extends LitElement {
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
        justify-content: space-between;
        align-items: center;
        margin-bottom: 1.5rem;
      }
      h2 {
        margin: 0;
        font-size: 1.1rem;
        font-weight: 600;
      }
      h3 {
        margin: 0 0 1rem;
        font-size: 0.95rem;
        font-weight: 600;
      }
      h4 {
        margin: 0.75rem 0 0.5rem;
        font-size: 0.85rem;
        font-weight: 600;
        color: var(--text-2);
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
      .btn-danger {
        background: var(--danger-subtle);
        color: var(--danger);
      }
      .btn-sm {
        padding: 0.3rem 0.6rem;
        font-size: 0.8rem;
      }
      .btn-outline {
        background: transparent;
        border: 1px solid var(--border);
        color: var(--text);
      }
      .card-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
        gap: 1rem;
      }
      .model-card {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        padding: 1.25rem;
      }
      .model-card-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        margin-bottom: 0.75rem;
      }
      .model-name {
        font-size: 0.95rem;
        font-weight: 600;
      }
      .model-provider {
        font-size: 0.75rem;
        color: var(--muted);
        margin-top: 0.15rem;
      }
      .model-meta {
        font-size: 0.8rem;
        color: var(--text-2);
        margin-bottom: 0.5rem;
      }
      .model-meta span {
        margin-right: 1rem;
      }
      .model-tags {
        display: flex;
        flex-wrap: wrap;
        gap: 0.3rem;
        margin-top: 0.5rem;
      }
      .model-tag {
        font-size: 0.72rem;
        padding: 0.15rem 0.5rem;
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: 999px;
        color: var(--text-2);
      }
      .model-tag.reasoning {
        border-color: var(--warn);
        color: var(--warn);
      }
      .shared-badge {
        font-size: 0.7rem;
        padding: 0.1rem 0.4rem;
        border-radius: 4px;
        background: var(--accent-light);
        color: var(--accent);
        margin-left: 0.4rem;
      }
      .status-dot {
        display: inline-block;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        margin-right: 0.3rem;
      }
      .status-dot.active {
        background: var(--ok);
      }
      .status-dot.inactive {
        background: var(--border);
      }
      .model-actions {
        display: flex;
        gap: 0.4rem;
        margin-top: 0.75rem;
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
      .form-card {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        padding: 1.25rem;
        margin-bottom: 1.5rem;
      }
      .form-row {
        display: flex;
        gap: 0.75rem;
        margin-bottom: 0.75rem;
      }
      .form-field {
        flex: 1;
      }
      .form-field label {
        display: block;
        font-size: 0.8rem;
        margin-bottom: 0.3rem;
        color: var(--text-2);
      }
      .form-field input,
      .form-field textarea,
      .form-field select {
        width: 100%;
        padding: 0.45rem 0.65rem;
        background: var(--input-bg);
        border: 1px solid var(--input-border);
        border-radius: var(--radius-md);
        color: var(--text);
        font-size: 0.85rem;
        outline: none;
        box-sizing: border-box;
      }
      .form-field input:focus,
      .form-field select:focus {
        border-color: var(--accent);
      }
      .form-hint {
        font-size: 0.72rem;
        color: var(--muted);
        margin-top: 0.25rem;
      }
      .empty {
        text-align: center;
        padding: 2rem;
        color: var(--muted);
        font-size: 0.85rem;
      }
      .loading {
        text-align: center;
        padding: 2rem;
        color: var(--muted);
      }
      .sub-models-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.8rem;
        margin-top: 0.5rem;
      }
      .sub-models-table th,
      .sub-models-table td {
        text-align: left;
        padding: 0.4rem 0.5rem;
        border-bottom: 1px solid var(--border);
      }
      .sub-models-table th {
        color: var(--text-2);
        font-weight: 500;
      }
      .sub-model-form {
        background: var(--input-bg);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: 0.75rem;
        margin-top: 0.5rem;
      }
      .sub-model-row {
        display: flex;
        gap: 0.5rem;
        margin-bottom: 0.5rem;
        align-items: flex-end;
      }
      .sub-model-row .form-field {
        flex: 1;
      }
      .sub-model-row .form-field label {
        font-size: 0.72rem;
      }
      .sub-model-row .form-field input {
        font-size: 0.8rem;
        padding: 0.35rem 0.5rem;
      }
    `,
  ];

  private i18nController = new I18nController(this);

  @property({ type: String }) gatewayUrl = "";
  @state() private configs: TenantModelConfig[] = [];
  @state() private loading = false;
  @state() private errorKey = "";
  @state() private successKey = "";
  private msgParams: Record<string, string> = {};
  private msgTimer?: ReturnType<typeof setTimeout>;
  @state() private showForm = false;
  @state() private saving = false;
  @state() private editingId: string | null = null;

  // Form fields
  @state() private formProviderType = "openai";
  @state() private formProviderName = "";
  @state() private formBaseUrl = "";
  @state() private formApiProtocol = "openai-completions";
  @state() private formAuthMode = "api-key";
  @state() private formApiKey = "";
  @state() private formModels: ModelDefinition[] = [];

  // Sub-model form
  @state() private showModelForm = false;
  @state() private subModelId = "";
  @state() private subModelName = "";

  // Cached agent list for model-in-use checks
  private cachedAgents: Array<{
    name: string;
    agentId: string;
    modelConfig: Array<{ providerId: string; modelId: string }>;
  }> = [];

  private showError(key: string, params?: Record<string, string>) {
    this.errorKey = key;
    this.successKey = "";
    this.msgParams = params ?? {};
    if (this.msgTimer) {
      clearTimeout(this.msgTimer);
    }
    this.msgTimer = setTimeout(() => (this.errorKey = ""), 5000);
  }

  private showSuccess(key: string, params?: Record<string, string>) {
    this.successKey = key;
    this.errorKey = "";
    this.msgParams = params ?? {};
    if (this.msgTimer) {
      clearTimeout(this.msgTimer);
    }
    this.msgTimer = setTimeout(() => (this.successKey = ""), 5000);
  }

  /** Translate key at render time; raw server messages pass through as-is. */
  private tr(key: string): string {
    const result = t(key, this.msgParams);
    return result === key ? key : result;
  }

  connectedCallback() {
    super.connectedCallback();
    this.loadConfigs();
    this.loadAgents();
  }

  private async loadAgents() {
    try {
      const result = (await this.rpc("tenant.agents.list")) as {
        agents: Array<{
          name: string;
          agentId: string;
          modelConfig: Array<{ providerId: string; modelId: string }>;
        }>;
      };
      this.cachedAgents = result.agents ?? [];
    } catch {
      this.cachedAgents = [];
    }
  }

  private rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return tenantRpc(method, params, this.gatewayUrl);
  }

  private async loadConfigs() {
    this.loading = true;
    this.errorKey = "";
    try {
      const result = (await this.rpc("tenant.models.list")) as { models: TenantModelConfig[] };
      this.configs = result.models;
    } catch (err) {
      this.showError(err instanceof Error ? err.message : "models.loadFailed");
    } finally {
      this.loading = false;
    }
  }

  private startCreate() {
    this.editingId = null;
    this.formProviderType = "openai";
    this.formProviderName = "OpenAI";
    this.providerNameManuallyEdited = false;
    this.formBaseUrl = "https://api.openai.com/v1";
    this.formApiProtocol = "openai-completions";
    this.formAuthMode = "api-key";
    this.formApiKey = "";
    this.formModels = [];
    this.showModelForm = false;
    this.showForm = true;
  }

  private startEdit(config: TenantModelConfig) {
    this.editingId = config.id;
    this.formProviderType = config.providerType;
    this.formProviderName = config.providerName;
    this.providerNameManuallyEdited = true; // editing existing — treat as manual
    this.formBaseUrl = config.baseUrl ?? "";
    this.formApiProtocol = config.apiProtocol;
    this.formAuthMode = config.authMode;
    this.formApiKey = "";
    this.formModels = [...config.models];
    this.showModelForm = false;
    this.showForm = true;
  }

  /** Track whether the user has manually edited the provider name */
  private providerNameManuallyEdited = false;

  private onProviderTypeChange(value: string) {
    this.formProviderType = value;
    const provider = PROVIDER_TYPES.find((p) => p.value === value);
    if (provider) {
      this.formBaseUrl = provider.defaultBaseUrl;
      this.formApiProtocol = provider.defaultProtocol;
      // Always sync provider name unless user has manually edited it
      if (!this.providerNameManuallyEdited) {
        this.formProviderName = provider.label;
      }
      if (value === "ollama") {
        this.formAuthMode = "none";
      } else {
        this.formAuthMode = "api-key";
      }
    }
  }

  private startAddModel() {
    this.subModelId = "";
    this.subModelName = "";
    this.showModelForm = true;
  }

  private addModel() {
    if (!this.subModelId) {
      this.showError("models.modelIdRequired");
      return;
    }
    if (!this.subModelName) {
      this.showError("models.displayNameRequired");
      return;
    }
    if (this.formModels.some((m) => m.id === this.subModelId)) {
      this.showError("models.duplicateModelId");
      return;
    }
    this.formModels = [
      ...this.formModels,
      {
        id: this.subModelId,
        name: this.subModelName,
        reasoning: false,
        input: ["text"],
        contextWindow: 128000,
        maxTokens: 128000,
      },
    ];
    this.showModelForm = false;
  }

  private removeModel(idx: number) {
    const model = this.formModels[idx];
    if (this.editingId && model) {
      const conflicts = this.cachedAgents.filter((a) =>
        (a.modelConfig ?? []).some(
          (mc) => mc.providerId === this.editingId && mc.modelId === model.id,
        ),
      );
      if (conflicts.length > 0) {
        const names = conflicts.map((a) => a.name || a.agentId).join(", ");
        this.showError("models.removeModelInUse", { agents: names });
        return;
      }
    }
    this.formModels = this.formModels.filter((_, i) => i !== idx);
  }

  private async handleSave(e: Event) {
    e.preventDefault();
    if (!this.formProviderType || !this.formProviderName) {
      return;
    }
    if (this.formModels.length === 0) {
      this.showError("models.needOneModel");
      return;
    }

    this.saving = true;
    this.errorKey = "";
    this.successKey = "";

    try {
      if (this.editingId) {
        await this.rpc("tenant.models.update", {
          id: this.editingId,
          providerName: this.formProviderName,
          baseUrl: this.formBaseUrl || undefined,
          apiProtocol: this.formApiProtocol,
          authMode: this.formAuthMode,
          ...(this.formApiKey ? { apiKey: this.formApiKey } : {}),
          models: this.formModels,
        });
        this.showSuccess("models.configUpdated");
      } else {
        await this.rpc("tenant.models.create", {
          providerType: this.formProviderType,
          providerName: this.formProviderName,
          baseUrl: this.formBaseUrl || undefined,
          apiProtocol: this.formApiProtocol,
          authMode: this.formAuthMode,
          ...(this.formApiKey ? { apiKey: this.formApiKey } : {}),
          models: this.formModels,
        });
        this.showSuccess("models.configCreated");
      }
      this.showForm = false;
      await this.loadConfigs();
    } catch (err: any) {
      this.showError(err?.message ?? "models.saveFailed", err?.details);
    } finally {
      this.saving = false;
    }
  }

  private async handleDelete(config: TenantModelConfig) {
    const ok = await showConfirm({
      title: t("models.delete"),
      message: t("models.confirmDelete", { name: config.providerName }),
      confirmText: t("models.delete"),
      cancelText: t("models.cancel"),
      danger: true,
    });
    if (!ok) {
      return;
    }
    this.errorKey = "";
    try {
      await this.rpc("tenant.models.delete", { id: config.id });
      this.showSuccess("models.configDeleted", { name: config.providerName });
      await this.loadConfigs();
    } catch (err: any) {
      this.showError(err?.message ?? "models.deleteFailed", err?.details);
    }
  }

  private async handleToggle(config: TenantModelConfig) {
    try {
      await this.rpc("tenant.models.update", { id: config.id, isActive: !config.isActive });
      await this.loadConfigs();
    } catch (err) {
      this.showError(err instanceof Error ? err.message : "models.toggleFailed");
    }
  }

  render() {
    return html`
      <div class="header">
        <h2>${t("models.title")}</h2>
        <div style="display:flex;gap:0.5rem">
          <button class="btn btn-outline" @click=${() => this.loadConfigs()}>${t("models.refresh")}</button>
          <button class="btn btn-primary" @click=${() => (this.showForm ? (this.showForm = false) : this.startCreate())}>
            ${this.showForm ? t("models.cancel") : t("models.addProvider")}
          </button>
        </div>
      </div>

      ${this.errorKey ? html`<div class="error-msg">${this.tr(this.errorKey)}</div>` : nothing}
      ${this.successKey ? html`<div class="success-msg">${this.tr(this.successKey)}</div>` : nothing}

      ${this.showForm ? this.renderForm() : nothing}

      ${
        this.loading
          ? html`<div class="loading">${t("models.loading")}</div>`
          : this.configs.length === 0
            ? html`<div class="empty">${t("models.empty")}</div>`
            : html`
            <div class="card-grid">
              ${this.configs.map((c) => this.renderCard(c))}
            </div>
          `
      }
    `;
  }

  private renderCard(config: TenantModelConfig) {
    const providerLabel =
      PROVIDER_TYPES.find((p) => p.value === config.providerType)?.label ?? config.providerType;
    const isShared = config.visibility === "shared";
    return html`
      <div class="model-card">
        <div class="model-card-header">
          <div>
            <div class="model-name">
              <span class="status-dot ${config.isActive ? "active" : "inactive"}"></span>
              ${config.providerName}
              ${isShared ? html`<span class="shared-badge">${t("platformModels.shared", {}, "Shared")}</span>` : nothing}
              ${!config.isActive ? html`<span style="font-size:0.7rem;padding:0.1rem 0.4rem;border-radius:4px;background:var(--danger-subtle);color:var(--danger);margin-left:0.4rem">${t("models.disable")}</span>` : nothing}
            </div>
            <div class="model-provider">${providerLabel} | ${config.apiProtocol}</div>
          </div>
        </div>
        <div class="model-meta">
          ${config.baseUrl ? html`<span>URL: ${config.baseUrl}</span>` : nothing}
          <span>${t("models.authMode")}: ${config.authMode}${config.hasApiKey ? ` (${t("models.authConfigured")})` : ""}</span>
        </div>
        <div class="model-tags">
          ${config.models.map(
            (m) => html`
            <span class="model-tag ${m.reasoning ? "reasoning" : ""}">${m.name} (${m.id})</span>
          `,
          )}
        </div>
        ${
          isShared
            ? nothing
            : html`
          <div class="model-actions">
            <button class="btn btn-outline btn-sm" @click=${() => this.startEdit(config)}>${t("models.edit")}</button>
            <button class="btn btn-danger btn-sm" @click=${() => this.handleDelete(config)}>${t("models.delete")}</button>
          </div>
        `
        }
      </div>
    `;
  }

  private renderForm() {
    return html`
      <div class="form-card">
        <h3>${this.editingId ? t("models.editTitle") : t("models.createTitle")}</h3>
        <form @submit=${this.handleSave}>
          <!-- Provider Type & Name -->
          <div class="form-row">
            <div class="form-field">
              <label>${t("models.providerType")}</label>
              <select
                ?disabled=${!!this.editingId}
                @change=${(e: Event) => this.onProviderTypeChange((e.target as HTMLSelectElement).value)}>
                ${PROVIDER_TYPES.map(
                  (p) => html`
                  <option value=${p.value} ?selected=${this.formProviderType === p.value}>${p.label}</option>
                `,
                )}
              </select>
            </div>
            <div class="form-field">
              <label>${t("models.providerName")}</label>
              <input type="text" required .placeholder=${t("models.providerNamePlaceholder")}
                .value=${this.formProviderName}
                @input=${(e: InputEvent) => {
                  this.formProviderName = (e.target as HTMLInputElement).value;
                  this.providerNameManuallyEdited = true;
                }} />
              <div class="form-hint">${t("models.providerNameHint")}</div>
            </div>
          </div>

          <!-- Base URL & Protocol -->
          <div class="form-row">
            <div class="form-field">
              <label>${t("models.baseUrl")}</label>
              <input type="text" .placeholder=${t("models.baseUrlPlaceholder")}
                .value=${this.formBaseUrl}
                @input=${(e: InputEvent) => (this.formBaseUrl = (e.target as HTMLInputElement).value)} />
            </div>
            <div class="form-field">
              <label>${t("models.apiProtocol")}</label>
              <select @change=${(e: Event) => (this.formApiProtocol = (e.target as HTMLSelectElement).value)}>
                ${API_PROTOCOLS.map(
                  (p) => html`
                  <option value=${p.value} ?selected=${this.formApiProtocol === p.value}>${p.label}</option>
                `,
                )}
              </select>
            </div>
          </div>

          <!-- Auth -->
          <div class="form-row">
            <div class="form-field">
              <label>${t("models.authMode")}</label>
              <select @change=${(e: Event) => (this.formAuthMode = (e.target as HTMLSelectElement).value)}>
                <option value="api-key" ?selected=${this.formAuthMode === "api-key"}>API Key</option>
                <option value="token" ?selected=${this.formAuthMode === "token"}>Token</option>
                <option value="none" ?selected=${this.formAuthMode === "none"}>${t("models.authNone")}</option>
              </select>
            </div>
            ${
              this.formAuthMode === "api-key" || this.formAuthMode === "token"
                ? html`
              <div class="form-field">
                <label>${t("models.apiKey")}${this.editingId ? t("models.apiKeyKeepHint") : ""}</label>
                <input type="password" .placeholder=${t("models.apiKeyPlaceholder")}
                  .value=${this.formApiKey}
                  @input=${(e: InputEvent) => (this.formApiKey = (e.target as HTMLInputElement).value)} />
              </div>
            `
                : nothing
            }
          </div>

          <!-- Models list -->
          <h4>${t("models.modelsCount", { count: String(this.formModels.length) })}</h4>
          ${
            this.formModels.length > 0
              ? html`
            <table class="sub-models-table">
              <thead>
                <tr>
                  <th>${t("models.modelId")}</th>
                  <th>${t("models.modelName")}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${this.formModels.map(
                  (m, idx) => html`
                  <tr>
                    <td style="font-family:monospace">${m.id}</td>
                    <td>${m.name}</td>
                    <td><button type="button" class="btn btn-danger btn-sm" @click=${() => this.removeModel(idx)}>${t("models.remove")}</button></td>
                  </tr>
                `,
                )}
              </tbody>
            </table>
          `
              : nothing
          }

          ${
            this.showModelForm
              ? html`
            <div class="sub-model-form">
              <div class="sub-model-row">
                <div class="form-field">
                  <label>${t("models.modelId")}</label>
                  <input type="text" .placeholder=${t("models.modelIdPlaceholder")}
                    .value=${this.subModelId}
                    @input=${(e: InputEvent) => (this.subModelId = (e.target as HTMLInputElement).value)} />
                </div>
                <div class="form-field">
                  <label>${t("models.displayName")}</label>
                  <input type="text" .placeholder=${t("models.displayNamePlaceholder")}
                    .value=${this.subModelName}
                    @input=${(e: InputEvent) => (this.subModelName = (e.target as HTMLInputElement).value)} />
                </div>
                <div style="display:flex;align-items:flex-end">
                  <button type="button" class="btn btn-primary btn-sm" @click=${() => this.addModel()}>${t("models.add")}</button>
                </div>
                <div style="display:flex;align-items:flex-end">
                  <button type="button" class="btn btn-outline btn-sm" @click=${() => (this.showModelForm = false)}>${t("models.cancel")}</button>
                </div>
              </div>
            </div>
          `
              : html`
            <button type="button" class="btn btn-outline btn-sm" style="margin-top:0.5rem" @click=${() => this.startAddModel()}>${t("models.addModel")}</button>
          `
          }

          <!-- Submit -->
          <div style="display:flex;gap:0.5rem;margin-top:1.25rem">
            <button class="btn btn-primary" type="submit" ?disabled=${this.saving}>
              ${this.saving ? t("models.saving") : t("models.save")}
            </button>
            <button class="btn btn-outline" type="button" @click=${() => (this.showForm = false)}>${t("models.cancel")}</button>
          </div>
        </form>
      </div>
    `;
  }
}
