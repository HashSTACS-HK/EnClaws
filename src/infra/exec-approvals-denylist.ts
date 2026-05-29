import type { ExecCommandSegment } from "./exec-approvals-analysis.js";
import { parseDenylist, type ExecDenylistEntry } from "./exec-approvals.js";

export type DenylistDecision =
  | { blocked: false }
  | { blocked: true; matched?: ExecDenylistEntry; reason: string };

/**
 * Hardcoded exec denylist. Each entry is `bin[:pattern]`:
 * - `bin`     must appear as a whole word in the command (or as argv[0] basename).
 * - `pattern` (optional) must also match the command (case-insensitive regex).
 *
 * Kept intentionally conservative — only high-blast-radius system commands.
 * Ordinary process management (e.g. `kill` of user processes) is not listed to
 * avoid breaking legitimate agent workflows.
 *
 * NOTE: The DSL splits top-level entries on unescaped `|`. Inside a pattern,
 *       - `\\|` in source → escaped separator → stays as `|` in the compiled regex
 *         (used for alternation inside groups like `(?:stop\\|disable)`).
 *       - `\\x7c` in source → literal pipe character in the compiled regex
 *         (used when matching the shell pipe operator, e.g. `curl ... | sh`).
 */
const DEFAULT_DENYLIST_SOURCES: readonly string[] = [
  // ── Recursive / force remove ──
  // `rm -rf`, `rm -fr`, `rm -Rf`, `rm -r --force`, …
  // Carve-out: `rm -rf <state-dir>/tenants/<id>/skills/...` is admin skill
  // management (role already gated by checkSkillWritePermission + PathPolicy).
  // `\\b` anchors the flag run so the engine can't backtrack to a shorter
  // flag prefix that would bypass the negative lookahead.
  "rm:-[rRf]+\\b(?!\\s+[^\\s]*\\.(?:enclaws\\|openclaw)[/\\\\]tenants[/\\\\][^/\\\\]+[/\\\\]skills\\b)",

  // ── System shutdown / reboot family ──
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "init:\\s+[06]\\b",

  // ── Filesystem formatting & raw-device writes ──
  "mkfs",
  "wipefs",
  "blkdiscard",
  "shred",
  "dd:of=/dev/",
  "diskutil:\\beraseDisk\\b",

  // ── Systemd / service destructive actions ──
  // `\\|` inside pattern = escaped separator → `|` alternation in compiled regex.
  "systemctl:\\b(?:stop\\|disable\\|mask\\|poweroff\\|reboot\\|halt)\\b",
  "launchctl:\\b(?:stop\\|kill\\|remove)\\b",
  "service:\\bstop\\b",

  // ── Pipe-to-shell remote execution ──
  // `\\x7c` = literal `|` shell pipe; `\\|` inside group = regex alternation.
  "curl:\\x7c\\s*(?:sh\\|bash)\\b",
  "wget:\\x7c\\s*(?:sh\\|bash)\\b",

  // ── Process kill targeting OpenClaw / EnClaws / gateway only ──
  // (Generic `kill`/`killall` intentionally NOT listed — breaks legitimate workflows.)
  "pkill:\\b(?:openclaw\\|enclaws\\|gateway)\\b",
  "killall:\\b(?:openclaw\\|enclaws\\|gateway)\\b",

  // ── User / permission tampering ──
  "useradd",
  "userdel",
  "usermod",
  "groupadd",
  "groupdel",
  "passwd",
  "chpasswd",
  "visudo",
  "chmod:\\s+777\\b",

  // ── Firewall / routing wipes ──
  "iptables:-[FXD]\\b",
  "ufw:\\bdisable\\b",
  "nft:\\bflush\\b",

  // ── SSH key manipulation ──
  "ssh-keygen",
  "ssh-copy-id",

  // ── EnClaws / OpenClaw state directory & config files ──
  // Matches `rm ~/.enclaws/...`, `rm .../.openclaw/...`, etc. — except paths
  // under `tenants/<id>/skills/` which admin/owner may manage (the upstream
  // `checkSkillWritePermission` + `PathPermissionPolicy` gates already enforce
  // that role requirement; this layer just stops being blanket-restrictive).
  // NOTE: `\\|` inside the negative lookahead must stay escaped (the DSL
  //       splits top-level entries on unescaped `|`).
  "rm:\\.(?:enclaws\\|openclaw)\\b(?![/\\\\]tenants[/\\\\][^/\\\\]+[/\\\\]skills(?:[/\\\\]\\|$\\|\\s))",
  "unlink:\\.(?:enclaws\\|openclaw)\\b(?![/\\\\]tenants[/\\\\][^/\\\\]+[/\\\\]skills(?:[/\\\\]\\|$\\|\\s))",
  "mv:\\.(?:enclaws\\|openclaw)\\b(?![/\\\\]tenants[/\\\\][^/\\\\]+[/\\\\]skills(?:[/\\\\]\\|$\\|\\s))",
];

