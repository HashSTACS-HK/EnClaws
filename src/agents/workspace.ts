import syncFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isOptEnabled } from "../config/token-optimization.js";
import { openBoundaryFile } from "../infra/boundary-file-read.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { isCronSessionKey, isSubagentSessionKey } from "../routing/session-key.js";
import { getSubagentDepth } from "../sessions/session-key-utils.js";
import { resolveUserPath } from "../utils.js";
import { getEnterpriseDefault, isCurrentEnterpriseDefault } from "./enterprise-defaults.js";
import { resolveWorkspaceTemplateDir } from "./workspace-templates.js";

export function resolveDefaultAgentWorkspaceDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const home = resolveRequiredHomeDir(env, homedir);
  const profile = env.ENCLAWS_PROFILE?.trim();
  if (profile && profile.toLowerCase() !== "default") {
    return path.join(home, ".enclaws", `workspace-${profile}`);
  }
  return path.join(home, ".enclaws", "workspace");
}

export const DEFAULT_AGENT_WORKSPACE_DIR = resolveDefaultAgentWorkspaceDir();
export const DEFAULT_AGENTS_FILENAME = "AGENTS.md";
export const DEFAULT_SOUL_FILENAME = "SOUL.md";
export const DEFAULT_TOOLS_FILENAME = "TOOLS.md";
export const DEFAULT_IDENTITY_FILENAME = "IDENTITY.md";
export const DEFAULT_USER_FILENAME = "USER.md";
export const DEFAULT_HEARTBEAT_FILENAME = "HEARTBEAT.md";
export const DEFAULT_BOOTSTRAP_FILENAME = "BOOTSTRAP.md";
export const DEFAULT_MEMORY_FILENAME = "MEMORY.md";
export const DEFAULT_MEMORY_ALT_FILENAME = "memory.md";
const WORKSPACE_STATE_DIRNAME = ".enclaws";
const WORKSPACE_STATE_FILENAME = "workspace-state.json";
const WORKSPACE_STATE_VERSION = 1;

const workspaceTemplateCache = new Map<string, Promise<string>>();
let gitAvailabilityPromise: Promise<boolean> | null = null;
const MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES = 2 * 1024 * 1024;

// File content cache keyed by stable file identity to avoid stale reads.
const workspaceFileCache = new Map<string, { content: string; identity: string }>();

/**
 * Read workspace files via boundary-safe open and cache by inode/dev/size/mtime identity.
 */
type WorkspaceGuardedReadResult =
  | { ok: true; content: string }
  | { ok: false; reason: "path" | "validation" | "io"; error?: unknown };

