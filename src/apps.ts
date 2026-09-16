import { readdir, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { AppIdentity, InstallSource, SystemPaths } from "./types";
import type { CommandRunner } from "./command";
import { appBaseName, pathExists } from "./fs-utils";
import { isValidBundleId, isValidDisplayName } from "./app-policy";

export class AppSelectionError extends Error {
  override name = "AppSelectionError";
}

async function plistValue(path: string, key: string, runner: CommandRunner): Promise<string | undefined> {
  const result = await runner.run(["/usr/bin/plutil", "-extract", key, "raw", "-o", "-", path]);
  const value = result.stdout.trim();
  return result.exitCode === 0 && value ? value : undefined;
}

interface InstalledCask {
  token: string;
  names: string[];
  appNames: string[];
}

const caskCache = new WeakMap<CommandRunner, Promise<InstalledCask[]>>();
const receiptCache = new WeakMap<CommandRunner, Promise<string[]>>();

async function installedCasks(runner: CommandRunner): Promise<InstalledCask[]> {
  const cached = caskCache.get(runner);
  if (cached) return cached;
  const pending = (async () => {
    if (!(await runner.exists("brew"))) return [];
    const result = await runner.run(["brew", "info", "--cask", "--json=v2", "--installed"]);
    if (result.exitCode === 0) {
      try {
        const parsed = JSON.parse(result.stdout) as { casks?: Array<{ token?: string; name?: string[] | string; artifacts?: Array<Record<string, unknown>> }> };
        return (parsed.casks ?? []).flatMap((cask) => {
          if (!cask.token) return [];
          const names = Array.isArray(cask.name) ? cask.name : cask.name ? [cask.name] : [];
          const appNames = (cask.artifacts ?? []).flatMap((artifact) => {
            const value = artifact.app;
            return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
          });
          return [{ token: cask.token, names, appNames }];
        });
      } catch {
        // Fall through to the stable list command.
      }
    }
    const fallback = await runner.run(["brew", "list", "--cask"]);
    return fallback.exitCode === 0
      ? fallback.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).map((token) => ({ token, names: [], appNames: [] }))
      : [];
  })();
  caskCache.set(runner, pending);
  return pending;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
}

async function relatedReceipts(bundleId: string, displayName: string, runner: CommandRunner): Promise<string[]> {
  let pending = receiptCache.get(runner);
  if (!pending) {
    pending = runner.run(["/usr/sbin/pkgutil", "--pkgs"]).then((result) =>
      result.exitCode === 0 ? result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean) : [],
    );
    receiptCache.set(runner, pending);
  }
  const receipts = await pending;
  const bundle = bundleId.toLowerCase();
  const name = slug(displayName).replaceAll("-", "");
  return receipts.filter((line) => {
      const normalized = line.toLowerCase();
      return normalized.includes(bundle) || (name.length >= 5 && normalized.replace(/[^a-z0-9]/gu, "").includes(name));
    });
}

async function discoverAppPaths(root: string, depth = 0): Promise<string[]> {
  const MAX_WALK_DEPTH = 2;
  const MAX_NEST_LEVEL = 1;
  if (!(await pathExists(root)) || depth > MAX_WALK_DEPTH) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.name.toLowerCase().endsWith(".app") && (entry.isDirectory() || entry.isSymbolicLink())) result.push(path);
    else if (entry.isDirectory() && depth < MAX_NEST_LEVEL) result.push(...(await discoverAppPaths(path, depth + 1)));
  }
  return result;
}

export async function readAppIdentity(path: string, paths: SystemPaths, runner: CommandRunner): Promise<AppIdentity> {
  const requestedPath = resolve(path);
  if (![paths.applications, paths.userApplications].some((root) => requestedPath === resolve(root) || requestedPath.startsWith(`${resolve(root)}/`))) {
    throw new AppSelectionError(`Application is outside supported local application roots: ${path}`);
  }
  await realpath(requestedPath);
  const infoPlist = join(requestedPath, "Contents", "Info.plist");
  if (!(await pathExists(infoPlist))) throw new AppSelectionError(`Not a valid macOS application bundle: ${path}`);

  const bundleId = await plistValue(infoPlist, "CFBundleIdentifier", runner);
  if (!bundleId) throw new AppSelectionError(`Application has no CFBundleIdentifier: ${path}`);
  const displayName =
    (await plistValue(infoPlist, "CFBundleDisplayName", runner)) ??
    (await plistValue(infoPlist, "CFBundleName", runner)) ??
    appBaseName(path);
  if (!isValidBundleId(bundleId)) throw new AppSelectionError(`Application has an unsafe bundle identifier: ${bundleId}`);
  if (!isValidDisplayName(displayName)) throw new AppSelectionError(`Application has an unsafe display name: ${displayName}`);
  const version = await plistValue(infoPlist, "CFBundleShortVersionString", runner);

  const signature = await runner.run(["/usr/bin/codesign", "-dv", "--verbose=4", requestedPath]);
  const rawTeamId = signature.stderr.match(/^TeamIdentifier=(.+)$/mu)?.[1]?.trim();
  const teamId = rawTeamId && rawTeamId !== "not set" ? rawTeamId : undefined;
  const receipts = await relatedReceipts(bundleId, displayName, runner);
  const casks = await installedCasks(runner);
  const matchingCask = casks.find((cask) =>
    cask.token === slug(displayName) ||
    cask.token === slug(appBaseName(path)) ||
    cask.names.some((name) => name.toLowerCase() === displayName.toLowerCase()) ||
    cask.appNames.some((name) => name.toLowerCase() === basename(requestedPath).toLowerCase()),
  );
  const hasMasReceipt = await pathExists(join(requestedPath, "Contents", "_MASReceipt", "receipt"));
  let installSource: InstallSource = "standalone";
  let managerId: string | undefined;
  if (hasMasReceipt) installSource = "app-store";
  else if (matchingCask) {
    installSource = "homebrew";
    managerId = matchingCask.token;
  } else if (receipts.length > 0) installSource = "pkg";

  return {
    displayName,
    bundleId,
    ...(teamId ? { teamId } : {}),
    ...(version ? { version } : {}),
    path: requestedPath,
    installSource,
    ...(managerId ? { managerId } : {}),
    packageReceipts: receipts,
  };
}

