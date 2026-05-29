export type UpdateTrack = "stable" | "beta" | "dev";
export type UpdateTrackSource = "env" | "config" | "git-tag" | "git-branch" | "default";

export const DEFAULT_PACKAGE_TRACK: UpdateTrack = "stable";
export const DEFAULT_GIT_TRACK: UpdateTrack = "dev";
export const DEV_BRANCH = "main";

export function normalizeUpdateTrack(value?: string | null): UpdateTrack | null {
  if (!value) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "stable" || normalized === "beta" || normalized === "dev") {
    return normalized;
  }
  return null;
}

export function trackToNpmTag(track: UpdateTrack): string {
  if (track === "beta") {
    return "beta";
  }
  if (track === "dev") {
    return "dev";
  }
  return "latest";
}

export function isBetaTag(tag: string): boolean {
  return /(?:^|[.-])beta(?:[.-]|$)/i.test(tag);
}

export function isStableTag(tag: string): boolean {
  return !isBetaTag(tag);
}

export function resolveEffectiveUpdateTrack(params: {
  storedTrack?: UpdateTrack | null;
  installKind: "git" | "package" | "unknown";
  git?: { tag?: string | null; branch?: string | null };
}): { track: UpdateTrack; source: UpdateTrackSource } {
  // Env var takes highest priority
  const envTrack = normalizeUpdateTrack(process.env.ENCLAWS_UPDATE_TRACK);
  if (envTrack) {
    return { track: envTrack, source: "env" };
  }

  // Then persisted setting (from state file or config)
  if (params.storedTrack) {
    return { track: params.storedTrack, source: "config" };
  }

  if (params.installKind === "git") {
    const tag = params.git?.tag;
    if (tag) {
      return { track: isBetaTag(tag) ? "beta" : "stable", source: "git-tag" };
    }
    const branch = params.git?.branch;
    if (branch && branch !== "HEAD") {
      return { track: "dev", source: "git-branch" };
    }
    return { track: DEFAULT_GIT_TRACK, source: "default" };
  }

  if (params.installKind === "package") {
    return { track: DEFAULT_PACKAGE_TRACK, source: "default" };
  }

  return { track: DEFAULT_PACKAGE_TRACK, source: "default" };
}

export function formatUpdateTrackLabel(params: {
  track: UpdateTrack;
  source: UpdateTrackSource;
  gitTag?: string | null;
  gitBranch?: string | null;
}): string {
  if (params.source === "env") {
    return `${params.track} (env)`;
  }
  if (params.source === "config") {
    return `${params.track} (config)`;
  }
  if (params.source === "git-tag") {
    return params.gitTag ? `${params.track} (${params.gitTag})` : `${params.track} (tag)`;
  }
  if (params.source === "git-branch") {
    return params.gitBranch ? `${params.track} (${params.gitBranch})` : `${params.track} (branch)`;
  }
  return `${params.track} (default)`;
}

export function resolveUpdateTrackDisplay(params: {
  storedTrack?: UpdateTrack | null;
  installKind: "git" | "package" | "unknown";
  gitTag?: string | null;
  gitBranch?: string | null;
}): { track: UpdateTrack; source: UpdateTrackSource; label: string } {
  const trackInfo = resolveEffectiveUpdateTrack({
    storedTrack: params.storedTrack,
    installKind: params.installKind,
    git:
      params.gitTag || params.gitBranch
        ? { tag: params.gitTag ?? null, branch: params.gitBranch ?? null }
        : undefined,
  });
  return {
    track: trackInfo.track,
    source: trackInfo.source,
    label: formatUpdateTrackLabel({
      track: trackInfo.track,
      source: trackInfo.source,
      gitTag: params.gitTag ?? null,
      gitBranch: params.gitBranch ?? null,
    }),
  };
}

// ---------------------------------------------------------------------------
// Backward-compat aliases (remove once all call sites are migrated)
// ---------------------------------------------------------------------------
/** @deprecated Use UpdateTrack */
export type UpdateChannel = UpdateTrack;
/** @deprecated Use normalizeUpdateTrack */
export const normalizeUpdateChannel = normalizeUpdateTrack;
/** @deprecated Use trackToNpmTag */
export const channelToNpmTag = trackToNpmTag;
/** @deprecated Use DEFAULT_PACKAGE_TRACK */
export const DEFAULT_PACKAGE_CHANNEL = DEFAULT_PACKAGE_TRACK;
/** @deprecated Use DEFAULT_GIT_TRACK */
export const DEFAULT_GIT_CHANNEL = DEFAULT_GIT_TRACK;
