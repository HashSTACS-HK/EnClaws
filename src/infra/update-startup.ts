import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveStateDir } from "../config/paths.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { VERSION } from "../version.js";
import { resolveOpenClawPackageRoot } from "./openclaw-root.js";
import { DEFAULT_PACKAGE_TRACK, normalizeUpdateTrack } from "./update-channels.js";
import { compareSemverStrings, resolveNpmChannelTag, checkUpdateStatus } from "./update-check.js";
import { readUpdateSettings } from "./update-settings.js";

type UpdateCheckState = {
  lastCheckedAt?: string;
  lastNotifiedVersion?: string;
  lastNotifiedTag?: string;
  lastAvailableVersion?: string;
  lastAvailableTag?: string;
  autoInstallId?: string;
  autoFirstSeenVersion?: string;
  autoFirstSeenTag?: string;
  autoFirstSeenAt?: string;
  autoLastAttemptVersion?: string;
  autoLastAttemptAt?: string;
  autoLastSuccessVersion?: string;
  autoLastSuccessAt?: string;
  /** Set when npm install fails with EBUSY on Windows; cleared after retry on next startup. */
  pendingRetryVersion?: string;
  pendingRetryTag?: string;
};

type AutoUpdatePolicy = {
  enabled: boolean;
  stableDelayHours: number;
  stableJitterHours: number;
  betaCheckIntervalHours: number;
};

type AutoUpdateRunResult = {
  ok: boolean;
  code: number | null;
  stdout?: string;
  stderr?: string;
  reason?: string;
};

export type UpdateAvailable = {
  currentVersion: string;
  latestVersion: string;
  channel: string;
  /** For installer mode: URL to download the new installer. */
  downloadUrl?: string;
};

let updateAvailableCache: UpdateAvailable | null = null;

export function getUpdateAvailable(): UpdateAvailable | null {
  return updateAvailableCache;
}

export function resetUpdateAvailableStateForTest(): void {
  updateAvailableCache = null;
}

const UPDATE_CHECK_FILENAME = "update-check.json";
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const AUTO_UPDATE_COMMAND_TIMEOUT_MS = 45 * 60 * 1000;
const AUTO_STABLE_DELAY_HOURS_DEFAULT = 6;
const AUTO_STABLE_JITTER_HOURS_DEFAULT = 12;
const AUTO_BETA_CHECK_INTERVAL_HOURS_DEFAULT = 1;

/** Resolve the download URL for the installer update. */
function resolveInstallerDownloadUrl(version: string): string {
  const envKey =
    process.platform === "darwin"
      ? "ENCLAWS_UPDATE_DOWNLOAD_URL_MAC"
      : "ENCLAWS_UPDATE_DOWNLOAD_URL";
  const template = process.env[envKey]?.trim();
  if (template) {
    return template.replace(/\{version\}/g, version);
  }
  return "https://www.enclaws.ai/";
}

function shouldSkipCheck(allowInTests: boolean): boolean {
  if (allowInTests) {
    return false;
  }
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return true;
  }
  return false;
}

function resolveAutoUpdatePolicy(settings: {
  auto?: {
    enabled?: boolean;
    stableDelayHours?: number;
    stableJitterHours?: number;
    betaCheckIntervalHours?: number;
  };
}): AutoUpdatePolicy {
  const auto = settings.auto;
  const stableDelayHours =
    typeof auto?.stableDelayHours === "number" && Number.isFinite(auto.stableDelayHours)
      ? Math.max(0, auto.stableDelayHours)
      : AUTO_STABLE_DELAY_HOURS_DEFAULT;
  const stableJitterHours =
    typeof auto?.stableJitterHours === "number" && Number.isFinite(auto.stableJitterHours)
      ? Math.max(0, auto.stableJitterHours)
      : AUTO_STABLE_JITTER_HOURS_DEFAULT;
  const betaCheckIntervalHours =
    typeof auto?.betaCheckIntervalHours === "number" && Number.isFinite(auto.betaCheckIntervalHours)
      ? Math.max(0.25, auto.betaCheckIntervalHours)
      : AUTO_BETA_CHECK_INTERVAL_HOURS_DEFAULT;

  return {
    enabled: Boolean(auto?.enabled),
    stableDelayHours,
    stableJitterHours,
    betaCheckIntervalHours,
  };
}

