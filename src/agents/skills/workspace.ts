import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  formatSkillsForPrompt,
  loadSkillsFromDir,
  stripFrontmatter,
  type Skill,
} from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../../config/config.js";
import { isOptEnabled } from "../../config/token-optimization.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { CONFIG_DIR, resolveUserPath } from "../../utils.js";
import { resolveSandboxPath } from "../sandbox-paths.js";
import { getTenantBootstrapContext } from "../workspace.js";
import { resolveBundledSkillsDir } from "./bundled-dir.js";
import { isBundledSkill, shouldIncludeSkill } from "./config.js";
import { normalizeSkillFilter } from "./filter.js";
import {
  parseFrontmatter,
  resolveOpenClawMetadata,
  resolveSkillInline,
  resolveSkillInvocationPolicy,
  resolveSkillOverrides,
} from "./frontmatter.js";
import { resolvePluginSkillDirs } from "./plugin-skills.js";
import { serializeByKey } from "./serialize.js";
import type {
  ParsedSkillFrontmatter,
  SkillEligibilityContext,
  SkillCommandSpec,
  SkillEntry,
  SkillSnapshot,
} from "./types.js";

const fsp = fs.promises;
const skillsLogger = createSubsystemLogger("skills");
const skillCommandDebugOnce = new Set<string>();

/**
 * Replace the user's home directory prefix with `~` in skill file paths
 * to reduce system prompt token usage. Models understand `~` expansion,
 * and the read tool resolves `~` to the home directory.
 *
 * Example: `/Users/alice/.bun/.../skills/github/SKILL.md`
 *       → `~/.bun/.../skills/github/SKILL.md`
 *
 * Saves ~5–6 tokens per skill path × N skills ≈ 400–600 tokens total.
 */
function compactSkillPaths(skills: Skill[]): Skill[] {
  const home = os.homedir();
  if (!home) return skills;
  const prefix = home.endsWith(path.sep) ? home : home + path.sep;
  return skills.map((s) => ({
    ...s,
    filePath: s.filePath.startsWith(prefix) ? "~/" + s.filePath.slice(prefix.length) : s.filePath,
  }));
}

function debugSkillCommandOnce(
  messageKey: string,
  message: string,
  meta?: Record<string, unknown>,
) {
  if (skillCommandDebugOnce.has(messageKey)) {
    return;
  }
  skillCommandDebugOnce.add(messageKey);
  skillsLogger.debug(message, meta);
}

function filterSkillEntries(
  entries: SkillEntry[],
  config?: OpenClawConfig,
  skillFilter?: string[],
  eligibility?: SkillEligibilityContext,
  disabledBundledSkills?: string[],
): SkillEntry[] {
  let filtered = entries.filter((entry) => shouldIncludeSkill({ entry, config, eligibility }));

  // Apply bundled skill denylist (agent-level, only affects bundled skills)
  if (disabledBundledSkills && disabledBundledSkills.length > 0) {
    const disabledSet = new Set(disabledBundledSkills);
    const before = filtered.length;
    filtered = filtered.filter(
      (entry) => !isBundledSkill(entry) || !disabledSet.has(entry.skill.name),
    );
    skillsLogger.info(
      `[skills-chain] disabledBundledSkills: removed ${before - filtered.length} bundled skills`,
    );
  }

  // If skillFilter is provided, only include skills in the filter list.
  skillsLogger.info(
    `[skills-chain] filterSkillEntries: total=${entries.length}, eligible=${filtered.length}, skillFilter=${skillFilter !== undefined ? JSON.stringify(skillFilter) : "undefined"}`,
  );
  if (skillFilter !== undefined) {
    const normalized = normalizeSkillFilter(skillFilter) ?? [];
    const label = normalized.length > 0 ? normalized.join(", ") : "(none)";
    skillsLogger.info(`[skills-chain] Applying skill filter: ${label}`);
    filtered =
      normalized.length > 0
        ? filtered.filter((entry) => normalized.includes(entry.skill.name))
        : [];
    skillsLogger.info(
      `[skills-chain] After skill filter: ${filtered.length} skills — ${filtered.map((entry) => entry.skill.name).join(", ") || "(none)"}`,
    );
  }
  return filtered;
}

