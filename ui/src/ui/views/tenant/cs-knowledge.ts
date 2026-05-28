/**
 * AI Customer Service — Knowledge Base management view.
 *
 * Upload, list, and delete .md knowledge files for the tenant's CS agent.
 * Files are stored at: ~/.enclaws/tenants/{tenantId}/customer-service/memory/
 *
 * AI 客服知识库管理页面。
 */

import { html, css, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { I18nController } from "../../../i18n/index.ts";
import { tenantRpc } from "./rpc.ts";
import { loadAuth } from "../../auth-store.ts";
import { caretFix } from "../../shared-styles.ts";

interface KBFile {
  name: string;
  size: number;
  updatedAt: string;
}

@customElement("cs-knowledge-view")
export class CSKnowledgeView extends LitElement {
  static styles = [
    caretFix,
    css`
      :host { display: block; }

      .toolbar {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 16px;
        flex-wrap: wrap;
      }

      .toolbar h2 {
        margin: 0;
        font-size: 16px;
        font-weight: 600;
        flex: 1;
      }

      /* Drop zone */
      .drop-zone {
        border: 2px dashed var(--color-border, #e1e4e8);
        border-radius: 8px;
        padding: 24px 20px;
        text-align: center;
        font-size: 13px;
        color: var(--color-text-secondary, #6a737d);
        margin-bottom: 20px;
        background: var(--color-bg-secondary, #f6f8fa);
        transition: border-color 0.15s, background 0.15s;
        cursor: pointer;
        line-height: 1.6;
      }

      .drop-zone.dragover {
        border-color: var(--color-accent, #0969da);
        background: var(--color-accent-muted, #ddf4ff);
        color: var(--color-accent, #0969da);
      }

      .drop-zone .drop-icon {
        font-size: 28px;
        display: block;
        margin-bottom: 6px;
      }

      .drop-zone strong {
        color: var(--color-accent, #0969da);
      }

      .info-banner {
        background: var(--color-bg-secondary, #f6f8fa);
        border: 1px solid var(--color-border, #e1e4e8);
        border-radius: 6px;
        padding: 10px 16px;
        font-size: 12px;
        color: var(--color-text-secondary, #6a737d);
        margin-bottom: 16px;
        line-height: 1.5;
      }

      .file-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 14px;
      }

      .file-table th {
        text-align: left;
        padding: 8px 12px;
        font-weight: 600;
        border-bottom: 2px solid var(--color-border, #e1e4e8);
        color: var(--color-text-secondary, #6a737d);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        white-space: nowrap;
      }

      .file-table td {
        padding: 10px 12px;
        border-bottom: 1px solid var(--color-border, #e1e4e8);
        vertical-align: middle;
      }

      .file-table tr:last-child td { border-bottom: none; }

      .file-name {
        font-weight: 500;
        font-family: monospace;
        font-size: 13px;
      }

      .file-size {
        color: var(--color-text-secondary, #6a737d);
        font-size: 13px;
        white-space: nowrap;
      }

      .file-date {
        color: var(--color-text-secondary, #6a737d);
        font-size: 13px;
        white-space: nowrap;
      }

      .status-badge {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 12px;
        font-size: 12px;
        background: var(--color-bg-secondary, #f6f8fa);
        border: 1px solid var(--color-border, #e1e4e8);
        color: var(--color-text-secondary, #6a737d);
        white-space: nowrap;
      }

      .actions {
        display: flex;
        gap: 6px;
        white-space: nowrap;
      }

      .btn {
        padding: 5px 12px;
        border-radius: 6px;
        font-size: 12px;
        cursor: pointer;
        border: 1px solid transparent;
        font-weight: 500;
        white-space: nowrap;
      }

      .btn-primary {
        background: var(--color-accent, #0969da);
        color: #fff;
        border-color: var(--color-accent, #0969da);
      }

      .btn-primary:hover { opacity: 0.85; }

      .btn-ghost {
        background: var(--color-bg-secondary, #f6f8fa);
        color: var(--color-text, #1c1c1e);
        border-color: var(--color-border, #e1e4e8);
      }

      .btn-ghost:hover { background: var(--color-bg-hover, #eaeef2); }

      .btn-danger {
        background: transparent;
        color: var(--color-danger, #cf222e);
        border-color: var(--color-danger, #cf222e);
      }

      .btn-danger:hover {
        background: var(--color-danger, #cf222e);
        color: #fff;
      }

      .btn:disabled { opacity: 0.5; cursor: not-allowed; }

      .empty-state {
        text-align: center;
        padding: 40px 20px;
        color: var(--color-text-secondary, #6a737d);
        font-size: 14px;
      }

      .error-msg {
        color: var(--color-danger, #cf222e);
        font-size: 13px;
        margin-bottom: 10px;
      }

      .success-msg {
        color: var(--color-success, #1a7f37);
        font-size: 13px;
        margin-bottom: 10px;
      }

      .loading {
        text-align: center;
        padding: 32px;
        color: var(--color-text-secondary, #6a737d);
        font-size: 14px;
      }

      input[type="file"] { display: none; }
    `,
  ];

  @state() private files: KBFile[] = [];
  @state() private loading = false;
  @state() private uploading = false;
  @state() private deletingFile: string | null = null;
  @state() private error: string | null = null;
  @state() private successMsg: string | null = null;
  @state() private dragover = false;

  private _i18n = new I18nController(this);

  private get tenantId(): string | undefined {
    return loadAuth()?.user?.tenantId;
  }

  connectedCallback() {
    super.connectedCallback();
    void this._loadFiles();
  }

  private async _loadFiles() {
    const tenantId = this.tenantId;
    if (!tenantId) {return;}
    this.loading = true;
    this.error = null;
    try {
      const result = await tenantRpc("cs.knowledge.list", { tenantId }) as { files: KBFile[] };
      this.files = result.files ?? [];
    } catch (err) {
      this.error = err instanceof Error ? err.message : "加载失败";
    } finally {
      this.loading = false;
    }
  }

  private _triggerUpload() {
    const input = this.shadowRoot?.querySelector<HTMLInputElement>("#file-input");
    input?.click();
  }

  private async _uploadFiles(fileList: FileList | File[]) {
    const tenantId = this.tenantId;
    if (!tenantId) {return;}

    const files = Array.from(fileList);
    const mdFiles = files.filter((f) => f.name.endsWith(".md"));
    const rejected = files.filter((f) => !f.name.endsWith(".md"));

    if (rejected.length > 0) {
      this.error = `仅支持 .md 文件，已跳过：${rejected.map((f) => f.name).join("、")}`;
    } else {
      this.error = null;
    }

    if (mdFiles.length === 0) {return;}

    this.uploading = true;
    this.successMsg = null;
    const uploaded: string[] = [];
    const failed: string[] = [];

    for (const file of mdFiles) {
      try {
        const content = await file.text();
        await tenantRpc("cs.knowledge.upload", { tenantId, name: file.name, content });
        uploaded.push(file.name);
      } catch {
        failed.push(file.name);
      }
    }

    this.uploading = false;

    if (uploaded.length > 0) {
      this.successMsg = `已上传：${uploaded.join("、")}`;
    }
    if (failed.length > 0) {
      this.error = `上传失败：${failed.join("、")}` + (this.error ? `；${this.error}` : "");
    }

    // Reset input so the same file can be re-uploaded
    const input = this.shadowRoot?.querySelector<HTMLInputElement>("#file-input");
    if (input) {input.value = "";}

    await this._loadFiles();
  }

  private async _onFileSelected(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files?.length) {
      await this._uploadFiles(input.files);
    }
  }

  private _onDragOver(e: DragEvent) {
    e.preventDefault();
    this.dragover = true;
  }

  private _onDragLeave() {
    this.dragover = false;
  }

  private async _onDrop(e: DragEvent) {
    e.preventDefault();
    this.dragover = false;
    const files = e.dataTransfer?.files;
    if (files?.length) {
      await this._uploadFiles(files);
    }
  }

  private async _viewFile(name: string) {
    const tenantId = this.tenantId;
    if (!tenantId) {return;}
    try {
      const result = await tenantRpc("cs.knowledge.view", { tenantId, name }) as { content: string };
      const blob = new Blob([result.content], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const win = window.open(url, "_blank");
      // Revoke after tab has had time to load
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      if (!win) {this.error = "弹窗被浏览器拦截，请允许弹窗后重试";}
    } catch (err) {
      this.error = err instanceof Error ? err.message : "加载文件失败";
    }
  }

  private async _downloadFile(name: string) {
    const tenantId = this.tenantId;
    if (!tenantId) {return;}
    try {
      const result = await tenantRpc("cs.knowledge.view", { tenantId, name }) as { content: string };
      const blob = new Blob([result.content], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5_000);
    } catch (err) {
      this.error = err instanceof Error ? err.message : "下载失败";
    }
  }

  private async _deleteFile(name: string) {
    const tenantId = this.tenantId;
    if (!tenantId) {return;}
    if (!confirm(`确认删除知识库文件 "${name}"？`)) {return;}

    this.deletingFile = name;
    this.error = null;
    this.successMsg = null;
    try {
      await tenantRpc("cs.knowledge.delete", { tenantId, name });
      this.successMsg = `已删除 ${name}`;
      await this._loadFiles();
    } catch (err) {
      this.error = err instanceof Error ? err.message : "删除失败";
    } finally {
      this.deletingFile = null;
    }
  }

  private _formatSize(bytes: number): string {
    if (bytes < 1024) {return `${bytes} B`;}
    if (bytes < 1024 * 1024) {return `${(bytes / 1024).toFixed(1)} KB`;}
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  private _formatDate(iso: string): string {
    try {
      return new Date(iso).toLocaleString("zh-CN", { hour12: false });
    } catch {
      return iso;
    }
  }

  render() {
    return html`
      <div class="toolbar">
        <h2>AI 客服知识库</h2>
        <button class="btn btn-primary" ?disabled=${this.uploading} @click=${this._triggerUpload}>
          ${this.uploading ? "上传中…" : "+ 上传文件"}
        </button>
        <input
          type="file"
          id="file-input"
          accept=".md,text/markdown"
          multiple
          @change=${this._onFileSelected}
        />
      </div>

      <!-- Drag-drop zone / 拖放上传区 -->
      <div
        class="drop-zone ${this.dragover ? "dragover" : ""}"
        @click=${this._triggerUpload}
        @dragover=${this._onDragOver}
        @dragleave=${this._onDragLeave}
        @drop=${this._onDrop}
      >
        <span class="drop-icon">📄</span>
        <strong>点击选择</strong>或将 <strong>.md</strong> 文件拖放到此处上传，支持多文件
      </div>

      <div class="info-banner">
        AI 客服将基于知识库文件检索并回答访客问题，建议按主题拆分（如产品介绍、常见问题、价格说明等）。<br>
        上传后知识库在下次对话时自动生效（无需重启）。
      </div>

      ${this.error ? html`<p class="error-msg">${this.error}</p>` : nothing}
      ${this.successMsg ? html`<p class="success-msg">${this.successMsg}</p>` : nothing}

      ${this.loading
        ? html`<div class="loading">加载中…</div>`
        : this.files.length === 0
          ? html`<div class="empty-state">暂无知识库文件，点击上传或拖放 .md 文件开始。</div>`
          : html`
            <table class="file-table">
              <thead>
                <tr>
                  <th>文件名</th>
                  <th>大小</th>
                  <th>最后更新</th>
                  <th>状态</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${this.files.map((f) => html`
                  <tr>
                    <td class="file-name">${f.name}</td>
                    <td class="file-size">${this._formatSize(f.size)}</td>
                    <td class="file-date">${this._formatDate(f.updatedAt)}</td>
                    <td><span class="status-badge">✅ 已生效</span></td>
                    <td>
                      <div class="actions">
                        <button class="btn btn-ghost" @click=${() => this._viewFile(f.name)}>查看</button>
                        <button class="btn btn-ghost" @click=${() => this._downloadFile(f.name)}>下载</button>
                        <button
                          class="btn btn-danger"
                          ?disabled=${this.deletingFile === f.name}
                          @click=${() => this._deleteFile(f.name)}
                        >${this.deletingFile === f.name ? "删除中…" : "删除"}</button>
                      </div>
                    </td>
                  </tr>
                `)}
              </tbody>
            </table>
          `
      }
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cs-knowledge-view": CSKnowledgeView;
  }
}
