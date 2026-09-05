import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { CommandRunner } from "./command";
import { inferKind, makeCandidate } from "./fs-utils";
import { isPersonalProtectedPath, isWithin } from "./safety";
import { candidateKeychainServices, isProtectedAppleApp } from "./app-policy";
import { applicationPids, loginItemExists } from "./processes";
import { assessRulePath, expandRulePath, loadRules, rulesForApp } from "./rules";
import {
  SCHEMA_VERSION,
  type AppIdentity,
  type Candidate,
  type CandidateKind,
  type DeferredAction,
  type Evidence,
  type RiskClass,
  type ScanResult,
  type SystemPaths,
} from "./types";

const RISK_ORDER: Record<RiskClass, number> = { confirmed: 0, possible: 1, protected: 2 };

const MAX_SPOTLIGHT_RESULTS = 500;
const MAX_DEEP_RESULTS = 500;
const FIND_MAXDEPTH = 8;
const FIND_TIMEOUT_MS = 30_000;
const MDFIND_TIMEOUT_MS = 15_000;
// Upper bound on concurrent lstat/du work while materializing the deduplicated
// plan; keeps a large scan from spawning dozens of simultaneous subprocesses.
const MATERIALIZE_CONCURRENCY = 8;

function escapeMdfind(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

interface PlannedCandidate {
  kind: CandidateKind;
  risk: RiskClass;
  evidence: Evidence[];
}

// Candidates are planned (deduplicated by resolved path) before any expensive
// filesystem work, so a path reported by several sources is measured once.
function mergePlanned(map: Map<string, PlannedCandidate>, path: string, kind: CandidateKind, risk: RiskClass, evidence: Evidence): void {
  const key = resolve(path);
  const existing = map.get(key);
  if (!existing) {
    map.set(key, { kind, risk, evidence: [evidence] });
    return;
  }
  if (!existing.evidence.some((current) => current.source === evidence.source && current.detail === evidence.detail)) {
    existing.evidence.push(evidence);
  }
  // Conservative upgrade: protected wins over everything; confirmed wins over
  // possible. Display order is RISK_ORDER (confirmed first), so the upgrade
  // rule is explicit rather than a numeric max.
  const shouldUpgrade =
    (risk === "protected" && existing.risk !== "protected") ||
    (existing.risk === "possible" && risk === "confirmed");
  if (shouldUpgrade) {
    existing.risk = risk;
  }
}

async function materializeCandidates(map: Map<string, PlannedCandidate>, runner: CommandRunner): Promise<Candidate[]> {
  const entries = [...map.entries()];
  const results: Array<Candidate | undefined> = new Array(entries.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(MATERIALIZE_CONCURRENCY, entries.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= entries.length) return;
      const [path, planned] = entries[index]!;
      results[index] = await makeCandidate({ path, kind: planned.kind, risk: planned.risk, evidence: planned.evidence, runner });
    }
  });
  await Promise.all(workers);
  return results.filter((value): value is Candidate => value !== undefined);
}

function standardPaths(app: AppIdentity, paths: SystemPaths): Array<{ path: string; risk: RiskClass; detail: string }> {
  const name = app.displayName;
  const id = app.bundleId;
  return [
    { path: join(paths.userLibrary, "Application Support", name), risk: "confirmed", detail: "Exact application support name" },
    { path: join(paths.userLibrary, "Application Support", id), risk: "confirmed", detail: "Exact bundle application support" },
    { path: join(paths.userLibrary, "Caches", id), risk: "confirmed", detail: "Exact bundle cache" },
    { path: join(paths.userLibrary, "HTTPStorages", id), risk: "confirmed", detail: "Exact bundle HTTP storage" },
    { path: join(paths.userLibrary, "HTTPStorages", `${id}.binarycookies`), risk: "confirmed", detail: "Exact bundle HTTP cookies" },
    { path: join(paths.userLibrary, "Preferences", `${id}.plist`), risk: "confirmed", detail: "Exact bundle preferences" },
    { path: join(paths.userLibrary, "Saved Application State", `${id}.savedState`), risk: "confirmed", detail: "Exact bundle saved state" },
    { path: join(paths.userLibrary, "WebKit", id), risk: "confirmed", detail: "Exact bundle WebKit data" },
    { path: join(paths.userLibrary, "Containers", id), risk: "confirmed", detail: "Exact sandbox container" },
    { path: join(paths.userLibrary, "Application Scripts", id), risk: "confirmed", detail: "Exact sandbox scripts" },
    { path: join(paths.userLibrary, "Logs", name), risk: "confirmed", detail: "Exact application log directory" },
  ];
}

