<div align="center">

# ◆ macpurge

### A safety-first, reversible macOS application uninstaller

Find the files an app leaves behind, review the evidence, and move verified items into quarantine before anything is permanently removed.

[![macOS](https://img.shields.io/badge/macOS_27-Apple_Silicon-111827?style=for-the-badge&logo=apple&logoColor=white)](https://www.apple.com/macos/)
[![Bun](https://img.shields.io/badge/Bun_1.4.1+-TypeScript-f9f1e1?style=for-the-badge&logo=bun&logoColor=111827)](https://bun.sh/)
[![Local only](https://img.shields.io/badge/Privacy-local_only-06b6d4?style=for-the-badge)](#privacy)
[![Safety](https://img.shields.io/badge/Default-reversible-a855f7?style=for-the-badge)](#safety-model)
[![License](https://img.shields.io/badge/License-MIT-4ade80?style=for-the-badge)](LICENSE)

<img src="docs/terminal-preview.svg" alt="macpurge terminal scan showing confirmed, review, and protected files" width="920">

</div>

> [!CAUTION]
> macpurge can move and permanently delete application files. This is an early, machine-specific release for Apple Silicon and macOS 27. Always inspect `scan` or `uninstall --dry-run` before approving a real operation.

## Why macpurge?

Dragging an app to Trash usually removes only its `.app` bundle. Caches, preferences, launch agents, CLI links, package receipts, helper tools, and application data can remain spread across macOS.

macpurge combines deep discovery with a deliberately conservative mutation model:

- **Evidence before action** — every candidate records why it matched.
- **Three risk classes** — confirmed, review, and protected paths are visually distinct.
- **Quarantine first** — normal uninstall and clean operations move files instead of deleting them.
- **Explicit permanence** — irreversible cleanup happens only through a separate `purge` command.
- **No surprise selection** — possible matches are never selected automatically.
- **Local by design** — no network requests, telemetry, analytics, or auto-updater.
- **Automation-friendly** — human-readable terminal output and stable JSON envelopes.

## Highlights

| Capability | What it does |
| --- | --- |
| Application discovery | Reads `/Applications` and `~/Applications`, including nested and symlinked bundles |
| Identity extraction | Collects display name, bundle ID, Team ID, version, path, and install source |
| Layered scanning | Checks standard Library paths, Spotlight, bounded filesystem matches, CLI links, processes, helpers, and registrations |
| Installer awareness | Detects standalone apps, Homebrew casks, App Store receipts, and PKG receipts |
| Safety classification | Separates strong ownership evidence from ambiguous or protected paths |
| Reversible sessions | Stores versioned manifests and moves same-volume files into per-app quarantine sessions |
| Controlled cleanup | Defers Keychain, TCC, login item, Homebrew, and package-receipt actions until permanent purge |
| Restore protection | Never overwrites an existing destination |
| Extensible rules | Loads declarative JSON profiles without allowing arbitrary command execution |

## Requirements

- Apple Silicon Mac
- macOS 27
- [Bun 1.4.1 or later](https://bun.sh/)
- Standard macOS command-line utilities used by `macpurge doctor`

The current release is intentionally built and tested for one local Apple Silicon configuration. Other macOS versions and Intel Macs are not yet supported targets.

## Install

Download the latest signed binary from
[GitHub Releases](https://github.com/mustafaerpek/macpurge/releases):

```bash
curl -fsSL -o macpurge https://github.com/mustafaerpek/macpurge/releases/latest/download/macpurge-darwin-arm64
chmod +x macpurge
install -m 755 macpurge ~/.bun/bin/macpurge
```

Make sure `~/.bun/bin` is available in your `PATH`, then confirm the installation:

```bash
macpurge --version
macpurge doctor
```

Verify the download against the published checksum
(the checksum file references the artifact name `macpurge-darwin-arm64`):

```bash
curl -fsSL -o macpurge-darwin-arm64 https://github.com/mustafaerpek/macpurge/releases/latest/download/macpurge-darwin-arm64
curl -fsSL -o SHA256SUMS.txt https://github.com/mustafaerpek/macpurge/releases/latest/download/SHA256SUMS.txt
shasum -a 256 -c SHA256SUMS.txt
```

## Install from source

```bash
git clone https://github.com/mustafaerpek/macpurge.git
cd macpurge
bun install --frozen-lockfile
bun run check
bun test
bun run build
install -m 755 dist/macpurge ~/.bun/bin/macpurge
```

The build script creates a standalone `bun-darwin-arm64` executable and reapplies a local ad-hoc code signature for current macOS runtime validation.

## Quick start

Open the searchable interactive application picker:

```bash
macpurge
```

Or inspect an application directly:

```bash
macpurge scan "Visual Studio Code"
macpurge uninstall "Visual Studio Code" --dry-run
macpurge uninstall "Visual Studio Code"
```

Or reclaim safe space without touching any installed app:

```bash
macpurge clean --dry-run --summary
macpurge clean --category user-caches --category user-logs --yes
macpurge clean --whitelist ~/Library/Caches/com.example.keep --whitelist user-logs
macpurge clean --whitelist-list
macpurge clean --whitelist-remove user-logs
macpurge clean --all-categories --include-possible --dry-run
```

After quarantine, every mutating command prints copy-paste recovery choices:

```bash
macpurge restore latest     # Put every available item back
macpurge purge latest       # Permanently remove the quarantine
macpurge verify "Example"   # Rescan for remaining files
```

## Command reference

| Command | Purpose | Mutates the system? |
| --- | --- | :---: |
| `macpurge` | Search for one installed application and open the guided flow | After confirmation |
| `macpurge list [--json]` | List discovered applications and install sources | No |
| `macpurge scan <selector> [--json] [--no-deep] [--summary]` | Find and classify related files | No |
| `macpurge uninstall <selector> [options]` | Move selected candidates into quarantine | Yes |
| `macpurge clean [options]` | Review safe caches, logs, trash, and orphaned leftovers | Yes |
| `macpurge history [--json]` | Display recorded sessions and states | No |
| `macpurge restore <session\|latest> [options]` | Restore quarantined files to their original paths | Yes |
| `macpurge purge <session\|latest> [options]` | Run deferred cleanup and permanently delete one quarantine | Yes, irreversible |
| `macpurge verify <selector\|session> [--json] [--summary]` | Rescan for files, processes, helpers, and registrations | No |
| `macpurge doctor [--json]` | Check architecture, Bun, tools, paths, and authorization readiness | No |
| `macpurge rules validate\|list\|explain` | Inspect the active declarative rule set | No |

### Common options

| Option | Meaning |
| --- | --- |
| `--json` | Emit the stable machine-readable envelope without ANSI formatting |
| `--no-deep` | Skip the bounded filesystem-name scan |
| `--dry-run` | Preview `uninstall`, `clean`, or `purge` without moving or deleting anything |
| `--yes`, `-y` | Skip typed and process confirmations (scripts and interactive runs) |
| `--include <candidate-id>` | Explicitly include one review candidate; may be repeated |
| `--include-possible` | Quarantine every review candidate without listing IDs (uninstall + clean) |
| `--category <id>` | Clean only these categories; repeatable (`trash`, `user-caches`, `user-logs`, `browser-caches`, `xcode-derived-data`, `dev-caches`, `orphaned-leftovers`) |
| `--all-categories` | Include orphaned leftovers in clean (off by default) |
| `--whitelist <path\|id>` | Never offer this path or category in future clean scans; repeatable |
| `--whitelist-list` | Show the clean whitelist |
| `--whitelist-remove <entry>` | Stop skipping this path or category; repeatable |
| `--summary` | Show counts instead of the full file list |
| `--confirm <exact-value>` | Supply the exact confirmation in non-interactive use |
| `--help`, `-h` | Show the command guide |
| `--version`, `-v` | Print the installed version |

Selectors are forgiving: an app path, bundle ID, or fuzzy display name (`vscode`, `Visual Studio Code`) all resolve, with suggestions on misses. Sessions accept a full ID, a unique short prefix, or `latest`.

```bash
macpurge uninstall vscode --dry-run --summary
macpurge uninstall "Visual Studio Code" --include-possible --yes
macpurge restore latest --yes
macpurge purge latest --dry-run
```

## Safety model

macpurge displays candidates in three classes:

| Class | Marker | Default | Meaning |
| --- | :---: | :---: | --- |
| `confirmed` | 🟢 | Selected | Exact app bundle, exact standard path, verified app symlink, trusted receipt payload, or validated profile match |
| `possible` | 🟡 | Not selected | Name-only match, data nested under another application, or potentially shared payload |
| `protected` | ⚪ | Blocked | Project settings, personal documents, broad roots, system developer tools, Apple apps, or paths that cannot be proven safe |

Protected candidates cannot be forced through `--include`. Possible candidates require an explicit interactive choice, `--include <id>`, or `--include-possible`.

### Protected boundaries

The path safety layer rejects, among other cases:

- `/`, the user home directory, and Library roots
- `/Applications` and other broad application roots
- parent traversal such as `..`
- unresolved environment variables and wildcard paths
- project `.vscode` directories
- personal `Documents`, `Desktop`, and `Downloads` content found by broad matching
- `/Library/Developer` and Apple system applications
- symlinks that do not resolve into the selected application
- quarantine paths belonging to another session

Every selected path, real path, ownership, symlink target, file type, inode, and filesystem boundary is checked again immediately before mutation. Restore writes additionally verify the symlink-resolved parent directory, so a redirected parent cannot move a file outside the supported roots, and administrator moves use `mv -n` so an existing destination is never overwritten.

## Quarantine lifecycle

```mermaid
flowchart LR
    A[Scan] --> B{Review candidates}
    B -->|confirmed| C[Exact-name confirmation]
    B -->|possible| D[Explicit opt-in]
    D --> C
    B -->|protected| E[Blocked]
    C --> F[Quarantine session]
    F --> G[Verify]
    G -->|Need the app back| H[Restore]
    G -->|Removal confirmed| I[Explicit purge]
    I --> J[Deferred cleanup]
    J --> K[Permanent deletion]
```

Quarantine data lives at:

```text
~/Library/Application Support/macpurge/quarantine/<session-id>
```

Session manifests remain available under:

```text
~/Library/Application Support/macpurge/sessions
```

Each manifest records the application identity, evidence, size, ownership, permissions, original path, quarantine path, item result, deferred actions, warnings, errors, and current transaction state.

Supported states are:

```text
planned → quarantining → quarantined → restored
                         └────────────→ purging → purged
              failures may produce partial or failed
```

## What gets cleaned?

`macpurge clean` is the no-app-needed counterpart to `uninstall`. It scans bounded, regenerable locations and quarantines what you approve—same transaction model, same `restore` path:

| Category | Default | What it covers |
| --- | :---: | --- |
| `trash` | Selected | Finder Trash inventory; emptied permanently via Finder, never quarantined |
| `user-caches` | Selected | Per-app directories in `~/Library/Caches` |
| `user-logs` | Selected | `~/Library/Logs` entries and diagnostic reports |
| `browser-caches` | Selected | Cache leaves (`Cache`, `GPUCache`, `Code Cache`, …) under browser vendors—profiles untouched |
| `xcode-derived-data` | Selected | Per-project `DerivedData` build products and indexes |
| `dev-caches` | Selected | Regenerable tool caches (`~/.npm`, `~/.bun`, `~/.cache/*`)—never `node_modules`, `Pods`, `venv` |
| `orphaned-leftovers` | Opt-in | Bundle-style `Application Support` directories with no installed owner (`--all-categories` or `--category`) |

Hard never-delete rules apply to every scan: local model stores (`~/.ollama`, `~/.cache/huggingface`), AI chat and memory directories (`.codex/sessions`, `.claude/projects`, `.grok/sessions`), dependency trees anywhere in the tree, and cache-named system stores such as `com.apple.e5rt.e5bundlecache`. Anything matching is silently excluded—never offered, never counted.

Trash is special: without Full Disk Access even the owner cannot list `~/.Trash` directly (`EPERM`), so macpurge inventories it through Finder—count, names, and best-effort total size via Finder's physical size—and empties it with Finder's own empty command. That action is permanent—it cannot enter quarantine or be restored. Everything else quarantines normally. `doctor` reports whether direct Trash reads work (`Direct read` vs `Via Finder`) so the fallback is never a surprise.

`clean --whitelist <path|category-id>` (repeatable) persists to `~/.config/macpurge/clean-whitelist.json` (`0600`). Whitelisted entries are reported as warnings and skipped on every future scan. Manage it with `clean --whitelist-list` and `clean --whitelist-remove <entry>`.

Clean sessions quarantine under a synthetic `System Cleanup` identity (`macpurge.clean`) so `history`, `restore latest`, and `purge latest` work exactly like uninstall sessions. The placeholder path is exempt from path validation by bundle id; every quarantined item still passes full revalidation.

## What gets scanned?

macpurge combines multiple bounded sources instead of trusting a single filename search:

1. Application bundle metadata from `Info.plist` and code signing.
2. Known user and system Library locations.
3. Spotlight metadata through `mdfind`.
4. A bundle-ID/name scan limited to approved local roots and depth.
5. CLI symlinks and their resolved targets.
6. Running processes and normal application quit state.
7. Login items, background registrations, and `launchctl` references.
8. LaunchAgents, LaunchDaemons, and PrivilegedHelperTools.
9. Homebrew cask metadata, App Store receipts, and PKG receipts.
10. Current-user macOS temporary directories.
11. Exact derived Keychain service names—never a general Keychain dump.

Other user accounts, external volumes, cloud data, subscriptions, OAuth grants, and remote sync state are outside the v1 scope.

## Package-manager behavior

### Homebrew casks

The cask registration remains untouched while files are quarantined. During purge, macpurge invokes the supported Homebrew uninstall flow. If Homebrew cleanup fails, the quarantine payload is retained.

### App Store applications

The local app receipt travels with the `.app` bundle. Purchase history and the App Store account are never modified.

### PKG installations

Only application-specific, strongly attributable payloads can be confirmed automatically. Potentially shared system paths remain review candidates. `pkgutil --forget` runs only after the purge workflow reaches its deferred-cleanup stage.

## Running applications

Before quarantine, macpurge detects running processes with the system `pgrep -fl` and verifies each candidate's executable against the bundle (including bundles installed through a symlink). It then requests a normal quit using the bundle ID and waits five seconds. If processes remain, it asks once for `SIGTERM` and once for `SIGKILL`—`--yes` approves both automatically for scripted runs. Non-interactive execution without `--yes` still refuses force termination.

A process lookup failure is reported as an error and stops the uninstall instead of being misread as "the application is not running."

## Non-interactive and JSON use

Mutation commands require exact confirmation when stdin is not a TTY. Purge now confirms the application name (not a raw UUID) after printing the session, and supports `--dry-run` before anything permanent:

```bash
macpurge uninstall "/Applications/Example.app" \
  --confirm "Example"

macpurge purge latest --dry-run
macpurge purge 4eb2f695 --confirm "Example"
macpurge uninstall vscode --yes --include-possible
```

JSON responses contain `schemaVersion`, `status`, `warnings`, and `errors`, plus command-specific data such as `app`, `candidates`, or `sessionId`:

```bash
macpurge scan "Example" --json | jq '.candidates[] | select(.risk == "confirmed")'
```

Exit codes are stable:

| Code | Meaning |
| :---: | --- |
| `0` | Success |
| `1` | Runtime failure |
| `2` | Invalid usage or rule |
| `3` | User cancelled |
| `4` | Partial operation; review or rollback required |
| `5` | Verification found residue |

## Custom rules

Place user profiles under `~/.config/macpurge/rules/*.json`:

```json
{
  "schemaVersion": 1,
  "id": "example-app",
  "bundleIds": ["com.example.application"],
  "platform": "darwin",
  "candidates": [
    {
      "pathTemplate": "{home}/Library/Application Support/Example",
      "kind": "application-support",
      "risk": "confirmed",
      "reason": "Application-owned user data"
    }
  ]
}
```

Allowed template tokens:

- `{home}`
- `{bundleId}`
- `{appName}`
- `{temp}`

Rules may describe only paths, classifications, reasons, and supported platform conditions. They cannot contain or execute arbitrary commands. Wildcards, traversal, unknown tokens, and protected-root matches are rejected.

Because user rules are untrusted input, additional policy applies to them:

- Rules targeting sensitive locations—`~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config`, package-manager and developer state such as `~/.cargo`, and broad source trees such as `~/Projects`—are rejected outright.
- Rules pointing into the macpurge support root (its own quarantine and session data) are rejected so a rule can never destroy the recovery path.
- A `confirmed` classification is honored only inside standard app-data locations (`~/Library/Application Support`, `Caches`, `Preferences`, and similar). Anything else is demoted to review (`possible`) and requires explicit opt-in.
- `kind`, `risk`, `platform`, and `bundleIds` are validated against the same domain vocabularies the scanner uses; bundle IDs must pass the canonical validator.

These checks run when a rule is loaded and again when the scanner expands it with the real application identity, so a display name cannot steer an expansion into a forbidden directory. Built-in profiles ship with the binary and are reviewed code; the demotion policy applies only to user rules.

Validate and explain rules before relying on them:

```bash
macpurge rules validate
macpurge rules list
macpurge rules explain "Visual Studio Code"
```

Built-in profiles currently cover Visual Studio Code and Floodtide. General bundle-based scanning works without an application-specific profile.

## Architecture

```text
src/
├── app-policy.ts       canonical Apple/bundle/display/keychain policy
├── apps.ts             application discovery and identity
├── clean.ts            system-wide cleanup categories and whitelist
├── cli.ts              thin routing plus runCli/default deps
├── cli-helpers.ts      shared CLI parsing, confirmations, and selection
├── command.ts          shell-free Bun.spawn command runner
├── interactive.ts      guided interactive flow
├── manifest-store.ts   atomic session persistence
├── processes.ts        verified process matching and quit handling
├── quarantine.ts       quarantine, restore, and purge transactions
├── rules.ts            built-in and user rule validation
├── safety.ts           path and mutation boundaries
├── scanner.ts          layered discovery and classification
├── system-paths.ts     approved local macOS roots
├── types.ts            public domain types and JSON contracts
├── ui.ts               color, layout, status, and terminal presentation
└── version.ts          single application version source
```

All external commands use argument arrays through `Bun.spawn({ cmd: [...] })`. User input is never interpolated into a shell command.

## Development

```bash
bun install
bun run check
bun test
bun run bench
bun run build
```

The suite uses temporary fake macOS roots and command-runner doubles. It does not uninstall real applications. Integration tests marked `real macOS process detection` compile a small helper binary into a fake bundle and verify process detection against the live system `pgrep`; they run on macOS with a compiler available and are skipped elsewhere. `bun run bench` measures scan wall time and per-command cost on a synthetic tree without changing scan behavior. Current coverage includes:

- ambiguous selectors and multiple same-name applications
- fuzzy selectors with suggestions on misses
- short session IDs and `latest` resolution
- clean category scans, whitelist persistence, and never-delete guards
- VS Code-style data, extensions, CLI links, and updater files
- protection of project `.vscode` directories
- ambiguous copies under another application's data
- Homebrew, App Store, and PKG scenarios
- symlink escape, traversal, roots, malformed rules, and permissions
- live process detection, argument-only decoys, symlinked bundles, and pgrep failure surfacing
- graceful quit, forced termination, and denied escalation
- symlink retargeting, file replacement, and file-type changes between scan and mutation
- partial movement and manifest continuity
- restore collisions and overwrite prevention, including redirected parent paths
- manifest status validation and state-transition rules
- rejection and demotion of unsafe user rules
- deduplicated size measurement across overlapping scan sources
- deferred irreversible actions
- JSON envelopes and exit codes
- standalone binary smoke checks

Continuous Integration runs on a macOS arm64 runner and executes `bun install --frozen-lockfile`, `bun run check`, `bun test`, `bun run build`, and a `--help`/`--version` smoke test of the built binary.

## Privacy

macpurge runs locally. It does not include network calls, telemetry, crash reporting, analytics, advertising, remote configuration, or an update service. Scans are limited to the current user and shared local system locations described above.

Keychain discovery is restricted to exact service names derived from the selected application. macpurge never enumerates or exports the user's complete Keychain.

## Troubleshooting

### The interface has no color

macpurge respects terminal capabilities and the [`NO_COLOR`](https://no-color.org/) convention. Check whether `NO_COLOR` is set in your shell environment.

### `doctor` reports administrator access as “On demand”

This is expected. macpurge does not install a privileged helper or cache its own credentials. macOS requests authorization only if a reviewed system-owned target needs it.

### `doctor` reports Trash as “Via Finder”

Also expected. Without Full Disk Access, macOS denies direct reads of `~/.Trash` even to its owner. macpurge inventories Trash through Finder instead. Grant Full Disk Access to the terminal (System Settings → Privacy & Security → Full Disk Access) for direct reads; Finder empty still works either way.

### Restore reports a destination collision

macpurge will not overwrite the existing path. Move or rename the conflicting file after reviewing it, then retry the restore session.

### A partial session cannot be purged

Review the manifest and restore the successfully moved files. macpurge blocks permanent purge while the transaction contains unresolved unmoved items.

## Inspiration

The terminal presentation was inspired by the clarity and energy of [Mole](https://github.com/tw93/Mole). macpurge is an independent TypeScript implementation focused specifically on evidence-based application removal, reversible quarantine, and explicit permanent cleanup.

## License

macpurge is available under the [MIT License](LICENSE). You may use, modify, distribute, and include it in commercial or private projects as long as the copyright and license notice are preserved. The software is provided without warranty.

## Disclaimer

Use this software at your own risk. Review every candidate and keep current backups. A public repository makes the source visible; it does not replace independent security review for a tool that changes local files.

---

<div align="center">

Built by [Mustafa Erpek](https://github.com/mustafaerpek) for careful Mac cleanup.

</div>
