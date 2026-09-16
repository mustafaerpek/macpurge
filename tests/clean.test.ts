import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandResult, CommandRunner } from "../src/command";
import {
  addWhitelistCategory,
  addWhitelistPath,
  CLEAN_CATEGORIES,
  loadCleanWhitelist,
  removeWhitelistEntry,
  saveCleanWhitelist,
  scanClean,
  selectCleanItems,
} from "../src/clean";
import { testPaths } from "./helpers";

class CleanRunner implements CommandRunner {
  async run(command: readonly string[]): Promise<CommandResult> {
    if (command[0] === "/usr/bin/du") return { exitCode: 0, stdout: `4\t${command.at(-1)}\n`, stderr: "" };
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
    expect(result.categories.find((category) => category.id === "trash")?.itemCount).toBe(1);
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
});
