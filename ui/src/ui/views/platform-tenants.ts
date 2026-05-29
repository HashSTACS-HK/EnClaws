/**
 * Platform tenant management view — platform-admin only.
 *
 * Displays a paginated list of all tenants with plan/status badges,
 * quota columns, and per-row edit/suspend actions (except the platform tenant).
 * Supports name search and status filtering in a logs-page-style toolbar.
 */

import { html, css, LitElement, nothing } from "lit";
import { customElement, state, property } from "lit/decorators.js";
import { t, i18n, I18nController } from "../../i18n/index.ts";
import { caretFix } from "../shared-styles.ts";
import { tenantRpc } from "./tenant/rpc.ts";

// ── Types ──────────────────────────────────────────────────────────────

const PLATFORM_TENANT_ID = "00000000-0000-0000-0000-000000000001";

interface TenantRow {
  id: string;
  name: string;
  plan: "free" | "pro" | "enterprise";
  status: "active" | "suspended" | "deleted";
  quotas: {
    maxUsers: number;
    maxAgents: number;
    maxChannels: number;
    maxTokensPerMonth: number;
    maxCronJobs: number;
  };
  createdAt: string;
}

interface PlanQuotaDefaults {
  free: TenantRow["quotas"];
  pro: TenantRow["quotas"];
  enterprise: TenantRow["quotas"];
}

type StatusFilter = "all" | "active" | "suspended";

interface EditState {
  tenantId: string;
  name: string;
  plan: TenantRow["plan"];
  quotas: TenantRow["quotas"];
}

// ── Component ──────────────────────────────────────────────────────────

@customElement("platform-tenants-view")
export class PlatformTenantsView extends LitElement {
  private i18nCtrl = new I18nController(this);

  @property() gatewayUrl = "";

  @state() private tenants: TenantRow[] = [];
  @state() private total = 0;
  @state() private page = 0;
  @state() private statusFilter: StatusFilter = "all";
  @state() private searchQuery = "";
  @state() private loading = false;
  @state() private error = "";
  @state() private success = "";
  @state() private editState: EditState | null = null;
  @state() private planDefaults: PlanQuotaDefaults | null = null;
  @state() private saving = false;

  private searchTimer?: ReturnType<typeof setTimeout>;
  private readonly PAGE_SIZE = 20;