const SKILL_COMMAND_MAX_LENGTH = 32;
const SKILL_COMMAND_FALLBACK = "skill";
// Discord command descriptions must be ≤100 characters
const SKILL_COMMAND_DESCRIPTION_MAX_LENGTH = 100;

const DEFAULT_MAX_CANDIDATES_PER_ROOT = 300;
const DEFAULT_MAX_SKILLS_LOADED_PER_SOURCE = 200;
const DEFAULT_MAX_SKILLS_IN_PROMPT = 150;
const DEFAULT_MAX_SKILLS_PROMPT_CHARS = 30_000;
const DEFAULT_MAX_SKILL_FILE_BYTES = 256_000;

function sanitizeSkillCommandName(raw: string): string {
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const trimmed = normalized.slice(0, SKILL_COMMAND_MAX_LENGTH);
  return trimmed || SKILL_COMMAND_FALLBACK;
}

function resolveUniqueSkillCommandName(base: string, used: Set<string>): string {
  const normalizedBase = base.toLowerCase();
  if (!used.has(normalizedBase)) {
    return base;
  }
  for (let index = 2; index < 1000; index += 1) {
    const suffix = `_${index}`;
    const maxBaseLength = Math.max(1, SKILL_COMMAND_MAX_LENGTH - suffix.length);
    const trimmedBase = base.slice(0, maxBaseLength);
    const candidate = `${trimmedBase}${suffix}`;
    const candidateKey = candidate.toLowerCase();
    if (!used.has(candidateKey)) {
      return candidate;
    }
  }
  const fallback = `${base.slice(0, Math.max(1, SKILL_COMMAND_MAX_LENGTH - 2))}_x`;
  return fallback;
}

type ResolvedSkillsLimits = {
  maxCandidatesPerRoot: number;
  maxSkillsLoadedPerSource: number;
  maxSkillsInPrompt: number;
  maxSkillsPromptChars: number;
  maxSkillFileBytes: number;
};

function resolveSkillsLimits(config?: OpenClawConfig): ResolvedSkillsLimits {
  const limits = config?.skills?.limits;
  return {
    maxCandidatesPerRoot: limits?.maxCandidatesPerRoot ?? DEFAULT_MAX_CANDIDATES_PER_ROOT,
    maxSkillsLoadedPerSource:
      limits?.maxSkillsLoadedPerSource ?? DEFAULT_MAX_SKILLS_LOADED_PER_SOURCE,
    maxSkillsInPrompt: limits?.maxSkillsInPrompt ?? DEFAULT_MAX_SKILLS_IN_PROMPT,
    maxSkillsPromptChars: limits?.maxSkillsPromptChars ?? DEFAULT_MAX_SKILLS_PROMPT_CHARS,
    maxSkillFileBytes: limits?.maxSkillFileBytes ?? DEFAULT_MAX_SKILL_FILE_BYTES,
  };
}

function listChildDirectories(dir: string): string[] {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const dirs: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.name === "node_modules") continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        dirs.push(entry.name);
        continue;
      }
      if (entry.isSymbolicLink()) {
        try {
          if (fs.statSync(fullPath).isDirectory()) {
            dirs.push(entry.name);
          }
        } catch {
          // ignore broken symlinks
        }
      }
    }
    return dirs;
  } catch {
    return [];
  }
}

function resolveNestedSkillsRoot(
  dir: string,
  opts?: {
    maxEntriesToScan?: number;
  },
): { baseDir: string; note?: string } {
  const nested = path.join(dir, "skills");
  try {
    if (!fs.existsSync(nested) || !fs.statSync(nested).isDirectory()) {
      return { baseDir: dir };
    }
  } catch {
    return { baseDir: dir };
  }

  // Heuristic: if `dir/skills/*/SKILL.md` exists for any entry, treat `dir/skills` as the real root.
  // Note: don't stop at 25, but keep a cap to avoid pathological scans.
  const nestedDirs = listChildDirectories(nested);
  const scanLimit = Math.max(0, opts?.maxEntriesToScan ?? 100);
  const toScan = scanLimit === 0 ? [] : nestedDirs.slice(0, Math.min(nestedDirs.length, scanLimit));

  for (const name of toScan) {
    const skillMd = path.join(nested, name, "SKILL.md");
    if (fs.existsSync(skillMd)) {
      return { baseDir: nested, note: `Detected nested skills root at ${nested}` };
    }
  }
  return { baseDir: dir };
}