function workspaceFileIdentity(stat: syncFs.Stats, canonicalPath: string): string {
  return `${canonicalPath}|${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
}

async function readWorkspaceFileWithGuards(params: {
  filePath: string;
  workspaceDir: string;
}): Promise<WorkspaceGuardedReadResult> {
  const opened = await openBoundaryFile({
    absolutePath: params.filePath,
    rootPath: params.workspaceDir,
    boundaryLabel: "workspace root",
    maxBytes: MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES,
  });
  if (!opened.ok) {
    workspaceFileCache.delete(params.filePath);
    return opened;
  }

  const identity = workspaceFileIdentity(opened.stat, opened.path);
  const cached = workspaceFileCache.get(params.filePath);
  if (cached && cached.identity === identity) {
    syncFs.closeSync(opened.fd);
    return { ok: true, content: cached.content };
  }

  try {
    const content = syncFs.readFileSync(opened.fd, "utf-8");
    workspaceFileCache.set(params.filePath, { content, identity });
    return { ok: true, content };
  } catch (error) {
    workspaceFileCache.delete(params.filePath);
    return { ok: false, reason: "io", error };
  } finally {
    syncFs.closeSync(opened.fd);
  }
}

function stripFrontMatter(content: string): string {
  if (!content.startsWith("---")) {
    return content;
  }
  const endIndex = content.indexOf("\n---", 3);
  if (endIndex === -1) {
    return content;
  }
  const start = endIndex + "\n---".length;
  let trimmed = content.slice(start);
  trimmed = trimmed.replace(/^\s+/, "");
  return trimmed;
}

async function loadTemplate(name: string): Promise<string> {
  const cached = workspaceTemplateCache.get(name);
  if (cached) {
    return cached;
  }

  const pending = (async () => {
    const templateDir = await resolveWorkspaceTemplateDir();
    const templatePath = path.join(templateDir, name);
    try {
      const content = await fs.readFile(templatePath, "utf-8");
      return stripFrontMatter(content);
    } catch {
      throw new Error(
        `Missing workspace template: ${name} (${templatePath}). Ensure docs/reference/templates are packaged.`,
      );
    }
  })();

  workspaceTemplateCache.set(name, pending);
  try {
    return await pending;
  } catch (error) {
    workspaceTemplateCache.delete(name);
    throw error;
  }
}

export type WorkspaceBootstrapFileName =
  | typeof DEFAULT_AGENTS_FILENAME
  | typeof DEFAULT_SOUL_FILENAME
  | typeof DEFAULT_TOOLS_FILENAME
  | typeof DEFAULT_IDENTITY_FILENAME
  | typeof DEFAULT_USER_FILENAME
  | typeof DEFAULT_HEARTBEAT_FILENAME
  | typeof DEFAULT_BOOTSTRAP_FILENAME
  | typeof DEFAULT_MEMORY_FILENAME
  | typeof DEFAULT_MEMORY_ALT_FILENAME;

export type WorkspaceBootstrapFile = {
  name: WorkspaceBootstrapFileName;
  path: string;
  content?: string;
  missing: boolean;
};

export type ExtraBootstrapLoadDiagnosticCode =
  | "invalid-bootstrap-filename"
  | "missing"
  | "security"
  | "io";

export type ExtraBootstrapLoadDiagnostic = {
  path: string;
  reason: ExtraBootstrapLoadDiagnosticCode;
  detail: string;
};

type WorkspaceOnboardingState = {
  version: typeof WORKSPACE_STATE_VERSION;
  bootstrapSeededAt?: string;
  onboardingCompletedAt?: string;
};

/** Set of recognized bootstrap filenames for runtime validation */
const VALID_BOOTSTRAP_NAMES: ReadonlySet<string> = new Set([
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_MEMORY_ALT_FILENAME,
]);

async function writeFileIfMissing(filePath: string, content: string): Promise<boolean> {
  try {
    await fs.writeFile(filePath, content, {
      encoding: "utf-8",
      flag: "wx",
    });
    return true;
  } catch (err) {
    const anyErr = err as { code?: string };
    if (anyErr.code !== "EEXIST") {
      throw err;
    }
    return false;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function resolveWorkspaceStatePath(dir: string): string {
  return path.join(dir, WORKSPACE_STATE_DIRNAME, WORKSPACE_STATE_FILENAME);
}

function parseWorkspaceOnboardingState(raw: string): WorkspaceOnboardingState | null {
  try {
    const parsed = JSON.parse(raw) as {
      bootstrapSeededAt?: unknown;
      onboardingCompletedAt?: unknown;
    };
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return {
      version: WORKSPACE_STATE_VERSION,
      bootstrapSeededAt:
        typeof parsed.bootstrapSeededAt === "string" ? parsed.bootstrapSeededAt : undefined,
      onboardingCompletedAt:
        typeof parsed.onboardingCompletedAt === "string" ? parsed.onboardingCompletedAt : undefined,
    };
  } catch {
    return null;
  }
}

async function readWorkspaceOnboardingState(statePath: string): Promise<WorkspaceOnboardingState> {
  try {
    const raw = await fs.readFile(statePath, "utf-8");
    return (
      parseWorkspaceOnboardingState(raw) ?? {
        version: WORKSPACE_STATE_VERSION,
      }
    );
  } catch (err) {
    const anyErr = err as { code?: string };
    if (anyErr.code !== "ENOENT") {
      throw err;
    }
    return {
      version: WORKSPACE_STATE_VERSION,
    };
  }
}

async function readWorkspaceOnboardingStateForDir(dir: string): Promise<WorkspaceOnboardingState> {
  const statePath = resolveWorkspaceStatePath(resolveUserPath(dir));
  return await readWorkspaceOnboardingState(statePath);
}

export async function isWorkspaceOnboardingCompleted(dir: string): Promise<boolean> {
  const state = await readWorkspaceOnboardingStateForDir(dir);
  return (
    typeof state.onboardingCompletedAt === "string" && state.onboardingCompletedAt.trim().length > 0
  );
}

async function writeWorkspaceOnboardingState(
  statePath: string,
  state: WorkspaceOnboardingState,
): Promise<void> {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const payload = `${JSON.stringify(state, null, 2)}\n`;
  const tmpPath = `${statePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    await fs.writeFile(tmpPath, payload, { encoding: "utf-8" });
    await fs.rename(tmpPath, statePath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

async function hasGitRepo(dir: string): Promise<boolean> {
  try {
    await fs.stat(path.join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function isGitAvailable(): Promise<boolean> {
  if (gitAvailabilityPromise) {
    return gitAvailabilityPromise;
  }

  gitAvailabilityPromise = (async () => {
    try {
      const result = await runCommandWithTimeout(["git", "--version"], { timeoutMs: 2_000 });
      return result.code === 0;
    } catch {
      return false;
    }
  })();

  return gitAvailabilityPromise;
}

async function ensureGitRepo(dir: string, isBrandNewWorkspace: boolean) {
  if (!isBrandNewWorkspace) {
    return;
  }
  if (await hasGitRepo(dir)) {
    return;
  }
  if (!(await isGitAvailable())) {
    return;
  }
  try {
    await runCommandWithTimeout(["git", "init"], { cwd: dir, timeoutMs: 10_000 });
  } catch {
    // Ignore git init failures; workspace creation should still succeed.
  }
}

export async function ensureAgentWorkspace(params?: {
  dir?: string;
  ensureBootstrapFiles?: boolean;
}): Promise<{
  dir: string;
  agentsPath?: string;
  soulPath?: string;
  toolsPath?: string;
  identityPath?: string;
  userPath?: string;
  heartbeatPath?: string;
  bootstrapPath?: string;
}> {
  const rawDir = params?.dir?.trim() ? params.dir.trim() : DEFAULT_AGENT_WORKSPACE_DIR;
  const dir = resolveUserPath(rawDir);
  await fs.mkdir(dir, { recursive: true });

  if (!params?.ensureBootstrapFiles) {
    return { dir };
  }

  const agentsPath = path.join(dir, DEFAULT_AGENTS_FILENAME);
  const soulPath = path.join(dir, DEFAULT_SOUL_FILENAME);
  const toolsPath = path.join(dir, DEFAULT_TOOLS_FILENAME);
  const identityPath = path.join(dir, DEFAULT_IDENTITY_FILENAME);
  const userPath = path.join(dir, DEFAULT_USER_FILENAME);
  const heartbeatPath = path.join(dir, DEFAULT_HEARTBEAT_FILENAME);
  const bootstrapPath = path.join(dir, DEFAULT_BOOTSTRAP_FILENAME);
  const statePath = resolveWorkspaceStatePath(dir);

  const isBrandNewWorkspace = await (async () => {
    const templatePaths = [agentsPath, soulPath, toolsPath, identityPath, userPath, heartbeatPath];
    const userContentPaths = [
      path.join(dir, "memory"),
      path.join(dir, DEFAULT_MEMORY_FILENAME),
      path.join(dir, ".git"),
    ];
    const paths = [...templatePaths, ...userContentPaths];
    const existing = await Promise.all(
      paths.map(async (p) => {
        try {
          await fs.access(p);
          return true;
        } catch {
          return false;
        }
      }),
    );
    return existing.every((v) => !v);
  })();

  const agentsTemplate = await loadTemplate(DEFAULT_AGENTS_FILENAME);
  const soulTemplate = await loadTemplate(DEFAULT_SOUL_FILENAME);
  const toolsTemplate = await loadTemplate(DEFAULT_TOOLS_FILENAME);
  const identityTemplate = await loadTemplate(DEFAULT_IDENTITY_FILENAME);
  const userTemplate = await loadTemplate(DEFAULT_USER_FILENAME);
  const heartbeatTemplate = await loadTemplate(DEFAULT_HEARTBEAT_FILENAME);
  await writeFileIfMissing(agentsPath, agentsTemplate);
  await writeFileIfMissing(soulPath, soulTemplate);
  await writeFileIfMissing(toolsPath, toolsTemplate);
  await writeFileIfMissing(identityPath, identityTemplate);
  await writeFileIfMissing(userPath, userTemplate);
  await writeFileIfMissing(heartbeatPath, heartbeatTemplate);

  let state = await readWorkspaceOnboardingState(statePath);
  let stateDirty = false;
  const markState = (next: Partial<WorkspaceOnboardingState>) => {
    state = { ...state, ...next };
    stateDirty = true;
  };
  const nowIso = () => new Date().toISOString();

  let bootstrapExists = await fileExists(bootstrapPath);
  if (!state.bootstrapSeededAt && bootstrapExists) {
    markState({ bootstrapSeededAt: nowIso() });
  }

  if (!state.onboardingCompletedAt && state.bootstrapSeededAt && !bootstrapExists) {
    markState({ onboardingCompletedAt: nowIso() });
  }

  if (!state.bootstrapSeededAt && !state.onboardingCompletedAt && !bootstrapExists) {
    // Legacy migration path: if USER/IDENTITY diverged from templates, or if user-content
    // indicators exist, treat onboarding as complete and avoid recreating BOOTSTRAP for
    // already-onboarded workspaces.
    const [identityContent, userContent] = await Promise.all([
      fs.readFile(identityPath, "utf-8"),
      fs.readFile(userPath, "utf-8"),
    ]);
    const hasUserContent = await (async () => {
      const indicators = [
        path.join(dir, "memory"),
        path.join(dir, DEFAULT_MEMORY_FILENAME),
        path.join(dir, ".git"),
      ];
      for (const indicator of indicators) {
        try {
          await fs.access(indicator);
          return true;
        } catch {
          // continue
        }
      }
      return false;
    })();
    const legacyOnboardingCompleted =
      identityContent !== identityTemplate || userContent !== userTemplate || hasUserContent;
    if (legacyOnboardingCompleted) {
      markState({ onboardingCompletedAt: nowIso() });
    } else {
      const bootstrapTemplate = await loadTemplate(DEFAULT_BOOTSTRAP_FILENAME);
      const wroteBootstrap = await writeFileIfMissing(bootstrapPath, bootstrapTemplate);
      if (!wroteBootstrap) {
        bootstrapExists = await fileExists(bootstrapPath);
      } else {
        bootstrapExists = true;
      }
      if (bootstrapExists && !state.bootstrapSeededAt) {
        markState({ bootstrapSeededAt: nowIso() });
      }
    }
  }

  if (stateDirty) {
    await writeWorkspaceOnboardingState(statePath, state);
  }
  await ensureGitRepo(dir, isBrandNewWorkspace);

  return {
    dir,
    agentsPath,
    soulPath,
    toolsPath,
    identityPath,
    userPath,
    heartbeatPath,
    bootstrapPath,
  };
}

/**
 * Initialize bootstrap files for the multi-tenant directory layout.
 *
 * - Tenant-level:  IDENTITY.md, MEMORY.md, TOOLS.md → tenants/{tid}/
 * - Agent-level:   AGENT.md(AGENTS.md), SOUL.md, IDENTITY.md, HEARTBEAT.md, BOOTSTRAP.md → tenants/{tid}/agents/{agentId}/
 * - User-level:    USER.md                   → tenants/{tid}/users/{userId}/
 * - User workspace:                          → tenants/{tid}/users/{userId}/workspace/ (created, but no files seeded)
 */
export async function ensureTenantBootstrapFiles(ctx: TenantBootstrapContext): Promise<void> {
  // Ensure all directories exist (skip user dirs when not provided)
  const mkdirs = [
    fs.mkdir(ctx.tenantDir, { recursive: true }),
    fs.mkdir(ctx.agentDir, { recursive: true }),
  ];
  if (ctx.userDir) {
    mkdirs.push(fs.mkdir(ctx.userDir, { recursive: true }));
  }
  if (ctx.workspaceDir) {
    mkdirs.push(fs.mkdir(ctx.workspaceDir, { recursive: true }));
  }
  await Promise.all(mkdirs);

  // Tenant-level files
  const tenantIdentityPath = path.join(ctx.tenantDir, DEFAULT_IDENTITY_FILENAME);
  const tenantMemoryPath = path.join(ctx.tenantDir, DEFAULT_MEMORY_FILENAME);
  const tenantToolsPath = path.join(ctx.tenantDir, DEFAULT_TOOLS_FILENAME);
  await writeFileIfMissing(
    tenantIdentityPath,
    "# 企业身份描述\n\n" +
      "请在此描述企业的身份特征，该内容将作为 AI 助手的企业上下文。\n\n" +
      "例如：\n" +
      "- 我们是XX科技有限公司，主营区块链技术开发\n" +
      "- 核心产品包括：数字资产管理平台、稳定币系统\n" +
      "- 技术栈：TypeScript, Node.js, React, PostgreSQL\n\n" +
      "提示：也可通过「企业设置」页面的「企业身份描述」字段编辑此内容。\n",
  );
  await writeFileIfMissing(
    tenantMemoryPath,
    "# Enterprise Memory\n\n" +
      "AI 助手会在对话中自动记录重要的企业信息到此文件。\n" +
      "你也可以手动编辑维护。\n\n" +
      "格式：每条记忆以 `- ` 开头，保持简洁。\n",
  );
  const tenantToolsTemplate = await loadTemplate(DEFAULT_TOOLS_FILENAME);
  await writeFileIfMissing(tenantToolsPath, tenantToolsTemplate);

  // Agent-level files
  const agentAgentsPath = path.join(ctx.agentDir, DEFAULT_AGENTS_FILENAME);
  const agentSoulPath = path.join(ctx.agentDir, DEFAULT_SOUL_FILENAME);
  const agentIdentityPath = path.join(ctx.agentDir, DEFAULT_IDENTITY_FILENAME);
  const agentHeartbeatPath = path.join(ctx.agentDir, DEFAULT_HEARTBEAT_FILENAME);
  const agentBootstrapPath = path.join(ctx.agentDir, DEFAULT_BOOTSTRAP_FILENAME);
  // Multi-tenant: seed enterprise defaults instead of generic templates for
  // agent-level persona files (AGENTS.md, SOUL.md, IDENTITY.md).
  const {
    ENTERPRISE_DEFAULT_AGENTS: agentsDefault,
    ENTERPRISE_DEFAULT_SOUL: soulDefault,
    ENTERPRISE_DEFAULT_IDENTITY: identityDefault,
  } = await import("./enterprise-defaults.js");
  const heartbeatTemplate = await loadTemplate(DEFAULT_HEARTBEAT_FILENAME);
  await writeFileIfMissing(agentAgentsPath, agentsDefault);
  await writeFileIfMissing(agentSoulPath, soulDefault);
  await writeFileIfMissing(agentIdentityPath, identityDefault);
  await writeFileIfMissing(agentHeartbeatPath, heartbeatTemplate);

  // Migrate existing agents: if files still have the old generic template content,
  // overwrite them with enterprise defaults so the system prompt gets proper guidance.
  const migrateTargets: Array<{ filePath: string; enterpriseContent: string }> = [
    { filePath: agentAgentsPath, enterpriseContent: agentsDefault },
    { filePath: agentSoulPath, enterpriseContent: soulDefault },
    { filePath: agentIdentityPath, enterpriseContent: identityDefault },
  ];
  for (const target of migrateTargets) {
    try {
      const current = await fs.readFile(target.filePath, "utf-8");
      // Leave user-customized content and current defaults (any locale) alone;
      // only overwrite when the file still holds the generic template or a
      // retired legacy default prefix.
      if (isCurrentEnterpriseDefault(path.basename(target.filePath), current)) {
        continue;
      }
      const template = await loadTemplate(path.basename(target.filePath));
      const isTemplate = current === template;
      const { PREVIOUS_ENTERPRISE_DEFAULT_PREFIXES } = await import("./enterprise-defaults.js");
      const isOldDefault =
        !isTemplate &&
        PREVIOUS_ENTERPRISE_DEFAULT_PREFIXES.some((prefix: string) => current.startsWith(prefix));
      if (isTemplate || isOldDefault) {
        await fs.writeFile(target.filePath, target.enterpriseContent, "utf-8");
      }
    } catch {
      /* file doesn't exist yet — writeFileIfMissing handled it above */
    }
  }

  // Seed BOOTSTRAP.md only if agent dir looks brand new
  const agentIndicators = [agentAgentsPath, agentSoulPath, agentIdentityPath];
  const agentHasContent = await Promise.all(
    agentIndicators.map(async (p) => {
      try {
        const content = await fs.readFile(p, "utf-8");
        // Treat any current-locale enterprise default (en or zh) and the
        // generic template as "no user content yet".
        const template = await loadTemplate(path.basename(p));
        return content !== template && !isCurrentEnterpriseDefault(path.basename(p), content);
      } catch {
        return false;
      }
    }),
  );
  if (!agentHasContent.some(Boolean)) {
    const bootstrapTemplate = await loadTemplate(DEFAULT_BOOTSTRAP_FILENAME);
    await writeFileIfMissing(agentBootstrapPath, bootstrapTemplate);
  }

  // User-level files (skip when userDir is not provided)
  if (ctx.userDir) {
    const userPath = path.join(ctx.userDir, DEFAULT_USER_FILENAME);
    const userTemplate = await loadTemplate(DEFAULT_USER_FILENAME);
    await writeFileIfMissing(userPath, userTemplate);
  }
}

/**
 * Seed the agent workspace directory with the five per-agent files so callers
 * don't have to wait for the first IM message to trigger lazy init. Writes are
 * idempotent — existing files are preserved.
 *
 * - IDENTITY.md: `systemPrompt` when provided, otherwise the locale-aware
 *   enterprise default.
 * - AGENTS.md / SOUL.md: locale-aware enterprise defaults.
 * - BOOTSTRAP.md / HEARTBEAT.md: generic workspace templates.
 */
export async function seedAgentWorkspaceFiles(
  agentDir: string,
  opts: { locale?: string; systemPrompt?: string } = {},
): Promise<void> {
  await fs.mkdir(agentDir, { recursive: true });

  const prompt = typeof opts.systemPrompt === "string" ? opts.systemPrompt.trim() : "";
  const identityContent =
    prompt || getEnterpriseDefault(DEFAULT_IDENTITY_FILENAME, opts.locale) || "";
  const agentsContent = getEnterpriseDefault(DEFAULT_AGENTS_FILENAME, opts.locale) || "";
  const soulContent = getEnterpriseDefault(DEFAULT_SOUL_FILENAME, opts.locale) || "";
  const [heartbeatTemplate, bootstrapTemplate] = await Promise.all([
    loadTemplate(DEFAULT_HEARTBEAT_FILENAME),
    loadTemplate(DEFAULT_BOOTSTRAP_FILENAME),
  ]);

  await Promise.all([
    writeFileIfMissing(path.join(agentDir, DEFAULT_IDENTITY_FILENAME), identityContent),
    writeFileIfMissing(path.join(agentDir, DEFAULT_AGENTS_FILENAME), agentsContent),
    writeFileIfMissing(path.join(agentDir, DEFAULT_SOUL_FILENAME), soulContent),
    writeFileIfMissing(path.join(agentDir, DEFAULT_BOOTSTRAP_FILENAME), bootstrapTemplate),
    writeFileIfMissing(path.join(agentDir, DEFAULT_HEARTBEAT_FILENAME), heartbeatTemplate),
  ]);
}

/**
 * Remove the five agent workspace files written by `seedAgentWorkspaceFiles`.
 * Used to roll back a create flow when the enclosing transaction fails.
 */
export async function removeAgentWorkspaceFiles(agentDir: string): Promise<void> {
  const names = [
    DEFAULT_IDENTITY_FILENAME,
    DEFAULT_AGENTS_FILENAME,
    DEFAULT_SOUL_FILENAME,
    DEFAULT_BOOTSTRAP_FILENAME,
    DEFAULT_HEARTBEAT_FILENAME,
  ];
  await Promise.all(
    names.map((n) => fs.rm(path.join(agentDir, n), { force: true }).catch(() => {})),
  );
}

/**
 * Initialize only the tenant-level directory and seed files.
 * Called immediately after tenant registration -- no agentId or userId needed.
 *
 * Creates:
 *   tenants/{tid}/IDENTITY.md
 *   tenants/{tid}/MEMORY.md
 *   tenants/{tid}/TOOLS.md
 */
export async function ensureTenantDirFiles(tenantDir: string): Promise<void> {
  await fs.mkdir(tenantDir, { recursive: true });

  const tenantIdentityPath = path.join(tenantDir, DEFAULT_IDENTITY_FILENAME);
  const tenantMemoryPath = path.join(tenantDir, DEFAULT_MEMORY_FILENAME);
  const tenantToolsPath = path.join(tenantDir, DEFAULT_TOOLS_FILENAME);

  await writeFileIfMissing(
    tenantIdentityPath,
    "# 企业身份描述\n\n" +
      "请在此描述企业的身份特征，该内容将作为 AI 助手的企业上下文。\n\n" +
      "例如：\n" +
      "- 我们是XX科技有限公司，主营区块链技术开发\n" +
      "- 核心产品包括：数字资产管理平台、稳定币系统\n" +
      "- 技术栈：TypeScript, Node.js, React, PostgreSQL\n\n" +
      "提示：也可通过「企业设置」页面的「企业身份描述」字段编辑此内容。\n",
  );
  await writeFileIfMissing(
    tenantMemoryPath,
    "# Enterprise Memory\n\n" +
      "AI 助手会在对话中自动记录重要的企业信息到此文件。\n" +
      "你也可以手动编辑维护。\n\n" +
      "格式：每条记忆以 `- ` 开头，保持简洁。\n",
  );
  const tenantToolsTemplate = await loadTemplate(DEFAULT_TOOLS_FILENAME);
  await writeFileIfMissing(tenantToolsPath, tenantToolsTemplate);
}

async function resolveMemoryBootstrapEntries(
  resolvedDir: string,
): Promise<Array<{ name: WorkspaceBootstrapFileName; filePath: string }>> {
  const candidates: WorkspaceBootstrapFileName[] = [
    DEFAULT_MEMORY_FILENAME,
    DEFAULT_MEMORY_ALT_FILENAME,
  ];
  const entries: Array<{ name: WorkspaceBootstrapFileName; filePath: string }> = [];
  for (const name of candidates) {
    const filePath = path.join(resolvedDir, name);
    try {
      await fs.access(filePath);
      entries.push({ name, filePath });
    } catch {
      // optional
    }
  }
  if (entries.length <= 1) {
    return entries;
  }

  const seen = new Set<string>();
  const deduped: Array<{ name: WorkspaceBootstrapFileName; filePath: string }> = [];
  for (const entry of entries) {
    let key = entry.filePath;
    try {
      key = await fs.realpath(entry.filePath);
    } catch {}
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(entry);
  }
  return deduped;
}

export async function loadWorkspaceBootstrapFiles(
  dir: string,
  tenantContext?: TenantBootstrapContext,
): Promise<WorkspaceBootstrapFile[]> {
  // Multi-tenant mode: collect files from tenant dir, agent dir, and user workspace dir
  if (tenantContext) {
    return loadTenantBootstrapFiles(dir, tenantContext);
  }

  // Single-tenant mode: all files from one workspace directory
  const resolvedDir = resolveUserPath(dir);

  const entries: Array<{
    name: WorkspaceBootstrapFileName;
    filePath: string;
  }> = [
    {
      name: DEFAULT_AGENTS_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_AGENTS_FILENAME),
    },
    {
      name: DEFAULT_SOUL_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_SOUL_FILENAME),
    },
    {
      name: DEFAULT_TOOLS_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_TOOLS_FILENAME),
    },
    {
      name: DEFAULT_IDENTITY_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_IDENTITY_FILENAME),
    },
    {
      name: DEFAULT_USER_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_USER_FILENAME),
    },
    {
      name: DEFAULT_HEARTBEAT_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_HEARTBEAT_FILENAME),
    },
    {
      name: DEFAULT_BOOTSTRAP_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_BOOTSTRAP_FILENAME),
    },
  ];

  entries.push(...(await resolveMemoryBootstrapEntries(resolvedDir)));

  const result: WorkspaceBootstrapFile[] = [];
  for (const entry of entries) {
    const loaded = await readWorkspaceFileWithGuards({
      filePath: entry.filePath,
      workspaceDir: resolvedDir,
    });
    if (loaded.ok) {
      result.push({
        name: entry.name,
        path: entry.filePath,
        content: loaded.content,
        missing: false,
      });
    } else {
      result.push({ name: entry.name, path: entry.filePath, missing: true });
    }
  }
  return result;
}

