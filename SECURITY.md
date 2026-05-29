# Security Policy

EnClaws targets enterprise-grade digital assistant containerization and multi-user runtime scenarios.
Security issues may involve multi-tenant isolation, cross-session leakage, layered-memory exposure, container escape, authorization bypass, message-channel authentication, audit-data tampering, secret exposure, and unsafe Skill execution.
If you believe you have found a security vulnerability, please **report it privately** and do not open a public issue first.

## Supported Versions

Before 1.0, we follow a "main branch first" security-fix strategy:

| Branch / Version                                                        | Status | Notes                              |
| ----------------------------------------------------------------------- | ------ | ---------------------------------- |
| `main` / latest state of the default branch                             | ✅     | Primary line for security fixes    |
| Most recent pre-release tag or snapshot                                 | ⚠️     | Best effort, no backport guarantee |
| Stale snapshots, private forks, or historical branches not kept in sync | ❌     | No security support commitment     |

## How to Report

1. **Prefer GitHub private vulnerability reporting**  
   If the repository has GitHub Private Vulnerability Reporting or Security Advisories enabled, use that channel.
2. **If private reporting is not yet enabled**  
   Do not publish vulnerability details in public. You may open a minimal issue without technical details solely to request a private communication channel.
3. **Do not paste sensitive material into public channels**  
   Do not post customer data, chat transcripts, access credentials, production logs, internal IPs, cloud resource details, or directly exploitable attack details in public.

## What to Include in a Report

To help reproduction and triage, please include as much of the following as you can:

- Vulnerability title
- Affected scope and likely impact
- Affected component, path, interface, command, or configuration
- Reproduction steps or a proof of concept
- Environment details such as version, deployment method, operating system, container runtime, and message channel
- Your understanding of the triggering conditions and permission boundaries
- Temporary mitigations or suggested fixes, if any

## Issue Types We Especially Care About

The following are usually high-priority security topics:

- Multi-user or multi-tenant isolation failures
- Leakage of session, memory, or audit data across principals that should not share data
- Container or sandbox escape, or gaining host-level permissions that should not be available
- Authentication bypass, privilege escalation, or cross-user operations
- Sensitive-information exposure reachable under default configuration
- Issues that allow unauthorized use of enterprise messaging channels, webhooks, tool execution, or admin panels
- Issues that make evidence trails, accountability, or audit logs incomplete, misleading, or silently alterable

## What Usually Does Not Qualify as a Vulnerability

The following are generally better treated as hardening suggestions rather than accepted vulnerabilities, though discussion is still welcome:

- Pure prompt injection or hallucination behavior that does not cross a real security boundary
- Problems that occur only after you heavily modify the code, disable default protections, or install a dangerous custom plugin
- Issues that affect only private forks, experimental branches, or snapshots explicitly marked as obsolete
- Generalized risk descriptions without a reproducible path or without any explanation of boundary impact

## Response Approach

We will try to acknowledge reports promptly and, after reproduction, assess severity, repair options, and disclosure timing.
At this time the project does not commit to a fixed SLA and does not publish a bug bounty program.

## Disclosure Expectations

Please do not publicly disclose directly exploitable details until a patch is ready or clear mitigation steps are available.
If public thanks are appropriate, we will try to coordinate the preferred form of attribution with the reporter after the fix is released.