function unwrapLoadedSkills(loaded: unknown): Skill[] {
  if (Array.isArray(loaded)) {
    return loaded as Skill[];
  }
  if (loaded && typeof loaded === "object" && "skills" in loaded) {
    const skills = (loaded as { skills?: unknown }).skills;
    if (Array.isArray(skills)) {
      return skills as Skill[];
    }
  }
  return [];
}

function loadSkillEntries(
  workspaceDir: string,
  opts?: {
    config?: OpenClawConfig;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
    tenantSkillsDir?: string;
  },
): SkillEntry[] {
  const limits = resolveSkillsLimits(opts?.config);

  const loadSkills = (params: { dir: string; source: string }): Skill[] => {
    const resolved = resolveNestedSkillsRoot(params.dir, {
      maxEntriesToScan: limits.maxCandidatesPerRoot,
    });
    const baseDir = resolved.baseDir;

    // If the root itself is a skill directory, just load it directly (but enforce size cap).
    const rootSkillMd = path.join(baseDir, "SKILL.md");
    if (fs.existsSync(rootSkillMd)) {
      try {
        const size = fs.statSync(rootSkillMd).size;
        if (size > limits.maxSkillFileBytes) {
          skillsLogger.warn("Skipping skills root due to oversized SKILL.md.", {
            dir: baseDir,
            filePath: rootSkillMd,
            size,
            maxSkillFileBytes: limits.maxSkillFileBytes,
          });
          return [];
        }
      } catch {
        return [];
      }

      const loaded = loadSkillsFromDir({ dir: baseDir, source: params.source });
      return unwrapLoadedSkills(loaded);
    }

    const childDirs = listChildDirectories(baseDir);
    const suspicious = childDirs.length > limits.maxCandidatesPerRoot;

    const maxCandidates = Math.max(0, limits.maxSkillsLoadedPerSource);
    const limitedChildren = childDirs.slice().sort().slice(0, maxCandidates);

    if (suspicious) {
      skillsLogger.warn("Skills root looks suspiciously large, truncating discovery.", {
        dir: params.dir,
        baseDir,
        childDirCount: childDirs.length,
        maxCandidatesPerRoot: limits.maxCandidatesPerRoot,
        maxSkillsLoadedPerSource: limits.maxSkillsLoadedPerSource,
      });
    } else if (childDirs.length > maxCandidates) {
      skillsLogger.warn("Skills root has many entries, truncating discovery.", {
        dir: params.dir,
        baseDir,
        childDirCount: childDirs.length,
        maxSkillsLoadedPerSource: limits.maxSkillsLoadedPerSource,
      });
    }

    const loadedSkills: Skill[] = [];

    const tryLoadSkillDir = (skillDir: string, skillName: string): boolean => {
      const skillMd = path.join(skillDir, "SKILL.md");
      if (!fs.existsSync(skillMd)) {
        return false;
      }
      try {
        const size = fs.statSync(skillMd).size;
        if (size > limits.maxSkillFileBytes) {
          skillsLogger.warn("Skipping skill due to oversized SKILL.md.", {
            skill: skillName,
            filePath: skillMd,
            size,
            maxSkillFileBytes: limits.maxSkillFileBytes,
          });
          return true; // exists but skipped
        }
      } catch {
        return true;
      }

      const loaded = loadSkillsFromDir({ dir: skillDir, source: params.source });
      loadedSkills.push(...unwrapLoadedSkills(loaded));
      return true;
    };

    // Consider immediate subfolders that are either skills (have SKILL.md)
    // or category directories (no SKILL.md) whose children contain skills.
    // This enables two-level layouts like: skills/feishu/create-doc/SKILL.md
    for (const name of limitedChildren) {
      if (loadedSkills.length >= limits.maxSkillsLoadedPerSource) {
        break;
      }

      const skillDir = path.join(baseDir, name);
      if (tryLoadSkillDir(skillDir, name)) {
        // Direct skill directory — already loaded
        continue;
      }

      // No SKILL.md here — treat as category directory and scan its children
      const subDirs = listChildDirectories(skillDir);
      for (const subName of subDirs) {
        if (loadedSkills.length >= limits.maxSkillsLoadedPerSource) {
          break;
        }
        tryLoadSkillDir(path.join(skillDir, subName), `${name}/${subName}`);
      }
    }

    if (loadedSkills.length > limits.maxSkillsLoadedPerSource) {
      return loadedSkills
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, limits.maxSkillsLoadedPerSource);
    }

    return loadedSkills;
  };

  const hasTenantSkillsDir = !!opts?.tenantSkillsDir;
  const managedSkillsDir = opts?.managedSkillsDir ?? path.join(CONFIG_DIR, "skills");
  const bundledSkillsDir = opts?.bundledSkillsDir ?? resolveBundledSkillsDir();
  const extraDirsRaw = opts?.config?.skills?.load?.extraDirs ?? [];
  const extraDirs = extraDirsRaw
    .map((d) => (typeof d === "string" ? d.trim() : ""))
    .filter(Boolean);
  const pluginSkillDirs = resolvePluginSkillDirs({
    workspaceDir,
    config: opts?.config,
  });
  const mergedExtraDirs = [...extraDirs, ...pluginSkillDirs];

  // In multi-tenant mode, tenants see bundled (system default) skills
  // plus their own tenant skills. Other global sources (managed/extra/
  // workspace/personal) are not visible — each tenant manages its own set.
  const bundledSkills = bundledSkillsDir
    ? loadSkills({
        dir: bundledSkillsDir,
        source: "enclaws-bundled",
      })
    : [];
  const extraSkills = hasTenantSkillsDir
    ? []
    : mergedExtraDirs.flatMap((dir) => {
        const resolved = resolveUserPath(dir);
        return loadSkills({
          dir: resolved,
          source: "enclaws-extra",
        });
      });
  const managedSkills = hasTenantSkillsDir
    ? []
    : loadSkills({
        dir: managedSkillsDir,
        source: "enclaws-managed",
      });

  // Multi-tenant mode: skills live in tenantDir/skills/, NOT workspace/skills/
  // Single-tenant mode: skills live in workspace/skills/ and .agents/skills/
  const tenantSkills = opts?.tenantSkillsDir
    ? loadSkills({
        dir: opts.tenantSkillsDir,
        source: "enclaws-tenant",
      })
    : [];
  const personalAgentsSkillsDir = path.resolve(os.homedir(), ".agents", "skills");
  const personalAgentsSkills = hasTenantSkillsDir
    ? []
    : loadSkills({
        dir: personalAgentsSkillsDir,
        source: "agents-skills-personal",
      });
  const projectAgentsSkillsDir = path.resolve(workspaceDir, ".agents", "skills");
  const projectAgentsSkills = hasTenantSkillsDir
    ? []
    : loadSkills({
        dir: projectAgentsSkillsDir,
        source: "agents-skills-project",
      });
  const workspaceSkillsDir = path.resolve(workspaceDir, "skills");
  const workspaceSkills = hasTenantSkillsDir
    ? []
    : loadSkills({
        dir: workspaceSkillsDir,
        source: "enclaws-workspace",
      });

  const merged = new Map<string, Skill>();
  // Precedence: extra < bundled < managed < tenant < agents-skills-personal < agents-skills-project < workspace
  for (const skill of extraSkills) {
    merged.set(skill.name, skill);
  }
  for (const skill of bundledSkills) {
    merged.set(skill.name, skill);
  }
  for (const skill of managedSkills) {
    merged.set(skill.name, skill);
  }
  for (const skill of tenantSkills) {
    merged.set(skill.name, skill);
  }
  for (const skill of personalAgentsSkills) {
    merged.set(skill.name, skill);
  }
  for (const skill of projectAgentsSkills) {
    merged.set(skill.name, skill);
  }
  for (const skill of workspaceSkills) {
    merged.set(skill.name, skill);
  }

  const skillEntries: SkillEntry[] = Array.from(merged.values()).map((skill) => {
    let frontmatter: ParsedSkillFrontmatter = {};
    let rawContent = "";
    try {
      rawContent = fs.readFileSync(skill.filePath, "utf-8");
      frontmatter = parseFrontmatter(rawContent);
    } catch {
      // ignore malformed skills
    }
    const overrides = resolveSkillOverrides(frontmatter);
    const inline = resolveSkillInline(frontmatter);
    const entry: SkillEntry = {
      skill,
      frontmatter,
      metadata: resolveOpenClawMetadata(frontmatter),
      invocation: resolveSkillInvocationPolicy(frontmatter),
      ...(overrides.length > 0 ? { overrides } : {}),
    };
    if (inline && rawContent && !isOptEnabled("PROMPT")) {
      entry.inline = true;
      entry.inlineContent = stripFrontmatter(rawContent).trim();
    }
    return entry;
  });
  return skillEntries;
}