function resolveCheckIntervalMs(settings: {
  track?: string | null;
  auto?: { enabled?: boolean; betaCheckIntervalHours?: number };
}): number {
  const track = normalizeUpdateTrack(settings.track) ?? DEFAULT_PACKAGE_TRACK;
  const auto = resolveAutoUpdatePolicy(settings);
  if (!auto.enabled) {
    return UPDATE_CHECK_INTERVAL_MS;
  }
  if (track === "beta") {
    return Math.max(ONE_HOUR_MS / 4, Math.floor(auto.betaCheckIntervalHours * ONE_HOUR_MS));
  }
  if (track === "stable") {
    return ONE_HOUR_MS;
  }
  return UPDATE_CHECK_INTERVAL_MS;
}

async function readState(statePath: string): Promise<UpdateCheckState> {
  try {
    const raw = await fs.readFile(statePath, "utf-8");
    const parsed = JSON.parse(raw) as UpdateCheckState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeState(statePath: string, state: UpdateCheckState): Promise<void> {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), "utf-8");
}

/** Mark that npm install failed with EBUSY; the next startup should retry. */
export async function markPendingUpdateRetry(version: string, tag: string): Promise<void> {
  const statePath = path.join(resolveStateDir(), UPDATE_CHECK_FILENAME);
  const state = await readState(statePath);
  state.pendingRetryVersion = version;
  state.pendingRetryTag = tag;
  await writeState(statePath, state);
}

function sameUpdateAvailable(a: UpdateAvailable | null, b: UpdateAvailable | null): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return (
    a.currentVersion === b.currentVersion &&
    a.latestVersion === b.latestVersion &&
    a.channel === b.channel
  );
}

function setUpdateAvailableCache(params: {
  next: UpdateAvailable | null;
  onUpdateAvailableChange?: (updateAvailable: UpdateAvailable | null) => void;
}): void {
  if (sameUpdateAvailable(updateAvailableCache, params.next)) {
    return;
  }
  updateAvailableCache = params.next;
  params.onUpdateAvailableChange?.(params.next);
}

function resolvePersistedUpdateAvailable(
  state: UpdateCheckState,
  installKind?: string,
): UpdateAvailable | null {
  const latestVersion = state.lastAvailableVersion?.trim();
  if (!latestVersion) {
    return null;
  }
  const cmp = compareSemverStrings(VERSION, latestVersion);
  if (cmp == null || cmp >= 0) {
    return null;
  }
  const channel = state.lastAvailableTag?.trim() || DEFAULT_PACKAGE_TRACK;
  const isInstallerMode = installKind === "installer";
  return {
    currentVersion: VERSION,
    latestVersion,
    channel: isInstallerMode ? "installer" : channel,
    downloadUrl: isInstallerMode ? resolveInstallerDownloadUrl(latestVersion) : undefined,
  };
}

function resolveStableJitterMs(params: {
  installId: string;
  version: string;
  tag: string;
  jitterWindowMs: number;
}): number {
  if (params.jitterWindowMs <= 0) {
    return 0;
  }
  const hash = createHash("sha256")
    .update(`${params.installId}:${params.version}:${params.tag}`)
    .digest();
  const bucket = hash.readUInt32BE(0);
  return bucket % (Math.floor(params.jitterWindowMs) + 1);
}

function resolveStableAutoApplyAtMs(params: {
  state: UpdateCheckState;
  nextState: UpdateCheckState;
  nowMs: number;
  version: string;
  tag: string;
  stableDelayHours: number;
  stableJitterHours: number;
}): number {
  if (!params.nextState.autoInstallId) {
    params.nextState.autoInstallId = params.state.autoInstallId?.trim() || randomUUID();
  }
  const installId = params.nextState.autoInstallId;
  const matchesExisting =
    params.state.autoFirstSeenVersion === params.version &&
    params.state.autoFirstSeenTag === params.tag;

  if (!matchesExisting) {
    params.nextState.autoFirstSeenVersion = params.version;
    params.nextState.autoFirstSeenTag = params.tag;
    params.nextState.autoFirstSeenAt = new Date(params.nowMs).toISOString();
  } else {
    params.nextState.autoFirstSeenVersion = params.state.autoFirstSeenVersion;
    params.nextState.autoFirstSeenTag = params.state.autoFirstSeenTag;
    params.nextState.autoFirstSeenAt = params.state.autoFirstSeenAt;
  }

  const firstSeenMs = params.nextState.autoFirstSeenAt
    ? Date.parse(params.nextState.autoFirstSeenAt)
    : params.nowMs;
  const baseDelayMs = Math.max(0, params.stableDelayHours) * ONE_HOUR_MS;
  const jitterWindowMs = Math.max(0, params.stableJitterHours) * ONE_HOUR_MS;
  const jitterMs = resolveStableJitterMs({
    installId,
    version: params.version,
    tag: params.tag,
    jitterWindowMs,
  });

  return firstSeenMs + baseDelayMs + jitterMs;
}