export async function listApplications(paths: SystemPaths, runner: CommandRunner): Promise<AppIdentity[]> {
  const found = new Set([
    ...(await discoverAppPaths(paths.applications)),
    ...(await discoverAppPaths(paths.userApplications)),
  ]);
  const apps: AppIdentity[] = [];
  for (const path of [...found].sort()) {
    try {
      apps.push(await readAppIdentity(path, paths, runner));
    } catch (error) {
      // Invalid bundles are intentionally omitted from the selectable list.
      if (process.env.MACPURGE_DEBUG) console.warn(`Skipping invalid bundle ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return apps.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function scoreMatch(app: AppIdentity, needle: string): number {
  const query = needle.trim().toLowerCase();
  if (!query) return 0;
  const bundle = app.bundleId.toLowerCase();
  const display = app.displayName.toLowerCase();
  const base = appBaseName(app.path).toLowerCase();
  if (bundle === query || display === query || base === query) return 100;
  if (display.replace(/\s+/gu, "") === query.replace(/\s+/gu, "")) return 90;
  if (bundle.toLowerCase().startsWith(query) || display.startsWith(query) || base.startsWith(query)) return 70;
  if (bundle.includes(query) || display.includes(query) || base.includes(query)) return 50;
  const condensed = query.replace(/[^a-z0-9]/gu, "");
  if (condensed.length >= 2) {
    const haystacks = [bundle.replace(/[^a-z0-9]/gu, ""), display.replace(/[^a-z0-9]/gu, ""), base.replace(/[^a-z0-9]/gu, "")];
    if (haystacks.some((value) => value.includes(condensed))) return 40;
  }
  const tokens = query.split(/[^a-z0-9]+/gu).filter((token) => token.length >= 3);
  if (tokens.length > 0) {
    const haystack = `${bundle} ${display} ${base}`;
    const hits = tokens.filter((token) => haystack.includes(token)).length;
    if (hits > 0) return 10 + Math.round((30 * hits) / tokens.length);
  }
  return 0;
}

export function suggestApplications(apps: AppIdentity[], selector: string, limit = 3): AppIdentity[] {
  return [...apps]
    .map((app) => ({ app, score: scoreMatch(app, selector) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.app.displayName.localeCompare(b.app.displayName))
    .slice(0, limit)
    .map((entry) => entry.app);
}

export async function selectApplication(selector: string, paths: SystemPaths, runner: CommandRunner): Promise<AppIdentity> {
  if (selector.startsWith("/")) return readAppIdentity(resolve(selector), paths, runner);
  const apps = await listApplications(paths, runner);
  const needle = selector.toLowerCase();
  const exact = apps.filter(
    (app) =>
      app.bundleId.toLowerCase() === needle ||
      app.displayName.toLowerCase() === needle ||
      appBaseName(app.path).toLowerCase() === needle,
  );
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) throw new AppSelectionError(`Application selector is ambiguous: ${exact.map((app) => app.path).join(", ")}`);
  const ranked = suggestApplications(apps, selector, 5).filter((app) => !exact.includes(app));
  if (ranked.length === 1) return ranked[0]!;
  if (ranked.length > 1) throw new AppSelectionError(`Application selector is ambiguous: ${ranked.map((app) => `${app.displayName} (${app.bundleId})`).join(", ")}`);
  const suggestions = suggestApplications(apps, selector, 3);
  const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.map((app) => app.displayName).join(", ")}?` : "";
  throw new AppSelectionError(`No installed application matches: ${selector}.${hint}`);
}