function applySkillsPromptLimits(params: { skills: Skill[]; config?: OpenClawConfig }): {
  skillsForPrompt: Skill[];
  truncated: boolean;
  truncatedReason: "count" | "chars" | null;
} {
  const limits = resolveSkillsLimits(params.config);
  const total = params.skills.length;
  const byCount = params.skills.slice(0, Math.max(0, limits.maxSkillsInPrompt));

  let skillsForPrompt = byCount;
  let truncated = total > byCount.length;
  let truncatedReason: "count" | "chars" | null = truncated ? "count" : null;

  const fits = (skills: Skill[]): boolean => {
    const block = formatSkillsForPrompt(skills);
    return block.length <= limits.maxSkillsPromptChars;
  };

  if (!fits(skillsForPrompt)) {
    // Binary search the largest prefix that fits in the char budget.
    let lo = 0;
    let hi = skillsForPrompt.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(skillsForPrompt.slice(0, mid))) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    skillsForPrompt = skillsForPrompt.slice(0, lo);
    truncated = true;
    truncatedReason = "chars";
  }

  return { skillsForPrompt, truncated, truncatedReason };
}

function promptPriorityForSkillSource(source: string | undefined): number {
  switch (source) {
    case "enclaws-tenant":
      return 0;
    case "enclaws-workspace":
    case "agents-skills-project":
      return 1;
    case "agents-skills-personal":
    case "enclaws-managed":
      return 2;
    case "enclaws-extra":
      return 3;
    case "enclaws-bundled":
      return 4;
    default:
      return 5;
  }
}