// ============================================================================
// Multi-tenant bootstrap: collect files from multiple directories
// ============================================================================

export type TenantBootstrapContext = {
  tenantId: string; // tenant UUID
  tenantDir: string; // tenants/{tid}/         — enterprise IDENTITY, TOOLS, MEMORY
  agentDir: string; // tenants/{tid}/agents/{agentId}/ — AGENT, SOUL, IDENTITY, HEARTBEAT, BOOTSTRAP
  userDir?: string; // tenants/{tid}/users/{userId}/   — USER.md
  workspaceDir?: string; // tenants/{tid}/users/{userId}/workspace/ — MEMORY, memory/
};

// ============================================================================
// Tenant bootstrap context registry
// ============================================================================

/**
 * Registry mapping workspace directory paths to their TenantBootstrapContext.
 * This allows deep call sites (attempt.ts, compact.ts) to resolve tenant
 * context from the workspace dir without threading it through all params.
 */
const tenantBootstrapRegistry = new Map<string, TenantBootstrapContext>();

export function registerTenantBootstrapContext(
  workspaceDir: string,
  ctx: TenantBootstrapContext,
): void {
  tenantBootstrapRegistry.set(workspaceDir, ctx);
}

export function getTenantBootstrapContext(
  workspaceDir: string,
): TenantBootstrapContext | undefined {
  return tenantBootstrapRegistry.get(workspaceDir);
}

