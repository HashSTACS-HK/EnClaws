import fs from "node:fs/promises";
import path from "node:path";
import { type CommandOptions, runCommandWithTimeout } from "../process/exec.js";
import {
  resolveControlUiDistIndexHealth,
  resolveControlUiDistIndexPathForRoot,
} from "./control-ui-assets.js";
import { detectPackageManager as detectPackageManagerImpl } from "./detect-package-manager.js";
import { readPackageName, readPackageVersion } from "./package-json.js";
import { trimLogTail } from "./restart-sentinel.js";
import { trackToNpmTag, DEFAULT_PACKAGE_TRACK, type UpdateTrack } from "./update-channels.js";
import { compareSemverStrings } from "./update-check.js";
import {
  cleanupGlobalRenameDirs,
  detectGlobalInstallManagerForRoot,
  globalInstallArgs,
  globalInstallFallbackArgs,
} from "./update-global.js";

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export type UpdateStepResult = {
  name: string;
  command: string;
  cwd: string;
  durationMs: number;
  exitCode: number | null;
  stdoutTail?: string | null;
  stderrTail?: string | null;
};

export type UpdateRunResult = {
  status: "ok" | "error" | "skipped";
  mode: "git" | "pnpm" | "bun" | "npm" | "unknown";
  root?: string;
  reason?: string;
  before?: { sha?: string | null; version?: string | null };
  after?: { sha?: string | null; version?: string | null };
  steps: UpdateStepResult[];
  durationMs: number;
};

type CommandRunner = (
  argv: string[],
  options: CommandOptions,
) => Promise<{ stdout: string; stderr: string; code: number | null }>;

export type UpdateStepInfo = {
  name: string;
  command: string;
  index: number;
  total: number;
};

export type UpdateStepCompletion = UpdateStepInfo & {
  durationMs: number;
  exitCode: number | null;
  stderrTail?: string | null;
};

export type UpdateStepProgress = {
  onStepStart?: (step: UpdateStepInfo) => void;
  onStepComplete?: (step: UpdateStepCompletion) => void;
};

type UpdateRunnerOptions = {
  cwd?: string;
  argv1?: string;
  tag?: string;
  track?: UpdateTrack;
  timeoutMs?: number;
  runCommand?: CommandRunner;
  progress?: UpdateStepProgress;
};

const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const MAX_LOG_CHARS = 8000;
const START_DIRS = ["cwd", "argv1", "process"];
const DEFAULT_PACKAGE_NAME = "enclaws";
const CORE_PACKAGE_NAMES = new Set([DEFAULT_PACKAGE_NAME]);

function normalizeDir(value?: string | null) {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return path.resolve(trimmed);
}

function resolveNodeModulesBinPackageRoot(argv1: string): string | null {
  const normalized = path.resolve(argv1);
  const parts = normalized.split(path.sep);
  const binIndex = parts.lastIndexOf(".bin");
  if (binIndex <= 0) {
    return null;
  }
  if (parts[binIndex - 1] !== "node_modules") {
    return null;
  }
  const binName = path.basename(normalized);
  const nodeModulesDir = parts.slice(0, binIndex).join(path.sep);
  return path.join(nodeModulesDir, binName);
}

function buildStartDirs(opts: UpdateRunnerOptions): string[] {
  const dirs: string[] = [];
  const cwd = normalizeDir(opts.cwd);
  if (cwd) {
    dirs.push(cwd);
  }
  const argv1 = normalizeDir(opts.argv1);
  if (argv1) {
    dirs.push(path.dirname(argv1));
    const packageRoot = resolveNodeModulesBinPackageRoot(argv1);
    if (packageRoot) {
      dirs.push(packageRoot);
    }
  }
  const proc = normalizeDir(process.cwd());
  if (proc) {
    dirs.push(proc);
  }
  return Array.from(new Set(dirs));
}

