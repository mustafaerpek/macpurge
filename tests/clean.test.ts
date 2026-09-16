import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandResult, CommandRunner } from "../src/command";
import { QuarantineService } from "../src/quarantine";
import { pathExists } from "../src/fs-utils";
import {
  addWhitelistCategory,
  addWhitelistPath,
  CLEAN_CATEGORIES,
  cleanIdentity,
  emptyTrash,
  loadCleanWhitelist,
  removeWhitelistEntry,
  saveCleanWhitelist,
  scanClean,
  selectCleanItems,
  trashInventory,
} from "../src/clean";
import { testPaths } from "./helpers";

class CleanRunner implements CommandRunner {
  constructor(private readonly trashNames: string[] = ["old.txt"]) {}

  async run(command: readonly string[]): Promise<CommandResult> {
    if (command[0] === "/usr/bin/du") return { exitCode: 0, stdout: `4\t${command.at(-1)}\n`, stderr: "" };
    if (command[0] === "/usr/bin/osascript" && command.at(-1)?.includes("name of every item of trash")) {
      return { exitCode: 0, stdout: `${this.trashNames.join(", ")}\n`, stderr: "" };
    }
    if (command[0] === "/usr/bin/osascript" && command.at(-1)?.includes("count items of trash")) {
      return { exitCode: 0, stdout: `${this.trashNames.length}\n`, stderr: "" };
    }
    if (command[0] === "/usr/bin/osascript" && command.at(-1)?.includes("physical size of trash")) {
      return { exitCode: 0, stdout: "4096\n", stderr: "" };
    }
    if (command[0] === "/usr/bin/osascript" && command.at(-1)?.includes("empty trash")) {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 127, stdout: "", stderr: "" };
  }

  async exists(): Promise<boolean> {
    return false;
  }
}

async function trashFixture(): Promise<ReturnType<typeof testPaths>> {
  const paths = await testPaths();
  await mkdir(join(paths.home, ".Trash"), { recursive: true });
  await writeFile(join(paths.home, ".Trash", "old.txt"), "trash");
  await mkdir(join(paths.userLibrary, "Caches", "com.example.app"), { recursive: true });
  await writeFile(join(paths.userLibrary, "Caches", "com.example.app", "data"), "cache");
  return paths;
}

