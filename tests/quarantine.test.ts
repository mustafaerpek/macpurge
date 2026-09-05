import { describe, expect, test } from "bun:test";
import { mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
      await rename(command[3]!, command[4]!);
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
    await expect(service.quarantine(app, [protectedCandidate], [])).rejects.toThrow("Protected candidates");
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
    expect(runner.calls.some((command) => command[0] === "/usr/bin/sudo" && command[1] === "/bin/mv" && command[2] === "-n" && command[3] === adminCandidate.path)).toBeTrue();
  });

  test("records partial movement and refuses to purge unmoved items", async () => {
    const { service, app, candidates, supportPath } = await fixture();
    await rm(supportPath, { recursive: true });
    const manifest = await service.quarantine(app, candidates, []);
    expect(manifest.status).toBe("partial");
    expect(manifest.items.some((item) => item.status === "failed")).toBeTrue();
    await expect(service.purge(manifest.id)).rejects.toThrow("unmoved items");
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
    await expect(service.purge(manifest.id)).rejects.toThrow("does not match");
  });

  test("rejects unknown deferred action types on load", async () => {
    const { paths, service, app, candidates } = await fixture();
    const manifest = await service.quarantine(app, candidates, [
      { type: "tcc", value: app.bundleId, description: "Reset TCC", requiresAdmin: false },
    ]);
    const manifestPath = join(paths.sessionRoot, `${manifest.id}.json`);
    const tampered = JSON.parse(await readFile(manifestPath, "utf8")) as typeof manifest;
    (tampered.deferredActions[0] as unknown as { type: string }).type = "unknown-action";
    await writeFile(manifestPath, JSON.stringify(tampered));
    await expect(service.purge(manifest.id)).rejects.toThrow("Unknown deferred action");
  });

  test("fails explicitly when runDeferred receives an unknown action", async () => {
    const { paths } = await fixture();
    const service = new QuarantineService(paths, new RecordingRunner());
    const unknown = { type: "unknown-action", value: "x", description: "Unknown", requiresAdmin: false } as never;
    await expect((service as unknown as { runDeferred: (a: never) => Promise<string | undefined> }).runDeferred(unknown)).rejects.toThrow("Unknown deferred action");
  });

  test("fails the move when a symlink target changes between scan and mutation", async () => {
    const paths = await testPaths();
    const runner = new BunCommandRunner();
    const targetA = join(paths.userLibrary, "Caches", "target-a");
    const targetB = join(paths.userLibrary, "Caches", "target-b");
    const link = join(paths.userLibrary, "Application Support", "Example");
    await Promise.all([mkdir(targetA, { recursive: true }), mkdir(targetB, { recursive: true }), mkdir(dirname(link), { recursive: true })]);
    await symlink(targetA, link);
    const candidate = await makeCandidate({ path: link, kind: "application-support", risk: "confirmed", evidence: [{ source: "standard-path", detail: "test" }], runner });
    await rm(link);
    await symlink(targetB, link);

    const app: AppIdentity = { displayName: "Example", bundleId: "com.example.app", path: join(paths.applications, "Example.app"), installSource: "standalone", packageReceipts: [] };
    const manifest = await new QuarantineService(paths, runner).quarantine(app, [candidate!], []);
    expect(manifest.status).toBe("partial");
    expect(manifest.items[0]?.error).toContain("changed since scan");
    // The original symlink target must be untouched.
    expect(await pathExists(targetA)).toBeTrue();
  });

  test("fails the move when the file is replaced between scan and mutation", async () => {
    const paths = await testPaths();
    const runner = new BunCommandRunner();
    const file = join(paths.userLibrary, "Preferences", "com.example.app.plist");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "v1");
    const candidate = await makeCandidate({ path: file, kind: "preference", risk: "confirmed", evidence: [{ source: "standard-path", detail: "test" }], runner });
    await rm(file);
    await writeFile(file, "v1");

    const app: AppIdentity = { displayName: "Example", bundleId: "com.example.app", path: join(paths.applications, "Example.app"), installSource: "standalone", packageReceipts: [] };
    const manifest = await new QuarantineService(paths, runner).quarantine(app, [candidate!], []);
    expect(manifest.status).toBe("partial");
    expect(manifest.items[0]?.error).toContain("inode mismatch");
  });

  test("fails the move when the file type changes between scan and mutation", async () => {
    const paths = await testPaths();
    const runner = new BunCommandRunner();
    const file = join(paths.userLibrary, "Preferences", "com.example.type.plist");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "v1");
    const candidate = await makeCandidate({ path: file, kind: "preference", risk: "confirmed", evidence: [{ source: "standard-path", detail: "test" }], runner });
    await rm(file);
    await mkdir(file);

    const app: AppIdentity = { displayName: "Example", bundleId: "com.example.app", path: join(paths.applications, "Example.app"), installSource: "standalone", packageReceipts: [] };
    const manifest = await new QuarantineService(paths, runner).quarantine(app, [candidate!], []);
    expect(manifest.status).toBe("partial");
    expect(manifest.items[0]?.error).toContain("File type changed");
  });

  test("rejects a manifest whose session status was tampered with", async () => {
    const { service, paths, app, candidates } = await fixture();
    const manifest = await service.quarantine(app, candidates, []);
    const manifestPath = join(paths.sessionRoot, `${manifest.id}.json`);
    const raw = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    raw.status = "banana";
    await writeFile(manifestPath, JSON.stringify(raw));
    await expect(service.restore(manifest.id)).rejects.toThrow("status is invalid");
  });

  test("rejects a manifest whose item status was tampered with", async () => {
    const { service, paths, app, candidates } = await fixture();
    const manifest = await service.quarantine(app, candidates, []);
    const manifestPath = join(paths.sessionRoot, `${manifest.id}.json`);
    const raw = JSON.parse(await readFile(manifestPath, "utf8")) as { items: Array<{ status: string }> };
    raw.items[0]!.status = "teleported";
    await writeFile(manifestPath, JSON.stringify(raw));
    await expect(service.restore(manifest.id)).rejects.toThrow("item status is invalid");
  });

  test("rejects restore when the manifest points outside supported roots", async () => {
    const { service, paths, app, candidates } = await fixture();
    const manifest = await service.quarantine(app, candidates, []);
    const manifestPath = join(paths.sessionRoot, `${manifest.id}.json`);
    const raw = JSON.parse(await readFile(manifestPath, "utf8")) as { items: Array<{ originalPath: string }> };
    raw.items[0]!.originalPath = "/etc/evil";
    await writeFile(manifestPath, JSON.stringify(raw));
    await expect(service.restore(manifest.id)).rejects.toThrow();
  });
});
