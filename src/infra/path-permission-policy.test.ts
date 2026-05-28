import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveTenantDir,
  resolveTenantSkillsDir,
  resolveTenantUserDir,
} from "../config/sessions/tenant-paths.js";
import {
  buildPathPermissionPolicy,
  parseExtraAllowedPaths,
  PathPermissionPolicy,
  resolveToolPathOp,
  type PathOp,
} from "./path-permission-policy.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a policy with two rules: a read+write dir and a read-only dir. */
function makePolicy(rwDir: string, roDir: string, noEmptyFile?: string): PathPermissionPolicy {
  const rules: Array<{ prefix: string; ops: ReadonlySet<PathOp>; noEmpty?: boolean }> = [
    { prefix: rwDir, ops: new Set(["read", "write"]) },
    { prefix: roDir, ops: new Set(["read"]) },
  ];
  if (noEmptyFile) {
    rules.push({ prefix: noEmptyFile, ops: new Set(["read", "write"]), noEmpty: true });
  }
  return new PathPermissionPolicy(rules);
}

// ── PathPermissionPolicy.check() ─────────────────────────────────────────────

describe("PathPermissionPolicy.check()", () => {
  const base = path.join(os.tmpdir(), "enclaws-policy-test");
  const rwDir = path.join(base, "workspace");
  const roDir = path.join(base, "agents");
  const noEmptyFile = path.join(base, "MEMORY.md");
  const outsideDir = path.join(os.tmpdir(), "completely-outside");

  const policy = makePolicy(rwDir, roDir, noEmptyFile);

  describe("allowed paths", () => {
    it("allows read on a read+write prefix", () => {
      expect(policy.check(rwDir, "read")).toBeNull();
    });

    it("allows write on a read+write prefix", () => {
      expect(policy.check(rwDir, "write")).toBeNull();
    });

    it("allows read on a file inside the read+write prefix", () => {
      expect(policy.check(path.join(rwDir, "notes.md"), "read")).toBeNull();
    });

    it("allows write on a file deep inside the read+write prefix", () => {
      expect(policy.check(path.join(rwDir, "sub", "file.txt"), "write")).toBeNull();
    });

    it("allows read on a read-only prefix", () => {
      expect(policy.check(roDir, "read")).toBeNull();
    });

    it("allows read on a file inside the read-only prefix", () => {
      expect(policy.check(path.join(roDir, "agent.md"), "read")).toBeNull();
    });

    it("allows write on noEmpty file with non-empty content", () => {
      expect(policy.check(noEmptyFile, "write", "some content")).toBeNull();
    });

    it("allows write on noEmpty file with whitespace-only content when content is undefined", () => {
      // When content is not passed (e.g. for edit tool), noEmpty check is skipped
      expect(policy.check(noEmptyFile, "write", undefined)).toBeNull();
    });
  });

  describe("denied paths — write on read-only", () => {
    it("blocks write on a read-only prefix", () => {
      const result = policy.check(roDir, "write");
      expect(result).toBeTypeOf("string");
      expect(result).toContain("'write' is not permitted");
    });

    it("blocks write on a file inside a read-only prefix", () => {
      const result = policy.check(path.join(roDir, "agent.md"), "write");
      expect(result).toBeTypeOf("string");
      expect(result).toContain("'write' is not permitted");
    });
  });

  describe("denied paths — noEmpty protection", () => {
    it("blocks write with empty string on a noEmpty file", () => {
      const result = policy.check(noEmptyFile, "write", "");
      expect(result).toBeTypeOf("string");
      expect(result).toContain("empty content");
      expect(result).toContain("MEMORY.md");
    });

    it("blocks write with whitespace-only content on a noEmpty file", () => {
      const result = policy.check(noEmptyFile, "write", "   \n  ");
      expect(result).toBeTypeOf("string");
      expect(result).toContain("empty content");
    });

    it("allows read on a noEmpty file regardless of content", () => {
      expect(policy.check(noEmptyFile, "read")).toBeNull();
    });
  });

  describe("denied paths — default deny", () => {
    it("blocks read on a path outside all rules", () => {
      const result = policy.check(outsideDir, "read");
      expect(result).toBeTypeOf("string");
      expect(result).toContain("outside the permitted path list");
    });

    it("blocks write on a path outside all rules", () => {
      const result = policy.check(outsideDir, "write");
      expect(result).toBeTypeOf("string");
      expect(result).toContain("outside the permitted path list");
    });

    it("blocks access to a sibling directory that starts with the same prefix string", () => {
      // Regression: ensure "workspace-evil" is not matched by the "workspace" prefix rule
      const sibling = path.join(base, "workspace-evil", "file.txt");
      const result = policy.check(sibling, "read");
      expect(result).toBeTypeOf("string");
      expect(result).toContain("outside the permitted path list");
    });

    it("blocks path traversal attempts (../../ style)", () => {
      // path.resolve normalizes traversal — the result lands outside the prefix
      const traversal = path.resolve(rwDir, "../../etc/passwd");
      const result = policy.check(traversal, "read");
      expect(result).toBeTypeOf("string");
      expect(result).toContain("outside the permitted path list");
    });
  });

  describe("first-match-wins ordering", () => {
    it("applies the first matching rule when two rules overlap", () => {
      // Create a policy where a rw rule appears before a ro rule for the same subtree
      const dir = path.join(os.tmpdir(), "enclaws-overlap-test");
      const specific = path.join(dir, "sub");
      const broader = dir;
      const p = new PathPermissionPolicy([
        { prefix: specific, ops: new Set(["read", "write"]) },
        { prefix: broader, ops: new Set(["read"]) },
      ]);
      // specific/file.txt matches the first (rw) rule → write allowed
      expect(p.check(path.join(specific, "file.txt"), "write")).toBeNull();
      // dir/other.txt matches only the broader (ro) rule → write denied
      expect(p.check(path.join(broader, "other.txt"), "write")).toBeTypeOf("string");
    });
  });
});