async function runAutoUpdateCommand(params: {
  channel: "stable" | "beta";
  timeoutMs: number;
  root?: string;
}): Promise<AutoUpdateRunResult> {
  const baseArgs = ["update", "--yes", "--track", params.channel, "--json"];
  const execPath = process.execPath?.trim();
  const argv1 = process.argv[1]?.trim();
  const lowerExecBase = execPath ? path.basename(execPath).toLowerCase() : "";
  const runtimeIsNodeOrBun =
    lowerExecBase === "node" ||
    lowerExecBase === "node.exe" ||
    lowerExecBase === "bun" ||
    lowerExecBase === "bun.exe";
  const argv: string[] = [];
  if (execPath && argv1) {
    argv.push(execPath, argv1, ...baseArgs);
  } else if (execPath && !runtimeIsNodeOrBun) {
    argv.push(execPath, ...baseArgs);
  } else if (execPath && params.root) {
    const candidates = [
      path.join(params.root, "dist", "entry.js"),
      path.join(params.root, "dist", "entry.mjs"),
      path.join(params.root, "dist", "index.js"),
      path.join(params.root, "dist", "index.mjs"),
    ];
    for (const candidate of candidates) {
      try {
        await fs.access(candidate);
        argv.push(execPath, candidate, ...baseArgs);
        break;
      } catch {
        // try next candidate
      }
    }
  }
  if (argv.length === 0) {
    argv.push("enclaws", ...baseArgs);
  }

  try {
    const res = await runCommandWithTimeout(argv, {
      timeoutMs: params.timeoutMs,
      env: {
        ENCLAWS_AUTO_UPDATE: "1",
      },
    });
    return {
      ok: res.code === 0,
      code: res.code,
      stdout: res.stdout,
      stderr: res.stderr,
      reason: res.code === 0 ? undefined : "non-zero-exit",
    };
  } catch (err) {
    return {
      ok: false,
      code: null,
      reason: String(err),
    };
  }
}

function clearAutoState(nextState: UpdateCheckState): void {
  delete nextState.autoFirstSeenVersion;
  delete nextState.autoFirstSeenTag;
  delete nextState.autoFirstSeenAt;
}

