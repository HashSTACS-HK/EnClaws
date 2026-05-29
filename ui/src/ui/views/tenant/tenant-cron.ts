/**
 * Enterprise cross-agent cron overview (Layer 3).
 *
 * Read-only monitoring + emergency management (disable/delete).
 * No create button — task creation happens in Agent Tab (Layer 2).
 */

import { html, css, LitElement, nothing } from "lit";
import { customElement, state, property } from "lit/decorators.js";
import { t, I18nController } from "../../../i18n/index.ts";
import { showConfirm } from "../../components/confirm-dialog.ts";
import { formatRelativeTimestamp } from "../../format.ts";
import { formatCronSchedule } from "../../presenter.ts";
import { caretFix } from "../../shared-styles.ts";
import type { CronJob } from "../../types.ts";
import { tenantRpc } from "./rpc.ts";

type CronJobWithAgent = CronJob & { _agentId: string };

@customElement("tenant-cron-view")
export class TenantCronView extends LitElement {
  private i18nCtrl = new I18nController(this);

  static styles = [
    caretFix,
    css`
      :host {
        display: block;
        padding: 1.5rem;
      }
      .card {
        background: var(--surface-2, #f8fcfd);
        border-radius: 6px;
        padding: 16px;
        margin-bottom: 16px;
      }
      .card-title {
        font-size: 1.1rem;
        font-weight: 600;
      }
      .card-sub {
        font-size: 0.8rem;
        color: var(--muted, #7ea5b2);
        margin-top: 2px;
      }
      .stats {
        display: flex;
        gap: 32px;
        flex-wrap: wrap;
      }
      .stat-item {
        text-align: center;
      }
      .stat-value {
        font-size: 1.5rem;
        font-weight: 700;
      }
      .stat-label {
        font-size: 0.75rem;
        color: var(--muted, #7ea5b2);
      }
      .alert-section {
        background: var(--warn-subtle, rgba(245, 158, 11, 0.1));
        border: 1px solid var(--warn-muted, rgba(245, 158, 11, 0.75));
        border-radius: 6px;
        padding: 12px 16px;
        margin-bottom: 16px;
      }
      .alert-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 0;
        font-size: 0.85rem;
      }
      .filters {
        display: flex;
        gap: 8px;
        margin-bottom: 12px;
        flex-wrap: wrap;
        align-items: center;
      }
      .filters input,
      .filters select {
        padding: 4px 8px;
        border: 1px solid var(--border, #e2eef2);
        border-radius: 4px;
        background: var(--input-bg, #f8fcfd);
        color: inherit;
        font-size: 0.85rem;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.85rem;
      }
      th {
        text-align: left;
        padding: 8px 12px;
        border-bottom: 1px solid var(--border, #e2eef2);
        color: var(--muted, #7ea5b2);
        font-weight: 500;
      }
      td {
        padding: 8px 12px;
        border-bottom: 1px solid var(--border, #e2eef2);
      }
      .chip {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 10px;
        font-size: 0.75rem;
      }
      .chip-ok {
        background: var(--ok-subtle, rgba(16, 185, 129, 0.1));
        color: var(--ok, #10b981);
      }
      .chip-muted {
        background: var(--bg-muted, #f0fdfe);
        color: var(--muted, #7ea5b2);
      }
      .chip-danger {
        background: var(--danger-subtle, rgba(239, 68, 68, 0.1));
        color: var(--danger, #ef4444);
      }
      .btn {
        padding: 4px 10px;
        border: 1px solid var(--border, #e2eef2);
        border-radius: 4px;
        background: var(--card, #ffffff);
        color: inherit;
        cursor: pointer;
        font-size: 0.8rem;
      }
      .btn:hover {
        background: var(--bg-hover, #e8f9fc);
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .btn-danger {
        border-color: var(--danger-muted, rgba(239, 68, 68, 0.75));
        color: var(--danger, #ef4444);
      }
      .btn-primary {
        background: var(--accent, #0891b2);
        border-color: var(--accent, #0891b2);
        color: #fff;
      }
      .agent-link {
        color: var(--accent, #0891b2);
        cursor: pointer;
        text-decoration: none;
      }
      .agent-link:hover {
        text-decoration: underline;
      }
      .empty {
        text-align: center;
        padding: 2rem;
        color: var(--muted, #7ea5b2);
      }
      .loading {
        text-align: center;
        padding: 2rem;
        color: var(--muted, #7ea5b2);
      }
    `,
  ];

  @property({ type: String }) gatewayUrl = "";
  @state() private jobs: CronJobWithAgent[] = [];
  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private busy = false;
  @state() private filterQuery = "";
  @state() private filterEnabled: "all" | "enabled" | "disabled" = "all";
  @state() private filterAgent = "";
  @state() private alertsExpanded = true;

