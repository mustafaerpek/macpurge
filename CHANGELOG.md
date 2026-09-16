# Changelog

All notable changes to macpurge are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.3.0] — 2026-09-16

### Added — `macpurge clean` is complete

System-wide cleanup without touching any installed app. Seven bounded
categories quarantine through the existing transaction model, so every
`clean` session restores and purges exactly like an uninstall session:

- `trash` — Finder inventory (count, names, physical size); emptied
  permanently via Finder's own command, never quarantined. Without Full
  Disk Access even the owner gets `EPERM` on `~/.Trash`; `doctor` reports
  `Direct read` vs `Via Finder` so the fallback is never a surprise.
- `user-caches`, `user-logs`, `browser-caches` (cache leaves only,
  profiles untouched), `xcode-derived-data`, `dev-caches`
  (`~/.npm`, `~/.bun`, `~/.cache/*`).
- `orphaned-leftovers` — bundle-style `Application Support` directories
  with no installed owner. `possible`, off by default; opened with
  `--all-categories`, `--category`, `--include <id>`, or the new
  `--include-possible` clean wiring.
- Hard never-delete guards: local model stores (`~/.ollama`,
  `~/.cache/huggingface`), AI chat/memory dirs (`.codex/sessions`,
  `.claude/projects`, `.grok/sessions`), dependency trees at any depth
  (`node_modules`, `Pods`, `venv`, …), and `com.apple.e5rt.e5bundlecache`.
- Whitelist at `~/.config/macpurge/clean-whitelist.json` (`0600`):
  repeatable `--whitelist <path|category-id>`, plus `--whitelist-list`
  and repeatable `--whitelist-remove <entry>`.
- Interactive flow: category picker with inline sizes, then an
  all-or-pick review picker for `possible` items — mirroring uninstall.
- Clean sessions quarantine under the synthetic `System Cleanup`
  identity (`macpurge.clean`); `history`, `restore latest`, and
  `purge latest` all work unchanged.

## [0.2.4] — 2026-09-16

### Fixed

- Root-owned bundles route through sudo: `parentNeedsAdmin` checks entry
  ownership, not just parent writability.
- Sandbox containers with a `com.apple.macl` lock (or an unlistable
  `Data/` dir) scan as `protected` with an explicit reason instead of
  failing mid-quarantine with `EPERM`.
- Quarantine/restore/purge spinners stay off during moves so the sudo
  password prompt inherits a clean terminal.
- Dangling symlinks no longer crash scans (`ENOENT` skip).
- Partial sessions print causes plus recovery steps; `purge --dry-run`
  previews instead of erroring twice.

## [0.2.3] — 2026-09-16

### Added — `macpurge clean` (first cut)

- Seven bounded categories (trash, user caches/logs, browser caches,
  Xcode DerivedData, dev caches, opt-in orphaned leftovers) quarantine
  through the existing transaction model.
- Hard never-delete guards for model stores, AI chat dirs, dependency
  trees, and `com.apple.e5rt.e5bundlecache`.
- Whitelist at `~/.config/macpurge/clean-whitelist.json`.
- Trash inventoried through Finder (`EPERM`-safe) and emptied
  permanently via Finder.

## [0.2.2] — 2026-09-16

### Fixed

- Interactive picker shows app size and install source inline on every
  row. Full browseable list restored with fuzzy filtering — no more
  focused-row-only hints.

## [0.2.1] — 2026-09-16

### Added — frictionless uninstall UX

- Fuzzy app selectors with suggestions, short-id/`latest` session
  aliases, `--yes`/`--confirm` everywhere, `--include-possible`,
  `--summary`, purge confirms the app name with a `--dry-run` preview,
  single-inventory interactive flow with next-step hints.

## [0.2.0] — 2026-09-05

Safety-first reversible macOS uninstaller: evidence-based scan,
confirmed/possible/protected classification, quarantine-first mutations,
deferred purge actions, stable JSON envelopes.