/**
 * Command-level regex denylist — evaluated BEFORE bin-first rules. Covers
 * attacks that can't be expressed as `bin[:pattern]`, notably redirection
 * truncation of protected files (`> ~/.enclaws/enclaws.json`) where the
 * offending token (`>`) is not a bin name.
 *
 * Only write-style redirects are blocked — reads (`cat`, `less`) stay allowed
 * for debuggability.
 */
const PROTECTED_PATH_WRITE_PATTERNS: readonly { label: string; pattern: RegExp }[] = [
  {
    label: "enclaws.json",
    // `> ~/.enclaws/enclaws.json`, `>| .enclaws/enclaws.json`, etc. (but not `>>` append)
    pattern: /(?<![>])>\|?\s*\S*\.enclaws[/\\]enclaws\.json\b/i,
  },
  {
    label: "exec-approvals.json",
    pattern: /(?<![>])>\|?\s*\S*\.enclaws[/\\]exec-approvals\.json\b/i,
  },
  {
    label: "shell rc (~/.bashrc family)",
    pattern:
      /(?<![>])>\|?\s*~\/\.(?:bashrc|zshrc|bash_profile|zprofile|profile|bash_login|zshenv)\b/i,
  },
  {
    label: "system shell init (/etc/profile family)",
    pattern:
      /(?<![>])>\|?\s*\/(?:etc\/(?:profile|environment|bash\.bashrc)|root\/\.(?:bashrc|profile))\b/i,
  },
];

const DEFAULT_DENYLIST: readonly ExecDenylistEntry[] = parseDenylist(
  DEFAULT_DENYLIST_SOURCES.join("\n"),
);

/**
 * Check a command (and its parsed segments) against a denylist.
 *
 * Logic: (1) command-level protected-path patterns are scanned first — a hit
 * there is an immediate block. (2) Otherwise, each bin-first entry is tried:
 * the bin name must appear as a word-boundary token in the command OR as an
 * executable in any segment's argv[0]; if the entry has an extra pattern, that
 * must match too. First hit wins.
 *
 * This is a hard block — callers should throw on a blocked decision regardless
 * of allowlist / approval state.
 */
export function evaluateDenylist(params: {
  command: string;
  denylist: readonly ExecDenylistEntry[];
  segments?: readonly ExecCommandSegment[];
}): DenylistDecision {
  const { command, denylist } = params;
  if (!command) {
    return { blocked: false };
  }

  for (const guard of PROTECTED_PATH_WRITE_PATTERNS) {
    if (guard.pattern.test(command)) {
      return {
        blocked: true,
        reason: `denylist: write to protected path '${guard.label}' (pattern=/${guard.pattern.source}/)`,
      };
    }
  }

  if (!denylist.length) {
    return { blocked: false };
  }

  const segmentExecNames: string[] = [];
  for (const segment of params.segments ?? []) {
    const argv0 = segment.argv[0];
    if (typeof argv0 !== "string" || !argv0) {
      continue;
    }
    const base = argv0.toLowerCase().split(/[/\\]/).pop() ?? "";
    if (base) {
      segmentExecNames.push(base);
    }
  }

  for (const entry of denylist) {
    const binInCommand = entry.binRegex.test(command);
    const binInSegments = segmentExecNames.includes(entry.bin);
    if (!binInCommand && !binInSegments) {
      continue;
    }

    if (entry.pattern && !entry.pattern.test(command)) {
      continue;
    }

    const reason = entry.pattern
      ? `denylist: '${entry.bin}' matching /${entry.pattern.source}/ (rule='${entry.source}')`
      : `denylist: '${entry.bin}' (rule='${entry.source}')`;
    return { blocked: true, matched: entry, reason };
  }
  return { blocked: false };
}

/** Return the compiled default exec denylist. */
export function getExecDenylist(): readonly ExecDenylistEntry[] {
  return DEFAULT_DENYLIST;
}
