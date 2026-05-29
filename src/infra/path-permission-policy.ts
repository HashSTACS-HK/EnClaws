/**
 * PathPermissionPolicy — default-deny path access control for multi-tenant AI tool calls.
 *
 * Replaces four scattered guards (cross-tenant path check, user enumeration block,
 * protected-file guard, tenants-root protection) with a single unified allow-list model.
 *
 * Rules are evaluated in order; the first matching prefix wins.
 * Any path that matches no rule is denied (default deny).
 *
 * Usage:
 *   const policy = buildPathPermissionPolicy({ tenantId, userId });
 *   const violation = policy.check(absolutePath, op, content);
 *   if (violation) throw new Error(violation);
 */

import os from "node:os";
import path from "node:path";
import { resolveWorkspaceRoot } from "../agents/workspace-dir.js";
import { resolveStateDir } from "../config/paths.js";
import {
  resolveTenantDir,
  resolveTenantSkillsDir,
  resolveTenantUserDir,
} from "../config/sessions/tenant-paths.js";
import { isPathInside } from "./path-guards.js";

// ── Op types ────────────────────────────────────────────────────────────────

/** File operations that the policy can permit or deny. */
export type PathOp = "read" | "write";

// ── Predefined op sets ───────────────────────────────────────────────────────

/** read + write (no delete — delete is covered by exec denylist separately). */
const NO_DELETE: ReadonlySet<PathOp> = new Set(["read", "write"]);

/** read + write, full access. */
const ALL_OPS: ReadonlySet<PathOp> = new Set(["read", "write"]);

/** read only. */
const READ_ONLY: ReadonlySet<PathOp> = new Set(["read"]);

// ── Internal rule type ───────────────────────────────────────────────────────

type PathRule = {
  /** Absolute path prefix. Any path equal to or inside this prefix matches. */
  prefix: string;
  /** Permitted operations. */
  ops: ReadonlySet<PathOp>;
  /**
   * When true, a write with empty content is rejected.
   * Protects critical files (MEMORY.md, USER.md) from being accidentally cleared.
   */
  noEmpty?: boolean;
};

/** Public, read-only view of a matched rule (used by alias-boundary guard). */
export type MatchedPathRule = Readonly<Pick<PathRule, "prefix">>;

// ── PathPermissionPolicy ─────────────────────────────────────────────────────

export class PathPermissionPolicy {
  readonly #rules: PathRule[];

  constructor(rules: PathRule[]) {
    this.#rules = rules.map((r) => ({ ...r, prefix: path.resolve(r.prefix) }));
  }

  /**
   * Find the first rule whose prefix lexically matches the path.
   * Returns only the rule's prefix (used by tenant-boundary-guard to obtain
   * the boundary root for symlink/junction alias checks).
   */
  findMatchingRule(absolutePath: string): MatchedPathRule | null {
    const normalized = path.resolve(absolutePath);
    for (const rule of this.#rules) {
      if (isPathInside(rule.prefix, normalized)) {
        return { prefix: rule.prefix };
      }
    }
    return null;
  }

  /**
   * Check whether an operation on absolutePath is permitted.
   *
   * @param absolutePath - The resolved absolute path to check.
   * @param op           - The operation being performed ("read" or "write").
   * @param content      - For write ops: the content being written (used for noEmpty check).
   * @returns null if allowed, or a human-readable denial reason string.
   */
  check(absolutePath: string, op: PathOp, content?: string): string | null {
    const normalized = path.resolve(absolutePath);

    for (const rule of this.#rules) {
      // Match if path equals the prefix or is inside it
      if (!isPathInside(rule.prefix, normalized)) {
        continue;
      }

      if (!rule.ops.has(op)) {
        return (
          `[SECURITY] '${op}' is not permitted on '${displayPath(normalized)}'. ` +
          `This is a hard security restriction — do NOT attempt alternative approaches ` +
          `(shell commands, exec, rename, copy, or any other tool). Inform the user that this operation is not allowed.`
        );
      }

      if (op === "write" && rule.noEmpty && typeof content === "string" && content.trim() === "") {
        return (
          `[SECURITY] Writing empty or near-empty content to '${path.basename(normalized)}' is not permitted. ` +
          `This is a hard security restriction — do NOT substitute placeholder or minimal content as a workaround. ` +
          `The intent to clear this file is blocked. Inform the user that this operation is not allowed.`
        );
      }

      return null; // allowed
    }

    // Default deny: path matched no rule
    return (
      `[SECURITY] '${displayPath(normalized)}' is outside the permitted path list for this session. ` +
      `This is a hard security restriction — do NOT attempt to access this path through any other means ` +
      `(shell commands, exec, alternative paths, etc.). Inform the user that this operation is not allowed.`
    );
  }
}

// ── Builder ──────────────────────────────────────────────────────────────────