export async function runGatewayUpdateCheck(params: {
  log: { info: (msg: string, meta?: Record<string, unknown>) => void };
  isNixMode: boolean;
  allowInTests?: boolean;
  onUpdateAvailableChange?: (updateAvailable: UpdateAvailable | null) => void;
  runAutoUpdate?: (params: {
    channel: "stable" | "beta";
    timeoutMs: number;
    root?: string;
  }) => Promise<AutoUpdateRunResult>;
}): Promise<void> {
  if (shouldSkipCheck(Boolean(params.allowInTests))) {
    return;
  }
  if (params.isNixMode) {
    return;
  }
  const settings = await readUpdateSettings();
  const auto = resolveAutoUpdatePolicy(settings);
  const shouldRunUpdateHints = settings.checkOnStart !== false;
  if (!shouldRunUpdateHints && !auto.enabled) {
    return;
  }

  const statePath = path.join(resolveStateDir(), UPDATE_CHECK_FILENAME);
  const state = await readState(statePath);

  // Handle pending retry from a previous EBUSY failure on Windows.
  // After restart, file locks are released and npm install should succeed.
  if (state.pendingRetryVersion) {
    const retryVersion = state.pendingRetryVersion;
    const retryTag = state.pendingRetryTag ?? "latest";
    delete state.pendingRetryVersion;
    delete state.pendingRetryTag;
    await writeState(statePath, state);
    params.log.info(`pending update retry: running npm install for v${retryVersion} (${retryTag})`);
    const runAuto = params.runAutoUpdate ?? runAutoUpdateCommand;
    const root = await resolveOpenClawPackageRoot({
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
      cwd: process.cwd(),
    });
    const outcome = await runAuto({
      channel: retryTag as "stable" | "beta",
      timeoutMs: AUTO_UPDATE_COMMAND_TIMEOUT_MS,
      root: root ?? undefined,
    });
    if (outcome.ok) {
      params.log.info(`pending update retry succeeded for v${retryVersion}`);
    } else {
      params.log.info(
        `pending update retry failed for v${retryVersion}: ${outcome.reason ?? `exit:${outcome.code}`}`,
      );
    }
    return;
  }

  const now = Date.now();
  const lastCheckedAt = state.lastCheckedAt ? Date.parse(state.lastCheckedAt) : null;
  if (shouldRunUpdateHints) {
    const persistedAvailable = resolvePersistedUpdateAvailable(state, settings.installKind);
    setUpdateAvailableCache({
      next: persistedAvailable,
      onUpdateAvailableChange: params.onUpdateAvailableChange,
    });
  } else {
    setUpdateAvailableCache({
      next: null,
      onUpdateAvailableChange: params.onUpdateAvailableChange,
    });
  }
  // Dev/git mode: always check on startup (developers want immediate feedback)
  const effectiveTrack = normalizeUpdateTrack(settings.track);
  const skipIntervalCheck = effectiveTrack === "dev";
  const checkIntervalMs = resolveCheckIntervalMs(settings);
  if (!skipIntervalCheck && lastCheckedAt && Number.isFinite(lastCheckedAt)) {
    if (now - lastCheckedAt < checkIntervalMs) {
      return;
    }
  }

  const root = await resolveOpenClawPackageRoot({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });
  const status = await checkUpdateStatus({
    root,
    timeoutMs: 2500,
    fetchGit: true,
    includeRegistry: true,
  });

  const nextState: UpdateCheckState = {
    ...state,
    lastCheckedAt: new Date(now).toISOString(),
  };

  // --- git mode: check if remote has new commits ---
  if (status.installKind === "git") {
    const behind = status.git?.behind ?? 0;
    if (behind > 0) {
      const nextAvailable: UpdateAvailable = {
        currentVersion: VERSION,
        latestVersion: String(behind),
        channel: "git",
      };
      if (shouldRunUpdateHints) {
        setUpdateAvailableCache({
          next: nextAvailable,
          onUpdateAvailableChange: params.onUpdateAvailableChange,
        });
      }
      nextState.lastAvailableVersion = nextAvailable.latestVersion;
      nextState.lastAvailableTag = "git";
      if (shouldRunUpdateHints && state.lastAvailableVersion !== nextAvailable.latestVersion) {
        params.log.info(
          `git update available: ${behind} commit(s) behind upstream. Run: ${formatCliCommand("enclaws update")}`,
        );
      }
    } else {
      setUpdateAvailableCache({
        next: null,
        onUpdateAvailableChange: params.onUpdateAvailableChange,
      });
    }
    clearAutoState(nextState);
    await writeState(statePath, nextState);
    return;
  }

  if (status.installKind !== "package" && status.installKind !== "installer") {
    delete nextState.lastAvailableVersion;
    delete nextState.lastAvailableTag;
    clearAutoState(nextState);
    setUpdateAvailableCache({
      next: null,
      onUpdateAvailableChange: params.onUpdateAvailableChange,
    });
    await writeState(statePath, nextState);
    return;
  }

  const isInstallerMode = status.installKind === "installer";
  const channel = normalizeUpdateTrack(settings.track) ?? DEFAULT_PACKAGE_TRACK;
  const resolved = await resolveNpmChannelTag({ channel, timeoutMs: 2500 });
  const tag = resolved.tag;
  if (!resolved.version) {
    await writeState(statePath, nextState);
    return;
  }

  const cmp = compareSemverStrings(VERSION, resolved.version);
  if (cmp != null && cmp < 0) {
    const downloadUrl = isInstallerMode ? resolveInstallerDownloadUrl(resolved.version) : undefined;
    const nextAvailable: UpdateAvailable = {
      currentVersion: VERSION,
      latestVersion: resolved.version,
      channel: isInstallerMode ? "installer" : tag,
      downloadUrl,
    };
    if (shouldRunUpdateHints) {
      setUpdateAvailableCache({
        next: nextAvailable,
        onUpdateAvailableChange: params.onUpdateAvailableChange,
      });
    }
    nextState.lastAvailableVersion = resolved.version;
    nextState.lastAvailableTag = tag;
    const shouldNotify =
      state.lastNotifiedVersion !== resolved.version || state.lastNotifiedTag !== tag;
    if (shouldRunUpdateHints && shouldNotify) {
      params.log.info(
        `update available (${tag}): v${resolved.version} (current v${VERSION}). Run: ${formatCliCommand("enclaws update")}`,
      );
      nextState.lastNotifiedVersion = resolved.version;
      nextState.lastNotifiedTag = tag;
    }

    if (auto.enabled && !isInstallerMode && (channel === "stable" || channel === "beta")) {
      const runAuto = params.runAutoUpdate ?? runAutoUpdateCommand;
      const attemptIntervalMs =
        channel === "beta"
          ? Math.max(ONE_HOUR_MS / 4, Math.floor(auto.betaCheckIntervalHours * ONE_HOUR_MS))
          : ONE_HOUR_MS;
      const lastAttemptAt = state.autoLastAttemptAt ? Date.parse(state.autoLastAttemptAt) : null;
      const recentAttemptForSameVersion =
        state.autoLastAttemptVersion === resolved.version &&
        lastAttemptAt != null &&
        Number.isFinite(lastAttemptAt) &&
        now - lastAttemptAt < attemptIntervalMs;

      let dueNow = channel === "beta";
      let applyAfterMs: number | null = null;
      if (channel === "stable") {
        applyAfterMs = resolveStableAutoApplyAtMs({
          state,
          nextState,
          nowMs: now,
          version: resolved.version,
          tag,
          stableDelayHours: auto.stableDelayHours,
          stableJitterHours: auto.stableJitterHours,
        });
        dueNow = now >= applyAfterMs;
      }

      if (!dueNow) {
        params.log.info("auto-update deferred (stable rollout window active)", {
          version: resolved.version,
          tag,
          applyAfter: applyAfterMs ? new Date(applyAfterMs).toISOString() : undefined,
        });
      } else if (recentAttemptForSameVersion) {
        params.log.info("auto-update deferred (recent attempt exists)", {
          version: resolved.version,
          tag,
        });
      } else {
        nextState.autoLastAttemptVersion = resolved.version;
        nextState.autoLastAttemptAt = new Date(now).toISOString();
        const outcome = await runAuto({
          channel,
          timeoutMs: AUTO_UPDATE_COMMAND_TIMEOUT_MS,
          root: root ?? undefined,
        });
        if (outcome.ok) {
          nextState.autoLastSuccessVersion = resolved.version;
          nextState.autoLastSuccessAt = new Date(now).toISOString();
          params.log.info("auto-update applied", {
            channel,
            version: resolved.version,
            tag,
          });
        } else {
          params.log.info("auto-update attempt failed", {
            channel,
            version: resolved.version,
            tag,
            reason: outcome.reason ?? `exit:${outcome.code}`,
          });
        }
      }
    }
  } else {
    delete nextState.lastAvailableVersion;
    delete nextState.lastAvailableTag;
    clearAutoState(nextState);
    setUpdateAvailableCache({
      next: null,
      onUpdateAvailableChange: params.onUpdateAvailableChange,
    });
  }

  await writeState(statePath, nextState);
}

export function scheduleGatewayUpdateCheck(params: {
  log: { info: (msg: string, meta?: Record<string, unknown>) => void };
  isNixMode: boolean;
  onUpdateAvailableChange?: (updateAvailable: UpdateAvailable | null) => void;
}): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  const tick = async () => {
    if (stopped || running) {
      return;
    }
    running = true;
    try {
      await runGatewayUpdateCheck(params);
    } catch {
      // Intentionally ignored: update checks should never crash the gateway loop.
    } finally {
      running = false;
    }
    if (stopped) {
      return;
    }
    const settings = await readUpdateSettings().catch(() => ({}));
    const intervalMs = resolveCheckIntervalMs(settings);
    timer = setTimeout(() => {
      void tick();
    }, intervalMs);
  };

  void tick();
  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}