function classifyDeepPath(path: string, app: AppIdentity, paths: SystemPaths): RiskClass {
  const resolved = resolve(path);
  if (isPersonalProtectedPath(resolved, paths)) return "protected";
  if (resolved === resolve(app.path)) return "confirmed";

  const leaf = basename(resolved).toLowerCase();
  const strong = leaf === app.bundleId.toLowerCase() || leaf.startsWith(`${app.bundleId.toLowerCase()}.`);
  const standardParents = [
    join(paths.userLibrary, "Caches"),
    join(paths.userLibrary, "Preferences"),
    join(paths.userLibrary, "HTTPStorages"),
    join(paths.userLibrary, "Saved Application State"),
    join(paths.userLibrary, "Containers"),
    join(paths.systemLibrary, "LaunchAgents"),
    join(paths.systemLibrary, "LaunchDaemons"),
    join(paths.systemLibrary, "PrivilegedHelperTools"),
  ];
  if (strong && standardParents.some((root) => isWithin(resolved, root))) return "confirmed";

  const appSupport = join(paths.userLibrary, "Application Support");
  if (isWithin(resolved, appSupport)) {
    const rel = relative(appSupport, resolved).split(sep).filter(Boolean);
    if (rel.length > 1 && rel[0]?.toLowerCase() !== app.displayName.toLowerCase() && rel[0]?.toLowerCase() !== app.bundleId.toLowerCase()) {
      return "possible";
    }
  }
  return "possible";
}

function planPathCandidate(
  map: Map<string, PlannedCandidate>,
  path: string,
  risk: RiskClass,
  evidence: Evidence,
  paths: SystemPaths,
): void {
  if (isWithin(path, paths.supportRoot)) return;
  mergePlanned(map, path, inferKind(path), risk, evidence);
}

