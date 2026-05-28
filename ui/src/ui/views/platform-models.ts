/**
 * Platform model management view.
 *
 * Create, edit, and delete shared LLM provider/model configs visible to all tenants.
 * Only accessible by platform-admin.
 */

import { html, css, LitElement, nothing } from "lit";
import { customElement, state, property } from "lit/decorators.js";
import { tenantRpc } from "./tenant/rpc.ts";
import { PROVIDER_TYPES as SHARED_PROVIDERS, API_PROTOCOLS as SHARED_PROTOCOLS } from "../../constants/providers.ts";
import { t } from "../../i18n/index.ts";
import { I18nController } from "../../i18n/lib/lit-controller.ts";
import { showConfirm } from "../components/confirm-dialog.ts";
import { caretFix } from "../shared-styles.ts";

interface ModelDefinition {
  id: string;
  name: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
}

interface PlatformModelConfig {
  id: string;
  providerType: string;
  providerName: string;
  baseUrl: string | null;
  apiProtocol: string;
  authMode: string;
  hasApiKey: boolean;
  models: ModelDefinition[];
  visibility: string;
  isActive: boolean;
  createdAt: string;
}

const PROVIDER_TYPES = SHARED_PROVIDERS;
const API_PROTOCOLS = SHARED_PROTOCOLS;

@customElement("platform-models-view")
export class PlatformModelsView extends LitElement {
  static styles = [caretFix, css`
    :host {
      display: block;
      padding: 1.5rem;
      color: var(--text);
      font-family: var(--font-sans, system-ui, sans-serif);
    }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; }
    h2 { margin: 0; font-size: 1.1rem; font-weight: 600; }
    h3 { margin: 0 0 1rem; font-size: 0.95rem; font-weight: 600; }
    h4 { margin: 0.75rem 0 0.5rem; font-size: 0.85rem; font-weight: 600; color: var(--text-2); }
    .btn {
      padding: 0.45rem 0.9rem; border: none; border-radius: var(--radius-md);
      font-size: 0.85rem; cursor: pointer; transition: opacity 0.15s;
    }
    .btn:hover { opacity: 0.85; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-primary { background: var(--accent); color: var(--accent-foreground); }
    .btn-danger { background: var(--danger-subtle); color: var(--danger); }
    .btn-sm { padding: 0.3rem 0.6rem; font-size: 0.8rem; }
    .btn-outline { background: transparent; border: 1px solid var(--border); color: var(--text); }
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
    .model-card-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.75rem; }
    .model-name { font-size: 0.95rem; font-weight: 600; }
    .model-provider { font-size: 0.75rem; color: var(--muted); margin-top: 0.15rem; }
    .model-meta { font-size: 0.8rem; color: var(--text-2); margin-bottom: 0.5rem; }
    .model-meta span { margin-right: 1rem; }
    .model-tags { display: flex; flex-wrap: wrap; gap: 0.3rem; margin-top: 0.5rem; }
    .model-tag {
      font-size: 0.72rem; padding: 0.15rem 0.5rem;
      background: var(--bg); border: 1px solid var(--border);
      border-radius: 999px; color: var(--text-2);
    }
    .model-tag.reasoning { border-color: var(--warn); color: var(--warn); }
    .shared-badge {
      font-size: 0.7rem; padding: 0.1rem 0.4rem; border-radius: 4px;
      background: var(--accent-light); color: var(--accent); margin-left: 0.4rem;
    }
    .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 0.3rem; }
    .status-dot.active { background: var(--ok); }
    .status-dot.inactive { background: var(--border); }
    .model-actions { display: flex; gap: 0.4rem; margin-top: 0.75rem; }
    .error-msg {
      background: var(--danger-subtle); border: 1px solid var(--danger);
      border-radius: var(--radius-md); color: var(--danger);
      padding: 0.5rem 0.75rem; font-size: 0.8rem; margin-bottom: 1rem;
    }
    .success-msg {
      background: var(--ok-subtle); border: 1px solid var(--ok); border-radius: var(--radius-md);
      color: var(--ok); padding: 0.5rem 0.75rem; font-size: 0.8rem; margin-bottom: 1rem;
    }
    .form-card {
      background: var(--card); border: 1px solid var(--border);
      border-radius: var(--radius-lg); padding: 1.25rem; margin-bottom: 1.5rem;
    }
    .form-row { display: flex; gap: 0.75rem; margin-bottom: 0.75rem; }
    .form-field { flex: 1; }
    .form-field label { display: block; font-size: 0.8rem; margin-bottom: 0.3rem; color: var(--text-2); }
    .form-field input, .form-field textarea, .form-field select {
      width: 100%; padding: 0.45rem 0.65rem; background: var(--input-bg);
      border: 1px solid var(--input-border); border-radius: var(--radius-md);
      color: var(--text); font-size: 0.85rem; outline: none; box-sizing: border-box;
    }
    .form-field input:focus, .form-field select:focus { border-color: var(--accent); }
    .form-hint { font-size: 0.72rem; color: var(--muted); margin-top: 0.25rem; }
    .empty { text-align: center; padding: 2rem; color: var(--muted); font-size: 0.85rem; }
    .loading { text-align: center; padding: 2rem; color: var(--muted); }
    .sub-models-table { width: 100%; border-collapse: collapse; font-size: 0.8rem; margin-top: 0.5rem; }
    .sub-models-table th, .sub-models-table td {
      text-align: left; padding: 0.4rem 0.5rem;
      border-bottom: 1px solid var(--border);
    }
    .sub-models-table th { color: var(--text-2); font-weight: 500; }
    .sub-model-form { background: var(--input-bg); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 0.75rem; margin-top: 0.5rem; }
    .sub-model-row { display: flex; gap: 0.5rem; margin-bottom: 0.5rem; align-items: flex-end; }
    .sub-model-row .form-field { flex: 1; }
    .sub-model-row .form-field label { font-size: 0.72rem; }
    .sub-model-row .form-field input { font-size: 0.8rem; padding: 0.35rem 0.5rem; }
  `];