function sortSkillEntriesForPrompt(entries: SkillEntry[]): SkillEntry[] {
  return entries.slice().sort((a, b) => {
    const priority =
      promptPriorityForSkillSource(a.skill.source) - promptPriorityForSkillSource(b.skill.source);
    if (priority !== 0) {
      return priority;
    }
    return a.skill.name.localeCompare(b.skill.name);
  });
}

export function buildWorkspaceSkillSnapshot(
  workspaceDir: string,
  opts?: WorkspaceSkillBuildOptions & { snapshotVersion?: number },
): SkillSnapshot {
  const { allEntries, eligible, prompt, resolvedSkills } = resolveWorkspaceSkillPromptState(
    workspaceDir,
    opts,
  );
  const skillFilter = normalizeSkillFilter(opts?.skillFilter);
  // Collect overrides from eligible skills (standard behavior) PLUS overrides
  // from skills excluded by skillFilter. When a skill is filtered out, its
  // associated plugin tools should also be disabled — not resurrected.
  const overrideSources =
    skillFilter !== undefined
      ? allEntries.filter((e) => e.overrides && e.overrides.length > 0)
      : eligible.filter((e) => e.overrides && e.overrides.length > 0);
  const skillOverrides = overrideSources.flatMap((e) => e.overrides!);
  return {
    prompt,
    skills: eligible.map((entry) => ({
      name: entry.skill.name,
      primaryEnv: entry.metadata?.primaryEnv,
      requiredEnv: entry.metadata?.requires?.env?.slice(),
    })),
    ...(skillFilter === undefined ? {} : { skillFilter }),
    resolvedSkills,
    ...(skillOverrides.length > 0 ? { skillOverrides } : {}),
    version: opts?.snapshotVersion,
  };
}