  static styles = [
    caretFix,
    css`
      :host {
        display: block;
        padding: 1.5rem;
        color: var(--text);
        font-family: var(--font-sans, system-ui, sans-serif);
      }

      /* ── Header ── */
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

      /* ── Buttons ── */
      .btn {
        padding: 0.45rem 0.9rem;
        border: none;
        border-radius: var(--radius-md, 6px);
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
        color: var(--accent-foreground, #fff);
      }
      .btn-outline {
        background: transparent;
        border: 1px solid var(--border);
        color: var(--text);
      }
      .btn-danger {
        background: var(--danger-subtle);
        color: var(--danger);
      }
      .btn-sm {
        padding: 0.3rem 0.6rem;
        font-size: 0.8rem;
      }

      /* ── Toolbar (logs-page style) ── */
      .filters {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        margin-bottom: 1rem;
      }
      .filter-label {
        font-size: 0.8rem;
        color: var(--text-secondary, var(--text-2, #a3a3a3));
        white-space: nowrap;
      }
      .filter-input {
        padding: 0.35rem 0.5rem;
        background: var(--bg, #0a0a0a);
        border: 1px solid var(--border, #262626);
        border-radius: 6px;
        color: var(--text, #e5e5e5);
        font-size: 0.8rem;
        outline: none;
        min-width: 180px;
      }
      .filter-input:focus {
        border-color: var(--accent);
      }
      .filter-input::placeholder {
        color: var(--muted);
      }
      .filter-select {
        padding: 0.35rem 0.5rem;
        padding-right: 1.8rem;
        background: var(--bg, #0a0a0a);
        border: 1px solid var(--border, #262626);
        border-radius: 6px;
        color: var(--text, #e5e5e5);
        font-size: 0.8rem;
        outline: none;
        appearance: none;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23888' d='M3 4.5L6 8l3-3.5H3z'/%3E%3C/svg%3E");
        background-repeat: no-repeat;
        background-position: right 0.5rem center;
        cursor: pointer;
      }
      .filter-select:focus {
        border-color: var(--accent);
      }
      .filter-sep {
        width: 1px;
        height: 18px;
        background: var(--border, #262626);
        margin: 0 4px;
      }

      /* ── Table ── */
      .table-wrap {
        overflow-x: auto;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.85rem;
      }
      th {
        text-align: left;
        padding: 0.5rem 0.75rem;
        border-bottom: 1px solid var(--border);
        font-weight: 500;
        white-space: nowrap;
        color: var(--text-2, var(--muted));
        font-size: 0.8rem;
      }
      td {
        padding: 0.6rem 0.75rem;
        border-bottom: 1px solid var(--border);
        vertical-align: middle;
      }
      .actions-cell {
        white-space: nowrap;
      }
      .actions-cell .btn + .btn {
        margin-left: 0.35rem;
      }

      /* ── Badges ── */
      .badge {
        display: inline-block;
        padding: 0.15rem 0.5rem;
        border-radius: 999px;
        font-size: 0.72rem;
        font-weight: 500;
      }
      .badge-free {
        background: var(--bg);
        border: 1px solid var(--border);
        color: var(--text-2);
      }
      .badge-pro {
        background: var(--accent-light, #dbeafe);
        color: var(--accent);
      }
      .badge-enterprise {
        background: var(--warn-subtle, #fef3c7);
        color: var(--warn, #92400e);
      }
      .badge-active {
        background: var(--ok-subtle, #d1fae5);
        color: var(--ok, #065f46);
      }
      .badge-suspended {
        background: var(--warn-subtle, #fed7aa);
        color: var(--warn, #9a3412);
      }
      .badge-deleted {
        background: var(--danger-subtle, #fee2e2);
        color: var(--danger, #991b1b);
      }

      /* ── Pagination ── */
      .pagination {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        margin-top: 1rem;
        gap: 0.25rem;
        font-size: 0.8rem;
        color: var(--text-2, var(--muted));
      }
      .page-info {
        font-variant-numeric: tabular-nums;
        margin-right: 0.75rem;
      }
      .page-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 28px;
        height: 28px;
        padding: 0 6px;
        border: 1px solid var(--border);
        border-radius: var(--radius-md, 6px);
        background: transparent;
        color: var(--text);
        font-size: 0.8rem;
        cursor: pointer;
        transition:
          background 0.15s,
          border-color 0.15s;
        font-variant-numeric: tabular-nums;
      }
      .page-btn:hover:not(:disabled):not(.active) {
        background: var(--bg-hover, rgba(255, 255, 255, 0.05));
        border-color: var(--accent);
      }
      .page-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .page-btn.active {
        background: var(--accent);
        color: var(--accent-foreground, #fff);
        border-color: var(--accent);
      }
      .page-ellipsis {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 28px;
        height: 28px;
        color: var(--muted);
        font-size: 0.8rem;
      }

      /* ── Modal ── */
      .modal-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
      }
      .modal {
        background: var(--card, #1a1a1a);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg, 12px);
        padding: 0;
        width: 480px;
        max-width: 90vw;
        box-shadow: 0 16px 48px rgba(0, 0, 0, 0.3);
        overflow: hidden;
      }
      .modal-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 1rem 1.25rem;
        border-bottom: 1px solid var(--border);
      }
      .modal-header h3 {
        margin: 0;
        font-size: 0.95rem;
        font-weight: 600;
      }
      .modal-close {
        background: none;
        border: none;
        color: var(--muted);
        cursor: pointer;
        font-size: 1.1rem;
        padding: 0.2rem;
        line-height: 1;
        border-radius: 4px;
      }
      .modal-close:hover {
        color: var(--text);
        background: var(--hover-bg, rgba(255, 255, 255, 0.06));
      }
      .modal-body {
        padding: 1.25rem;
      }
      .form-section {
        margin-bottom: 1.25rem;
      }
      .form-section:last-child {
        margin-bottom: 0;
      }
      .form-section-title {
        font-size: 0.75rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--muted);
        margin-bottom: 0.75rem;
      }
      .form-group {
        margin-bottom: 0.75rem;
      }
      .form-group:last-child {
        margin-bottom: 0;
      }
      .form-label {
        display: block;
        font-size: 0.8rem;
        margin-bottom: 0.35rem;
        color: var(--text-2);
        font-weight: 500;
      }
      .form-input,
      .form-select {
        width: 100%;
        padding: 0.5rem 0.7rem;
        background: var(--input-bg, var(--bg));
        border: 1px solid var(--input-border, var(--border));
        border-radius: var(--radius-md, 6px);
        color: var(--text);
        font-size: 0.85rem;
        outline: none;
        box-sizing: border-box;
        transition: border-color 0.15s;
      }
      .form-input:focus,
      .form-select:focus {
        border-color: var(--accent);
      }
      .form-input[readonly] {
        opacity: 0.55;
        cursor: not-allowed;
        background: var(--hover-bg, rgba(255, 255, 255, 0.03));
      }
      .form-hint {
        font-size: 0.72rem;
        color: var(--muted);
        margin-top: 0.25rem;
      }
      .form-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 0.75rem;
      }
      .quota-field {
        display: flex;
        gap: 0.5rem;
      }
      .quota-field .form-select {
        width: auto;
        min-width: 80px;
        flex-shrink: 0;
      }
      .quota-field .form-input {
        flex: 1;
        min-width: 0;
      }
      .modal-footer {
        display: flex;
        justify-content: flex-end;
        gap: 0.5rem;
        padding: 0.85rem 1.25rem;
        border-top: 1px solid var(--border);
        background: var(--hover-bg, rgba(255, 255, 255, 0.02));
      }

      /* ── Messages ── */
      .error-msg {
        background: var(--danger-subtle);
        border: 1px solid var(--danger);
        border-radius: var(--radius-md, 6px);
        color: var(--danger);
        padding: 0.5rem 0.75rem;
        font-size: 0.8rem;
        margin-bottom: 1rem;
      }
      .success-msg {
        background: var(--ok-subtle);
        border: 1px solid var(--ok);
        border-radius: var(--radius-md, 6px);
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
      .empty {
        text-align: center;
        padding: 2rem;
        color: var(--muted);
        font-size: 0.85rem;
      }
    `,
  ];