/**
 * Load bootstrap files from the multi-tenant directory layout.
 *
 * Collection order (injected into prompt in this order):
 *   1. Enterprise IDENTITY.md   — from tenantDir (managed via tenant settings)
 *   2. Enterprise MEMORY.md     — from tenantDir (enterprise long-term memory)
 *   3. Enterprise TOOLS.md      — from tenantDir
 *   4. Agent AGENT.md           — from agentDir (replaces AGENTS.md)
 *   5. Agent SOUL.md            — from agentDir
 *   6. Agent IDENTITY.md        — from agentDir
 *   7. Agent HEARTBEAT.md       — from agentDir
 *   8. Agent BOOTSTRAP.md       — from agentDir
 *   9. User USER.md             — from userDir
 *  10. User MEMORY.md           — from workspaceDir
 */
async function loadTenantBootstrapFiles(
  _workspaceDir: string,
  ctx: TenantBootstrapContext,
): Promise<WorkspaceBootstrapFile[]> {
  const tenantIdentityPath = path.join(ctx.tenantDir, DEFAULT_IDENTITY_FILENAME);

  const entries: Array<{
    name: WorkspaceBootstrapFileName;
    filePath: string;
    rootDir: string;
  }> = [
    // Enterprise-level files (tenant IDENTITY.md handled separately below)
    {
      name: DEFAULT_MEMORY_FILENAME,
      filePath: path.join(ctx.tenantDir, DEFAULT_MEMORY_FILENAME),
      rootDir: ctx.tenantDir,
    },
    {
      name: DEFAULT_TOOLS_FILENAME,
      filePath: path.join(ctx.tenantDir, DEFAULT_TOOLS_FILENAME),
      rootDir: ctx.tenantDir,
    },
    // Agent-level files
    {
      name: DEFAULT_AGENTS_FILENAME,
      filePath: path.join(ctx.agentDir, DEFAULT_AGENTS_FILENAME),
      rootDir: ctx.agentDir,
    },
    {
      name: DEFAULT_SOUL_FILENAME,
      filePath: path.join(ctx.agentDir, DEFAULT_SOUL_FILENAME),
      rootDir: ctx.agentDir,
    },
    {
      name: DEFAULT_IDENTITY_FILENAME,
      filePath: path.join(ctx.agentDir, DEFAULT_IDENTITY_FILENAME),
      rootDir: ctx.agentDir,
    },
    {
      name: DEFAULT_HEARTBEAT_FILENAME,
      filePath: path.join(ctx.agentDir, DEFAULT_HEARTBEAT_FILENAME),
      rootDir: ctx.agentDir,
    },
    {
      name: DEFAULT_BOOTSTRAP_FILENAME,
      filePath: path.join(ctx.agentDir, DEFAULT_BOOTSTRAP_FILENAME),
      rootDir: ctx.agentDir,
    },
  ];

  // User-level files (only when userDir is provided)
  if (ctx.userDir) {
    entries.push({
      name: DEFAULT_USER_FILENAME,
      filePath: path.join(ctx.userDir, DEFAULT_USER_FILENAME),
      rootDir: ctx.userDir,
    });
  }

  // User memory files from workspace
  if (ctx.workspaceDir) {
    const wsDir = ctx.workspaceDir;
    entries.push(
      ...(await resolveMemoryBootstrapEntries(wsDir)).map((e) => ({
        ...e,
        rootDir: wsDir,
      })),
    );
  }

  const result: WorkspaceBootstrapFile[] = [];

  // 1. Tenant IDENTITY.md — build structured header from DB metadata + file content
  {
    let metaHeader = "";
    try {
      const { getTenantById } = await import("../db/models/tenant.js");
      const tenant = await getTenantById(ctx.tenantId);
      if (tenant) {
        const lines: string[] = ["# 企业身份", ""];
        if (tenant.name) {
          lines.push(`- 企业名称：${tenant.name}`);
        }
        lines.push("");
        lines.push("当用户询问你的身份时，应主动说明你服务于该企业。");
        lines.push("当对话中出现重要的企业级信息时，主动使用 tenant_memory 工具保存。");
        metaHeader = lines.join("\n");
      }
    } catch {
      // DB not available — skip metadata
    }

    const tenantIdentity = await readWorkspaceFileGuardless(tenantIdentityPath);
    const fileContent = tenantIdentity.ok ? tenantIdentity.content.trim() : "";
    const combined = [metaHeader, fileContent].filter(Boolean).join("\n\n");

    if (combined) {
      result.push({
        name: DEFAULT_IDENTITY_FILENAME,
        path: tenantIdentityPath,
        content: combined,
        missing: false,
      });
    } else {
      result.push({ name: DEFAULT_IDENTITY_FILENAME, path: tenantIdentityPath, missing: true });
    }
  }

  // 2. Remaining files — use enterprise defaults for missing agent-level files
  for (const entry of entries) {
    const loaded = await readWorkspaceFileGuardless(entry.filePath);
    if (loaded.ok) {
      result.push({
        name: entry.name,
        path: entry.filePath,
        content: loaded.content,
        missing: false,
      });
    } else {
      // For agent-level files (AGENTS.md, SOUL.md, IDENTITY.md) in multi-tenant mode,
      // inject enterprise defaults so the system prompt always has baseline guidance
      // even before the user explicitly saves custom content.
      const enterpriseDefault = getEnterpriseDefault(entry.name);
      if (enterpriseDefault) {
        result.push({
          name: entry.name,
          path: entry.filePath,
          content: enterpriseDefault,
          missing: true,
        });
      } else {
        result.push({ name: entry.name, path: entry.filePath, missing: true });
      }
    }
  }
  return result;
}

