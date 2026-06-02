import { html, css, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { caretFix } from "../../shared-styles.ts";
import { normalizeKnowledgeFileName } from "./knowledge-path.ts";
import { tenantRpc } from "./rpc.ts";

type KnowledgeFile = {
  name: string;
  path: string;
  missing?: boolean;
  size?: number;
  updatedAtMs?: number;
  content?: string;
  editable?: boolean;
};

type KnowledgeListResult = {
  workspace: string;
  files: KnowledgeFile[];
};

@customElement("tenant-knowledge-view")
export class TenantKnowledgeView extends LitElement {
  static styles = [
    caretFix,
    css`
      :host {
        display: block;
      }
      .toolbar {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 16px;
        margin-bottom: 16px;
      }
      .title {
        font-size: 16px;
        font-weight: 650;
      }
      .sub {
        color: var(--color-text-secondary, #6a737d);
        font-size: 13px;
        margin-top: 4px;
      }
      .actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        justify-content: flex-end;
      }
      .btn {
        border: 1px solid var(--color-border, #d0d7de);
        background: var(--color-bg, #fff);
        color: var(--color-text, #24292f);
        border-radius: 6px;
        padding: 7px 12px;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
      }
      .btn:hover {
        background: var(--color-bg-secondary, #f6f8fa);
      }
      .btn.primary {
        background: var(--color-accent, #0969da);
        border-color: var(--color-accent, #0969da);
        color: #fff;
      }
      .btn.danger {
        color: var(--color-danger, #cf222e);
      }
      .btn:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      .layout {
        display: grid;
        grid-template-columns: minmax(260px, 360px) minmax(0, 1fr);
        gap: 16px;
        align-items: stretch;
      }
      .panel {
        border: 1px solid var(--color-border, #d0d7de);
        border-radius: 8px;
        background: var(--color-bg, #fff);
        min-height: 520px;
      }
      .panel-head {
        padding: 14px 16px;
        border-bottom: 1px solid var(--color-border, #d0d7de);
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
      }
      .panel-title {
        font-weight: 650;
      }
      .drop {
        margin: 14px 16px 0;
        border: 1px dashed var(--color-border, #d0d7de);
        border-radius: 8px;
        padding: 18px;
        text-align: center;
        color: var(--color-text-secondary, #6a737d);
        cursor: pointer;
        font-size: 13px;
      }
      .drop.active {
        border-color: var(--color-accent, #0969da);
        background: var(--color-accent-muted, #ddf4ff);
      }
      .list {
        padding: 12px;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .file {
        border: 1px solid transparent;
        border-radius: 6px;
        padding: 10px;
        cursor: pointer;
      }
      .file:hover {
        background: var(--color-bg-secondary, #f6f8fa);
      }
      .file.active {
        background: var(--color-accent-muted, #ddf4ff);
        border-color: var(--color-accent, #0969da);
      }
      .file-name {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 13px;
      }
      .file-meta {
        color: var(--color-text-secondary, #6a737d);
        font-size: 12px;
        margin-top: 4px;
      }
      textarea {
        width: 100%;
        min-height: 430px;
        box-sizing: border-box;
        border: 0;
        resize: vertical;
        padding: 16px;
        font:
          13px/1.55 ui-monospace,
          SFMono-Regular,
          Menlo,
          Consolas,
          monospace;
        background: var(--color-bg, #fff);
        color: var(--color-text, #24292f);
      }
      .editor-actions {
        border-top: 1px solid var(--color-border, #d0d7de);
        padding: 12px 16px;
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }
      .empty,
      .message {
        color: var(--color-text-secondary, #6a737d);
        font-size: 13px;
        padding: 20px;
      }
      .error {
        color: var(--color-danger, #cf222e);
      }
      input[type="file"] {
        display: none;
      }
      @media (max-width: 900px) {
        .layout {
          grid-template-columns: 1fr;
        }
      }
    `,
  ];

  @state() private list: KnowledgeListResult | null = null;
  @state() private active: string | null = null;
  @state() private contents: Record<string, string> = {};
  @state() private drafts: Record<string, string> = {};
  @state() private loading = false;
  @state() private saving = false;
  @state() private dragover = false;
  @state() private error: string | null = null;
  private readonly supportedExtensions = [".md", ".txt", ".csv", ".docx", ".xlsx", ".pdf"];

  connectedCallback() {
    super.connectedCallback();
    void this.loadFiles();
  }

  private normalizeName(raw: string): string | null {
    return normalizeKnowledgeFileName(raw);
  }

  private isEditable(name: string): boolean {
    const lower = name.toLowerCase();
    return lower.endsWith(".md") || lower.endsWith(".txt") || lower.endsWith(".csv");
  }

  private async fileToBase64(file: File): Promise<string> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i] ?? 0);
    }
    return btoa(binary);
  }

  private formatSize(bytes?: number): string {
    if (bytes == null) {
      return "";
    }
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  private async loadFiles() {
    this.loading = true;
    this.error = null;
    try {
      this.list = (await tenantRpc("tenant.memory.list")) as KnowledgeListResult;
      if (this.active && !this.list.files.some((file) => file.name === this.active)) {
        this.active = null;
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
    }
  }

  private async selectFile(name: string) {
    this.active = name;
    if (Object.hasOwn(this.contents, name)) {
      return;
    }
    this.loading = true;
    this.error = null;
    try {
      const result = (await tenantRpc("tenant.memory.file.get", { name })) as {
        file?: KnowledgeFile;
      };
      const content = result.file?.content ?? "";
      this.contents = { ...this.contents, [name]: content };
      this.drafts = { ...this.drafts, [name]: content };
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
    }
  }

  private async saveFile(name: string) {
    const content = this.drafts[name] ?? "";
    this.saving = true;
    this.error = null;
    try {
      const result = (await tenantRpc("tenant.memory.file.set", { name, content })) as {
        file?: KnowledgeFile;
      };
      this.contents = { ...this.contents, [name]: content };
      this.drafts = { ...this.drafts, [name]: content };
      if (result.file) {
        const files = this.list?.files ?? [];
        const nextFiles = files.some((file) => file.name === result.file?.name)
          ? files.map((file) => (file.name === result.file?.name ? result.file : file))
          : [...files, result.file];
        this.list = { workspace: this.list?.workspace ?? "", files: nextFiles };
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.saving = false;
    }
  }

  private async deleteFile(name: string) {
    if (!confirm(`确认删除企业知识库文件 "${name}"？`)) {
      return;
    }
    this.saving = true;
    this.error = null;
    try {
      await tenantRpc("tenant.memory.delete", { name });
      this.list = {
        workspace: this.list?.workspace ?? "",
        files: (this.list?.files ?? []).filter((file) => file.name !== name),
      };
      if (this.active === name) {
        this.active = null;
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.saving = false;
    }
  }

  private downloadFile(name: string) {
    const content = this.drafts[name] ?? this.contents[name] ?? "";
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name.split("/").pop() || "knowledge.txt";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  private triggerUpload() {
    this.shadowRoot?.querySelector<HTMLInputElement>("#tenant-kb-upload")?.click();
  }

  private async uploadFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList).filter((file) =>
      this.supportedExtensions.some((ext) => file.name.toLowerCase().endsWith(ext)),
    );
    if (files.length === 0) {
      this.error = "仅支持 .md Markdown 文件";
      return;
    }
    this.saving = true;
    this.error = null;
    try {
      for (const file of files) {
        const name = this.normalizeName(file.name);
        if (!name) {
          continue;
        }
        if (this.isEditable(name)) {
          await tenantRpc("tenant.memory.file.set", { name, content: await file.text() });
        } else {
          await tenantRpc("tenant.memory.file.set", {
            name,
            content: "",
            contentBase64: await this.fileToBase64(file),
          });
        }
      }
      await this.loadFiles();
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.saving = false;
      const input = this.shadowRoot?.querySelector<HTMLInputElement>("#tenant-kb-upload");
      if (input) {
        input.value = "";
      }
    }
  }

  render() {
    const files = this.list?.files ?? [];
    const active = this.active;
    const draft = active ? (this.drafts[active] ?? this.contents[active] ?? "") : "";
    const isDirty = active ? draft !== (this.contents[active] ?? "") : false;
    const editable = active ? this.isEditable(active) : false;
    return html`
      <div class="toolbar">
        <div>
          <div class="title">企业知识库</div>
          <div class="sub">维护所有 Agent 优先检索的企业级 Markdown 知识文件。</div>
        </div>
        <div class="actions">
          <button class="btn" ?disabled=${this.loading} @click=${() => void this.loadFiles()}>刷新</button>
          <button class="btn primary" ?disabled=${this.saving} @click=${this.triggerUpload}>上传文件</button>
          <input id="tenant-kb-upload" type="file" accept=".md,.txt,.csv,.docx,.xlsx,.pdf,text/markdown,text/plain,text/csv,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" multiple
            @change=${(e: Event) => {
              const input = e.target as HTMLInputElement;
              if (input.files?.length) {
                void this.uploadFiles(input.files);
              }
            }}
          />
        </div>
      </div>
      ${this.error ? html`<div class="message error">${this.error}</div>` : nothing}
      <div class="layout">
        <section class="panel">
          <div class="panel-head">
            <div class="panel-title">文件</div>
            <button class="btn" @click=${() => {
              const name = window.prompt("新建文件名", "memory/product.md");
              const normalized = name ? this.normalizeName(name) : null;
              if (normalized) {
                void this.selectFile(normalized);
              }
            }}>新建</button>
          </div>
          <div class="drop ${this.dragover ? "active" : ""}"
            @click=${this.triggerUpload}
            @dragover=${(e: DragEvent) => {
              e.preventDefault();
              this.dragover = true;
            }}
            @dragleave=${() => {
              this.dragover = false;
            }}
            @drop=${(e: DragEvent) => {
              e.preventDefault();
              this.dragover = false;
              if (e.dataTransfer?.files?.length) {
                void this.uploadFiles(e.dataTransfer.files);
              }
            }}
          >点击或拖放 .md 文件上传</div>
          ${
            this.loading && files.length === 0
              ? html`
                  <div class="empty">加载中...</div>
                `
              : files.length === 0
                ? html`
                    <div class="empty">暂无企业知识库文件。</div>
                  `
                : html`<div class="list">
                  ${files.map(
                    (file) => html`
                    <div class="file ${file.name === active ? "active" : ""}" @click=${() => void this.selectFile(file.name)}>
                      <div class="file-name">${file.name}</div>
                      <div class="file-meta">${this.formatSize(file.size)}${file.updatedAtMs ? ` · ${new Date(file.updatedAtMs).toLocaleString()}` : ""}</div>
                    </div>
                  `,
                  )}
                </div>`
          }
        </section>
        <section class="panel">
          <div class="panel-head">
            <div>
              <div class="panel-title">${active ?? "选择文件"}</div>
              ${/* workspace 路径已隐藏（租户视角无用） */ nothing}
            </div>
            ${
              active
                ? html`
              <div class="actions">
                <button class="btn" @click=${() => this.downloadFile(active)}>下载</button>
                <button class="btn danger" ?disabled=${this.saving} @click=${() => void this.deleteFile(active)}>删除</button>
              </div>
            `
                : nothing
            }
          </div>
          ${
            active
              ? html`
                <textarea
                  .value=${draft}
                  ?disabled=${this.loading || this.saving || !editable}
                  @input=${(e: Event) => {
                    this.drafts = {
                      ...this.drafts,
                      [active]: (e.target as HTMLTextAreaElement).value,
                    };
                  }}
                ></textarea>
                <div class="editor-actions">
                  <button class="btn" ?disabled=${!editable || !isDirty || this.saving} @click=${() => {
                    this.drafts = { ...this.drafts, [active]: this.contents[active] ?? "" };
                  }}>重置</button>
                  <button class="btn primary" ?disabled=${!editable || !isDirty || this.saving} @click=${() => void this.saveFile(active)}>
                    ${this.saving ? "保存中..." : "保存"}
                  </button>
                </div>
              `
              : html`
                  <div class="empty">选择、新建或上传一个 Markdown 文件后编辑。</div>
                `
          }
        </section>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "tenant-knowledge-view": TenantKnowledgeView;
  }
}