  private i18nController = new I18nController(this);

  @property({ type: String }) gatewayUrl = "";
  @state() private configs: PlatformModelConfig[] = [];
  @state() private loading = false;
  @state() private error = "";
  @state() private success = "";
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

  private providerNameManuallyEdited = false;

  private showError(msg: string) {
    this.error = msg; this.success = "";
    if (this.msgTimer) {clearTimeout(this.msgTimer);}
    this.msgTimer = setTimeout(() => (this.error = ""), 5000);
  }
  private showSuccess(msg: string) {
    this.success = msg; this.error = "";
    if (this.msgTimer) {clearTimeout(this.msgTimer);}
    this.msgTimer = setTimeout(() => (this.success = ""), 5000);
  }

  private rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return tenantRpc(method, params, this.gatewayUrl);
  }

  connectedCallback() {
    super.connectedCallback();
    this.loadConfigs();
  }

  private async loadConfigs() {
    this.loading = true;
    this.error = "";
    try {
      const result = await this.rpc("platform.models.list") as { models: PlatformModelConfig[] };
      this.configs = result.models;
    } catch (err) {
      this.showError(err instanceof Error ? err.message : "Failed to load models");
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

  private startEdit(config: PlatformModelConfig) {
    this.editingId = config.id;
    this.formProviderType = config.providerType;
    this.formProviderName = config.providerName;
    this.providerNameManuallyEdited = true;
    this.formBaseUrl = config.baseUrl ?? "";
    this.formApiProtocol = config.apiProtocol;
    this.formAuthMode = config.authMode;
    this.formApiKey = "";
    this.formModels = [...config.models];
    this.showModelForm = false;
    this.showForm = true;
  }

  private onProviderTypeChange(value: string) {
    this.formProviderType = value;
    const provider = PROVIDER_TYPES.find((p) => p.value === value);
    if (provider) {
      this.formBaseUrl = provider.defaultBaseUrl;
      this.formApiProtocol = provider.defaultProtocol;
      if (!this.providerNameManuallyEdited) {
        this.formProviderName = provider.label;
      }
      this.formAuthMode = value === "ollama" ? "none" : "api-key";
    }
  }

  private startAddModel() {
    this.subModelId = "";
    this.subModelName = "";
    this.showModelForm = true;
  }

  private addModel() {
    if (!this.subModelId || !this.subModelName) {
      this.showError("Model ID and name are required");
      return;
    }
    if (this.formModels.some((m) => m.id === this.subModelId)) {
      this.showError("Duplicate model ID");
      return;
    }
    this.formModels = [...this.formModels, {
      id: this.subModelId,
      name: this.subModelName,
      reasoning: false,
      input: ["text"],
      contextWindow: 128000,
      maxTokens: 128000,
    }];
    this.showModelForm = false;
  }

  private async removeModel(idx: number) {
    const model = this.formModels[idx];
    if (this.editingId && model) {
      try {
        const result = await this.rpc("platform.models.checkModelUsage", {
          providerId: this.editingId,
          modelId: model.id,
        }) as { agents: string[] };
        if (result.agents && result.agents.length > 0) {
          this.showError(t("platformModels.removeModelInUse", {
            modelId: model.id,
            agents: result.agents.join(", "),
          }));
          return;
        }
      } catch {
        // If check fails, allow removal — backend update will catch it
      }
    }
    this.formModels = this.formModels.filter((_, i) => i !== idx);
  }

  private async handleSave(e: Event) {
    e.preventDefault();
    if (!this.formProviderType || !this.formProviderName) {return;}
    if (this.formModels.length === 0) {
      this.showError(t("models.needOneModel"));
      return;
    }

    this.saving = true;
    this.error = "";
    this.success = "";

    try {
      if (this.editingId) {
        await this.rpc("platform.models.update", {
          id: this.editingId,
          providerName: this.formProviderName,
          baseUrl: this.formBaseUrl || undefined,
          apiProtocol: this.formApiProtocol,
          authMode: this.formAuthMode,
          ...(this.formApiKey ? { apiKey: this.formApiKey } : {}),
          models: this.formModels,
        });
        this.showSuccess(t("models.configUpdated"));
      } else {
        await this.rpc("platform.models.create", {
          providerType: this.formProviderType,
          providerName: this.formProviderName,
          baseUrl: this.formBaseUrl || undefined,
          apiProtocol: this.formApiProtocol,
          authMode: this.formAuthMode,
          ...(this.formApiKey ? { apiKey: this.formApiKey } : {}),
          models: this.formModels,
        });
        this.showSuccess(t("models.configCreated"));
      }
      this.showForm = false;
      await this.loadConfigs();
    } catch (err: any) {
      const msg = err?.message ?? "Save failed";
      if (msg.startsWith("platformModels.removeModelInUse:")) {
        const parts = msg.slice("platformModels.removeModelInUse:".length).split(":");
        const modelId = parts[0] ?? "";
        const agents = parts.slice(1).join(":");
        this.showError(t("platformModels.removeModelInUse", { modelId, agents }));
      } else {
        this.showError(msg);
      }
    } finally {
      this.saving = false;
    }
  }

  private async handleDelete(config: PlatformModelConfig) {
    const ok = await showConfirm({
      title: t("models.delete"),
      message: t("models.confirmDelete", { name: config.providerName }),
      confirmText: t("models.delete"),
      cancelText: t("models.cancel"),
      danger: true,
    });
    if (!ok) {return;}
    try {
      await this.rpc("platform.models.delete", { id: config.id });
      this.showSuccess(t("models.configDeleted", { name: config.providerName }));
      await this.loadConfigs();
    } catch (err: any) {
      const msg = err?.message ?? "Delete failed";
      if (msg.startsWith("platformModels.deleteInUse:")) {
        const agents = msg.slice("platformModels.deleteInUse:".length);
        this.showError(t("platformModels.deleteInUse", { agents }));
      } else {
        this.showError(msg);
      }
    }
  }

  private async handleToggle(config: PlatformModelConfig) {
    try {
      await this.rpc("platform.models.update", { id: config.id, isActive: !config.isActive });
      await this.loadConfigs();
    } catch (err) {
      this.showError(err instanceof Error ? err.message : "Toggle failed");
    }
  }

  render() {
    return html`
      <div class="header">
        <h2>${t("platformModels.title", {}, "Platform Shared Models")}</h2>
        <div style="display:flex;gap:0.5rem">
          <button class="btn btn-outline" @click=${() => this.loadConfigs()}>${t("models.refresh")}</button>
          <button class="btn btn-primary" @click=${() => this.showForm ? (this.showForm = false) : this.startCreate()}>
            ${this.showForm ? t("models.cancel") : t("platformModels.addProvider", {}, "Add Shared Provider")}
          </button>
        </div>
      </div>

      ${this.error ? html`<div class="error-msg">${this.error}</div>` : nothing}
      ${this.success ? html`<div class="success-msg">${this.success}</div>` : nothing}

      ${this.showForm ? this.renderForm() : nothing}

      ${this.loading
        ? html`<div class="loading">${t("models.loading")}</div>`
        : this.configs.length === 0
          ? html`<div class="empty">${t("platformModels.empty", {}, "No shared models yet. Create one to make it available to all tenants.")}</div>`
          : html`<div class="card-grid">${this.configs.map((c) => this.renderCard(c))}</div>`}
    `;
  }

  private renderCard(config: PlatformModelConfig) {
    const providerLabel = PROVIDER_TYPES.find((p) => p.value === config.providerType)?.label ?? config.providerType;
    return html`
      <div class="model-card">
        <div class="model-card-header">
          <div>
            <div class="model-name">
              <span class="status-dot ${config.isActive ? "active" : "inactive"}"></span>
              ${config.providerName}
              <span class="shared-badge">${t("platformModels.shared", {}, "Shared")}</span>
              ${!config.isActive ? html`<span style="font-size:0.7rem;padding:0.1rem 0.4rem;border-radius:4px;background:#2d1215;color:#fca5a5;margin-left:0.4rem">${t("models.disable")}</span>` : nothing}
            </div>
            <div class="model-provider">${providerLabel} | ${config.apiProtocol}</div>
          </div>
        </div>
        <div class="model-meta">
          ${config.baseUrl ? html`<span>URL: ${config.baseUrl}</span>` : nothing}
          <span>${t("models.authMode")}: ${config.authMode}${config.hasApiKey ? ` (${t("models.authConfigured")})` : ""}</span>
        </div>
        <div class="model-tags">
          ${config.models.map((m) => html`
            <span class="model-tag ${m.reasoning ? "reasoning" : ""}">${m.name} (${m.id})</span>
          `)}
        </div>
        <div class="model-actions">
          <button class="btn btn-outline btn-sm" @click=${() => this.startEdit(config)}>${t("models.edit")}</button>
          <button class="btn btn-danger btn-sm" @click=${() => this.handleDelete(config)}>${t("models.delete")}</button>
        </div>
      </div>
    `;
  }

  private renderForm() {
    return html`
      <div class="form-card">
        <h3>${this.editingId ? t("models.editTitle") : t("platformModels.createTitle", {}, "Create Shared Provider")}</h3>
        <form @submit=${this.handleSave}>
          <div class="form-row">
            <div class="form-field">
              <label>${t("models.providerType")}</label>
              <select ?disabled=${!!this.editingId}
                @change=${(e: Event) => this.onProviderTypeChange((e.target as HTMLSelectElement).value)}>
                ${PROVIDER_TYPES.map((p) => html`
                  <option value=${p.value} ?selected=${this.formProviderType === p.value}>${p.label}</option>
                `)}
              </select>
            </div>
            <div class="form-field">
              <label>${t("models.providerName")}</label>
              <input type="text" required .value=${this.formProviderName}
                @input=${(e: InputEvent) => { this.formProviderName = (e.target as HTMLInputElement).value; this.providerNameManuallyEdited = true; }} />
            </div>
          </div>

          <div class="form-row">
            <div class="form-field">
              <label>${t("models.baseUrl")}</label>
              <input type="text" .value=${this.formBaseUrl}
                @input=${(e: InputEvent) => (this.formBaseUrl = (e.target as HTMLInputElement).value)} />
            </div>
            <div class="form-field">
              <label>${t("models.apiProtocol")}</label>
              <select @change=${(e: Event) => (this.formApiProtocol = (e.target as HTMLSelectElement).value)}>
                ${API_PROTOCOLS.map((p) => html`
                  <option value=${p.value} ?selected=${this.formApiProtocol === p.value}>${p.label}</option>
                `)}
              </select>
            </div>
          </div>

          <div class="form-row">
            <div class="form-field">
              <label>${t("models.authMode")}</label>
              <select @change=${(e: Event) => (this.formAuthMode = (e.target as HTMLSelectElement).value)}>
                <option value="api-key" ?selected=${this.formAuthMode === "api-key"}>API Key</option>
                <option value="token" ?selected=${this.formAuthMode === "token"}>Token</option>
                <option value="none" ?selected=${this.formAuthMode === "none"}>${t("models.authNone")}</option>
              </select>
            </div>
            ${this.formAuthMode === "api-key" || this.formAuthMode === "token" ? html`
              <div class="form-field">
                <label>${t("models.apiKey")}${this.editingId ? t("models.apiKeyKeepHint") : ""}</label>
                <input type="password" .value=${this.formApiKey}
                  @input=${(e: InputEvent) => (this.formApiKey = (e.target as HTMLInputElement).value)} />
              </div>
            ` : nothing}
          </div>

          <h4>${t("models.modelsCount", { count: String(this.formModels.length) })}</h4>
          ${this.formModels.length > 0 ? html`
            <table class="sub-models-table">
              <thead><tr><th>${t("models.modelId")}</th><th>${t("models.modelName")}</th><th></th></tr></thead>
              <tbody>
                ${this.formModels.map((m, idx) => html`
                  <tr>
                    <td style="font-family:monospace">${m.id}</td>
                    <td>${m.name}</td>
                    <td><button type="button" class="btn btn-danger btn-sm" @click=${() => this.removeModel(idx)}>${t("models.remove")}</button></td>
                  </tr>
                `)}
              </tbody>
            </table>
          ` : nothing}

          ${this.showModelForm ? html`
            <div class="sub-model-form">
              <div class="sub-model-row">
                <div class="form-field">
                  <label>${t("models.modelId")}</label>
                  <input type="text" .value=${this.subModelId}
                    @input=${(e: InputEvent) => (this.subModelId = (e.target as HTMLInputElement).value)} />
                </div>
                <div class="form-field">
                  <label>${t("models.displayName")}</label>
                  <input type="text" .value=${this.subModelName}
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
          ` : html`
            <button type="button" class="btn btn-outline btn-sm" style="margin-top:0.5rem" @click=${() => this.startAddModel()}>${t("models.addModel")}</button>
          `}

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
