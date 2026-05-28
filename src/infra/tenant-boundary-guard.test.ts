import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PathPermissionPolicy } from "./path-permission-policy.js";
import { assertPolicyBoundary } from "./tenant-boundary-guard.js";

describe("assertPolicyBoundary", () => {
  const base = path.join(os.tmpdir(), `enclaws-boundary-guard-${process.pid}`);
  const rwDir = path.join(base, "workspace");
  const roFile = path.join(base, "TOOLS.md");
  const outsideDir = path.join(base, "secret");

  // Fixtures
  const secretFile = path.join(outsideDir, "passwords.txt");
  const normalFile = path.join(rwDir, "notes.md");
  const hardlinkedA = path.join(rwDir, "dup-a.txt");
  const hardlinkedB = path.join(rwDir, "dup-b.txt");
  const linkToRoFile = path.join(rwDir, "link-to-tools");
  const linkToSecret = path.join(rwDir, "evil-link");
  const viaLinkDirSecret = path.join(linkToSecret, "passwords.txt");

  let symlinkFileSupported = true;
  let junctionSupported = true;

  beforeAll(() => {
    fs.mkdirSync(rwDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(roFile, "# TOOLS.md");
    fs.writeFileSync(secretFile, "TOP_SECRET=hunter2");
    fs.writeFileSync(normalFile, "hello");
    fs.writeFileSync(hardlinkedA, "shared content");
    fs.linkSync(hardlinkedA, hardlinkedB);

    try {
      fs.symlinkSync(roFile, linkToRoFile, "file");
    } catch {
      symlinkFileSupported = false;
    }
    try {
      fs.symlinkSync(outsideDir, linkToSecret, "junction");
    } catch {
      junctionSupported = false;
    }
  });

  afterAll(() => {
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // Policy: workspace is RW, TOOLS.md is READ_ONLY, everything else default-deny
  const policy = new PathPermissionPolicy([
    { prefix: rwDir, ops: new Set(["read", "write"]) },
    { prefix: roFile, ops: new Set(["read"]) },
  ]);

  it("allows a normal file inside the permitted dir", async () => {
    const v = await assertPolicyBoundary({ policy, absolutePath: normalFile, op: "read" });
    expect(v).toBeNull();
  });

  it("allows a file with nlink > 1 (hardlink regression — must not false-positive)", async () => {
    expect(fs.statSync(hardlinkedA).nlink).toBeGreaterThan(1);
    const v = await assertPolicyBoundary({ policy, absolutePath: hardlinkedA, op: "read" });
    expect(v).toBeNull();
    const vw = await assertPolicyBoundary({ policy, absolutePath: hardlinkedA, op: "write" });
    expect(vw).toBeNull();
  });

  it("allows a non-existent leaf (new-file creation path)", async () => {
    const ghost = path.join(rwDir, "does", "not", "exist.txt");
    const v = await assertPolicyBoundary({ policy, absolutePath: ghost, op: "write" });
    expect(v).toBeNull();
  });

  it("allows READ through a symlink whose canonical target is a read-permitted file", async () => {
    if (!symlinkFileSupported) {return;}
    // link-to-tools → TOOLS.md (READ_ONLY rule). Reading is fine.
    const v = await assertPolicyBoundary({ policy, absolutePath: linkToRoFile, op: "read" });
    expect(v).toBeNull();
  });

  it("blocks WRITE through a symlink whose canonical target is read-only (permission elevation)", async () => {
    if (!symlinkFileSupported) {return;}
    // link-to-tools lives under RW workspace, but canonical TOOLS.md is READ_ONLY.
    // A naive lexical check would allow write; the alias guard catches it.
    const v = await assertPolicyBoundary({ policy, absolutePath: linkToRoFile, op: "write" });
    expect(v).toBeTypeOf("string");
    expect(v).toContain("[SECURITY]");
    expect(v).toContain("symlink/junction");
  });

  it("blocks access through a junction that escapes all permitted rules", async () => {
    if (!junctionSupported) {return;}
    const v = await assertPolicyBoundary({ policy, absolutePath: viaLinkDirSecret, op: "read" });
    expect(v).toBeTypeOf("string");
    expect(v).toContain("[SECURITY]");
    expect(v).toContain("symlink/junction");
  });

  it("returns null when the lexical path matches no rule (delegates to policy.check)", async () => {
    const outside = path.join(base, "not-in-any-rule", "x.txt");
    const v = await assertPolicyBoundary({ policy, absolutePath: outside, op: "read" });
    // Lexical path has no alias resolution happening (path doesn't exist, no
    // symlinks in ancestors); canonical === lexical, short-circuit returns null.
    // Default-deny is the lexical policy.check's job, not this guard's.
    expect(v).toBeNull();
  });
});
