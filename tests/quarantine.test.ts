import { describe, expect, test } from "bun:test";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BunCommandRunner, type CommandResult, type CommandRunner } from "../src/command";
import { makeCandidate, pathExists } from "../src/fs-utils";
import { collapseCandidates, QuarantineService } from "../src/quarantine";
import type { AppIdentity, Candidate } from "../src/types";
import { testPaths } from "./helpers";

class RecordingRunner implements CommandRunner {
  readonly calls: string[][] = [];
  constructor(private readonly failHomebrew = false) {}

  async run(command: readonly string[]): Promise<CommandResult> {
    this.calls.push([...command]);
    if (command[0] === "/usr/bin/sudo" && command[1] === "/bin/mkdir") {
      await mkdir(command.at(-1)!, { recursive: true });
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command[0] === "/usr/bin/sudo" && command[1] === "/bin/mv") {
      await rename(command[2]!, command[3]!);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command[0] === "/usr/bin/sudo" && command[1] === "/bin/rm") {
      await rm(command.at(-1)!, { recursive: true, force: true });
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command[0] === "brew" && command[1] === "list") return { exitCode: 0, stdout: "fixture\n", stderr: "" };
    if (command[0] === "brew" && command[1] === "uninstall") return { exitCode: this.failHomebrew ? 1 : 0, stdout: "", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  async exists(): Promise<boolean> {
    return true;
  }
}

async function fixture() {
  const paths = await testPaths();
  const runner = new BunCommandRunner();
  const appPath = join(paths.applications, "Example.app");
  const supportPath = join(paths.userLibrary, "Application Support", "Example");
  await mkdir(join(appPath, "Contents"), { recursive: true });
  await mkdir(supportPath, { recursive: true });
  await writeFile(join(appPath, "Contents", "data"), "app");
  await writeFile(join(supportPath, "settings.json"), "{}");
  const app: AppIdentity = { displayName: "Example", bundleId: "com.example.app", path: appPath, installSource: "standalone", packageReceipts: [] };
  const candidates = (await Promise.all([
    makeCandidate({ path: appPath, kind: "application", risk: "confirmed", evidence: [{ source: "identity", detail: "test" }], runner }),
    makeCandidate({ path: supportPath, kind: "application-support", risk: "confirmed", evidence: [{ source: "standard-path", detail: "test" }], runner }),
  ])).filter((value): value is Candidate => value !== undefined);
  return { paths, runner, appPath, supportPath, app, candidates, service: new QuarantineService(paths, runner) };
}

describe("quarantine transactions", () => {
  test("collapses nested candidates", async () => {
    const { candidates, appPath, runner } = await fixture();
    const nestedPath = join(appPath, "Contents");
    const nested = await makeCandidate({ path: nestedPath, kind: "other", risk: "possible", evidence: [{ source: "deep-scan", detail: "nested" }], runner });
    expect(collapseCandidates([...candidates, nested!]).some((item) => item.path === nestedPath)).toBeFalse();
  });

  test("quarantines and restores without data loss", async () => {
    const { service, app, candidates, appPath, supportPath } = await fixture();
    const manifest = await service.quarantine(app, candidates, []);
    expect(manifest.status).toBe("quarantined");
    expect(await pathExists(appPath)).toBeFalse();
    expect(await pathExists(supportPath)).toBeFalse();
    for (const item of manifest.items) expect(await pathExists(item.quarantinePath)).toBeTrue();

    const restored = await service.restore(manifest.id);
    expect(restored.status).toBe("restored");
    expect(await pathExists(appPath)).toBeTrue();
    expect(await pathExists(supportPath)).toBeTrue();
  });

  test("restore refuses to overwrite an existing destination", async () => {
    const { service, app, candidates, appPath } = await fixture();
    const manifest = await service.quarantine(app, candidates, []);
    await mkdir(appPath, { recursive: true });
    const restored = await service.restore(manifest.id);
    expect(restored.status).toBe("partial");
    expect(restored.errors.some((error) => error.includes("already exists"))).toBeTrue();
  });

  test("purge permanently deletes payload but retains history manifest", async () => {
    const { service, app, candidates } = await fixture();
    const manifest = await service.quarantine(app, candidates, []);
    const purged = await service.purge(manifest.id);
    expect(purged.status).toBe("purged");
    for (const item of purged.items) expect(await pathExists(item.quarantinePath)).toBeFalse();
    expect((await service.store.load(manifest.id)).status).toBe("purged");
  });

  test("rejects protected candidates at the service boundary", async () => {
    const { service, app, candidates } = await fixture();
    const protectedCandidate = { ...candidates[0]!, risk: "protected" as const, selectedByDefault: false };
    expect(service.quarantine(app, [protectedCandidate], [])).rejects.toThrow("Protected candidates");
  });

  test("defers irreversible actions until purge", async () => {
    const { paths, app, candidates } = await fixture();
    const runner = new RecordingRunner();
    const service = new QuarantineService(paths, runner);
    const manifest = await service.quarantine(app, candidates, [
      { type: "tcc", value: app.bundleId, description: "Reset TCC", requiresAdmin: false },
    ]);
    expect(runner.calls.some((command) => command.includes("tccutil"))).toBeFalse();
    await service.purge(manifest.id);
    expect(runner.calls.some((command) => command[0] === "/usr/bin/tccutil")).toBeTrue();
  });

  test("uses argument arrays for admin moves", async () => {
    const { paths, app, candidates } = await fixture();
    const runner = new RecordingRunner();
    const service = new QuarantineService(paths, runner);
    const adminCandidate = { ...candidates[0]!, requiresAdmin: true };
    const manifest = await service.quarantine(app, [adminCandidate], []);
    expect(manifest.status).toBe("quarantined");
    expect(runner.calls.some((command) => command[0] === "/usr/bin/sudo" && command[1] === "/bin/mv" && command[2] === adminCandidate.path)).toBeTrue();
  });

  test("records partial movement and refuses to purge unmoved items", async () => {
    const { service, app, candidates, supportPath } = await fixture();
    await rm(supportPath, { recursive: true });
    const manifest = await service.quarantine(app, candidates, []);
    expect(manifest.status).toBe("partial");
    expect(manifest.items.some((item) => item.status === "failed")).toBeTrue();
    expect(service.purge(manifest.id)).rejects.toThrow("unmoved items");
  });

  test("keeps quarantine payload when Homebrew cleanup fails", async () => {
    const { paths, app, candidates } = await fixture();
    const runner = new RecordingRunner(true);
    const service = new QuarantineService(paths, runner);
    const managedApp = { ...app, installSource: "homebrew" as const, managerId: "example" };
    const manifest = await service.quarantine(managedApp, candidates, [
      { type: "homebrew-cask", value: "example", description: "Remove cask", requiresAdmin: false },
    ]);
    const purged = await service.purge(manifest.id);
    expect(purged.status).toBe("partial");
    expect(purged.errors[0]).toContain("failed");
    expect(await pathExists(purged.items[0]!.quarantinePath)).toBeTrue();
  });

  test("rejects a tampered deferred action before purge", async () => {
    const { paths, service, app, candidates } = await fixture();
    const manifest = await service.quarantine(app, candidates, [
      { type: "tcc", value: app.bundleId, description: "Reset TCC", requiresAdmin: false },
    ]);
    const manifestPath = join(paths.sessionRoot, `${manifest.id}.json`);
    const tampered = JSON.parse(await readFile(manifestPath, "utf8")) as typeof manifest;
    tampered.deferredActions[0]!.value = "com.example.other";
    await writeFile(manifestPath, JSON.stringify(tampered));
    expect(service.purge(manifest.id)).rejects.toThrow("does not match");
  });
});