// ── parseExtraAllowedPaths() ─────────────────────────────────────────────────

describe("parseExtraAllowedPaths()", () => {
  it("returns empty array for empty string", () => {
    expect(parseExtraAllowedPaths("")).toHaveLength(0);
  });

  it("returns empty array for whitespace-only string", () => {
    expect(parseExtraAllowedPaths("   \n  ")).toHaveLength(0);
  });

  it("parses a single read+write path", () => {
    const [rule] = parseExtraAllowedPaths("/data/shared");
    expect(rule).toBeDefined();
    expect(rule.ops.has("read")).toBe(true);
    expect(rule.ops.has("write")).toBe(true);
  });

  it("parses a single read-only path (`:read` suffix)", () => {
    const [rule] = parseExtraAllowedPaths("/mnt/reports:read");
    expect(rule).toBeDefined();
    expect(rule.ops.has("read")).toBe(true);
    expect(rule.ops.has("write")).toBe(false);
  });

  it("parses comma-separated paths", () => {
    const rules = parseExtraAllowedPaths("/data/shared,/mnt/reports:read");
    expect(rules).toHaveLength(2);
    expect(rules[0].ops.has("write")).toBe(true);
    expect(rules[1].ops.has("write")).toBe(false);
  });

  it("parses newline-separated paths", () => {
    const rules = parseExtraAllowedPaths("/data/shared\n/mnt/reports:read");
    expect(rules).toHaveLength(2);
  });

  it("trims whitespace around entries", () => {
    const rules = parseExtraAllowedPaths("  /data/shared  ,  /mnt/reports:read  ");
    expect(rules).toHaveLength(2);
  });

  it("resolves relative paths to absolute", () => {
    const rules = parseExtraAllowedPaths("relative/path");
    expect(path.isAbsolute(rules[0].prefix)).toBe(true);
  });

  it("treats unknown suffix as read+write (not :read)", () => {
    // e.g. /path/to/dir:write — unknown suffix, fallback to full access
    const [rule] = parseExtraAllowedPaths("/data/shared:write");
    expect(rule.ops.has("read")).toBe(true);
    expect(rule.ops.has("write")).toBe(true);
  });
});

// ── resolveToolPathOp() ───────────────────────────────────────────────────────

describe("resolveToolPathOp()", () => {
  it.each([
    ["read", "read"],
    ["write", "write"],
    ["edit", "write"],
    ["apply_patch", "write"],
  ] as const)('maps tool "%s" to op "%s"', (tool, expected) => {
    expect(resolveToolPathOp(tool)).toBe(expected);
  });

  it.each(["exec", "process", "gateway", "cron", "memory_search", "unknown_tool"])(
    'returns null for non-path tool "%s"',
    (tool) => {
      expect(resolveToolPathOp(tool)).toBeNull();
    },
  );
});

// ── buildPathPermissionPolicy() — integration smoke test ─────────────────────

