import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { CommandRunner } from "./command";
import { inferKind, makeCandidate } from "./fs-utils";
import { isWithin } from "./safety";
import { applicationPids } from "./processes";
import { expandRulePath, loadRules, rulesForApp } from "./rules";
import {
  SCHEMA_VERSION,
  type AppIdentity,
  type Candidate,
  type DeferredAction,
  type Evidence,
  type RiskClass,
  type ScanResult,
  type SystemPaths,
} from "./types";

const RISK_WEIGHT: Record<RiskClass, number> = { possible: 1, confirmed: 2, protected: 3 };

function escapeMdfind(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function mergeCandidate(map: Map<string, Candidate>, candidate: Candidate): void {
  const key = resolve(candidate.path);
  const existing = map.get(key);
  if (!existing) {
    map.set(key, candidate);
    return;
  }
  existing.evidence.push(...candidate.evidence.filter((incoming) => !existing.evidence.some((current) => current.source === incoming.source && current.detail === incoming.detail)));
  if (RISK_WEIGHT[candidate.risk] > RISK_WEIGHT[existing.risk]) {
    existing.risk = candidate.risk;
    existing.selectedByDefault = candidate.risk === "confirmed";
  }
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
  const personalRoots = [join(paths.home, "Documents"), join(paths.home, "Desktop"), join(paths.home, "Downloads")];
  if (personalRoots.some((root) => isWithin(resolved, root)) || isWithin(resolved, "/Library/Developer")) return "protected";
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

async function addPathCandidate(
  map: Map<string, Candidate>,
  path: string,
  risk: RiskClass,
  evidence: Evidence,
  paths: SystemPaths,
  runner: CommandRunner,
): Promise<void> {
  if (isWithin(path, paths.supportRoot)) return;
  const candidate = await makeCandidate({ path, kind: inferKind(path), risk, evidence: [evidence], runner });
  if (candidate) mergeCandidate(map, candidate);
}

async function byHostPreferences(app: AppIdentity, paths: SystemPaths): Promise<string[]> {
  const root = join(paths.userLibrary, "Preferences", "ByHost");
  try {
    return (await readdir(root)).filter((name) => name.startsWith(`${app.bundleId}.`)).map((name) => join(root, name));
  } catch {
    return [];
  }
}

async function scanRuleCandidates(app: AppIdentity, paths: SystemPaths, runner: CommandRunner, map: Map<string, Candidate>): Promise<string[]> {
  const loaded = await loadRules(paths);
  for (const rule of rulesForApp(loaded.rules, app)) {
    for (const entry of rule.candidates) {
      const expanded = expandRulePath(entry.pathTemplate, app, paths);
      let matches = [expanded];
      if (entry.match === "prefix") {
        const parent = dirname(expanded);
        const prefix = basename(expanded);
        try {
          matches = (await readdir(parent)).filter((name) => name.startsWith(prefix)).map((name) => join(parent, name));
        } catch {
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
        const candidate = await makeCandidate({
          path,
          kind: entry.kind,
          risk: entry.risk,
          evidence: [{ source: "rule", detail: `${rule.id}: ${entry.reason}` }],
          runner,
        });
        if (candidate) mergeCandidate(map, candidate);
      }
    }
  }
  return loaded.warnings;
}

async function scanSymlinks(app: AppIdentity, paths: SystemPaths, runner: CommandRunner, map: Map<string, Candidate>): Promise<void> {
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
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(root, name);
      try {
        if (!(await lstat(path)).isSymbolicLink()) continue;
        const target = await realpath(path);
        if (!isWithin(target, appRoot)) continue;
        const candidate = await makeCandidate({
          path,
          kind: "cli-symlink",
          risk: "confirmed",
          evidence: [{ source: "symlink", detail: `Resolves inside ${app.path}` }],
          runner,
        });
        if (candidate) mergeCandidate(map, candidate);
      } catch {
        // Broken or racing symlinks are ignored.
      }
    }
  }
}

async function deepPaths(app: AppIdentity, paths: SystemPaths, runner: CommandRunner): Promise<string[]> {
  const roots = [paths.userLibrary, paths.systemLibrary, paths.temp];
  const escapeFindPattern = (value: string) => value.replaceAll("\\", "\\\\").replaceAll("*", "\\*").replaceAll("?", "\\?").replaceAll("[", "\\[");
  const patterns = [`*${escapeFindPattern(app.bundleId)}*`, `*${escapeFindPattern(app.displayName)}*`];
  const command = ["/usr/bin/find", ...roots, "-maxdepth", "8", "(", "-iname", patterns[0]!, "-o", "-iname", patterns[1]!, ")", "-print"];
  const result = await runner.run(command, { timeoutMs: 30_000 });
  return result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).slice(0, 500);
}

