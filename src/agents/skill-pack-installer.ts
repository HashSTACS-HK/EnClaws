/**
 * Skill-pack auto-installer.
 *
 * Copies feishu-skills into a tenant's skills directory on enterprise creation.
 * Fallback chain: local dir → git clone → skip.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveTenantSkillsDir } from "../config/sessions/tenant-paths.js";
import { runCommandWithTimeout } from "../process/exec.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SKILLS = [
  "feishu-auth",
  "feishu-create-doc",
  "feishu-fetch-doc",
  "feishu-search-doc",
  "feishu-update-doc",
  "feishu-im-read",
  "feishu-calendar",
  "feishu-task",
  "feishu-bitable",
  "feishu-docx-download",
  "feishu-drive",
  "feishu-image-ocr",
  "feishu-search-user",
] as const;

const EXCLUDE = new Set([
  ".tokens",
  "node_modules",
  ".python",
  "__pycache__",
  "config.json",
  ".git",
]);
const EXCLUDE_EXT = [".bak", ".pyc"];

const DEFAULT_GIT_URL = "https://github.com/hashSTACS-Global/feishu-skills.git";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shouldExclude(name: string): boolean {
  if (EXCLUDE.has(name)) {
    return true;
  }
  return EXCLUDE_EXT.some((ext) => name.endsWith(ext));
}

function copyDirRecursive(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    if (shouldExclude(entry)) {
      continue;
    }
    const srcPath = path.join(src, entry);
    const dstPath = path.join(dst, entry);
    if (fs.statSync(srcPath).isDirectory()) {
      copyDirRecursive(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

// ---------------------------------------------------------------------------
// Source resolution (fallback chain)
// ---------------------------------------------------------------------------

type SkillPackSource =
  | { kind: "local"; dir: string }
  | { kind: "git"; url: string }
  | { kind: "none"; reason: string };

function resolveSkillPackSource(): SkillPackSource {
  // 1. Local directory (bundled installer scenario)
  const localDir = process.env.SKILL_PACK_LOCAL_DIR?.trim();
  if (localDir && fs.existsSync(localDir)) {
    const hasSkills = SKILLS.some((s) => fs.existsSync(path.join(localDir, s)));
    if (hasSkills) {
      return { kind: "local", dir: localDir };
    }
  }

  // 2. Git clone
  const gitUrl = process.env.SKILL_PACK_GIT_URL?.trim() || DEFAULT_GIT_URL;
  if (gitUrl) {
    return { kind: "git", url: gitUrl };
  }

  return { kind: "none", reason: "No skill pack source configured" };
}

// ---------------------------------------------------------------------------
// Git clone
// ---------------------------------------------------------------------------

async function cloneToTemp(gitUrl: string): Promise<string | null> {
  // Check git availability
  try {
    const check = await runCommandWithTimeout(["git", "--version"], { timeoutMs: 5_000 });
    if (check.code !== 0) {
      return null;
    }
  } catch {
    return null;
  }

  const tmpDir = path.join(os.tmpdir(), `skill-pack-${Date.now()}`);
  try {
    const result = await runCommandWithTimeout(["git", "clone", "--depth", "1", gitUrl, tmpDir], {
      timeoutMs: 120_000,
    });
    if (result.code !== 0) {
      cleanupDir(tmpDir);
      return null;
    }
    return tmpDir;
  } catch {
    cleanupDir(tmpDir);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type SkillPackResult = {
  ok: boolean;
  installed: string[];
  errors: Array<{ skill: string; error: string }>;
  source: string;
  skipped?: string;
};

/**
 * Check whether a tenant already has skill packs installed.
 * Returns true if at least one skill subdirectory exists under the target.
 */
function hasSkillPack(tenantId: string): boolean {
  const targetDir = path.join(resolveTenantSkillsDir(tenantId), "feishu-skills");
  if (!fs.existsSync(targetDir)) {
    return false;
  }
  return SKILLS.some((s) => fs.existsSync(path.join(targetDir, s)));
}

/**
 * Ensure all tenants have skill packs installed.
 * Called on gateway startup — only installs for tenants missing skill packs.
 */
export async function ensureSkillPacksForAllTenants(
  tenantIds: string[],
  log?: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<void> {
  const autoInstall = process.env.SKILL_PACK_AUTO_INSTALL?.trim().toLowerCase();
  if (autoInstall === "false" || autoInstall === "0") {
    return;
  }

  for (const tenantId of tenantIds) {
    if (hasSkillPack(tenantId)) {
      continue;
    }
    log?.info(`skill-pack: tenant ${tenantId} missing skill pack, installing...`);
    const result = await installSkillPack(tenantId);
    if (result.ok && result.installed.length > 0) {
      log?.info(`skill-pack: installed ${result.installed.length} skills for tenant ${tenantId}`);
    } else if (!result.ok) {
      log?.warn(
        `skill-pack: failed for tenant ${tenantId}: ${result.errors.map((e) => e.error).join(", ")}`,
      );
    }
  }
}

export async function installSkillPack(tenantId: string): Promise<SkillPackResult> {
  // Check toggle
  const autoInstall = process.env.SKILL_PACK_AUTO_INSTALL?.trim().toLowerCase();
  if (autoInstall === "false" || autoInstall === "0") {
    return {
      ok: true,
      installed: [],
      errors: [],
      source: "disabled",
      skipped: "auto-install disabled",
    };
  }

  const targetDir = path.join(resolveTenantSkillsDir(tenantId), "feishu-skills");
  const source = resolveSkillPackSource();

  let sourceDir: string;
  let tmpDir: string | null = null;

  switch (source.kind) {
    case "local":
      sourceDir = source.dir;
      break;
    case "git": {
      const cloned = await cloneToTemp(source.url);
      if (!cloned) {
        return {
          ok: false,
          installed: [],
          errors: [],
          source: "git",
          skipped: "git clone failed or git not available",
        };
      }
      sourceDir = cloned;
      tmpDir = cloned;
      break;
    }
    case "none":
      return { ok: true, installed: [], errors: [], source: "none", skipped: source.reason };
  }

  const installed: string[] = [];
  const errors: Array<{ skill: string; error: string }> = [];

  for (const skill of SKILLS) {
    const src = path.join(sourceDir, skill);
    if (!fs.existsSync(src)) {
      continue;
    }
    try {
      const dst = path.join(targetDir, skill);
      copyDirRecursive(src, dst);
      installed.push(skill);
    } catch (err) {
      errors.push({ skill, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Cleanup temp directory
  if (tmpDir) {
    cleanupDir(tmpDir);
  }

  return {
    ok: errors.length === 0,
    installed,
    errors,
    source: source.kind,
  };
}