/**
 * Build the PathPermissionPolicy for a specific tenant session.
 * All allowed paths are derived from existing path-resolution functions —
 * no hardcoded strings, resilient to directory layout changes.
 *
 * `role` lifts the tenant-root prefix to read-only for admin/owner so exec
 * literals referencing `tenants/<id>/` (e.g. install-script cwd, clawhub
 * --prefix) don't get blanket-denied. Actual write gating for skill files
 * still runs through `checkSkillWritePermission`; this rule only widens
 * read/traversal. Missing/unknown role → strict (member-equivalent).
 */
export function buildPathPermissionPolicy(ctx: {
  tenantId: string;
  userId: string;
  /** Agent workspace dir override (from sandbox config). Falls back to cwd. */
  workspaceDir?: string;
  /** Tenant user role. `admin`/`owner` unlock a few elevated prefixes. */
  role?: string;
}): PathPermissionPolicy {
  const tenantRoot = resolveTenantDir(ctx.tenantId);
  const userRoot = resolveTenantUserDir(ctx.tenantId, ctx.userId);
  const skillsRoot = resolveTenantSkillsDir(ctx.tenantId);
  const workspace = ctx.workspaceDir ?? resolveWorkspaceRoot();
  const extras = parseExtraAllowedPaths(process.env.ENCLAWS_EXTRA_ALLOWED_PATHS ?? "");
  const isAdmin = ctx.role === "admin" || ctx.role === "owner";

  return new PathPermissionPolicy([
    // ── L1: full read + write ──────────────────────────────────────────────
    { prefix: path.join(userRoot, "workspace"), ops: ALL_OPS },
    { prefix: workspace, ops: ALL_OPS },
    { prefix: os.tmpdir(), ops: ALL_OPS },

    // ── L2: read + write, no delete, no empty for critical files ───────────
    { prefix: path.join(tenantRoot, "IDENTITY.md"), ops: READ_ONLY },
    { prefix: path.join(tenantRoot, "MEMORY.md"), ops: NO_DELETE, noEmpty: true },
    { prefix: path.join(userRoot, "USER.md"), ops: NO_DELETE, noEmpty: true },
    { prefix: path.join(userRoot, "sessions"), ops: NO_DELETE },
    { prefix: path.join(userRoot, "cron"), ops: NO_DELETE },

    // ── Skills: read + write (actual write permission is re-checked by
    //    checkSkillWritePermission — PathPermissionPolicy only blocks delete) ─
    { prefix: skillsRoot, ops: NO_DELETE },

    // ── L3: read-only ──────────────────────────────────────────────────────
    { prefix: path.join(tenantRoot, "TOOLS.md"), ops: READ_ONLY },
    { prefix: path.join(tenantRoot, "agents"), ops: READ_ONLY },
    { prefix: path.join(tenantRoot, "cron"), ops: READ_ONLY },
    { prefix: path.join(userRoot, "credentials"), ops: READ_ONLY },
    { prefix: path.join(userRoot, "devices"), ops: READ_ONLY },
    { prefix: path.join(resolveStateDir(), "logs"), ops: READ_ONLY },

    // ── Admin/owner: read-level traversal of the tenant root ──────────────
    //    Keeps skill-install scripts that reference `tenants/<id>/` (as cwd,
    //    --prefix, or a path literal captured by exec-path-policy) from
    //    hitting default-deny. Writes to nested paths are still governed by
    //    the specific sub-rules above; this is a last-resort READ_ONLY rule.
    ...(isAdmin ? [{ prefix: tenantRoot, ops: READ_ONLY }] : []),

    // ── User-configured extra paths (ENCLAWS_EXTRA_ALLOWED_PATHS) ──────────
    ...extras,
  ]);
}

// ── Extra paths parser ───────────────────────────────────────────────────────

/**
 * Parse comma- or newline-separated extra allowed paths from an env var.
 *
 * Format: `/abs/path` (read+write) or `/abs/path:read` (read-only).
 *
 * Example:
 *   ENCLAWS_EXTRA_ALLOWED_PATHS=/data/shared,/mnt/reports:read
 */
export function parseExtraAllowedPaths(raw: string): PathRule[] {
  return raw
    .split(/[,\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const colonIdx = entry.lastIndexOf(":");
      if (colonIdx > 0) {
        const suffix = entry.slice(colonIdx + 1).toLowerCase();
        if (suffix === "read") {
          return { prefix: path.resolve(entry.slice(0, colonIdx)), ops: READ_ONLY };
        }
      }
      return { prefix: path.resolve(entry), ops: ALL_OPS };
    });
}

// ── Tool op resolver ─────────────────────────────────────────────────────────

/**
 * Map a normalized tool name to the PathOp it performs.
 * Returns null for tools that don't operate on file paths (exec, process, etc.),
 * which are governed by the exec denylist instead.
 */
export function resolveToolPathOp(toolName: string): PathOp | null {
  if (toolName === "read") {
    return "read";
  }
  if (toolName === "write" || toolName === "edit" || toolName === "apply_patch") {
    return "write";
  }
  return null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function displayPath(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}
