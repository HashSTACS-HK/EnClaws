/**
 * Tenant skill management view.
 *
 * Lists all skills available to the current tenant workspace,
 * showing name, description, source, and status.
 */

import { html, css, LitElement, nothing } from "lit";
import { customElement, state, property } from "lit/decorators.js";
import { t, I18nController } from "../../../i18n/index.ts";
import { caretFix } from "../../shared-styles.ts";
import { renderComingSoonPlaceholder } from "../coming-soon-placeholder.ts";
import { tenantRpc } from "./rpc.ts";

interface SkillInstallSpec {
  id: string;
  label: string;
}

interface SkillStatusEntry {
  name: string;
  description: string;
  source: string;
  filePath: string;
  baseDir: string;
  skillKey: string;
  bundled?: boolean;
  primaryEnv?: string;
  emoji?: string;
  homepage?: string;
  always: boolean;
  disabled: boolean;
  blockedByAllowlist: boolean;
  eligible: boolean;
  requirements: {
    bins: string[];
    anyBins: string[];
    env: string[];
    config: string[];
    os: string[];
  };
  missing: {
    bins: string[];
    env: string[];
    config: string[];
    os: string[];
  };
  install: SkillInstallSpec[];
}

interface SkillStatusReport {
  workspaceDir: string;
  managedSkillsDir: string;
  skills: SkillStatusEntry[];
}

type SourceGroup = { id: string; label: string; skills: SkillStatusEntry[] };

function groupBySource(skills: SkillStatusEntry[]): SourceGroup[] {
  const map = new Map<string, SkillStatusEntry[]>();
  for (const s of skills) {
    const key = s.source || "other";
    if (!map.has(key)) {
      map.set(key, []);
    }
    map.get(key)!.push(s);
  }
  const order = [
    "enclaws-tenant",
    "enclaws-workspace",
    "agents-skills-project",
    "agents-skills-personal",
    "enclaws-managed",
    "enclaws-extra",
    "enclaws-bundled",
  ];
  const groups: SourceGroup[] = [];
  for (const key of order) {
    const list = map.get(key);
    if (list?.length) {
      groups.push({ id: key, label: sourceLabel(key), skills: list });
      map.delete(key);
    }
  }
  for (const [key, list] of map) {
    if (list.length) {
      groups.push({ id: key, label: sourceLabel(key), skills: list });
    }
  }
  return groups;
}

function sourceLabel(source: string): string {
  switch (source) {
    case "enclaws-workspace":
      return t("tenantSkills.sourceWorkspace");
    case "enclaws-managed":
      return t("tenantSkills.sourceManaged");
    case "enclaws-bundled":
      return t("tenantSkills.sourceBundled");
    case "enclaws-extra":
      return t("tenantSkills.sourceExtra");
    case "enclaws-tenant":
      return t("tenantSkills.sourceTenant");
    case "agents-skills-personal":
      return t("tenantSkills.sourcePersonal");
    case "agents-skills-project":
      return t("tenantSkills.sourceProject");
    default:
      return source.startsWith("openclaw-plugin-")
        ? t("tenantSkills.sourcePlugin", { name: source.replace("openclaw-plugin-", "") })
        : source;
  }
}

