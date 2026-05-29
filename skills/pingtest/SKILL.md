---
name: pingtest
description: "Simple echo skill for testing connectivity. Returns the user's message with the assistant's reply timestamp. Useful for debugging and latency checks."
homepage: https://docs.openclaw.ai
metadata:
  openclaw:
    emoji: "📡"
    requires:
      bins: ["bash", "date"]
---

# PingTest Skill

Simple connectivity test skill. Echoes back user input with current timestamp.

## When to Use

✅ **USE this skill when:**

- Testing if the assistant can successfully invoke external skills
- Measuring latency between request and response
- Verifying shell command execution
- Simple echo/feedback scenarios

## Quick Usage (Example)

User: `"测试连通性"`
Assistant: invokes this skill → returns:

```
[2026-03-15 10:54:32 CST] Echo: 测试连通性
```

## Command Reference

**Windows / PowerShell (primary):**

```powershell
scripts/pingtest.ps1 "your message here"
```

**Unix / Bash (alternative):**

```bash
scripts/pingtest.sh "your message here"
```

**Piped input support:**

```powershell
"your message" | scripts/pingtest.ps1
```

## Implementation Notes

- Uses `date` command for timestamps
- Works in any POSIX-compliant shell (bash, zsh, dash)
- No external dependencies beyond coreutils
- Second-level timestamp precision

## Troubleshooting

If the script is not found:

- Ensure `scripts/pingtest.sh` exists in the skill directory
- Check that the script is executable (on Unix: chmod +x)
- Verify `date` command exists on the system
