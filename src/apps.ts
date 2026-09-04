import { readdir, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { AppIdentity, InstallSource, SystemPaths } from "./types";
import type { CommandRunner } from "./command";
import { appBaseName, pathExists } from "./fs-utils";

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
  if (!(await pathExists(root)) || depth > 2) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.name.toLowerCase().endsWith(".app") && (entry.isDirectory() || entry.isSymbolicLink())) result.push(path);
    else if (entry.isDirectory() && depth < 1) result.push(...(await discoverAppPaths(path, depth + 1)));
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
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]+$/u.test(bundleId) || bundleId.includes("..")) throw new AppSelectionError(`Application has an unsafe bundle identifier: ${bundleId}`);
  if (/[\/\0]/u.test(displayName) || displayName === "." || displayName === "..") throw new AppSelectionError(`Application has an unsafe display name: ${displayName}`);
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
    } catch {
      // Invalid bundles are intentionally omitted from the selectable list.
    }
  }
  return apps.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export async function selectApplication(selector: string, paths: SystemPaths, runner: CommandRunner): Promise<AppIdentity> {
  if (selector.startsWith("/")) return readAppIdentity(resolve(selector), paths, runner);
  const apps = await listApplications(paths, runner);
  const needle = selector.toLowerCase();
  const matches = apps.filter(
    (app) =>
      app.bundleId.toLowerCase() === needle ||
      app.displayName.toLowerCase() === needle ||
      appBaseName(app.path).toLowerCase() === needle,
  );
  if (matches.length === 0) throw new AppSelectionError(`No installed application matches: ${selector}`);
  if (matches.length > 1) throw new AppSelectionError(`Application selector is ambiguous: ${matches.map((app) => app.path).join(", ")}`);
  return matches[0]!;
}