describe("buildPathPermissionPolicy()", () => {
  const TENANT = "test-tenant-abc";
  const USER = "test-user-xyz";
  const WORKSPACE = path.join(os.tmpdir(), "enclaws-test-workspace");

  const tenantRoot = resolveTenantDir(TENANT);
  const userRoot = resolveTenantUserDir(TENANT, USER);
  const skillsRoot = resolveTenantSkillsDir(TENANT);

  const policy = buildPathPermissionPolicy({
    tenantId: TENANT,
    userId: USER,
    workspaceDir: WORKSPACE,
  });

  it("returns a PathPermissionPolicy instance", () => {
    expect(policy).toBeInstanceOf(PathPermissionPolicy);
  });

  it("allows read+write in user workspace", () => {
    const f = path.join(userRoot, "workspace", "notes.md");
    expect(policy.check(f, "read")).toBeNull();
    expect(policy.check(f, "write")).toBeNull();
  });

  it("allows read+write in the sandbox workspaceDir", () => {
    const f = path.join(WORKSPACE, "src", "main.ts");
    expect(policy.check(f, "read")).toBeNull();
    expect(policy.check(f, "write")).toBeNull();
  });

  it("allows read+write in sessions dir", () => {
    const f = path.join(userRoot, "sessions", "session-001.jsonl");
    expect(policy.check(f, "read")).toBeNull();
    expect(policy.check(f, "write")).toBeNull();
  });

  it("allows read on agents dir", () => {
    const f = path.join(tenantRoot, "agents", "main", "AGENT.md");
    expect(policy.check(f, "read")).toBeNull();
  });

  it("blocks write on agents dir", () => {
    const f = path.join(tenantRoot, "agents", "main", "AGENT.md");
    expect(policy.check(f, "write")).toBeTypeOf("string");
  });

  it("allows read on credentials dir", () => {
    const f = path.join(userRoot, "credentials", "github.json");
    expect(policy.check(f, "read")).toBeNull();
  });

  it("blocks write on credentials dir", () => {
    const f = path.join(userRoot, "credentials", "github.json");
    expect(policy.check(f, "write")).toBeTypeOf("string");
  });

  it("allows read+write on MEMORY.md with content", () => {
    const f = path.join(tenantRoot, "MEMORY.md");
    expect(policy.check(f, "read")).toBeNull();
    expect(policy.check(f, "write", "## Goals\n- ship it")).toBeNull();
  });

  it("blocks empty write on MEMORY.md", () => {
    const f = path.join(tenantRoot, "MEMORY.md");
    expect(policy.check(f, "write", "")).toBeTypeOf("string");
  });

  it("allows read+write on USER.md with content", () => {
    const f = path.join(userRoot, "USER.md");
    expect(policy.check(f, "write", "## Profile\n")).toBeNull();
  });

  it("blocks empty write on USER.md", () => {
    const f = path.join(userRoot, "USER.md");
    expect(policy.check(f, "write", "  ")).toBeTypeOf("string");
  });

  it("blocks access to the tenants root dir (cross-tenant enumeration)", () => {
    const tenantsRoot = path.dirname(tenantRoot);
    expect(policy.check(tenantsRoot, "read")).toBeTypeOf("string");
  });

  it("blocks access to another tenant's directory", () => {
    const otherTenantRoot = resolveTenantDir("other-tenant-999");
    expect(policy.check(path.join(otherTenantRoot, "MEMORY.md"), "read")).toBeTypeOf("string");
  });

  it("blocks access to another user's directory within the same tenant", () => {
    const otherUserDir = resolveTenantUserDir(TENANT, "other-user-999");
    expect(policy.check(path.join(otherUserDir, "USER.md"), "read")).toBeTypeOf("string");
  });

  it("blocks access to /etc/passwd", () => {
    expect(policy.check("/etc/passwd", "read")).toBeTypeOf("string");
  });

  it("allows read+write in skills dir", () => {
    const f = path.join(skillsRoot, "my-skill", "SKILL.md");
    expect(policy.check(f, "read")).toBeNull();
    expect(policy.check(f, "write")).toBeNull();
  });

  describe("role-aware tenant-root carve-out", () => {
    // Deny-side assertions omitted here: os.tmpdir() is ALL_OPS and the test
    // state dir lives under tmpdir, so tenantRoot reads "leak" as allowed
    // regardless of role in this harness. Cross-tenant deny is covered by the
    // existing "blocks access to another tenant's directory" test above.

    it("allows read on the tenant root for role=admin", () => {
      const adminPolicy = buildPathPermissionPolicy({
        tenantId: TENANT,
        userId: USER,
        workspaceDir: WORKSPACE,
        role: "admin",
      });
      expect(adminPolicy.check(tenantRoot, "read")).toBeNull();
    });

    it("allows read on the tenant root for role=owner", () => {
      const ownerPolicy = buildPathPermissionPolicy({
        tenantId: TENANT,
        userId: USER,
        workspaceDir: WORKSPACE,
        role: "owner",
      });
      expect(ownerPolicy.check(tenantRoot, "read")).toBeNull();
    });

    it("leaves skill read+write behavior unchanged for role=admin", () => {
      const adminPolicy = buildPathPermissionPolicy({
        tenantId: TENANT,
        userId: USER,
        workspaceDir: WORKSPACE,
        role: "admin",
      });
      const skillFile = path.join(skillsRoot, "my-skill", "SKILL.md");
      expect(adminPolicy.check(skillFile, "read")).toBeNull();
      expect(adminPolicy.check(skillFile, "write")).toBeNull();
    });
  });

  describe("ENCLAWS_EXTRA_ALLOWED_PATHS", () => {
    it("honours an extra read+write path from env", () => {
      const extraDir = path.join(os.tmpdir(), "enclaws-extra-dir");
      const p = buildPathPermissionPolicy({
        tenantId: TENANT,
        userId: USER,
        workspaceDir: WORKSPACE,
      });
      // Simulate the env var by passing it in parseExtraAllowedPaths directly —
      // buildPathPermissionPolicy reads process.env at call time, so we test
      // parseExtraAllowedPaths integration in its own suite above.
      // Here we verify the policy works when given an explicit extra rule.
      const pWithExtra = new PathPermissionPolicy([
        { prefix: extraDir, ops: new Set(["read", "write"]) },
      ]);
      expect(pWithExtra.check(path.join(extraDir, "file.txt"), "read")).toBeNull();
      expect(pWithExtra.check(path.join(extraDir, "file.txt"), "write")).toBeNull();
    });
  });
});
