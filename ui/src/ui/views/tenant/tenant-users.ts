/**
 * Tenant user management view.
 *
 * Lists users, supports inviting new users, changing roles, and removing users.
 */

import { html, css, LitElement, nothing } from "lit";
import { customElement, state, property } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { t, i18n, I18nController } from "../../../i18n/index.ts";
import { loadAuth, hashPasswordForTransport } from "../../auth-store.ts";
import { caretFix } from "../../shared-styles.ts";
import { tenantRpc, quotaErrorKey } from "./rpc.ts";

interface TenantUser {
  id: string;
  email: string;
  displayName: string | null;
  role: string;
  status: string;
  lastLoginAt: string | null;
  createdAt: string;
  channelName: string | null;
  channelType: string | null;
}

@customElement("tenant-users-view")
export class TenantUsersView extends LitElement {
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
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.85rem;
      }
      th,
      td {
        text-align: left;
        padding: 0.6rem 0.75rem;
        border-bottom: 1px solid var(--border);
      }
      th {
        font-weight: 500;
        color: var(--text-2);
        font-size: 0.8rem;
      }
      .role-badge {
        display: inline-block;
        padding: 0.15rem 0.45rem;
        border-radius: 4px;
        font-size: 0.75rem;
        font-weight: 500;
        background: var(--border);
      }
      .role-badge.owner {
        background: var(--accent-light);
        color: var(--accent);
      }
      .role-badge.admin {
        background: var(--accent-light);
        color: var(--accent-2);
      }
      .role-badge.member {
        background: var(--ok-subtle);
        color: var(--ok);
      }
      .role-badge.viewer {
        background: var(--border);
        color: var(--muted);
      }
      .btn-warn {
        background: var(--warn-subtle);
        color: var(--warn);
      }
      .btn-success {
        background: var(--ok-subtle);
        color: var(--ok);
      }
      .status-badge {
        display: inline-block;
        padding: 0.15rem 0.45rem;
        border-radius: 4px;
        font-size: 0.75rem;
        font-weight: 500;
      }
      .status-badge.active {
        background: var(--ok-subtle);
        color: var(--ok);
      }
      .status-badge.suspended {
        background: var(--warn-subtle);
        color: var(--warn);
      }
      .status-badge.deleted {
        background: var(--danger-subtle);
        color: var(--danger);
      }
      .actions {
        display: flex;
        gap: 0.4rem;
      }
      .error-msg a {
        color: inherit;
        text-decoration: underline;
        font-weight: 600;
      }
      .error-msg a:hover {
        opacity: 0.85;
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
      .invite-form {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        padding: 1.25rem;
        margin-bottom: 1.5rem;
      }
      .invite-form h3 {
        margin: 0 0 1rem;
        font-size: 0.95rem;
        font-weight: 600;
      }
      .form-row {
        display: flex;
        gap: 0.75rem;
        margin-bottom: 0.75rem;
        align-items: flex-end;
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
    `,
  ];

  @property({ type: String }) gatewayUrl = "";
  @state() private users: TenantUser[] = [];
  @state() private loading = false;
  @state() private errorKey = "";
  @state() private successKey = "";
  private msgParams: Record<string, string> = {};
  private msgTimer?: ReturnType<typeof setTimeout>;
  @state() private showInvite = false;
  @state() private inviteEmail = "";
  @state() private inviteRole = "member";
  @state() private inviteDisplayName = "";
  @state() private invitePassword = "";
  @state() private inviting = false;

  connectedCallback() {
    super.connectedCallback();
    this.loadUsers();
  }

  private rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return tenantRpc(method, params, this.gatewayUrl);
  }

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

  private tr(key: string): string {
    if (
      key.includes("已注册") ||
      key.includes("duplicate key") ||
      key.includes("unique constraint")
    ) {
      return t("tenantUsers.emailAlreadyRegistered");
    }
    const result = t(key, this.msgParams);
    return result === key ? key : result;
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

  private async loadUsers() {
    this.loading = true;
    this.errorKey = "";
    try {
      const result = (await this.rpc("tenant.users.list")) as { users: TenantUser[] };
      this.users = result.users ?? [];
    } catch (err) {
      this.showError(err instanceof Error ? err.message : "tenantUsers.loadFailed");
    } finally {
      this.loading = false;
    }
  }

  private async handleInvite(e: Event) {
    e.preventDefault();
    if (!this.inviteEmail || !this.invitePassword) {
      return;
    }
    this.inviting = true;
    this.errorKey = "";
    this.successKey = "";
    try {
      const hashedPassword = await hashPasswordForTransport(this.invitePassword);
      await this.rpc("tenant.users.invite", {
        email: this.inviteEmail,
        password: hashedPassword,
        role: this.inviteRole,
        displayName: this.inviteDisplayName || undefined,
      });
      this.showSuccess("tenantUsers.invited", { email: this.inviteEmail });
      this.inviteEmail = "";
      this.invitePassword = "";
      this.inviteDisplayName = "";
      this.showInvite = false;
      await this.loadUsers();
    } catch (err) {
      const q = quotaErrorKey(err);
      if (q) {
        this.showError(q.key, q.params);
      } else {
        this.showError(err instanceof Error ? err.message : "tenantUsers.inviteFailed");
      }
    } finally {
      this.inviting = false;
    }
  }

  private async handleRoleChange(userId: string, newRole: string) {
    this.errorKey = "";
    try {
      await this.rpc("tenant.users.update", { userId, role: newRole });
      await this.loadUsers();
    } catch (err) {
      this.showError(err instanceof Error ? err.message : "tenantUsers.roleUpdateFailed");
    }
  }

  private async handleToggleStatus(
    userId: string,
    displayName: string | null,
    email: string | null,
    currentStatus: string,
  ) {
    const label = displayName || email || userId;
    const newStatus = currentStatus === "active" ? "suspended" : "active";
    this.errorKey = "";
    try {
      await this.rpc("tenant.users.update", { userId, status: newStatus });
      const successKey =
        newStatus === "suspended" ? "tenantUsers.suspended" : "tenantUsers.activated";
      this.showSuccess(successKey, { name: label });
      await this.loadUsers();
    } catch (err) {
      const failKey =
        newStatus === "suspended" ? "tenantUsers.suspendFailed" : "tenantUsers.activateFailed";
      this.showError(err instanceof Error ? err.message : failKey);
    }
  }

  private roleLabel(role: string): string {
    const map: Record<string, string> = {
      owner: t("tenantUsers.roleOwner"),
      admin: t("tenantUsers.roleAdmin"),
      member: t("tenantUsers.roleMember"),
      viewer: t("tenantUsers.roleViewer"),
    };
    return map[role] ?? role;
  }

  private formatChannelType(channelType: string | null): string {
    if (!channelType) {
      return "-";
    }
    return t(`channels.${channelType}` as any) || channelType;
  }

  private statusLabel(status: string): string {
    const map: Record<string, string> = {
      active: t("tenantUsers.statusActive"),
      suspended: t("tenantUsers.statusSuspended"),
      deleted: t("tenantUsers.statusDeleted"),
    };
    return map[status] ?? status;
  }

  render() {
    const currentAuth = loadAuth();
    const currentUserId = currentAuth?.user?.id;
    const currentRole = currentAuth?.user?.role;

    return html`
      <div class="header">
        <h2>${t("tenantUsers.title")}</h2>
      </div>

      ${
        this.errorKey
          ? html`<div class="error-msg">${
              this.errorKey.startsWith("errors.quotaExceeded.")
                ? unsafeHTML(this.tr(this.errorKey))
                : this.tr(this.errorKey)
            }</div>`
          : nothing
      }
      ${this.successKey ? html`<div class="success-msg">${this.tr(this.successKey)}</div>` : nothing}

      ${
        this.loading
          ? html`<div class="loading">${t("tenantUsers.loading")}</div>`
          : this.users.length === 0
            ? html`<div class="empty">${t("tenantUsers.empty")}</div>`
            : html`
        <table>
          <thead>
            <tr>
              <th>${t("tenantUsers.displayName")}</th>
              <th>${t("tenantUsers.channel")}</th>
              <th>${t("tenantUsers.role")}</th>
              <th>${t("tenantUsers.status")}</th>
              <th>${t("tenantUsers.lastLogin")}</th>
              <th>${t("tenantUsers.actions")}</th>
            </tr>
          </thead>
          <tbody>
            ${this.users.map(
              (user) => html`
              <tr>
                <td>${user.displayName ?? "-"}</td>
                <td>${this.formatChannelType(user.channelType)}</td>
                <td>
                  <span class="role-badge ${user.role}">${this.roleLabel(user.role)}</span>
                </td>
                <td>
                  <span class="status-badge ${user.status}">${this.statusLabel(user.status)}</span>
                </td>
                <td>${user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString(this.currentLocaleTag) : "-"}</td>
                <td>
                  <div class="actions">
                    ${
                      user.id !== currentUserId && user.role !== "owner"
                        ? html`
                      ${
                        currentRole === "owner"
                          ? html`
                        <select class="btn btn-sm"
                          .value=${user.role}
                          @change=${(e: Event) => this.handleRoleChange(user.id, (e.target as HTMLSelectElement).value)}>
                          <option value="admin" ?selected=${user.role === "admin"}>${t("tenantUsers.roleAdmin")}</option>
                          <option value="member" ?selected=${user.role === "member"}>${t("tenantUsers.roleMember")}</option>
                          <option value="viewer" ?selected=${user.role === "viewer"}>${t("tenantUsers.roleViewer")}</option>
                        </select>
                      `
                          : nothing
                      }
                      ${
                        user.status === "active"
                          ? html`
                        <button class="btn btn-warn btn-sm"
                          @click=${() => this.handleToggleStatus(user.id, user.displayName, user.email, user.status)}>${t("tenantUsers.suspend")}</button>
                      `
                          : html`
                        <button class="btn btn-success btn-sm"
                          @click=${() => this.handleToggleStatus(user.id, user.displayName, user.email, user.status)}>${t("tenantUsers.activate")}</button>
                      `
                      }
                    `
                        : nothing
                    }
                  </div>
                </td>
              </tr>
            `,
            )}
          </tbody>
        </table>
      `
      }
    `;
  }
}
