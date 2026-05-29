import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type { AgentsFilesListResult } from "../types.ts";

/**
 * Persona card configuration for the three editable agent files.
 */
const PERSONA_CARDS = [
  {
    id: "IDENTITY.md",
    icon: "\u{1F4CB}", // 📋
    titleKey: "agents.persona.identity.title",
    fileKey: "agents.persona.identity.file",
    descKey: "agents.persona.identity.desc",
  },
  {
    id: "SOUL.md",
    icon: "\u{1F6E1}\uFE0F", // 🛡️
    titleKey: "agents.persona.soul.title",
    fileKey: "agents.persona.soul.file",
    descKey: "agents.persona.soul.desc",
  },
  {
    id: "AGENTS.md",
    icon: "\u{1F4D0}", // 📐
    titleKey: "agents.persona.agents.title",
    fileKey: "agents.persona.agents.file",
    descKey: "agents.persona.agents.desc",
  },
] as const;

export function renderAgentPersona(params: {
  agentId: string;
  agentFilesList: AgentsFilesListResult | null;
  agentFilesLoading: boolean;
  agentFilesError: string | null;
  agentFileActive: string | null;
  agentFileContents: Record<string, string>;
  agentFileDrafts: Record<string, string>;
  agentFileSaving: boolean;
  onLoadFiles: (agentId: string) => void;
  onSelectFile: (name: string) => void;
  onFileDraftChange: (name: string, content: string) => void;
  onFileReset: (name: string) => void;
  onFileSave: (name: string) => void;
}) {
  const list = params.agentFilesList?.agentId === params.agentId ? params.agentFilesList : null;
  const files = list?.files ?? [];

  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">${t("agents.persona.title")}</div>
          <div class="card-sub">${t("agents.persona.subtitle")}</div>
        </div>
        <button
          class="btn btn--sm"
          ?disabled=${params.agentFilesLoading}
          @click=${() => params.onLoadFiles(params.agentId)}
        >
          ${params.agentFilesLoading ? t("agents.persona.loading") : t("agents.persona.refresh")}
        </button>
      </div>
      ${
        list
          ? html`<div class="muted mono" style="margin-top: 8px;">
              ${t("agents.persona.workspace")}: ${list.workspace}
            </div>`
          : nothing
      }
      ${
        params.agentFilesError
          ? html`<div class="callout danger" style="margin-top: 12px;">${params.agentFilesError}</div>`
          : nothing
      }
      ${
        !list
          ? html`
              <div class="callout info" style="margin-top: 12px">
                ${t("agents.persona.subtitle")}
              </div>
            `
          : html`
              <div class="persona-cards" style="margin-top: 16px; display: flex; flex-direction: column; gap: 12px;">
                ${PERSONA_CARDS.map((card) => {
                  const fileEntry = files.find((f) => f.name === card.id) ?? null;
                  const isActive = params.agentFileActive === card.id;
                  const baseContent = params.agentFileContents[card.id] ?? "";
                  const draft = params.agentFileDrafts[card.id] ?? baseContent;
                  const isDirty = draft !== baseContent;
                  const isMissing = fileEntry?.missing ?? true;

                  return html`
                    <div
                      class="persona-card"
                      style="
                        border: 1px solid var(--border);
                        border-radius: 8px;
                        overflow: hidden;
                        ${isActive ? "border-color: var(--accent, #3b82f6);" : ""}
                      "
                    >
                      <button
                        type="button"
                        class="persona-card-header"
                        style="
                          display: flex;
                          align-items: center;
                          gap: 12px;
                          width: 100%;
                          padding: 12px 16px;
                          background: var(--card-bg, var(--surface));
                          border: none;
                          cursor: pointer;
                          text-align: left;
                          color: inherit;
                          font: inherit;
                        "
                        @click=${() => params.onSelectFile(isActive ? "" : card.id)}
                      >
                        <span style="font-size: 1.4em; flex-shrink: 0;">${card.icon}</span>
                        <div style="flex: 1; min-width: 0;">
                          <div style="font-weight: 600; display: flex; align-items: center; gap: 8px;">
                            ${t(card.titleKey)}
                            <span class="mono" style="font-size: 0.8em; opacity: 0.6; font-weight: normal;">${t(card.fileKey)}</span>
                            ${
                              isMissing
                                ? html`
                                    <span class="agent-pill warn" style="font-size: 0.75em">missing</span>
                                  `
                                : nothing
                            }
                          </div>
                          <div class="muted" style="font-size: 0.85em; margin-top: 2px;">
                            ${t(card.descKey)}
                          </div>
                        </div>
                        <span style="font-size: 0.9em; opacity: 0.5; transition: transform 0.2s; ${isActive ? "transform: rotate(180deg);" : ""}">
                          ▼
                        </span>
                      </button>
                      ${
                        isActive
                          ? html`
                              <div style="padding: 0 16px 16px 16px; border-top: 1px solid var(--border);">
                                ${
                                  isMissing
                                    ? html`
                                        <div class="callout info" style="margin-top: 12px; font-size: 0.85em;">
                                          ${
                                            fileEntry?.defaultContent
                                              ? t("agents.persona.missingHint")
                                              : t("agents.persona.noDefault")
                                          }
                                        </div>
                                      `
                                    : nothing
                                }
                                <div style="margin-top: 12px; display: flex; justify-content: flex-end; gap: 8px;">
                                  <button
                                    class="btn btn--sm"
                                    ?disabled=${!isDirty}
                                    @click=${() => params.onFileReset(card.id)}
                                  >
                                    ${t("agents.persona.reset")}
                                  </button>
                                  <button
                                    class="btn btn--sm primary"
                                    ?disabled=${params.agentFileSaving || !isDirty}
                                    @click=${() => params.onFileSave(card.id)}
                                  >
                                    ${params.agentFileSaving ? t("agents.persona.saving") : t("agents.persona.save")}
                                  </button>
                                </div>
                                <label class="field" style="margin-top: 8px;">
                                  <textarea
                                    .value=${draft}
                                    style="min-height: 300px; font-family: var(--mono-font, monospace); font-size: 0.85em;"
                                    @input=${(e: Event) =>
                                      params.onFileDraftChange(
                                        card.id,
                                        (e.target as HTMLTextAreaElement).value,
                                      )}
                                  ></textarea>
                                </label>
                              </div>
                            `
                          : nothing
                      }
                    </div>
                  `;
                })}
              </div>
            `
      }
    </section>
  `;
}