describe("clean scanner", () => {
  test("finds trash and user caches with evidence", async () => {
    const paths = await trashFixture();
    const result = await scanClean(paths, new CleanRunner(), { categories: ["trash", "user-caches"], includeOrphans: false });
    expect(result.status).toBe("found");
    expect(result.items.some((item) => item.category === "trash")).toBeTrue();
    expect(result.items.some((item) => item.category === "user-caches")).toBeTrue();
    expect(result.items.every((item) => item.evidence.some((entry) => entry.source === "clean-scan"))).toBeTrue();
    expect(result.trashInventory?.count).toBe(1);
    expect(result.warnings.some((warning) => warning.includes("Emptying is permanent"))).toBeTrue();
  });

  test("reads Trash through Finder and empties it on request", async () => {
    const paths = await testPaths();
    const inventory = await trashInventory(new CleanRunner(["a.txt", "b.txt"]));
    expect(inventory.count).toBe(2);
    expect(inventory.names).toEqual(["a.txt", "b.txt"]);
    expect(inventory.totalBytes).toBe(4096);
    expect(inventory.unavailable).toBeFalse();
    expect((await emptyTrash(new CleanRunner())).emptied).toBeTrue();
    const denied = await trashInventory(new (class implements CommandRunner {
      async run(): Promise<CommandResult> { return { exitCode: 1, stdout: "", stderr: "denied" }; }
      async exists(): Promise<boolean> { return false; }
    })());
    expect(denied.unavailable).toBeTrue();
    void paths;
  });

  test("never offers model stores, chat history, or dependency trees", async () => {
    const paths = await testPaths();
    const forbidden = [
      join(paths.home, ".ollama", "models", "blob"),
      join(paths.home, ".cache", "huggingface", "model.bin"),
      join(paths.home, ".codex", "sessions", "chat.json"),
      join(paths.home, ".claude", "projects", "chat.json"),
      join(paths.userLibrary, "Caches", "com.apple.e5rt.e5bundlecache"),
      join(paths.userLibrary, "Caches", "com.example.app", "node_modules"),
    ];
    for (const path of forbidden) {
      await mkdir(path, { recursive: true });
      await writeFile(join(path, "payload"), "x");
    }
    const result = await scanClean(paths, new CleanRunner(), { categories: ["user-caches"], includeOrphans: false });
    expect(result.items.length).toBe(0);
    expect(result.status).toBe("clean");
  });

  test("whitelist persistence skips paths and categories", async () => {
    const paths = await trashFixture();
    const cacheDir = join(paths.userLibrary, "Caches", "com.example.app");
    await saveCleanWhitelist(paths, addWhitelistPath({ categories: [], paths: [] }, cacheDir));
    await saveCleanWhitelist(paths, await loadCleanWhitelist(paths).then((current) => addWhitelistCategory(current, "trash")));
    const loaded = await loadCleanWhitelist(paths);
    expect(loaded.paths).toContain(cacheDir);
    expect(loaded.categories).toContain("trash");
    const result = await scanClean(paths, new CleanRunner(), { categories: ["trash", "user-caches"], includeOrphans: false });
    expect(result.items.some((item) => item.path === cacheDir)).toBeFalse();
    expect(result.items.some((item) => item.category === "trash")).toBeFalse();
    expect(result.warnings.some((warning) => warning.includes("whitelist"))).toBeTrue();
    const reduced = removeWhitelistEntry(loaded, "trash");
    expect(reduced.categories).not.toContain("trash");
  });

  test("rejects invalid whitelist files", async () => {
    const paths = await testPaths();
    await mkdir(join(paths.home, ".config", "macpurge"), { recursive: true });
    await writeFile(paths.cleanWhitelistPath, "{not-json");
    await expect(loadCleanWhitelist(paths)).rejects.toThrow("not valid JSON");
    await writeFile(paths.cleanWhitelistPath, JSON.stringify({ categories: ["nope"], paths: [] }));
    await expect(loadCleanWhitelist(paths)).rejects.toThrow("Unknown clean category");
  });

  test("category allowlist and selectCleanItems scope the plan", async () => {
    const paths = await trashFixture();
    const result = await scanClean(paths, new CleanRunner(), { categories: ["trash"], includeOrphans: false });
    expect(result.items.every((item) => item.category === "trash")).toBeTrue();
    expect(result.categories.map((category) => category.id)).toEqual(["trash"]);
    const selected = selectCleanItems(result.items, ["trash"], []);
    expect(selected.length).toBe(result.items.length);
    expect(() => selectCleanItems(result.items, ["trash"], ["missing"])).toThrow("Unknown clean item id");
  });

  test("orphaned leftovers are opt-in and skip installed owners", async () => {
    const paths = await testPaths();
    const support = join(paths.userLibrary, "Application Support");
    await mkdir(join(support, "com.example.gone"), { recursive: true });
    await writeFile(join(support, "com.example.gone", "data"), "x");
    const without = await scanClean(paths, new CleanRunner(), { includeOrphans: false });
    expect(without.items.some((item) => item.category === "orphaned-leftovers")).toBeFalse();
    const withOrphans = await scanClean(paths, new CleanRunner(), { categories: ["orphaned-leftovers"] });
    expect(withOrphans.items.some((item) => item.category === "orphaned-leftovers" && item.risk === "possible")).toBeTrue();
    expect(CLEAN_CATEGORIES.some((category) => category.id === "orphaned-leftovers" && !category.selectedByDefault)).toBeTrue();
  });

  test("review items stay out unless --include-possible or --include", async () => {
    const paths = await testPaths();
    const support = join(paths.userLibrary, "Application Support");
    await mkdir(join(support, "com.example.gone"), { recursive: true });
    await writeFile(join(support, "com.example.gone", "data"), "x");
    const result = await scanClean(paths, new CleanRunner(), { categories: ["orphaned-leftovers"] });
    expect(result.items.length).toBeGreaterThan(0);
    expect(selectCleanItems(result.items, ["orphaned-leftovers"], []).length).toBe(0);
    expect(selectCleanItems(result.items, ["orphaned-leftovers"], [], true).length).toBe(result.items.length);
    const one = selectCleanItems(result.items, ["orphaned-leftovers"], [result.items[0]!.id]);
    expect(one.map((item) => item.id)).toContain(result.items[0]!.id);
    expect(() => selectCleanItems(result.items, ["orphaned-leftovers"], [], false).length).not.toThrow();
  });

  test("clean quarantine round-trips through restore", async () => {
    const paths = await testPaths();
    const cacheDir = join(paths.userLibrary, "Caches", "com.example.app");
    const logDir = join(paths.userLibrary, "Logs", "Example");
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, "data"), "cache");
    await mkdir(logDir, { recursive: true });
    await writeFile(join(logDir, "app.log"), "log");
    const runner = new CleanRunner([]);
    const result = await scanClean(paths, runner, { categories: ["user-caches", "user-logs"], includeOrphans: false });
    const selected = selectCleanItems(result.items, ["user-caches", "user-logs"], [], true);
    expect(selected.length).toBe(2);
    const service = new QuarantineService(paths, runner);
    const manifest = await service.quarantine(cleanIdentity(), selected, []);
    expect(manifest.status).toBe("quarantined");
    expect(manifest.app.bundleId).toBe("macpurge.clean");
    expect(await pathExists(cacheDir)).toBeFalse();
    expect(await pathExists(logDir)).toBeFalse();
    const reloaded = await service.store.load(manifest.id);
    expect(reloaded.status).toBe("quarantined");
    const restored = await service.restore(manifest.id);
    expect(restored.status).toBe("restored");
    expect(await pathExists(join(cacheDir, "data"))).toBeTrue();
    expect(await pathExists(join(logDir, "app.log"))).toBeTrue();
    const purged = await service.quarantine(cleanIdentity(), selected, []);
    expect(purged.status).toBe("quarantined");
    const wiped = await service.purge(purged.id);
    expect(wiped.status).toBe("purged");
  });

  test("whitelist add/remove round-trips through save and load", async () => {
    const paths = await testPaths();
    let whitelist = await loadCleanWhitelist(paths);
    expect(whitelist.categories).toEqual([]);
    whitelist = addWhitelistCategory(whitelist, "user-logs");
    whitelist = addWhitelistPath(whitelist, "~/Library/Caches/com.example.keep");
    whitelist = addWhitelistPath(whitelist, "~/Library/Caches/com.example.keep");
    expect(whitelist.paths.length).toBe(1);
    await saveCleanWhitelist(paths, whitelist);
    const reloaded = await loadCleanWhitelist(paths);
    expect(reloaded.categories).toContain("user-logs");
    expect(reloaded.paths).toContain("~/Library/Caches/com.example.keep");
    const reduced = removeWhitelistEntry(removeWhitelistEntry(reloaded, "user-logs"), "~/Library/Caches/com.example.keep");
    expect(reduced.categories).toEqual([]);
    expect(reduced.paths).toEqual([]);
    await saveCleanWhitelist(paths, reduced);
    expect((await loadCleanWhitelist(paths)).paths).toEqual([]);
  });
});