export function buildWorkspaceSkillsPrompt(
  workspaceDir: string,
  opts?: WorkspaceSkillBuildOptions,
): string {
  return resolveWorkspaceSkillPromptState(workspaceDir, opts).prompt;
}

type WorkspaceSkillBuildOptions = {
  config?: OpenClawConfig;
  managedSkillsDir?: string;
  bundledSkillsDir?: string;
  entries?: SkillEntry[];
  /** If provided, only include skills with these names */
  skillFilter?: string[];
  eligibility?: SkillEligibilityContext;
  /** If provided, exclude bundled skills with these names (denylist, agent-level) */
  disabledBundledSkills?: string[];
};

function resolveWorkspaceSkillPromptState(
  workspaceDir: string,
  opts?: WorkspaceSkillBuildOptions,
): {
  allEntries: SkillEntry[];
  eligible: SkillEntry[];
  prompt: string;
  resolvedSkills: Skill[];
} {
  const skillEntries = opts?.entries ?? loadWorkspaceSkillEntries(workspaceDir, opts);
  const eligible = filterSkillEntries(
    skillEntries,
    opts?.config,
    opts?.skillFilter,
    opts?.eligibility,
    opts?.disabledBundledSkills,
  );
  const promptEntries = eligible.filter(
    (entry) => entry.invocation?.disableModelInvocation !== true,
  );
  const promptEntriesForPrompt = sortSkillEntriesForPrompt(promptEntries);
  const remoteNote = opts?.eligibility?.remote?.note?.trim();
  const resolvedSkills = promptEntriesForPrompt.map((entry) => entry.skill);
  const { skillsForPrompt, truncated } = applySkillsPromptLimits({
    skills: resolvedSkills,
    config: opts?.config,
  });
  const truncationNote = truncated
    ? `⚠️ Skills truncated: included ${skillsForPrompt.length} of ${resolvedSkills.length}. Run \`enclaws skills check\` to audit.`
    : "";
  // Build inline skill content blocks for skills with inline: true
  const inlineBlocks: string[] = [];
  for (const entry of promptEntriesForPrompt) {
    if (entry.inline && entry.inlineContent) {
      inlineBlocks.push(
        `\n<inline_skill name="${entry.skill.name}">\n${entry.inlineContent}\n</inline_skill>`,
      );
    }
  }
  // When skillFilter is active, compute skills excluded by the filter and
  // inject a <disabled_skills> block so the model knows not to invoke them
  // via exec even if conversation history contains prior usage.
  let disabledBlock = "";
  if (opts?.skillFilter !== undefined) {
    const eligibleNames = new Set(eligible.map((e) => e.skill.name));
    const configEligible = skillEntries.filter((entry) =>
      shouldIncludeSkill({ entry, config: opts?.config, eligibility: opts?.eligibility }),
    );
    const excludedNames = configEligible
      .filter((e) => !eligibleNames.has(e.skill.name))
      .map((e) => e.skill.name);
    if (excludedNames.length > 0) {
      disabledBlock = [
        "<disabled_skills>",
        excludedNames.join(", "),
        "</disabled_skills>",
        "You MUST NOT invoke disabled skills via exec or any other tool, even if conversation history shows prior usage.",
      ].join("\n");
    }
  }
  const skillsListBlock = formatSkillsForPrompt(compactSkillPaths(skillsForPrompt));
  const prompt = [remoteNote, truncationNote, skillsListBlock, ...inlineBlocks, disabledBlock]
    .filter(Boolean)
    .join("\n");
  return { allEntries: skillEntries, eligible, prompt, resolvedSkills };
}