async function spotlightPaths(app: AppIdentity, runner: CommandRunner): Promise<string[]> {
  const query = `kMDItemCFBundleIdentifier == '${escapeMdfind(app.bundleId)}' || kMDItemFSName == '*${escapeMdfind(app.bundleId)}*'cd`;
  const result = await runner.run(["/usr/bin/mdfind", query], { timeoutMs: 15_000 });
  return result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).slice(0, 500);
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
  const knownServices: Record<string, string[]> = {
    "com.microsoft.VSCode": ["Code Safe Storage"],
  };
  const services = new Set([
    `${app.displayName} Safe Storage`,
    `${basename(app.path, ".app")} Safe Storage`,
    app.bundleId,
    ...(knownServices[app.bundleId] ?? []),
  ]);
  for (const service of services) {
    const result = await runner.run(["/usr/bin/security", "find-generic-password", "-s", service]);
    if (result.exitCode === 0) actions.push({ type: "keychain", value: service, description: `Delete Keychain service ${service}`, requiresAdmin: false });
  }
  const loginItems = await runner.run(["/usr/bin/osascript", "-e", "tell application \"System Events\" to get the name of every login item"]);
  const installedLoginItems = loginItems.stdout.split(",").map((name) => name.trim());
  for (const name of new Set([app.displayName, basename(app.path, ".app")])) {
    if (loginItems.exitCode === 0 && installedLoginItems.includes(name)) {
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

async function runtimeWarnings(app: AppIdentity, runner: CommandRunner): Promise<string[]> {
  const warnings: string[] = [];
  const pids = (await applicationPids(app, runner)).map(String);
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
  const map = new Map<string, Candidate>();
  const errors: string[] = [];
  const warnings = await scanRuleCandidates(app, paths, runner, map);
  warnings.push(...(await runtimeWarnings(app, runner)));

  await addPathCandidate(map, app.path, "confirmed", { source: "identity", detail: `Application bundle ${app.bundleId}` }, paths, runner);
  for (const item of standardPaths(app, paths)) {
    await addPathCandidate(map, item.path, item.risk, { source: "standard-path", detail: item.detail }, paths, runner);
  }
  for (const path of await byHostPreferences(app, paths)) {
    await addPathCandidate(map, path, "confirmed", { source: "standard-path", detail: "Bundle-specific ByHost preference" }, paths, runner);
  }
  await scanSymlinks(app, paths, runner, map);

  for (const path of await spotlightPaths(app, runner)) {
    await addPathCandidate(map, path, classifyDeepPath(path, app, paths), { source: "spotlight", detail: "Spotlight bundle/name match" }, paths, runner);
  }
  if (deep) {
    for (const path of await deepPaths(app, paths, runner)) {
      await addPathCandidate(map, path, classifyDeepPath(path, app, paths), { source: "deep-scan", detail: "Bounded bundle/name filesystem match" }, paths, runner);
    }
  }
  for (const path of await packagePayloads(app, runner)) {
    await addPathCandidate(map, path, path === app.path ? "confirmed" : "possible", { source: "receipt", detail: "Related package receipt payload" }, paths, runner);
  }

  const candidates = [...map.values()].sort((a, b) => {
    const riskOrder = { confirmed: 0, possible: 1, protected: 2 } as const;
    return riskOrder[a.risk] - riskOrder[b.risk] || a.path.localeCompare(b.path);
  });
  if (app.bundleId.startsWith("com.apple.")) {
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