/**
 * Read a file without workspace boundary check (files are spread across
 * multiple directories in multi-tenant mode).
 */
async function readWorkspaceFileGuardless(
  filePath: string,
): Promise<{ ok: true; content: string } | { ok: false }> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return { ok: true, content };
  } catch {
    return { ok: false };
  }
}

const MINIMAL_BOOTSTRAP_ALLOWLIST = new Set([
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
]);

const WORKER_BOOTSTRAP_ALLOWLIST = new Set([DEFAULT_TOOLS_FILENAME, DEFAULT_IDENTITY_FILENAME]);

export function filterBootstrapFilesForSession(
  files: WorkspaceBootstrapFile[],
  sessionKey?: string,
): WorkspaceBootstrapFile[] {
  if (!sessionKey || (!isSubagentSessionKey(sessionKey) && !isCronSessionKey(sessionKey))) {
    return files;
  }
  const allowlist =
    isOptEnabled("WORKER") && getSubagentDepth(sessionKey) >= 2
      ? WORKER_BOOTSTRAP_ALLOWLIST
      : MINIMAL_BOOTSTRAP_ALLOWLIST;
  return files.filter((file) => allowlist.has(file.name));
}

export async function loadExtraBootstrapFiles(
  dir: string,
  extraPatterns: string[],
): Promise<WorkspaceBootstrapFile[]> {
  const loaded = await loadExtraBootstrapFilesWithDiagnostics(dir, extraPatterns);
  return loaded.files;
}

