/**
 * Tenant usage dashboard view.
 *
 * Focused on the "quota / consumption" angle to complement the homepage
 * (tenant-overview), which already covers business-overview style data.
 *
 * Sections:
 *   B. 资源配额（agents/channels/users 当前 vs 上限 + 进度条）
 *   C. 月度 Token 配额（已用 / 剩余 / 百分比 / 进度条）
 *   D. 区间统计（4 卡：总 / 输入 / 输出 / 记录数） + 日期过滤器（仅影响本节）
 */

import { html, css, LitElement, nothing } from "lit";
import { customElement, state, property } from "lit/decorators.js";
import { t, i18n, I18nController } from "../../../i18n/index.ts";
import "../../components/date-picker.ts";
import { caretFix } from "../../shared-styles.ts";
import { tenantRpc } from "./rpc.ts";

// ── Types ──

/** Shape returned by `tenant.usage.summary` RPC. */
interface UsageSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  recordCount: number;
}

/** Shape returned by `tenant.usage.quota` RPC. */
interface QuotaInfo {
  plan: string;
  period: { start: string; end: string };
  tokens: { used: number; max: number; remaining: number; percentUsed: number };
  quotas: TenantQuotas;
  currentCronJobs?: number;
}

/** Subset of tenant.overview.summary used to populate the resource quota cards. */
interface TenantSummary {
  tenant: { name: string; plan: string; status: string; createdAt: string; admin: string };
  agents: { total: number; active: number; active30d: number };
  channels: { total: number; active: number; apps: number };
  users: { total: number; active30d: number };
}

interface TenantQuotas {
  maxUsers?: number;
  maxAgents?: number;
  maxChannels?: number;
  maxModels?: number;
  maxTokensPerMonth?: number;
  maxCronJobs?: number;
}

// ── Component ──