@customElement("tenant-skills-view")
export class TenantSkillsView extends LitElement {
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
      .subtitle {
        font-size: 0.8rem;
        color: var(--text-2);
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
      .btn-outline {
        background: transparent;
        border: 1px solid var(--border);
        color: var(--text);
      }
      .btn-primary {
        background: var(--accent);
        color: var(--accent-foreground);
        border: none;
      }
      .btn-warn {
        background: var(--warn-subtle);
        color: var(--warn);
        border: none;
      }
      .btn-sm {
        padding: 0.3rem 0.6rem;
        font-size: 0.78rem;
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
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
      .filters {
        display: flex;
        gap: 0.5rem;
        align-items: center;
        margin-bottom: 1rem;
        flex-wrap: wrap;
      }
      .filters input {
        padding: 0.35rem 0.5rem;
        background: var(--input-bg);
        border: 1px solid var(--input-border);
        border-radius: var(--radius-md);
        color: var(--text);
        font-size: 0.8rem;
        outline: none;
        flex: 1;
        min-width: 160px;
      }
      .filters label {
        font-size: 0.8rem;
        color: var(--text-2);
      }
      .filters input:focus {
        border-color: var(--accent);
      }
      .muted {
        font-size: 0.78rem;
        color: var(--text-2);
      }
      .group {
        margin-bottom: 1.5rem;
      }
      .group-header {
        font-size: 0.85rem;
        font-weight: 600;
        margin-bottom: 0.5rem;
        display: flex;
        align-items: center;
        gap: 0.5rem;
        cursor: pointer;
        user-select: none;
      }
      .group-header .count {
        font-weight: 400;
        color: var(--text-2);
        font-size: 0.78rem;
      }
      .skill-list {
        display: flex;
        flex-direction: column;
        border-top: 1px solid var(--border);
      }
      .skill-card {
        padding: 0.75rem;
        border-bottom: 1px solid var(--border);
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 1rem;
      }
      .skill-card:hover {
        background: var(--bg-hover);
      }
      .skill-info {
        flex: 1;
        min-width: 0;
      }
      .skill-name {
        font-size: 0.85rem;
        font-weight: 600;
      }
      .skill-desc {
        font-size: 0.78rem;
        color: var(--text-2);
        margin-top: 0.2rem;
      }
      .skill-meta {
        display: flex;
        gap: 0.4rem;
        flex-wrap: wrap;
        margin-top: 0.4rem;
      }
      .chip {
        display: inline-block;
        font-size: 0.75rem;
        padding: 0.15rem 0.45rem;
        border-radius: 4px;
        font-weight: 500;
        background: var(--border);
        color: var(--muted);
      }
      .chip-success {
        background: var(--ok-subtle);
        color: var(--ok);
      }
      .chip-warning {
        background: var(--warn-subtle);
        color: var(--warn);
      }
      .chip-danger {
        background: var(--danger-subtle);
        color: var(--danger);
      }
      .skill-actions {
        display: flex;
        gap: 0.4rem;
        flex-shrink: 0;
        align-items: center;
      }
      .empty {
        text-align: center;
        padding: 3rem 1rem;
        color: var(--text-2);
      }
      .loading {
        text-align: center;
        padding: 2rem;
        color: var(--text-2);
      }
    `,
  ];

  @property({ type: String }) gatewayUrl = "";

  @state() private _loading = false;
  @state() private _error = "";
  @state() private _report: SkillStatusReport | null = null;
  @state() private _filter = "";
  @state() private _busyKey = "";
  @state() private _message: { key: string; kind: "success" | "error"; text: string } | null = null;

  connectedCallback() {
    super.connectedCallback();
    this._load();
  }

  private async _load() {
    this._loading = true;
    this._error = "";
    try {
      const res = (await tenantRpc("skills.status", {}, this.gatewayUrl)) as SkillStatusReport;
      this._report = res;
    } catch (err) {
      this._error = err instanceof Error ? err.message : String(err);
    } finally {
      this._loading = false;
    }
  }

  private async _toggleSkill(skillKey: string, currentlyDisabled: boolean) {
    this._busyKey = skillKey;
    this._message = null;
    try {
      await tenantRpc("skills.update", { skillKey, enabled: currentlyDisabled }, this.gatewayUrl);
      this._message = {
        key: skillKey,
        kind: "success",
        text: currentlyDisabled ? t("tenantSkills.enabled") : t("tenantSkills.justDisabled"),
      };
      await this._load();
    } catch (err) {
      this._message = {
        key: skillKey,
        kind: "error",
        text: err instanceof Error ? err.message : String(err),
      };
    } finally {
      this._busyKey = "";
    }
  }

  private async _installSkill(skillKey: string, name: string, installId: string) {
    this._busyKey = skillKey;
    this._message = null;
    try {
      await tenantRpc("skills.install", { name, installId, timeoutMs: 120000 }, this.gatewayUrl);
      this._message = { key: skillKey, kind: "success", text: t("tenantSkills.installSuccess") };
      await this._load();
    } catch (err) {
      this._message = {
        key: skillKey,
        kind: "error",
        text: err instanceof Error ? err.message : String(err),
      };
    } finally {
      this._busyKey = "";
    }
  }

  render() {
    return html`
      <div class="header">
        <div>
          <h2>${t("tenantSkills.title")}</h2>
        </div>
      </div>
      ${renderComingSoonPlaceholder(t("tenantSkills.title"), t("tenantWorkshop.comingSoonLabel"))}
    `;
  }

  private _renderReport() {
    const skills = this._report!.skills;
    const filter = this._filter.trim().toLowerCase();
    const filtered = filter
      ? skills.filter((s) =>
          [s.name, s.description, s.source, s.skillKey].join(" ").toLowerCase().includes(filter),
        )
      : skills;
    const groups = groupBySource(filtered);

    return html`
      <div class="filters">
        <label>${t("tenantSkills.skillName")}</label>
        <input type="text"
          .placeholder=${t("tenantSkills.searchPlaceholder")}
          .value=${this._filter}
          @input=${(e: Event) => {
            this._filter = (e.target as HTMLInputElement).value;
          }}
        />
        <span class="muted">${filtered.length} / ${skills.length}</span>
      </div>

      ${
        filtered.length === 0
          ? html`<div class="empty">${t("tenantSkills.noMatch")}</div>`
          : groups.map((g) => this._renderGroup(g))
      }
    `;
  }

  private _renderGroup(group: SourceGroup) {
    return html`
      <details class="group" open>
        <summary class="group-header">
          <span>${group.label}</span>
          <span class="count">${group.skills.length}</span>
        </summary>
        <div class="skill-list">
          ${group.skills.map((s) => this._renderSkill(s))}
        </div>
      </details>
    `;
  }

  private _renderSkill(skill: SkillStatusEntry) {
    const busy = this._busyKey === skill.skillKey;
    const msg = this._message?.key === skill.skillKey ? this._message : null;
    const missingBins = skill.missing.bins.length > 0;
    const missingEnv = skill.missing.env.length > 0;
    const canInstall = skill.install.length > 0 && missingBins;

    return html`
      <div class="skill-card">
        <div class="skill-info">
          <div class="skill-name">${skill.emoji ? `${skill.emoji} ` : ""}${skill.name}</div>
          <div class="skill-desc">${skill.description || "—"}</div>
          <div class="skill-meta">
            ${
              skill.eligible
                ? html`<span class="chip chip-success">${t("tenantSkills.available")}</span>`
                : html`<span class="chip chip-danger">${t("tenantSkills.unavailable")}</span>`
            }
            ${skill.disabled ? html`<span class="chip chip-warning">${t("tenantSkills.disabled")}</span>` : nothing}
            ${skill.bundled ? html`<span class="chip">${t("tenantSkills.builtin")}</span>` : nothing}
            ${missingBins ? html`<span class="chip chip-warning">${t("tenantSkills.missingBins", { bins: skill.missing.bins.join(", ") })}</span>` : nothing}
            ${missingEnv ? html`<span class="chip chip-warning">${t("tenantSkills.missingEnv", { env: skill.missing.env.join(", ") })}</span>` : nothing}
          </div>
          ${msg ? html`<div class="muted" style="margin-top: 0.4rem; color: ${msg.kind === "error" ? "var(--text-destructive, #fca5a5)" : "#4ade80"};">${msg.text}</div>` : nothing}
        </div>
        <div class="skill-actions">
          ${
            canInstall
              ? skill.install.map(
                  (inst) => html`
            <button class="btn btn-sm btn-outline"
              ?disabled=${busy}
              @click=${() => this._installSkill(skill.skillKey, skill.name, inst.id)}>
              ${busy ? t("tenantSkills.installing") : inst.label}
            </button>
          `,
                )
              : nothing
          }
        </div>
      </div>
    `;
  }
}