async function byHostPreferences(app: AppIdentity, paths: SystemPaths, warnings: string[]): Promise<string[]> {
  const root = join(paths.userLibrary, "Preferences", "ByHost");
  try {
    return (await readdir(root)).filter((name) => name.startsWith(`${app.bundleId}.`)).map((name) => join(root, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnings.push(`Could not read ByHost preferences: ${String(error)}`);
    return [];
  }
}

async function scanRuleCandidates(app: AppIdentity, paths: SystemPaths, map: Map<string, PlannedCandidate>, warnings: string[]): Promise<void> {
  const loaded = await loadRules(paths);
  for (const rule of rulesForApp(loaded.rules, app)) {
    for (const entry of rule.candidates) {
      let expanded: string;
      try {
        expanded = expandRulePath(entry.pathTemplate, app, paths);
      } catch (error) {
        // A crafted display name could expand a template into a forbidden
        // location; skip the entry instead of aborting the whole scan.
        warnings.push(`Rule ${rule.id} entry ${entry.pathTemplate} could not be expanded: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      let matches = [expanded];
      if (entry.match === "prefix") {
        const parent = dirname(expanded);
        const prefix = basename(expanded);
        try {
          matches = (await readdir(parent)).filter((name) => name.startsWith(prefix)).map((name) => join(parent, name));
        } catch (error) {
          warnings.push(`Rule ${rule.id} prefix match failed for ${parent}: ${String(error)}`);
          matches = [];
        }
      }
      for (const path of matches) {
        if (entry.requiresSymlinkIntoApp) {
          try {
            const info = await lstat(path);
            const target = await realpath(path);
            if (!info.isSymbolicLink() || !isWithin(target, app.path)) continue;
          } catch {
            continue;
          }
        }
        // Re-assess the real expansion: validation only saw the sample tokens.
        const verdict = assessRulePath(path, paths, entry.risk, rule.origin);
        if (!verdict.allowed) {
          warnings.push(`Rule ${rule.id} skipped ${path}: ${verdict.reason}`);
          continue;
        }
        mergePlanned(map, path, entry.kind, verdict.risk, { source: "rule", detail: `${rule.id}: ${entry.reason}` });
      }
    }
  }
  for (const warning of loaded.warnings) warnings.push(warning);
}

async function scanSymlinks(app: AppIdentity, paths: SystemPaths, map: Map<string, PlannedCandidate>, warnings: string[]): Promise<void> {
  let appRoot = app.path;
  try {
    appRoot = await realpath(app.path);
  } catch {
    // Verification can scan an app that has already been quarantined.
  }
  for (const root of paths.binRoots) {
    let names: string[] = [];
    try {
      names = await readdir(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnings.push(`Could not read bin root ${root}: ${String(error)}`);
      continue;
    }
    for (const name of names) {
      const path = join(root, name);
      try {
        if (!(await lstat(path)).isSymbolicLink()) continue;
        const target = await realpath(path);
        if (!isWithin(target, appRoot)) continue;
        mergePlanned(map, path, "cli-symlink", "confirmed", { source: "symlink", detail: `Resolves inside ${app.path}` });
      } catch {
        // Broken or racing symlinks are ignored.
      }
    }
  }
}

async function deepPaths(app: AppIdentity, paths: SystemPaths, runner: CommandRunner, errors: string[]): Promise<string[]> {
  const roots = [paths.userLibrary, paths.systemLibrary, paths.temp];
  const escapeFindPattern = (value: string) => value.replaceAll("\\", "\\\\").replaceAll("*", "\\*").replaceAll("?", "\\?").replaceAll("[", "\\[");
  const patterns = [`*${escapeFindPattern(app.bundleId)}*`, `*${escapeFindPattern(app.displayName)}*`];
  const command = ["/usr/bin/find", ...roots, "-maxdepth", String(FIND_MAXDEPTH), "(", "-iname", patterns[0]!, "-o", "-iname", patterns[1]!, ")", "-print"];
  const result = await runner.run(command, { timeoutMs: FIND_TIMEOUT_MS });
  // find exits 1 when some directories were unreadable but the listing is
  // still meaningful; anything else means the scan did not really run.
  if (result.exitCode > 1) errors.push(`Deep filesystem scan failed: find exited with code ${result.exitCode}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}`);
  return result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).slice(0, MAX_DEEP_RESULTS);
}

async function spotlightPaths(app: AppIdentity, runner: CommandRunner, warnings: string[]): Promise<string[]> {
  const query = `kMDItemCFBundleIdentifier == '${escapeMdfind(app.bundleId)}' || kMDItemFSName == '*${escapeMdfind(app.bundleId)}*'cd`;
  const result = await runner.run(["/usr/bin/mdfind", query], { timeoutMs: MDFIND_TIMEOUT_MS });
  if (result.exitCode !== 0) warnings.push(`Spotlight scan exited with code ${result.exitCode}; results may be incomplete`);
  return result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).slice(0, MAX_SPOTLIGHT_RESULTS);
}

async function packagePayloads(app: AppIdentity, runner: CommandRunner): Promise<string[]> {
  const results: string[] = [];
  for (const receipt of app.packageReceipts) {
    const listed = await runner.run(["/usr/sbin/pkgutil", "--files", receipt]);
    if (listed.exitCode !== 0) continue;
    for (const relativePath of listed.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)) {
      if (relativePath.split("/").includes("..")) continue;
      if (!relativePath.startsWith("Applications/") && !relativePath.startsWith("Library/")) continue;
      const absolute = resolve("/", relativePath);
      if (absolute === app.path || basename(absolute).toLowerCase().includes(app.displayName.toLowerCase())) results.push(absolute);
    }
  }
  return results;
}

async function deferredActions(app: AppIdentity, runner: CommandRunner): Promise<DeferredAction[]> {
  const actions: DeferredAction[] = [
    { type: "tcc", value: app.bundleId, description: `Reset local privacy permissions for ${app.bundleId}`, requiresAdmin: false },
    { type: "preferences-domain", value: app.bundleId, description: `Delete cached preferences domain ${app.bundleId}`, requiresAdmin: false },
  ];
  const services = new Set(candidateKeychainServices(app));
  for (const service of services) {
    const result = await runner.run(["/usr/bin/security", "find-generic-password", "-s", service]);
    if (result.exitCode === 0) actions.push({ type: "keychain", value: service, description: `Delete Keychain service ${service}`, requiresAdmin: false });
  }
  for (const name of new Set([app.displayName, basename(app.path, ".app")])) {
    if (await loginItemExists(name, runner)) {
      actions.push({ type: "login-item", value: name, description: `Delete login item ${name}`, requiresAdmin: false });
    }
  }
  if (app.installSource === "homebrew" && app.managerId) {
    actions.push({ type: "homebrew-cask", value: app.managerId, description: `Unregister Homebrew cask ${app.managerId}`, requiresAdmin: false });
  }
  for (const receipt of app.packageReceipts) {
    actions.push({ type: "pkg-receipt", value: receipt, description: `Forget package receipt ${receipt}`, requiresAdmin: true });
  }
  return actions;
}

async function runtimeWarnings(app: AppIdentity, runner: CommandRunner, errors: string[]): Promise<string[]> {
  const warnings: string[] = [];
  let pids: string[] = [];
  try {
    pids = (await applicationPids(app, runner)).map(String);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (pids.length > 0) warnings.push(`RUNTIME_RESIDUE: running process IDs: ${pids.join(", ")}`);

  const background = await runner.run(["/usr/bin/sfltool", "dumpbtm"]);
  if (background.exitCode === 0 && background.stdout.includes(app.bundleId)) {
    warnings.push(`RUNTIME_RESIDUE: background item registration references ${app.bundleId}`);
  }
  const launchctl = await runner.run(["/bin/launchctl", "print", `gui/${process.getuid?.() ?? 0}`]);
  if (launchctl.exitCode === 0 && launchctl.stdout.includes(app.bundleId)) {
    warnings.push(`RUNTIME_RESIDUE: launchctl registration references ${app.bundleId}`);
  }
  return warnings;
}

export async function scanApplication(app: AppIdentity, paths: SystemPaths, runner: CommandRunner, deep = true): Promise<ScanResult> {
  const map = new Map<string, PlannedCandidate>();
  const errors: string[] = [];
  const warnings: string[] = [];
  await scanRuleCandidates(app, paths, map, warnings);
  warnings.push(...(await runtimeWarnings(app, runner, errors)));

  planPathCandidate(map, app.path, "confirmed", { source: "identity", detail: `Application bundle ${app.bundleId}` }, paths);
  for (const item of standardPaths(app, paths)) {
    planPathCandidate(map, item.path, item.risk, { source: "standard-path", detail: item.detail }, paths);
  }
  for (const path of await byHostPreferences(app, paths, warnings)) {
    planPathCandidate(map, path, "confirmed", { source: "standard-path", detail: "Bundle-specific ByHost preference" }, paths);
  }
  await scanSymlinks(app, paths, map, warnings);

  for (const path of await spotlightPaths(app, runner, warnings)) {
    planPathCandidate(map, path, classifyDeepPath(path, app, paths), { source: "spotlight", detail: "Spotlight bundle/name match" }, paths);
  }
  if (deep) {
    for (const path of await deepPaths(app, paths, runner, errors)) {
      planPathCandidate(map, path, classifyDeepPath(path, app, paths), { source: "deep-scan", detail: "Bounded bundle/name filesystem match" }, paths);
    }
  }
  for (const path of await packagePayloads(app, runner)) {
    planPathCandidate(map, path, path === app.path ? "confirmed" : "possible", { source: "receipt", detail: "Related package receipt payload" }, paths);
  }

  const candidates = (await materializeCandidates(map, runner)).sort((a, b) => {
    return RISK_ORDER[a.risk] - RISK_ORDER[b.risk] || a.path.localeCompare(b.path);
  });
  if (isProtectedAppleApp(app)) {
    for (const candidate of candidates) {
      candidate.risk = "protected";
      candidate.selectedByDefault = false;
      candidate.evidence.push({ source: "identity", detail: "Apple system application protection" });
    }
    warnings.push("Apple system applications are scan-only and cannot be removed by macpurge.");
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    status: candidates.length > 0 ? "found" : "clean",
    app,
    candidates,
    deferredActions: await deferredActions(app, runner),
    warnings,
    errors,
  };
}
