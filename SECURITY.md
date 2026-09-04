# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a vulnerability that could cause unintended file movement, deletion, privilege escalation, path traversal, command injection, manifest tampering, or disclosure of private local data.

Use GitHub's private vulnerability reporting feature for this repository. Include the affected command and version, the smallest reproducible input, the expected and observed boundary, and whether any file was moved, restored, or deleted. Redact personal paths from manifests.

Never include passwords, authentication tokens, complete Keychain output, private documents, or unrelated system data.

## Security boundaries

macpurge is designed to:

- execute external tools with argument arrays and without a shell;
- reject broad roots, traversal, wildcards, and unresolved templates;
- revalidate paths and symlinks immediately before mutation;
- prevent protected candidates from entering a transaction;
- quarantine before permanent deletion;
- avoid overwriting files during restore;
- defer irreversible registrations and receipt cleanup until purge;
- avoid installing a persistent privileged helper.

These controls reduce risk but do not make destructive software risk-free. Review the scan and dry-run output before every uninstall.

## Supported environment

Security testing currently targets Apple Silicon and macOS 27 with Bun 1.4.1 or later. Reports from other environments are welcome, but those environments are not yet supported targets.