  connectedCallback() {
    super.connectedCallback();
    this.loadTenants();
  }

  private async loadTenants() {
    this.loading = true;
    this.error = "";
    try {
      const result = (await tenantRpc(
        "platform.tenants.list",
        {
          status: this.statusFilter === "all" ? undefined : this.statusFilter,
          search: this.searchQuery || undefined,
          limit: this.PAGE_SIZE,
          offset: this.page * this.PAGE_SIZE,
        },
        this.gatewayUrl,
      )) as { tenants: TenantRow[]; total: number };
      this.tenants = result.tenants;
      this.total = result.total;
    } catch (err) {
      this.error =
        err instanceof Error
          ? err.message
          : t("platformTenants.loadFailed" as any) || "Failed to load";
    } finally {
      this.loading = false;
    }
  }

  private onSearchInput(e: InputEvent) {
    this.searchQuery = (e.target as HTMLInputElement).value;
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
    }
    this.searchTimer = setTimeout(() => {
      this.page = 0;
      this.loadTenants();
    }, 300);
  }

  private onFilterChange(e: Event) {
    this.statusFilter = (e.target as HTMLSelectElement).value as StatusFilter;
    this.page = 0;
    this.loadTenants();
  }

  private async startEdit(row: TenantRow) {
    this.editState = {
      tenantId: row.id,
      name: row.name,
      plan: row.plan,
      quotas: { ...row.quotas },
    };
    if (!this.planDefaults) {
      try {
        this.planDefaults = (await tenantRpc(
          "platform.plans.quotas",
          {},
          this.gatewayUrl,
        )) as PlanQuotaDefaults;
      } catch {
        /* best-effort */
      }
    }
  }

  private closeEdit() {
    this.editState = null;
  }

  private onEditPlanChange(plan: TenantRow["plan"]) {
    if (!this.editState) {
      return;
    }
    const defaults = this.planDefaults?.[plan];
    this.editState = {
      ...this.editState,
      plan,
      quotas: defaults ? { ...defaults } : this.editState.quotas,
    };
  }

  private async saveEdit() {
    if (!this.editState) {
      return;
    }
    this.saving = true;
    try {
      await tenantRpc(
        "platform.tenants.update",
        {
          tenantId: this.editState.tenantId,
          name: this.editState.name,
          plan: this.editState.plan,
          quotas: this.editState.quotas,
        },
        this.gatewayUrl,
      );
      this.success = t("platformTenants.saveSuccess" as any) || "Saved";
      this.editState = null;
      await this.loadTenants();
      setTimeout(() => {
        this.success = "";
      }, 2000);
    } catch (err) {
      this.error =
        err instanceof Error
          ? err.message
          : t("platformTenants.saveFailed" as any) || "Save failed";
    } finally {
      this.saving = false;
    }
  }

  private async toggleSuspend(row: TenantRow) {
    const action =
      row.status === "suspended" ? "platform.tenants.unsuspend" : "platform.tenants.suspend";
    try {
      await tenantRpc(action, { tenantId: row.id }, this.gatewayUrl);
      await this.loadTenants();
    } catch (err) {
      this.error = err instanceof Error ? err.message : "Operation failed";
    }
  }

  private formatQuota(value: number): string {
    if (value === -1) {
      return t("tenantUsage.noLimit" as any) || "Unlimited";
    }
    if (value >= 1_000_000) {
      return `${(value / 1_000_000).toFixed(1)}M`;
    }
    return String(value);
  }

  private formatPlan(plan: string): string {
    const key = `platformTenants.plan${plan.charAt(0).toUpperCase()}${plan.slice(1)}` as any;
    return t(key) || plan;
  }

  private formatStatus(status: string): string {
    const key = `platformTenants.filter${status.charAt(0).toUpperCase()}${status.slice(1)}` as any;
    return t(key) || status;
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

  private formatDate(iso: string): string {
    try {
      return new Date(iso).toLocaleString(this.currentLocaleTag);
    } catch {
      return iso;
    }
  }

  private get totalPages(): number {
    return Math.max(1, Math.ceil(this.total / this.PAGE_SIZE));
  }

  private goToPage(p: number) {
    if (p < 0 || p >= this.totalPages || p === this.page) {
      return;
    }
    this.page = p;
    this.loadTenants();
  }

  private renderPagination() {
    const tp = this.totalPages;
    if (this.total <= 0) {
      return nothing;
    }
    const start = this.page * this.PAGE_SIZE + 1;
    const end = Math.min((this.page + 1) * this.PAGE_SIZE, this.total);

    const pages: (number | "...")[] = [];
    if (tp <= 7) {
      for (let i = 0; i < tp; i++) {
        pages.push(i);
      }
    } else {
      pages.push(0);
      if (this.page > 2) {
        pages.push("...");
      }
      const lo = Math.max(1, this.page - 1);
      const hi = Math.min(tp - 2, this.page + 1);
      for (let i = lo; i <= hi; i++) {
        pages.push(i);
      }
      if (this.page < tp - 3) {
        pages.push("...");
      }
      pages.push(tp - 1);
    }

    return html`
      <div class="pagination">
        <span class="page-info">${start}–${end} / ${this.total}</span>
        <button class="page-btn" ?disabled=${this.page === 0}
          @click=${() => this.goToPage(this.page - 1)}>‹</button>
        ${pages.map((p) =>
          p === "..."
            ? html`
                <span class="page-ellipsis">…</span>
              `
            : html`<button class="page-btn ${p === this.page ? "active" : ""}"
                @click=${() => this.goToPage(p)}>${p + 1}</button>`,
        )}
        <button class="page-btn" ?disabled=${this.page >= tp - 1}
          @click=${() => this.goToPage(this.page + 1)}>›</button>
      </div>
    `;
  }

  private renderQuotaField(es: EditState, key: keyof EditState["quotas"], label: string) {
    const isUnlimited = es.quotas[key] === -1;
    const unlimitedLabel = t("platformTenants.unlimited" as any) || "Unlimited";
    const customLabel = t("platformTenants.custom" as any) || "Custom";
    return html`
      <div class="form-group">
        <label class="form-label">${label}</label>
        <div class="quota-field">
          <select class="form-select"
            @change=${(e: Event) => {
              const v = (e.target as HTMLSelectElement).value;
              this.editState = {
                ...es,
                quotas: { ...es.quotas, [key]: v === "unlimited" ? -1 : 1 },
              };
            }}>
            <option value="unlimited" ?selected=${isUnlimited}>${unlimitedLabel}</option>
            <option value="custom" ?selected=${!isUnlimited}>${customLabel}</option>
          </select>
          ${
            isUnlimited
              ? nothing
              : html`
            <input class="form-input" type="number" min="1"
              .value=${String(es.quotas[key])}
              @input=${(e: InputEvent) => {
                const v = Number((e.target as HTMLInputElement).value);
                this.editState = {
                  ...es,
                  quotas: { ...es.quotas, [key]: v < 1 ? 1 : Math.floor(v) },
                };
              }} />
          `
          }
        </div>
      </div>
    `;
  }

  private renderEditModal() {
    const es = this.editState;
    if (!es) {
      return nothing;
    }
    return html`
      <div class="modal-overlay" @click=${(e: Event) => {
        if (e.target === e.currentTarget) {
          this.closeEdit();
        }
      }}>
        <div class="modal">
          <div class="modal-header">
            <h3>${t("platformTenants.editTitle" as any) || "Edit Enterprise"}</h3>
            <button class="modal-close" @click=${() => this.closeEdit()}>✕</button>
          </div>
          <div class="modal-body">
            <div class="form-section">
              <div class="form-group">
                <label class="form-label">${t("platformTenants.colName" as any) || "Enterprise Name"}</label>
                <input class="form-input" .value=${es.name} readonly />
              </div>
              <div class="form-group">
                <label class="form-label">${t("platformTenants.colPlan" as any) || "Plan"}</label>
                <select class="form-select" @change=${(e: Event) => this.onEditPlanChange((e.target as HTMLSelectElement).value as TenantRow["plan"])}>
                  ${(["free", "pro", "enterprise"] as const).map(
                    (p) => html`
                    <option value=${p} ?selected=${es.plan === p}>${this.formatPlan(p)}</option>
                  `,
                  )}
                </select>
                <div class="form-hint">${t("platformTenants.planChangeHint" as any) || "Changing plan resets quotas to plan defaults"}</div>
              </div>
            </div>
            <div class="form-section">
              <div class="form-section-title">${t("platformTenants.quotaSettings" as any) || "Quota Settings"}</div>
              <div class="form-row">
                ${this.renderQuotaField(es, "maxUsers", t("platformTenants.colMaxUsers" as any) || "User Limit")}
                ${this.renderQuotaField(es, "maxAgents", t("platformTenants.colMaxAgents" as any) || "Agent Limit")}
              </div>
              <div class="form-row">
                ${this.renderQuotaField(es, "maxChannels", t("platformTenants.colMaxChannels" as any) || "Channel Limit")}
                ${this.renderQuotaField(es, "maxCronJobs", t("platformTenants.colMaxCronJobs" as any) || "Cron Limit")}
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-outline" @click=${() => this.closeEdit()}>${t("platformTenants.cancel" as any) || "Cancel"}</button>
            <button class="btn btn-primary" ?disabled=${this.saving} @click=${() => this.saveEdit()}>
              ${this.saving ? t("platformTenants.saving" as any) || "Saving…" : t("platformTenants.save" as any) || "Save"}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  render() {
    return html`
      <div class="header">
        <h2>${t("platformTenants.title" as any) || "Enterprise Management"}</h2>
        <button class="btn btn-outline" @click=${() => this.loadTenants()}>${t("platformTenants.refresh" as any) || "Refresh"}</button>
      </div>

      <div class="filters">
        <span class="filter-label">${t("platformTenants.colName" as any) || "Enterprise"}:</span>
        <input class="filter-input" type="text"
          placeholder=${t("platformTenants.searchPlaceholder" as any) || "Enter enterprise name"}
          .value=${this.searchQuery}
          @input=${this.onSearchInput} />
        <span class="filter-label">${t("platformTenants.colStatus" as any) || "Status"}:</span>
        <select class="filter-select" @change=${this.onFilterChange}>
          <option value="all" ?selected=${this.statusFilter === "all"}>${t("platformTenants.filterAll" as any) || "All"}</option>
          <option value="active" ?selected=${this.statusFilter === "active"}>${t("platformTenants.filterActive" as any) || "Active"}</option>
          <option value="suspended" ?selected=${this.statusFilter === "suspended"}>${t("platformTenants.filterSuspended" as any) || "Suspended"}</option>
        </select>
      </div>

      ${this.error ? html`<div class="error-msg">${this.error}</div>` : nothing}
      ${this.success ? html`<div class="success-msg">${this.success}</div>` : nothing}

      ${
        this.loading
          ? html`<div class="loading">${t("platformTenants.loading" as any) || "Loading…"}</div>`
          : this.tenants.length === 0
            ? html`<div class="empty">${t("platformTenants.empty" as any) || "No enterprises yet"}</div>`
            : html`
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>${t("platformTenants.colName" as any) || "Enterprise Name"}</th>
                    <th>${t("platformTenants.colPlan" as any) || "Plan"}</th>
                    <th>${t("platformTenants.colStatus" as any) || "Status"}</th>
                    <th>${t("platformTenants.colMaxUsers" as any) || "User Limit"}</th>
                    <th>${t("platformTenants.colMaxAgents" as any) || "Agent Limit"}</th>
                    <th>${t("platformTenants.colMaxChannels" as any) || "Channel Limit"}</th>
                    <th>${t("platformTenants.colMaxCronJobs" as any) || "Cron Limit"}</th>
                    <th>${t("platformTenants.colCreatedAt" as any) || "Created"}</th>
                    <th>${t("platformTenants.colActions" as any) || "Actions"}</th>
                  </tr>
                </thead>
                <tbody>
                  ${this.tenants.map(
                    (r) => html`
                    <tr>
                      <td>${r.name}</td>
                      <td><span class="badge badge-${r.plan}">${this.formatPlan(r.plan)}</span></td>
                      <td><span class="badge badge-${r.status}">${this.formatStatus(r.status)}</span></td>
                      <td>${this.formatQuota(r.quotas.maxUsers)}</td>
                      <td>${this.formatQuota(r.quotas.maxAgents)}</td>
                      <td>${this.formatQuota(r.quotas.maxChannels)}</td>
                      <td>${this.formatQuota(r.quotas.maxCronJobs)}</td>
                      <td>${this.formatDate(r.createdAt)}</td>
                      <td class="actions-cell">
                        ${
                          r.id === PLATFORM_TENANT_ID
                            ? html`
                                <span style="color: var(--muted); font-size: 0.8rem">—</span>
                              `
                            : html`
                          <button class="btn btn-outline btn-sm" @click=${() => this.startEdit(r)}>${t("platformTenants.edit" as any) || "Edit"}</button>
                          <button class="btn ${r.status === "suspended" ? "btn-primary" : "btn-danger"} btn-sm"
                            @click=${() => this.toggleSuspend(r)}>
                            ${
                              r.status === "suspended"
                                ? t("platformTenants.unsuspend" as any) || "Activate"
                                : t("platformTenants.suspend" as any) || "Suspend"
                            }
                          </button>
                        `
                        }
                      </td>
                    </tr>
                  `,
                  )}
                </tbody>
              </table>
            </div>

            ${this.renderPagination()}
          `
      }

      ${this.renderEditModal()}
    `;
  }
}