export function resolveSkillsPromptForRun(params: {
  skillsSnapshot?: SkillSnapshot;
  entries?: SkillEntry[];
  config?: OpenClawConfig;
  workspaceDir: string;
}): string {
  const snapshotPrompt = params.skillsSnapshot?.prompt?.trim();
  if (snapshotPrompt) {
    return snapshotPrompt;
  }
  if (params.entries && params.entries.length > 0) {
    const prompt = buildWorkspaceSkillsPrompt(params.workspaceDir, {
      entries: params.entries,
      config: params.config,
    });
    return prompt.trim() ? prompt : "";
  }
  return "";
}

export function loadWorkspaceSkillEntries(
  workspaceDir: string,
  opts?: {
    config?: OpenClawConfig;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
    tenantSkillsDir?: string;
  },
): SkillEntry[] {
  // Auto-resolve tenant skills dir from registry if not explicitly provided
  let effectiveOpts = opts;
  if (!opts?.tenantSkillsDir) {
    const tenantCtx = getTenantBootstrapContext(workspaceDir);
    if (tenantCtx) {
      effectiveOpts = {
        ...opts,
        tenantSkillsDir: path.join(tenantCtx.tenantDir, "skills"),
      };
    }
  }
  return loadSkillEntries(workspaceDir, effectiveOpts);
}

function resolveUniqueSyncedSkillDirName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  let fallbackIndex = 10_000;
  let fallback = `${base}-${fallbackIndex}`;
  while (used.has(fallback)) {
    fallbackIndex += 1;
    fallback = `${base}-${fallbackIndex}`;
  }
  used.add(fallback);
  return fallback;
}

function resolveSyncedSkillDestinationPath(params: {
  targetSkillsDir: string;
  entry: SkillEntry;
  usedDirNames: Set<string>;
}): string | null {
  const sourceDirName = path.basename(params.entry.skill.baseDir).trim();
  if (!sourceDirName || sourceDirName === "." || sourceDirName === "..") {
    return null;
  }
  const uniqueDirName = resolveUniqueSyncedSkillDirName(sourceDirName, params.usedDirNames);
  return resolveSandboxPath({
    filePath: uniqueDirName,
    cwd: params.targetSkillsDir,
    root: params.targetSkillsDir,
  }).resolved;
}

