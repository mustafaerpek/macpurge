import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { CommandRunner } from "./command";
import { inferKind, makeCandidate } from "./fs-utils";
import { isPersonalProtectedPath, isWithin } from "./safety";
import {
  SCHEMA_VERSION,
  type AppIdentity,
  type Candidate,
  type CleanCategory,
  type CleanCategoryId,
  type CleanItem,
  type CleanResult,
  type Evidence,
  type RiskClass,
  type SystemPaths,
} from "./types";

export const CLEAN_CATEGORIES: readonly CleanCategory[] = [
  { id: "trash", title: "Trash", description: "Files already deleted by the user", selectedByDefault: true },
  { id: "user-caches", title: "User caches", description: "Regenerable per-app caches", selectedByDefault: true },
  { id: "user-logs", title: "User logs", description: "Rotatable application and diagnostic logs", selectedByDefault: true },
  { id: "browser-caches", title: "Browser caches", description: "Regenerable web caches (profile data untouched)", selectedByDefault: true },
  { id: "xcode-derived-data", title: "Xcode DerivedData", description: "Rebuildable Xcode build products and indexes", selectedByDefault: true },
  { id: "dev-caches", title: "Developer caches", description: "Regenerable tool caches, never dependency trees", selectedByDefault: true },
  { id: "orphaned-leftovers", title: "Orphaned leftovers", description: "Data of apps no longer installed", selectedByDefault: false },
];

const CLEAN_EVIDENCE: Record<CleanCategoryId, string> = {
  trash: "Already in Trash",
  "user-caches": "Regenerable user cache",
  "user-logs": "Rotatable log data",
  "browser-caches": "Regenerable browser cache",
  "xcode-derived-data": "Rebuildable Xcode derived data",
  "dev-caches": "Regenerable developer tool cache",
  "orphaned-leftovers": "Owning application is no longer installed",
};

// Hard never-delete list. AI-era weight lives here on purpose: local model
// stores use content-addressed blocks shared between models, and chat/memory
// directories hold irreplaceable conversation history. None of these may ever
// become a clean candidate, regardless of age or size.
const CLEAN_NEVER_DELETE: readonly string[][] = [
  ["home", ".ollama"],
  ["home", ".cache", "huggingface"],
  ["home", ".codex", "sessions"],
  ["home", ".claude", "projects"],
  ["home", ".grok", "sessions"],
];

// Dependency trees look like caches but are download-only: removing them on a
// plane or train leaves the user stuck. They are never clean candidates.
const CLEAN_NEVER_DEPENDENCY_DIRS = new Set(["node_modules", "pods", "venv", ".venv", "__pypackages__"]);

// Cache-looking directories whose contents are not actually safe to drop.
const CLEAN_NEVER_CACHE_NAMES = new Set(["com.apple.e5rt.e5bundlecache"]);

export interface CleanWhitelist {
  categories: CleanCategoryId[];
  paths: string[];
}

