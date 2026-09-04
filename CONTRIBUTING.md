# Contributing to macpurge

Thank you for helping make application removal safer.

## Before opening a change

- Keep safety defaults conservative.
- Never auto-select a `possible` candidate.
- Never introduce shell interpolation for user-controlled values.
- Do not broaden filesystem roots without tests and a written rationale.
- Preserve quarantine and restore behavior for every reversible file action.
- Keep terminal messages and documentation in English.

For large behavior changes, open an issue first and describe the affected safety boundary.

## Local checks

Use Bun for all project commands:

```bash
bun install --frozen-lockfile
bun run check
bun test
bun run build
```

Do not test destructive behavior against real applications. Use temporary filesystem roots and a fake command runner, following the existing test suite.

## Pull requests

A focused pull request should include:

1. A concise explanation of the behavior change.
2. Tests for successful, rejected, and partial paths where relevant.
3. Documentation updates for user-visible behavior.
4. Confirmation that JSON output and exit-code contracts remain stable.
5. A note about any new external command or privileged operation.

## Adding application rules

Prefer general scanner improvements over application-specific rules. When a profile is necessary:

- identify the app by exact bundle ID;
- use only supported template variables;
- provide a concrete reason for every path;
- mark shared or ambiguous data as `possible`;
- add tests proving protected and unrelated paths remain untouched.

Rules are declarative data. They must never execute commands.