async function resolveGitRoot(
  runCommand: CommandRunner,
  candidates: string[],
  timeoutMs: number,
): Promise<string | null> {
  for (const dir of candidates) {
    const res = await runCommand(["git", "-C", dir, "rev-parse", "--show-toplevel"], {
      timeoutMs,
    });
    if (res.code === 0) {
      const root = res.stdout.trim();
      if (root) {
        return root;
      }
    }
  }
  return null;
}

async function findPackageRoot(candidates: string[]) {
  for (const dir of candidates) {
    let current = dir;
    for (let i = 0; i < 12; i += 1) {
      const pkgPath = path.join(current, "package.json");
      try {
        const raw = await fs.readFile(pkgPath, "utf-8");
        const parsed = JSON.parse(raw) as { name?: string };
        const name = parsed?.name?.trim();
        if (name && CORE_PACKAGE_NAMES.has(name)) {
          return current;
        }
      } catch {
        // ignore
      }
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }
  return null;
}

async function detectPackageManager(root: string) {
  return (await detectPackageManagerImpl(root)) ?? "npm";
}

type RunStepOptions = {
  runCommand: CommandRunner;
  name: string;
  argv: string[];
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  progress?: UpdateStepProgress;
  stepIndex: number;
  totalSteps: number;
};

async function runStep(opts: RunStepOptions): Promise<UpdateStepResult> {
  const { runCommand, name, argv, cwd, timeoutMs, env, progress, stepIndex, totalSteps } = opts;
  const command = argv.join(" ");

  const stepInfo: UpdateStepInfo = {
    name,
    command,
    index: stepIndex,
    total: totalSteps,
  };

  progress?.onStepStart?.(stepInfo);

  const started = Date.now();
  const result = await runCommand(argv, { cwd, timeoutMs, env });
  const durationMs = Date.now() - started;

  const stderrTail = trimLogTail(result.stderr, MAX_LOG_CHARS);

  progress?.onStepComplete?.({
    ...stepInfo,
    durationMs,
    exitCode: result.code,
    stderrTail,
  });

  return {
    name,
    command,
    cwd,
    durationMs,
    exitCode: result.code,
    stdoutTail: trimLogTail(result.stdout, MAX_LOG_CHARS),
    stderrTail: trimLogTail(result.stderr, MAX_LOG_CHARS),
  };
}

function managerScriptArgs(manager: "pnpm" | "bun" | "npm", script: string, args: string[] = []) {
  if (manager === "pnpm") {
    return ["pnpm", script, ...args];
  }
  if (manager === "bun") {
    return ["bun", "run", script, ...args];
  }
  if (args.length > 0) {
    return ["npm", "run", script, "--", ...args];
  }
  return ["npm", "run", script];
}

function managerInstallArgs(manager: "pnpm" | "bun" | "npm") {
  if (manager === "pnpm") {
    return ["pnpm", "install"];
  }
  if (manager === "bun") {
    return ["bun", "install"];
  }
  return ["npm", "install"];
}

function normalizeTag(tag?: string) {
  const trimmed = tag?.trim();
  if (!trimmed) {
    return "latest";
  }
  if (trimmed.startsWith("enclaws@")) {
    return trimmed.slice("enclaws@".length);
  }
  if (trimmed.startsWith(`${DEFAULT_PACKAGE_NAME}@`)) {
    return trimmed.slice(`${DEFAULT_PACKAGE_NAME}@`.length);
  }
  return trimmed;
}

export async function runGatewayUpdate(opts: UpdateRunnerOptions = {}): Promise<UpdateRunResult> {
  const startedAt = Date.now();
  const runCommand =
    opts.runCommand ??
    (async (argv, options) => {
      const res = await runCommandWithTimeout(argv, options);
      return { stdout: res.stdout, stderr: res.stderr, code: res.code };
    });
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const progress = opts.progress;
  const steps: UpdateStepResult[] = [];
  const candidates = buildStartDirs(opts);

  let stepIndex = 0;
  let gitTotalSteps = 0;

  const step = (
    name: string,
    argv: string[],
    cwd: string,
    env?: NodeJS.ProcessEnv,
  ): RunStepOptions => {
    const currentIndex = stepIndex;
    stepIndex += 1;
    return {
      runCommand,
      name,
      argv,
      cwd,
      timeoutMs,
      env,
      progress,
      stepIndex: currentIndex,
      totalSteps: gitTotalSteps,
    };
  };

  const pkgRoot = await findPackageRoot(candidates);

  let gitRoot = await resolveGitRoot(runCommand, candidates, timeoutMs);
  if (gitRoot && pkgRoot && path.resolve(gitRoot) !== path.resolve(pkgRoot)) {
    gitRoot = null;
  }

  if (gitRoot && !pkgRoot) {
    return {
      status: "error",
      mode: "unknown",
      root: gitRoot,
      reason: "not-enclaws-root",
      steps: [],
      durationMs: Date.now() - startedAt,
    };
  }

  if (gitRoot && pkgRoot && path.resolve(gitRoot) === path.resolve(pkgRoot)) {
    // Get current SHA (not a visible step, no progress)
    const beforeShaResult = await runCommand(["git", "-C", gitRoot, "rev-parse", "HEAD"], {
      cwd: gitRoot,
      timeoutMs,
    });
    const beforeSha = beforeShaResult.stdout.trim() || null;
    const beforeVersion = await readPackageVersion(gitRoot);
    gitTotalSteps = 8; // clean check, upstream check, fetch, pull, deps, build, ui:build, doctor
    const buildGitErrorResult = (reason: string): UpdateRunResult => ({
      status: "error",
      mode: "git",
      root: gitRoot,
      reason,
      before: { sha: beforeSha, version: beforeVersion },
      steps,
      durationMs: Date.now() - startedAt,
    });

    const statusCheck = await runStep(
      step(
        "clean check",
        ["git", "-C", gitRoot, "status", "--porcelain", "--", ":!dist/control-ui/"],
        gitRoot,
      ),
    );
    steps.push(statusCheck);
    const hasUncommittedChanges =
      statusCheck.stdoutTail && statusCheck.stdoutTail.trim().length > 0;
    if (hasUncommittedChanges) {
      return {
        status: "skipped",
        mode: "git",
        root: gitRoot,
        reason: "dirty",
        before: { sha: beforeSha, version: beforeVersion },
        steps,
        durationMs: Date.now() - startedAt,
      };
    }

    // Check that current branch has an upstream configured
    const upstreamStep = await runStep(
      step(
        "upstream check",
        ["git", "-C", gitRoot, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
        gitRoot,
      ),
    );
    steps.push(upstreamStep);
    if (upstreamStep.exitCode !== 0) {
      return {
        status: "skipped",
        mode: "git",
        root: gitRoot,
        reason: "no-upstream",
        before: { sha: beforeSha, version: beforeVersion },
        steps,
        durationMs: Date.now() - startedAt,
      };
    }

    // Fetch remote and pull (stay on current branch)
    const fetchStep = await runStep(
      step("git fetch", ["git", "-C", gitRoot, "fetch", "--all", "--prune", "--tags"], gitRoot),
    );
    steps.push(fetchStep);
    if (fetchStep.exitCode !== 0) {
      return buildGitErrorResult("fetch-failed");
    }

    const pullStep = await runStep(
      step("git pull", ["git", "-C", gitRoot, "pull", "--rebase"], gitRoot),
    );
    steps.push(pullStep);
    if (pullStep.exitCode !== 0) {
      // Abort rebase if pull --rebase failed mid-way
      await runCommand(["git", "-C", gitRoot, "rebase", "--abort"], {
        cwd: gitRoot,
        timeoutMs,
      }).catch(() => null);
      return buildGitErrorResult("pull-failed");
    }

    const manager = await detectPackageManager(gitRoot);

    const depsStep = await runStep(step("deps install", managerInstallArgs(manager), gitRoot));
    steps.push(depsStep);
    if (depsStep.exitCode !== 0) {
      return {
        status: "error",
        mode: "git",
        root: gitRoot,
        reason: "deps-install-failed",
        before: { sha: beforeSha, version: beforeVersion },
        steps,
        durationMs: Date.now() - startedAt,
      };
    }

    const buildStep = await runStep(step("build", managerScriptArgs(manager, "build"), gitRoot));
    steps.push(buildStep);
    if (buildStep.exitCode !== 0) {
      return {
        status: "error",
        mode: "git",
        root: gitRoot,
        reason: "build-failed",
        before: { sha: beforeSha, version: beforeVersion },
        steps,
        durationMs: Date.now() - startedAt,
      };
    }

    const uiBuildStep = await runStep(
      step("ui:build", managerScriptArgs(manager, "ui:build"), gitRoot),
    );
    steps.push(uiBuildStep);
    if (uiBuildStep.exitCode !== 0) {
      return {
        status: "error",
        mode: "git",
        root: gitRoot,
        reason: "ui-build-failed",
        before: { sha: beforeSha, version: beforeVersion },
        steps,
        durationMs: Date.now() - startedAt,
      };
    }

    const doctorEntry = path.join(gitRoot, "enclaws.mjs");
    const doctorEntryExists = await fs
      .stat(doctorEntry)
      .then(() => true)
      .catch(() => false);
    if (!doctorEntryExists) {
      steps.push({
        name: "enclaws doctor entry",
        command: `verify ${doctorEntry}`,
        cwd: gitRoot,
        durationMs: 0,
        exitCode: 1,
        stderrTail: `missing ${doctorEntry}`,
      });
      return {
        status: "error",
        mode: "git",
        root: gitRoot,
        reason: "doctor-entry-missing",
        before: { sha: beforeSha, version: beforeVersion },
        steps,
        durationMs: Date.now() - startedAt,
      };
    }

    // Use --fix so that doctor auto-strips unknown config keys introduced by
    // schema changes between versions, preventing a startup validation crash.
    const doctorArgv = [process.execPath, doctorEntry, "doctor", "--non-interactive", "--fix"];
    const doctorStep = await runStep(
      step("enclaws doctor", doctorArgv, gitRoot, { ENCLAWS_UPDATE_IN_PROGRESS: "1" }),
    );
    steps.push(doctorStep);

    const uiIndexHealth = await resolveControlUiDistIndexHealth({ root: gitRoot });
    if (!uiIndexHealth.exists) {
      const repairArgv = managerScriptArgs(manager, "ui:build");
      const started = Date.now();
      const repairResult = await runCommand(repairArgv, { cwd: gitRoot, timeoutMs });
      const repairStep: UpdateStepResult = {
        name: "ui:build (post-doctor repair)",
        command: repairArgv.join(" "),
        cwd: gitRoot,
        durationMs: Date.now() - started,
        exitCode: repairResult.code,
        stdoutTail: trimLogTail(repairResult.stdout, MAX_LOG_CHARS),
        stderrTail: trimLogTail(repairResult.stderr, MAX_LOG_CHARS),
      };
      steps.push(repairStep);

      if (repairResult.code !== 0) {
        return {
          status: "error",
          mode: "git",
          root: gitRoot,
          reason: repairStep.name,
          before: { sha: beforeSha, version: beforeVersion },
          steps,
          durationMs: Date.now() - startedAt,
        };
      }

      const repairedUiIndexHealth = await resolveControlUiDistIndexHealth({ root: gitRoot });
      if (!repairedUiIndexHealth.exists) {
        const uiIndexPath =
          repairedUiIndexHealth.indexPath ?? resolveControlUiDistIndexPathForRoot(gitRoot);
        steps.push({
          name: "ui assets verify",
          command: `verify ${uiIndexPath}`,
          cwd: gitRoot,
          durationMs: 0,
          exitCode: 1,
          stderrTail: `missing ${uiIndexPath}`,
        });
        return {
          status: "error",
          mode: "git",
          root: gitRoot,
          reason: "ui-assets-missing",
          before: { sha: beforeSha, version: beforeVersion },
          steps,
          durationMs: Date.now() - startedAt,
        };
      }
    }

    const failedStep = steps.find((s) => s.exitCode !== 0);
    const afterShaStep = await runStep(
      step("git rev-parse HEAD (after)", ["git", "-C", gitRoot, "rev-parse", "HEAD"], gitRoot),
    );
    steps.push(afterShaStep);
    const afterVersion = await readPackageVersion(gitRoot);

    return {
      status: failedStep ? "error" : "ok",
      mode: "git",
      root: gitRoot,
      reason: failedStep ? failedStep.name : undefined,
      before: { sha: beforeSha, version: beforeVersion },
      after: {
        sha: afterShaStep.stdoutTail?.trim() ?? null,
        version: afterVersion,
      },
      steps,
      durationMs: Date.now() - startedAt,
    };
  }

  if (!pkgRoot) {
    return {
      status: "error",
      mode: "unknown",
      reason: `no root (${START_DIRS.join(",")})`,
      steps: [],
      durationMs: Date.now() - startedAt,
    };
  }

  const beforeVersion = await readPackageVersion(pkgRoot);
  const globalManager = await detectGlobalInstallManagerForRoot(runCommand, pkgRoot, timeoutMs);
  if (globalManager) {
    const packageName = (await readPackageName(pkgRoot)) ?? DEFAULT_PACKAGE_NAME;
    await cleanupGlobalRenameDirs({
      globalRoot: path.dirname(pkgRoot),
      packageName,
    });
    const channel = opts.track ?? DEFAULT_PACKAGE_TRACK;
    const tag = normalizeTag(opts.tag ?? trackToNpmTag(channel));
    const spec = `${packageName}@${tag}`;
    const steps: UpdateStepResult[] = [];
    const updateStep = await runStep({
      runCommand,
      name: "global update",
      argv: globalInstallArgs(globalManager, spec),
      cwd: pkgRoot,
      timeoutMs,
      progress,
      stepIndex: 0,
      totalSteps: 1,
    });
    steps.push(updateStep);

    let finalStep = updateStep;
    if (updateStep.exitCode !== 0) {
      const fallbackArgv = globalInstallFallbackArgs(globalManager, spec);
      if (fallbackArgv) {
        const fallbackStep = await runStep({
          runCommand,
          name: "global update (omit optional)",
          argv: fallbackArgv,
          cwd: pkgRoot,
          timeoutMs,
          progress,
          stepIndex: 0,
          totalSteps: 1,
        });
        steps.push(fallbackStep);
        finalStep = fallbackStep;
      }
    }

    const afterVersion = await readPackageVersion(pkgRoot);
    return {
      status: finalStep.exitCode === 0 ? "ok" : "error",
      mode: globalManager,
      root: pkgRoot,
      reason: finalStep.exitCode === 0 ? undefined : finalStep.name,
      before: { version: beforeVersion },
      after: { version: afterVersion },
      steps,
      durationMs: Date.now() - startedAt,
    };
  }

  // Installer mode (Windows .exe / macOS .dmg) cannot be updated in-place.
  const isInstallerBundle =
    (process.platform === "win32" &&
      (await fileExists(path.join(pkgRoot, "..", "node", "node.exe")))) ||
    (process.platform === "darwin" &&
      (await fileExists(path.join(pkgRoot, "node", "bin", "node"))));

  return {
    status: "skipped",
    mode: "unknown",
    root: pkgRoot,
    reason: isInstallerBundle ? "installer" : "not-git-install",
    before: { version: beforeVersion },
    steps: [],
    durationMs: Date.now() - startedAt,
  };
}