@customElement("tenant-usage-view")
export class TenantUsageView extends LitElement {
  // Drives reactive re-render when the active locale changes.
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
      .stats-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
        gap: 1rem;
        margin-bottom: 1.5rem;
      }
      .stat-card {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        padding: 1.25rem;
      }
      .stat-label {
        font-size: 0.8rem;
        color: var(--text-secondary, #a3a3a3);
        margin-bottom: 0.35rem;
      }
      .stat-value {
        font-size: 1.5rem;
        font-weight: 700;
      }
      .stat-sub {
        font-size: 0.75rem;
        color: var(--muted);
        margin-top: 0.25rem;
      }
      .quota-bar {
        height: 8px;
        border-radius: 4px;
        background: var(--border);
        margin-top: 0.5rem;
        overflow: hidden;
      }
      .quota-fill {
        height: 100%;
        border-radius: 4px;
        transition: width 0.3s;
      }
      .quota-fill.low {
        background: var(--ok);
      }
      .quota-fill.mid {
        background: var(--warn);
      }
      .quota-fill.high {
        background: var(--danger);
      }
      .section {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        padding: 1.25rem;
        margin-bottom: 1rem;
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
        color: var(--text-muted, #525252);
      }
      .filters {
        display: flex;
        gap: 0.5rem;
        align-items: center;
        margin-bottom: 1rem;
        flex-wrap: wrap;
      }
      .filters label {
        font-size: 0.8rem;
        color: var(--text-secondary, #a3a3a3);
      }

      /* ── Resource quota cards (Section B) ── */
      .resource-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
        gap: 0.75rem;
      }
      .resource-card {
        background: var(--bg, #0a0a0a);
        border: 1px solid var(--border, #262626);
        border-radius: var(--radius-md, 6px);
        padding: 0.85rem 1rem;
      }
      .resource-label {
        font-size: 0.75rem;
        color: var(--text-secondary, #a3a3a3);
        margin-bottom: 0.35rem;
      }
      .resource-value {
        font-size: 1.1rem;
        font-weight: 600;
      }
      .resource-value .max {
        color: var(--text-muted, #525252);
        font-weight: 400;
        font-size: 0.85rem;
      }
      .resource-value .infinite {
        color: var(--text-muted, #525252);
        font-weight: 400;
        font-size: 0.85rem;
      }

      .empty-hint {
        color: var(--text-muted, #525252);
        font-size: 0.85rem;
        padding: 1rem 0.5rem;
        text-align: center;
      }

      .section-note {
        font-size: 0.85rem;
        color: var(--text-2, #a1a1aa);
        margin-top: 0.35rem;
        display: flex;
        align-items: center;
        gap: 0.5rem;
      }
      .plan-tag {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        padding: 0.25rem 0.7rem;
        border-radius: 9999px;
        font-size: 0.8rem;
        font-weight: 600;
        letter-spacing: 0.02em;
      }
      .plan-tag.free {
        background: var(--border, #333);
        color: var(--muted, #888);
      }
      .plan-tag.pro {
        background: var(--accent-light, #1e3a5f);
        color: var(--accent, #3b82f6);
      }
      .plan-tag.enterprise {
        background: var(--accent-light, #1e3a5f);
        color: var(--accent-2, #8b5cf6);
      }
    `,
  ];

  @property({ type: String }) gatewayUrl = "";

  @state() private summary: UsageSummary | null = null;
  @state() private quota: QuotaInfo | null = null;
  @state() private tenantSummary: TenantSummary | null = null;
  @state() private tenantQuotas: TenantQuotas = {};

  @state() private loading = false;
  @state() private error = "";
  private msgTimer?: ReturnType<typeof setTimeout>;

  @state() private startDate = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
  })();
  @state() private endDate = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();

  private showError(msg: string) {
    this.error = msg;
    if (this.msgTimer) {
      clearTimeout(this.msgTimer);
    }
    this.msgTimer = setTimeout(() => (this.error = ""), 5000);
  }

  connectedCallback() {
    super.connectedCallback();
    this.loadData();
  }

  private rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return tenantRpc(method, params, this.gatewayUrl);
  }

  /** Map active i18n locale to a BCP-47 tag the date-picker understands. */
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

  private async loadData() {
    this.loading = true;
    this.error = "";
    try {
      const [summaryResult, quotaResult, tenantSummaryResult] = await Promise.all([
        this.rpc("tenant.usage.summary", { since: this.startDate, until: this.endDate }).catch(
          () => null,
        ),
        this.rpc("tenant.usage.quota").catch(() => null),
        this.rpc("tenant.overview.summary").catch(() => null),
      ]);

      this.summary = summaryResult as UsageSummary | null;
      this.quota = quotaResult as QuotaInfo | null;
      this.tenantSummary = tenantSummaryResult as TenantSummary | null;
      this.tenantQuotas = this.quota?.quotas ?? {};
    } catch (err) {
      this.showError(err instanceof Error ? err.message : t("tenantUsage.loadFailed"));
    } finally {
      this.loading = false;
    }
  }

  private formatNumber(n: number): string {
    if (n >= 1_000_000) {
      return `${(n / 1_000_000).toFixed(1)}M`;
    }
    if (n >= 1_000) {
      return `${(n / 1_000).toFixed(1)}K`;
    }
    return String(n);
  }

  private quotaClass(pct: number | null): string {
    if (pct === null) {
      return "low";
    }
    if (pct > 90) {
      return "high";
    }
    if (pct > 70) {
      return "mid";
    }
    return "low";
  }

  /** Render a single resource quota card (current vs max). */
  private renderResourceCard(label: string, current: number, max: number | undefined) {
    const limit = max ?? 0;
    const isInfinite = limit < 0;
    return html`
      <div class="resource-card">
        <div class="resource-label">${label}</div>
        <div class="resource-value">
          ${current}
          ${
            isInfinite
              ? html`<span class="infinite"> / ${t("tenantUsage.unlimited")}</span>`
              : html`<span class="max"> / ${limit}</span>`
          }
        </div>
        ${
          !isInfinite && limit > 0
            ? html`
              <div class="quota-bar">
                <div
                  class="quota-fill ${this.quotaClass((current / limit) * 100)}"
                  style="width:${Math.min(100, (current / limit) * 100)}%"
                ></div>
              </div>
            `
            : nothing
        }
      </div>
    `;
  }

  render() {
    if (this.loading && !this.tenantSummary) {
      return html`<div class="loading">${t("tenantUsage.loading")}</div>`;
    }

    return html`
      <div class="header">
        <h2>${t("tenantUsage.title")}</h2>
        <button class="btn btn-outline" @click=${() => this.loadData()}>${t("tenantUsage.refresh")}</button>
      </div>

      ${this.error ? html`<div class="error-msg">${this.error}</div>` : nothing}

      <!-- ════════════════════════════════════════════════════════════
           Section B: 资源配额（agents / channels / users）
           ════════════════════════════════════════════════════════════ -->
      ${
        this.tenantSummary
          ? html`
            <div class="section">
              <h3>${t("tenantUsage.resourceQuotas")}</h3>
              <div class="section-note">
                ${t("tenantUsage.currentPlan")}
                <span class="plan-tag ${this.tenantSummary.tenant.plan}">${t(`platformTenants.plan${this.tenantSummary.tenant.plan.charAt(0).toUpperCase()}${this.tenantSummary.tenant.plan.slice(1)}` as any) || this.tenantSummary.tenant.plan}</span>
              </div>
              <div class="resource-grid" style="margin-top: 0.75rem;">
                ${this.renderResourceCard(t("tenantUsage.agents"), this.tenantSummary.agents.total, this.tenantQuotas.maxAgents)}
                ${this.renderResourceCard(t("tenantUsage.channels"), this.tenantSummary.channels.total, this.tenantQuotas.maxChannels)}
                ${this.renderResourceCard(t("tenantUsage.users"), this.tenantSummary.users.total, this.tenantQuotas.maxUsers)}
                ${this.renderResourceCard(t("tenantUsage.cronJobs"), this.quota?.currentCronJobs ?? 0, this.tenantQuotas.maxCronJobs)}
              </div>
            </div>
          `
          : nothing
      }

      <!-- ════════════════════════════════════════════════════════════
           Section C: 月度 Token 配额（已用 / 剩余 / 百分比 / 进度条）
           ════════════════════════════════════════════════════════════ -->
      ${
        this.quota
          ? (() => {
              const tk = this.quota.tokens;
              const isInfinite = tk.max <= 0;
              return html`
              <div class="section">
                <h3>${t("tenantUsage.monthlyTokenQuota")}</h3>
                <div class="stats-grid">
                  <div class="stat-card">
                    <div class="stat-label">${t("tenantUsage.monthlyQuota")}</div>
                    <div class="stat-value">${isInfinite ? t("tenantUsage.noLimit") : this.formatNumber(tk.max)}</div>
                  </div>
                  <div class="stat-card">
                    <div class="stat-label-row">
                      <span class="stat-label">${t("tenantUsage.used")}</span>
                      ${
                        !isInfinite
                          ? html`<span class="stat-percent">${tk.percentUsed.toFixed(1)}%</span>`
                          : nothing
                      }
                    </div>
                    <div class="stat-value">${this.formatNumber(tk.used)}</div>
                    ${
                      !isInfinite
                        ? html`
                          <div class="quota-bar">
                            <div class="quota-fill ${this.quotaClass(tk.percentUsed)}"
                              style="width:${Math.min(100, tk.percentUsed)}%"></div>
                          </div>
                        `
                        : nothing
                    }
                  </div>
                  <div class="stat-card">
                    <div class="stat-label">${t("tenantUsage.remaining")}</div>
                    <div class="stat-value">${isInfinite ? t("tenantUsage.noLimit") : this.formatNumber(tk.remaining)}</div>
                  </div>
                </div>
              </div>
            `;
            })()
          : nothing
      }

      <!-- ════════════════════════════════════════════════════════════
           Section D: 区间统计（4 卡：总 / 输入 / 输出 / 记录数）
           日期过滤器仅作用于这一节，因此就近放在标题下。
           ════════════════════════════════════════════════════════════ -->
      <div class="section">
        <h3>${t("tenantUsage.periodStats")}</h3>
        <div class="filters">
          <label>${t("tenantUsage.since")}</label>
          <date-picker .value=${this.startDate} .locale=${this.currentLocaleTag}
            .max=${this.endDate} .placeholder=${t("tenantUsage.since")}
            @change=${(e: CustomEvent) => {
              this.startDate = e.detail.value;
              this.loadData();
            }}></date-picker>
          <label>${t("tenantUsage.until")}</label>
          <date-picker .value=${this.endDate} .locale=${this.currentLocaleTag}
            .min=${this.startDate} .placeholder=${t("tenantUsage.until")}
            @change=${(e: CustomEvent) => {
              this.endDate = e.detail.value;
              this.loadData();
            }}></date-picker>
        </div>
        ${
          this.summary
            ? (() => {
                const totalTokens = this.summary.totalInputTokens + this.summary.totalOutputTokens;
                return html`
                <div class="stats-grid">
                  <div class="stat-card">
                    <div class="stat-label">${t("tenantUsage.totalTokens")}</div>
                    <div class="stat-value">${this.formatNumber(totalTokens)}</div>
                  </div>
                  <div class="stat-card">
                    <div class="stat-label">${t("tenantUsage.inputTokens")}</div>
                    <div class="stat-value">${this.formatNumber(this.summary.totalInputTokens)}</div>
                  </div>
                  <div class="stat-card">
                    <div class="stat-label">${t("tenantUsage.outputTokens")}</div>
                    <div class="stat-value">${this.formatNumber(this.summary.totalOutputTokens)}</div>
                  </div>
                  <div class="stat-card">
                    <div class="stat-label">${t("tenantUsage.recordCount")}</div>
                    <div class="stat-value">${this.formatNumber(this.summary.recordCount)}</div>
                  </div>
                </div>
              `;
              })()
            : html`<div class="empty-hint">${t("tenantUsage.noData")}</div>`
        }
      </div>
    `;
  }
}