export async function loadExtraBootstrapFilesWithDiagnostics(
  dir: string,
  extraPatterns: string[],
): Promise<{
  files: WorkspaceBootstrapFile[];
  diagnostics: ExtraBootstrapLoadDiagnostic[];
}> {
  if (!extraPatterns.length) {
    return { files: [], diagnostics: [] };
  }
  const resolvedDir = resolveUserPath(dir);

  // Resolve glob patterns into concrete file paths
  const resolvedPaths = new Set<string>();
  for (const pattern of extraPatterns) {
    if (pattern.includes("*") || pattern.includes("?") || pattern.includes("{")) {
      try {
        const matches = fs.glob(pattern, { cwd: resolvedDir });
        for await (const m of matches) {
          resolvedPaths.add(m);
        }
      } catch {
        // glob not available or pattern error — fall back to literal
        resolvedPaths.add(pattern);
      }
    } else {
      resolvedPaths.add(pattern);
    }
  }

  const files: WorkspaceBootstrapFile[] = [];
  const diagnostics: ExtraBootstrapLoadDiagnostic[] = [];
  for (const relPath of resolvedPaths) {
    const filePath = path.resolve(resolvedDir, relPath);
    // Only load files whose basename is a recognized bootstrap filename
    const baseName = path.basename(relPath);
    if (!VALID_BOOTSTRAP_NAMES.has(baseName)) {
      diagnostics.push({
        path: filePath,
        reason: "invalid-bootstrap-filename",
        detail: `unsupported bootstrap basename: ${baseName}`,
      });
      continue;
    }
    const loaded = await readWorkspaceFileWithGuards({
      filePath,
      workspaceDir: resolvedDir,
    });
    if (loaded.ok) {
      files.push({
        name: baseName as WorkspaceBootstrapFileName,
        path: filePath,
        content: loaded.content,
        missing: false,
      });
      continue;
    }

    const reason: ExtraBootstrapLoadDiagnosticCode =
      loaded.reason === "path" ? "missing" : loaded.reason === "validation" ? "security" : "io";
    diagnostics.push({
      path: filePath,
      reason,
      detail:
        loaded.error instanceof Error
          ? loaded.error.message
          : typeof loaded.error === "string"
            ? loaded.error
            : reason,
    });
  }
  return { files, diagnostics };
}