  connectedCallback() {
    super.connectedCallback();
    this.loadJobs();
  }

  private rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return tenantRpc(method, params, this.gatewayUrl);
  }

  private async loadJobs() {
    this.loading = true;
    this.error = null;
    try {
      const res = (await this.rpc("cron.listAll")) as { jobs?: CronJobWithAgent[]; total?: number };
      this.jobs = res.jobs ?? [];
    } catch (err) {
      this.error = String(err);
    } finally {
      this.loading = false;
    }
  }

  private get filteredJobs(): CronJobWithAgent[] {
    let result = this.jobs;
    if (this.filterEnabled === "enabled") {
      result = result.filter((j) => j.enabled);
    } else if (this.filterEnabled === "disabled") {
      result = result.filter((j) => !j.enabled);
    }
    if (this.filterAgent) {
      const q = this.filterAgent.toLowerCase();
      result = result.filter((j) => j._agentId.toLowerCase().includes(q));
    }
    if (this.filterQuery) {
      const q = this.filterQuery.toLowerCase();
      result = result.filter(
        (j) => j.name.toLowerCase().includes(q) || j._agentId.toLowerCase().includes(q),
      );
    }
    return result;
  }

  private get failedJobs(): CronJobWithAgent[] {
    return this.jobs.filter((j) => (j.state?.consecutiveErrors ?? 0) > 0);
  }

  private get agentIds(): string[] {
    return [...new Set(this.jobs.map((j) => j._agentId))].toSorted();
  }

  private async toggleJob(job: CronJobWithAgent, enabled: boolean) {
    this.busy = true;
    try {
      await this.rpc("cron.update", { _agentId: job._agentId, id: job.id, patch: { enabled } });
      await this.loadJobs();
    } catch (err) {
      this.error = String(err);
    } finally {
      this.busy = false;
    }
  }

  private async removeJob(job: CronJobWithAgent) {
    const confirmed = await showConfirm({
      title: t("cron.remove.confirmTitle"),
      message: t("cron.remove.confirmMessage", { name: job.name }),
      confirmText: t("cron.remove.confirmButton"),
      cancelText: t("cron.remove.cancelButton"),
      danger: true,
    });
    if (!confirmed) {
      return;
    }
    this.busy = true;
    try {
      await this.rpc("cron.remove", { _agentId: job._agentId, id: job.id });
      await this.loadJobs();
    } catch (err) {
      this.error = String(err);
    } finally {
      this.busy = false;
    }
  }

  private navigateToAgent(agentId: string) {
    // Dispatch event for parent to handle navigation to tenant-agents + select agent + cron panel
    this.dispatchEvent(
      new CustomEvent("navigate-to-agent-cron", {
        detail: { agentId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  render() {
    const filtered = this.filteredJobs;
    const failed = this.failedJobs;
    const enabledCount = this.jobs.filter((j) => j.enabled).length;

    return html`
      <div class="card">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div>
            <div class="card-title">${t("tenantCron.title")}</div>
            <div class="card-sub">${t("tenantCron.subtitle")}</div>
          </div>
          <button class="btn" ?disabled=${this.loading} @click=${() => this.loadJobs()}>
            ${this.loading ? t("cron.summary.refreshing") : t("cron.summary.refresh")}
          </button>
        </div>
      </div>

      <!-- Health overview -->
      <div class="card">
        <div class="stats">
          <div class="stat-item">
            <div class="stat-value">${this.jobs.length}</div>
            <div class="stat-label">${t("tenantCron.totalJobs")}</div>
          </div>
          <div class="stat-item">
            <div class="stat-value">${enabledCount}</div>
            <div class="stat-label">${t("cron.summary.enabled")}</div>
          </div>
          <div class="stat-item">
            <div class="stat-value" style="color: ${failed.length > 0 ? "var(--danger, #ef4444)" : "inherit"};">
              ${failed.length}
            </div>
            <div class="stat-label">${t("tenantCron.failedAlerts")}</div>
          </div>
          <div class="stat-item">
            <div class="stat-value">${this.agentIds.length}</div>
            <div class="stat-label">${t("tenantCron.agents")}</div>
          </div>
        </div>
      </div>

      ${this.error ? html`<div class="card" style="color: var(--danger, #ef4444);">${this.error}</div>` : nothing}

      <!-- Failed alerts -->
      ${
        failed.length > 0
          ? html`
        <div class="alert-section">
          <div style="display: flex; justify-content: space-between; align-items: center; cursor: pointer;"
            @click=${() => (this.alertsExpanded = !this.alertsExpanded)}>
            <span style="font-weight: 600;">\u26A0 ${t("tenantCron.failedAlerts")} (${failed.length})</span>
            <span>${this.alertsExpanded ? "\u25B2" : "\u25BC"}</span>
          </div>
          ${
            this.alertsExpanded
              ? html`
            ${failed.map(
              (job) => html`
              <div class="alert-row">
                <span>\u274C</span>
                <strong>${job.name}</strong>
                <span class="agent-link" @click=${() => this.navigateToAgent(job._agentId)}>${job._agentId}</span>
                <span style="color: var(--muted, #7ea5b2);">
                  ${t("tenantCron.consecutiveErrors", { count: String(job.state?.consecutiveErrors ?? 0) })}
                  ${!job.enabled ? ` (${t("tenantCron.autoDisabled")})` : ""}
                </span>
              </div>
            `,
            )}
          `
              : nothing
          }
        </div>
      `
          : nothing
      }

      <!-- Filters -->
      <div class="filters">
        <input placeholder=${t("cron.jobs.searchPlaceholder")} .value=${this.filterQuery}
          @input=${(e: Event) => (this.filterQuery = (e.target as HTMLInputElement).value)} />
        <select .value=${this.filterEnabled}
          @change=${(e: Event) => (this.filterEnabled = (e.target as HTMLSelectElement).value as "all" | "enabled" | "disabled")}>
          <option value="all">${t("cron.jobs.all")}</option>
          <option value="enabled">${t("cron.jobList.enabled")}</option>
          <option value="disabled">${t("cron.jobList.disabled")}</option>
        </select>
        ${
          this.agentIds.length > 1
            ? html`
          <select .value=${this.filterAgent}
            @change=${(e: Event) => (this.filterAgent = (e.target as HTMLSelectElement).value)}>
            <option value="">${t("tenantCron.allAgents")}</option>
            ${this.agentIds.map((id) => html`<option value=${id}>${id}</option>`)}
          </select>
        `
            : nothing
        }
      </div>

      <!-- Jobs table -->
      ${
        this.loading && this.jobs.length === 0
          ? html`<div class="loading">${t("cron.jobs.loading")}</div>`
          : filtered.length === 0
            ? html`<div class="empty">${t("cron.jobs.noMatching")}</div>`
            : html`
            <div class="card" style="padding: 0; overflow-x: auto;">
              <table>
                <thead>
                  <tr>
                    <th>${t("tenantCron.agent")}</th>
                    <th>${t("cron.form.fieldName")}</th>
                    <th>${t("cron.jobs.schedule")}</th>
                    <th>${t("cron.jobs.lastRun")}</th>
                    <th>${t("cron.summary.enabled")}</th>
                    <th>${t("cron.summary.nextWake")}</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  ${filtered.map((job) => this.renderJobRow(job))}
                </tbody>
              </table>
            </div>
            <div style="font-size: 0.8rem; color: var(--muted, #7ea5b2); margin-top: 4px;">
              ${t("cron.jobs.shownOf", { shown: String(filtered.length), total: String(this.jobs.length) })}
            </div>
          `
      }
    `;
  }

  private renderJobRow(job: CronJobWithAgent) {
    const status = job.state?.lastRunStatus ?? job.state?.lastStatus;
    const statusIcon =
      status === "ok"
        ? "\u2705"
        : status === "error"
          ? "\u274C"
          : status === "skipped"
            ? "\u23ED"
            : "";
    const lastRunText = job.state?.lastRunAtMs
      ? formatRelativeTimestamp(job.state.lastRunAtMs)
      : "--";
    const nextRunText = job.state?.nextRunAtMs
      ? formatRelativeTimestamp(job.state.nextRunAtMs)
      : "--";

    return html`
      <tr>
        <td><span class="agent-link" @click=${() => this.navigateToAgent(job._agentId)}>${job._agentId}</span></td>
        <td>
          <div style="font-weight: 500;">${job.name}</div>
          ${job.createdBy ? html`<div style="font-size: 0.75rem; color: var(--muted, #7ea5b2);">${job.createdBy.displayName || job.createdBy.userId}</div>` : nothing}
        </td>
        <td>${formatCronSchedule(job)}</td>
        <td>${statusIcon} ${lastRunText}</td>
        <td><span class=${`chip ${job.enabled ? "chip-ok" : "chip-muted"}`}>${job.enabled ? t("cron.jobList.enabled") : t("cron.jobList.disabled")}</span></td>
        <td>${nextRunText}</td>
        <td style="white-space: nowrap;">
          <button class="btn" ?disabled=${this.busy}
            @click=${() => this.toggleJob(job, !job.enabled)}>
            ${job.enabled ? t("cron.jobList.disable") : t("cron.jobList.enable")}
          </button>
          <button class="btn btn-danger" ?disabled=${this.busy}
            @click=${() => this.removeJob(job)}>
            ${t("cron.jobList.remove")}
          </button>
        </td>
      </tr>
    `;
  }
}