export async function syncSkillsToWorkspace(params: {
  sourceWorkspaceDir: string;
  targetWorkspaceDir: string;
  config?: OpenClawConfig;
  managedSkillsDir?: string;
  bundledSkillsDir?: string;
}) {
  const sourceDir = resolveUserPath(params.sourceWorkspaceDir);
  const targetDir = resolveUserPath(params.targetWorkspaceDir);
  if (sourceDir === targetDir) {
    return;
  }

  await serializeByKey(`syncSkills:${targetDir}`, async () => {
    const targetSkillsDir = path.join(targetDir, "skills");

    const entries = loadSkillEntries(sourceDir, {
      config: params.config,
      managedSkillsDir: params.managedSkillsDir,
      bundledSkillsDir: params.bundledSkillsDir,
    });

    await fsp.rm(targetSkillsDir, { recursive: true, force: true });
    await fsp.mkdir(targetSkillsDir, { recursive: true });

    const usedDirNames = new Set<string>();
    for (const entry of entries) {
      let dest: string | null = null;
      try {
        dest = resolveSyncedSkillDestinationPath({
          targetSkillsDir,
          entry,
          usedDirNames,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : JSON.stringify(error);
        skillsLogger.warn(`Failed to resolve safe destination for ${entry.skill.name}: ${message}`);
        continue;
      }
      if (!dest) {
        skillsLogger.warn(
          `Failed to resolve safe destination for ${entry.skill.name}: invalid source directory name`,
        );
        continue;
      }
      try {
        await fsp.cp(entry.skill.baseDir, dest, {
          recursive: true,
          force: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : JSON.stringify(error);
        skillsLogger.warn(`Failed to copy ${entry.skill.name} to sandbox: ${message}`);
      }
    }
  });
}

export function filterWorkspaceSkillEntries(
  entries: SkillEntry[],
  config?: OpenClawConfig,
): SkillEntry[] {
  return filterSkillEntries(entries, config);
}

export function buildWorkspaceSkillCommandSpecs(
  workspaceDir: string,
  opts?: {
    config?: OpenClawConfig;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
    entries?: SkillEntry[];
    skillFilter?: string[];
    eligibility?: SkillEligibilityContext;
    reservedNames?: Set<string>;
    /** If provided, exclude bundled skills with these names (denylist, agent-level) */
    disabledBundledSkills?: string[];
  },
): SkillCommandSpec[] {
  const skillEntries = opts?.entries ?? loadWorkspaceSkillEntries(workspaceDir, opts);
  const eligible = filterSkillEntries(
    skillEntries,
    opts?.config,
    opts?.skillFilter,
    opts?.eligibility,
    opts?.disabledBundledSkills,
  );
  const userInvocable = eligible.filter((entry) => entry.invocation?.userInvocable !== false);
  const used = new Set<string>();
  for (const reserved of opts?.reservedNames ?? []) {
    used.add(reserved.toLowerCase());
  }

  const specs: SkillCommandSpec[] = [];
  for (const entry of userInvocable) {
    const rawName = entry.skill.name;
    const base = sanitizeSkillCommandName(rawName);
    if (base !== rawName) {
      debugSkillCommandOnce(
        `sanitize:${rawName}:${base}`,
        `Sanitized skill command name "${rawName}" to "/${base}".`,
        { rawName, sanitized: `/${base}` },
      );
    }
    const unique = resolveUniqueSkillCommandName(base, used);
    if (unique !== base) {
      debugSkillCommandOnce(
        `dedupe:${rawName}:${unique}`,
        `De-duplicated skill command name for "${rawName}" to "/${unique}".`,
        { rawName, deduped: `/${unique}` },
      );
    }
    used.add(unique.toLowerCase());
    const rawDescription = entry.skill.description?.trim() || rawName;
    const description =
      rawDescription.length > SKILL_COMMAND_DESCRIPTION_MAX_LENGTH
        ? rawDescription.slice(0, SKILL_COMMAND_DESCRIPTION_MAX_LENGTH - 1) + "…"
        : rawDescription;
    const dispatch = (() => {
      const kindRaw = (
        entry.frontmatter?.["command-dispatch"] ??
        entry.frontmatter?.["command_dispatch"] ??
        ""
      )
        .trim()
        .toLowerCase();
      if (!kindRaw) {
        return undefined;
      }
      if (kindRaw !== "tool") {
        return undefined;
      }

      const toolName = (
        entry.frontmatter?.["command-tool"] ??
        entry.frontmatter?.["command_tool"] ??
        ""
      ).trim();
      if (!toolName) {
        debugSkillCommandOnce(
          `dispatch:missingTool:${rawName}`,
          `Skill command "/${unique}" requested tool dispatch but did not provide command-tool. Ignoring dispatch.`,
          { skillName: rawName, command: unique },
        );
        return undefined;
      }

      const argModeRaw = (
        entry.frontmatter?.["command-arg-mode"] ??
        entry.frontmatter?.["command_arg_mode"] ??
        ""
      )
        .trim()
        .toLowerCase();
      const argMode = !argModeRaw || argModeRaw === "raw" ? "raw" : null;
      if (!argMode) {
        debugSkillCommandOnce(
          `dispatch:badArgMode:${rawName}:${argModeRaw}`,
          `Skill command "/${unique}" requested tool dispatch but has unknown command-arg-mode. Falling back to raw.`,
          { skillName: rawName, command: unique, argMode: argModeRaw },
        );
      }

      return { kind: "tool", toolName, argMode: "raw" } as const;
    })();

    specs.push({
      name: unique,
      skillName: rawName,
      description,
      ...(dispatch ? { dispatch } : {}),
    });
  }
  return specs;
}
