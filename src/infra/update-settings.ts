import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { resolveOpenClawPackageRoot } from "./openclaw-root.js";
import { normalizeUpdateTrack, type UpdateTrack } from "./update-channels.js";

const UPDATE_SETTINGS_FILENAME = "update-settings.json";

export type InstallKind = "git" | "package" | "installer" | "unknown";

export type UpdateSettings = {
  track?: UpdateTrack;
  checkOnStart?: boolean;
  installKind?: InstallKind;
  auto?: {
    enabled?: boolean;
    stableDelayHours?: number;
    stableJitterHours?: number;
    betaCheckIntervalHours?: number;
  };
};

export async function readUpdateSettings(): Promise<UpdateSettings> {
  const settingsPath = path.join(resolveStateDir(), UPDATE_SETTINGS_FILENAME);
  try {
    const raw = await fs.readFile(settingsPath, "utf-8");
    const parsed = JSON.parse(raw) as UpdateSettings;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function writeUpdateSettings(settings: UpdateSettings): Promise<void> {
  const settingsPath = path.join(resolveStateDir(), UPDATE_SETTINGS_FILENAME);
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
}

export async function patchUpdateSettings(patch: Partial<UpdateSettings>): Promise<void> {
  const current = await readUpdateSettings();
  await writeUpdateSettings({ ...current, ...patch });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Detect the install kind at startup. */
async function detectInstallKind(): Promise<InstallKind> {
  const root = await resolveOpenClawPackageRoot({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });
  if (!root) {
    return "unknown";
  }

  // Check git checkout
  const isGit = await fileExists(path.join(root, ".git"));
  if (isGit) {
    return "git";
  }

  // Check npm/pnpm global install — package root lives inside node_modules
  const normalized = root.replace(/\\/g, "/");
  if (normalized.includes("/node_modules/")) {
    return "package";
  }

  // Not git, not npm package → must be bundled installer (Windows .exe / macOS .dmg)
  return "installer";
}

/** Ensure update-settings.json exists with defaults. Called on gateway startup. */
export async function ensureUpdateSettings(): Promise<UpdateSettings> {
  const settingsPath = path.join(resolveStateDir(), UPDATE_SETTINGS_FILENAME);
  try {
    const raw = await fs.readFile(settingsPath, "utf-8");
    const parsed = JSON.parse(raw) as UpdateSettings;
    if (parsed && typeof parsed === "object") {
      // Always re-detect installKind on startup to correct any prior misdetection
      const detected = await detectInstallKind();
      if (detected !== "unknown" && parsed.installKind !== detected) {
        parsed.installKind = detected;
        await writeUpdateSettings(parsed);
      }
      return parsed;
    }
  } catch {
    // File doesn't exist or is invalid — create with defaults
  }
  const installKind = await detectInstallKind();
  const isGit = installKind === "git";
  const defaults: UpdateSettings = isGit
    ? {
        track: "dev",
        checkOnStart: true,
        installKind,
      }
    : {
        track: "stable",
        checkOnStart: true,
        installKind,
        auto: {
          enabled: false,
          stableDelayHours: 6,
          stableJitterHours: 12,
          betaCheckIntervalHours: 1,
        },
      };
  await writeUpdateSettings(defaults);
  return defaults;
}

/** Returns the effective stored track: env var > settings file > null */
export async function getStoredUpdateTrack(): Promise<UpdateTrack | null> {
  const envTrack = normalizeUpdateTrack(process.env.ENCLAWS_UPDATE_TRACK);
  if (envTrack) {
    return envTrack;
  }
  const settings = await readUpdateSettings();
  return normalizeUpdateTrack(settings.track) ?? null;
}