export async function loadCleanWhitelist(paths: SystemPaths): Promise<CleanWhitelist> {
  const empty: CleanWhitelist = { categories: [], paths: [] };
  let raw: string;
  try {
    raw = await readFile(paths.cleanWhitelistPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Clean whitelist is not valid JSON: ${paths.cleanWhitelistPath}`);
  }
  if (!parsed || typeof parsed !== "object") throw new Error(`Clean whitelist must be an object: ${paths.cleanWhitelistPath}`);
  const record = parsed as Record<string, unknown>;
  const categories = Array.isArray(record.categories) ? record.categories : [];
  const listed = Array.isArray(record.paths) ? record.paths : [];
  const known = new Set(CLEAN_CATEGORIES.map((category) => category.id));
  for (const id of categories) {
    if (typeof id !== "string" || !known.has(id as CleanCategoryId)) throw new Error(`Unknown clean category in whitelist: ${String(id)}`);
  }
  for (const entry of listed) {
    if (typeof entry !== "string" || entry.length === 0) throw new Error("Clean whitelist paths must be non-empty strings");
  }
  return { categories: categories as CleanCategoryId[], paths: listed as string[] };
}

export async function saveCleanWhitelist(paths: SystemPaths, whitelist: CleanWhitelist): Promise<void> {
  await mkdir(dirname(paths.cleanWhitelistPath), { recursive: true, mode: 0o700 });
  const payload = `${JSON.stringify({ categories: whitelist.categories, paths: whitelist.paths }, null, 2)}\n`;
  await writeFile(paths.cleanWhitelistPath, payload, { mode: 0o600 });
}

export function addWhitelistPath(whitelist: CleanWhitelist, entry: string): CleanWhitelist {
  if (whitelist.paths.includes(entry)) return whitelist;
  return { categories: whitelist.categories, paths: [...whitelist.paths, entry] };
}

export function addWhitelistCategory(whitelist: CleanWhitelist, id: CleanCategoryId): CleanWhitelist {
  if (whitelist.categories.includes(id)) return whitelist;
  return { categories: [...whitelist.categories, id], paths: whitelist.paths };
}

export function removeWhitelistEntry(whitelist: CleanWhitelist, entry: string): CleanWhitelist {
  return {
    categories: whitelist.categories.filter((id) => id !== entry),
    paths: whitelist.paths.filter((path) => path !== entry),
  };
}

function isNeverDelete(path: string, paths: SystemPaths): boolean {
  const resolved = resolve(path);
  for (const segments of CLEAN_NEVER_DELETE) {
    const [scope, ...rest] = segments as [string, ...string[]];
    const root = scope === "home" ? join(paths.home, ...rest) : join(paths.userLibrary, ...rest);
    if (isWithin(resolved, root)) return true;
  }
  const leaf = basename(resolved);
  if (CLEAN_NEVER_DEPENDENCY_DIRS.has(leaf)) return true;
  if (CLEAN_NEVER_CACHE_NAMES.has(leaf)) return true;
  const segments = relative(resolve(paths.home), resolved).split(sep).filter(Boolean);
  if (segments.some((segment) => CLEAN_NEVER_DEPENDENCY_DIRS.has(segment))) return true;
  return false;
}

function isWhitelisted(path: string, whitelist: CleanWhitelist, paths: SystemPaths): { hit: boolean; reason?: string } {
  const resolved = resolve(path);
  for (const entry of whitelist.paths) {
    const expanded = entry === "~" ? paths.home : entry.startsWith("~/") ? join(paths.home, entry.slice(2)) : entry;
    if (resolved === resolve(expanded) || isWithin(resolved, expanded)) {
      return { hit: true, reason: `matches whitelist entry ${entry}` };
    }
  }
  return { hit: false };
}

interface PlannedCleanItem {
  path: string;
  category: CleanCategoryId;
  risk: RiskClass;
  evidence: Evidence;
}

function planCleanItem(
  planned: Map<string, PlannedCleanItem>,
  input: { path: string; category: CleanCategoryId; risk: RiskClass; evidence: Evidence },
  paths: SystemPaths,
): void {
  const resolved = resolve(input.path);
  if (resolved === resolve(paths.home)) return;
  if (isWithin(resolved, paths.supportRoot)) return;
  if (isPersonalProtectedPath(resolved, paths)) return;
  if (isNeverDelete(resolved, paths)) return;
  const key = resolved;
  const existing = planned.get(key);
  if (!existing) {
    planned.set(key, { path: input.path, category: input.category, risk: input.risk, evidence: input.evidence });
    return;
  }
  if (existing.category !== input.category) return;
  if (!existing.evidence || (existing.evidence.source === input.evidence.source && existing.evidence.detail === input.evidence.detail)) return;
}

async function trashPaths(paths: SystemPaths): Promise<string[]> {
  const roots = [join(paths.home, ".Trash")];
  const found: string[] = [];
  for (const root of roots) {
    let names: string[];
    try {
      names = await readdir(root);
    } catch (error) {
      // Trash may be present but unreadable (TCC/EPERM): surface it as a
      // warning downstream rather than failing the whole scan.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(`cannot read Trash: ${(error as Error).message ?? String(error)}`);
    }
    for (const name of names) found.push(join(root, name));
  }
  return found;
}

async function childDirectories(root: string, includeHidden = false): Promise<string[]> {
  try {
    const names = await readdir(root);
    const result: string[] = [];
    for (const name of names) {
      if (!includeHidden && name.startsWith(".")) continue;
      const path = join(root, name);
      try {
        if ((await lstat(path)).isDirectory()) result.push(path);
      } catch (error) {
        // Unreadable entries (TCC/EPERM) are skipped individually; the rest of
        // the directory still scans. ENOENT races are skipped silently.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        continue;
      }
    }
    return result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function planUserCaches(planned: Map<string, PlannedCleanItem>, paths: SystemPaths): Promise<void> {
  for (const dir of await childDirectories(join(paths.userLibrary, "Caches"), true)) {
    if (isNeverDelete(dir, paths)) continue;
    const stack = [dir];
    let depth = 0;
    let blocked = false;
    while (stack.length > 0 && depth < 3) {
      const level = stack.splice(0);
      depth += 1;
      for (const current of level) {
        let names: string[] = [];
        try {
          names = await readdir(current);
        } catch {
          continue;
        }
        for (const name of names) {
          const path = join(current, name);
          if (isNeverDelete(path, paths)) {
            blocked = true;
            break;
          }
          if (depth < 3) {
            try {
              if ((await lstat(path)).isDirectory()) stack.push(path);
            } catch {
              continue;
            }
          }
        }
        if (blocked) break;
      }
    }
    if (blocked) continue;
    planCleanItem(planned, {
      path: dir,
      category: "user-caches",
      risk: "confirmed",
      evidence: { source: "clean-scan", detail: `${CLEAN_EVIDENCE["user-caches"]}: ${basename(dir)}` },
    }, paths);
  }
}

async function planUserLogs(planned: Map<string, PlannedCleanItem>, paths: SystemPaths): Promise<void> {
  for (const dir of await childDirectories(join(paths.userLibrary, "Logs"))) {
    planCleanItem(planned, {
      path: dir,
      category: "user-logs",
      risk: "confirmed",
      evidence: { source: "clean-scan", detail: `${CLEAN_EVIDENCE["user-logs"]}: ${basename(dir)}` },
    }, paths);
  }
  const diagnosticRoots = [join(paths.userLibrary, "Logs", "DiagnosticReports")];
  for (const root of diagnosticRoots) {
    try {
      for (const name of await readdir(root)) {
        const path = join(root, name);
        try {
          if ((await lstat(path)).isFile()) {
            planCleanItem(planned, {
              path,
              category: "user-logs",
              risk: "confirmed",
              evidence: { source: "clean-scan", detail: "Diagnostic report file" },
            }, paths);
          }
        } catch {
          continue;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

const BROWSER_CACHE_LEAVES = new Set(["Cache", "Code Cache", "GPUCache", "Service Worker", "Media Cache", "ShaderCache"]);

async function planBrowserCaches(planned: Map<string, PlannedCleanItem>, paths: SystemPaths): Promise<void> {
  const support = join(paths.userLibrary, "Application Support");
  let vendors: string[] = [];
  try {
    vendors = await readdir(support);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const vendor of vendors) {
    if (!/chrome|chromium|firefox|edge|brave|arc|opera|vivaldi|safari/i.test(vendor)) continue;
    const root = join(support, vendor);
    const stack = [root];
    let depth = 0;
    while (stack.length > 0 && depth < 4) {
      const current = stack.splice(0);
      depth += 1;
      for (const dir of current) {
        let names: string[] = [];
        try {
          names = await readdir(dir);
        } catch {
          continue;
        }
        for (const name of names) {
          const path = join(dir, name);
          if (BROWSER_CACHE_LEAVES.has(name)) {
            try {
              if ((await lstat(path)).isDirectory()) {
                planCleanItem(planned, {
                  path,
                  category: "browser-caches",
                  risk: "confirmed",
                  evidence: { source: "clean-scan", detail: `Regenerable browser cache leaf: ${vendor}/${name}` },
                }, paths);
              }
            } catch {
              continue;
            }
          } else if (depth < 4) {
            try {
              if ((await lstat(path)).isDirectory()) stack.push(path);
            } catch {
              continue;
            }
          }
        }
      }
    }
  }
}

async function planDerivedData(planned: Map<string, PlannedCleanItem>, paths: SystemPaths): Promise<void> {
  const root = join(paths.userLibrary, "Developer", "Xcode", "DerivedData");
  for (const dir of await childDirectories(root)) {
    planCleanItem(planned, {
      path: dir,
      category: "xcode-derived-data",
      risk: "confirmed",
      evidence: { source: "clean-scan", detail: `DerivedData project: ${basename(dir)}` },
    }, paths);
  }
}

async function planDevCaches(planned: Map<string, PlannedCleanItem>, paths: SystemPaths): Promise<void> {
  const homeEntries: Array<{ name: string; detail: string }> = [
    { name: ".npm", detail: "npm cache directory" },
    { name: ".bun", detail: "bun cache directory" },
    { name: ".cache", detail: "generic tool cache directory" },
  ];
  for (const entry of homeEntries) {
    const path = join(paths.home, entry.name);
    try {
      if (!(await lstat(path)).isDirectory()) continue;
    } catch {
      continue;
    }
    if (entry.name === ".cache") {
      for (const dir of await childDirectories(path)) {
        if (isNeverDelete(dir, paths)) continue;
        planCleanItem(planned, {
          path: dir,
          category: "dev-caches",
          risk: "confirmed",
          evidence: { source: "clean-scan", detail: `Regenerable tool cache: ${basename(dir)}` },
        }, paths);
      }
      continue;
    }
    planCleanItem(planned, {
      path,
      category: "dev-caches",
      risk: "confirmed",
      evidence: { source: "clean-scan", detail: entry.detail },
    }, paths);
  }
}

async function installedBundleIds(paths: SystemPaths, runner: CommandRunner): Promise<Set<string>> {
  const { listApplications } = await import("./apps");
  try {
    const apps = await listApplications(paths, runner);
    return new Set(apps.map((app) => app.bundleId.toLowerCase()));
  } catch {
    return new Set();
  }
}

async function planOrphanedLeftovers(
  planned: Map<string, PlannedCleanItem>,
  paths: SystemPaths,
  runner: CommandRunner,
  warnings: string[],
): Promise<void> {
  let installed: Set<string>;
  try {
    installed = await installedBundleIds(paths, runner);
  } catch (error) {
    warnings.push(`Orphaned leftover scan skipped: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const support = join(paths.userLibrary, "Application Support");
  let names: string[] = [];
  try {
    names = await readdir(support);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnings.push(`Could not read Application Support: ${String(error)}`);
    return;
  }
  for (const name of names) {
    if (!name.includes(".")) continue;
    if (installed.has(name.toLowerCase())) continue;
    const path = join(support, name);
    try {
      if (!(await lstat(path)).isDirectory()) continue;
    } catch {
      continue;
    }
    planCleanItem(planned, {
      path,
      category: "orphaned-leftovers",
      risk: "possible",
      evidence: { source: "clean-scan", detail: `Bundle-style directory without an installed app: ${name}` },
    }, paths);
  }
}

export interface CleanScanOptions {
  categories?: CleanCategoryId[];
  includeOrphans?: boolean;
}

export async function scanCleanTargets(
  paths: SystemPaths,
  runner: CommandRunner,
  options: CleanScanOptions = {},
): Promise<{ planned: PlannedCleanItem[]; warnings: string[]; errors: string[] }> {
  const warnings: string[] = [];
  const errors: string[] = [];
  const planned = new Map<string, PlannedCleanItem>();
  const selected = new Set(options.categories ?? CLEAN_CATEGORIES.map((category) => category.id));
  const run = async (id: CleanCategoryId, work: () => Promise<void>): Promise<void> => {
    if (!selected.has(id)) return;
    try {
      await work();
    } catch (error) {
      errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  if (selected.has("trash")) {
    let trash: string[];
    try {
      trash = await trashPaths(paths);
    } catch (error) {
      errors.push(`trash: ${error instanceof Error ? error.message : String(error)}`);
      trash = [];
    }
    for (const path of trash) {
      planCleanItem(planned, {
        path,
        category: "trash",
        risk: "confirmed",
        evidence: { source: "clean-scan", detail: CLEAN_EVIDENCE.trash },
      }, paths);
    }
  }
  await run("user-caches", () => planUserCaches(planned, paths));
  await run("user-logs", () => planUserLogs(planned, paths));
  await run("browser-caches", () => planBrowserCaches(planned, paths));
  await run("xcode-derived-data", () => planDerivedData(planned, paths));
  await run("dev-caches", () => planDevCaches(planned, paths));
  if (options.includeOrphans !== false) await run("orphaned-leftovers", () => planOrphanedLeftovers(planned, paths, runner, warnings));
  return { planned: [...planned.values()], warnings, errors };
}

const MATERIALIZE_CONCURRENCY = 8;

export async function materializeCleanItems(
  planned: PlannedCleanItem[],
  paths: SystemPaths,
  runner: CommandRunner,
  whitelist: CleanWhitelist,
): Promise<{ items: CleanItem[]; skipped: Array<{ path: string; reason: string }> }> {
  const items: CleanItem[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  const categoryById = new Map(CLEAN_CATEGORIES.map((category) => [category.id, category]));
  let next = 0;
  const workers = Array.from({ length: Math.min(MATERIALIZE_CONCURRENCY, Math.max(planned.length, 1)) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= planned.length) return;
      const entry = planned[index]!;
      const gate = isWhitelisted(entry.path, whitelist, paths);
      if (gate.hit) {
        skipped.push({ path: entry.path, reason: gate.reason ?? "whitelisted" });
        continue;
      }
      if (whitelist.categories.includes(entry.category)) {
        skipped.push({ path: entry.path, reason: `category ${entry.category} is whitelisted` });
        continue;
      }
      const candidate = await makeCandidate({ path: entry.path, kind: inferKind(entry.path), risk: entry.risk, evidence: [entry.evidence], runner });
      if (!candidate) continue;
      if (candidate.risk === "protected") continue;
      const meta = categoryById.get(entry.category);
      items.push({
        ...candidate,
        risk: entry.risk,
        selectedByDefault: meta?.selectedByDefault ?? entry.risk === "confirmed",
        category: entry.category,
        categoryTitle: meta?.title ?? entry.category,
      });
    }
  });
  await Promise.all(workers);
  items.sort((a, b) => a.category.localeCompare(b.category) || a.path.localeCompare(b.path));
  return { items, skipped };
}

export async function scanClean(
  paths: SystemPaths,
  runner: CommandRunner,
  options: CleanScanOptions = {},
): Promise<CleanResult> {
  const whitelist = await loadCleanWhitelist(paths).catch((error) => {
    throw error;
  });
  const { planned, warnings, errors } = await scanCleanTargets(paths, runner, options);
  const { items, skipped } = await materializeCleanItems(planned, paths, runner, whitelist);
  for (const entry of skipped) warnings.push(`Skipped ${entry.path}: ${entry.reason}`);
  const totals = new Map<CleanCategoryId, { itemCount: number; totalBytes: number }>();
  for (const item of items) {
    const total = totals.get(item.category) ?? { itemCount: 0, totalBytes: 0 };
    total.itemCount += 1;
    total.totalBytes += item.sizeBytes;
    totals.set(item.category, total);
  }
  const categories = CLEAN_CATEGORIES.filter((category) => options.categories === undefined || options.categories.includes(category.id)).map((category) => ({
    ...category,
    itemCount: totals.get(category.id)?.itemCount ?? 0,
    totalBytes: totals.get(category.id)?.totalBytes ?? 0,
  }));
  return {
    schemaVersion: SCHEMA_VERSION,
    status: items.length > 0 ? "found" : "clean",
    categories,
    items,
    warnings,
    errors,
  };
}

export function cleanIdentity(): AppIdentity {
  return {
    displayName: "System Cleanup",
    bundleId: "macpurge.clean",
    path: "/Applications/macpurge-clean",
    installSource: "standalone",
    packageReceipts: [],
  };
}

export function selectCleanItems(items: CleanItem[], categories: CleanCategoryId[], ids: string[]): CleanItem[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const enabled = new Set(categories);
  const selected = items.filter((item) => enabled.has(item.category));
  for (const id of ids) {
    const item = byId.get(id);
    if (!item) throw new Error(`Unknown clean item id: ${id}`);
    if (!selected.some((entry) => entry.id === item.id)) selected.push(item);
  }
  return selected;
}
