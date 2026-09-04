import { describe, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandResult, CommandRunner } from "../src/command";
import { listApplications, readAppIdentity, selectApplication } from "../src/apps";
import { testPaths } from "./helpers";

class IdentityRunner implements CommandRunner {
  constructor(
    private readonly plist: Record<string, Record<string, string>>,
    private readonly options: { casks?: unknown[]; receipts?: string[] } = {},
  ) {}

  async run(command: readonly string[]): Promise<CommandResult> {
    if (command[0] === "/usr/bin/plutil") {
      const key = command[2]!;
      const path = command.at(-1)!;
      const app = Object.keys(this.plist).find((name) => path.includes(`/${name}.app/`));
      const value = app ? this.plist[app]?.[key] : undefined;
      return value ? { exitCode: 0, stdout: `${value}\n`, stderr: "" } : { exitCode: 1, stdout: "", stderr: "missing" };
    }
    if (command[0] === "/usr/bin/codesign") return { exitCode: 0, stdout: "", stderr: "TeamIdentifier=TEAM123\n" };
    if (command[0] === "/usr/sbin/pkgutil" && command[1] === "--pkgs") {
      return { exitCode: 0, stdout: `${(this.options.receipts ?? []).join("\n")}\n`, stderr: "" };
    }
    if (command[0] === "brew" && command[1] === "info") {
      return { exitCode: 0, stdout: JSON.stringify({ casks: this.options.casks ?? [] }), stderr: "" };
    }
    return { exitCode: 1, stdout: "", stderr: "" };
  }

  async exists(command: string): Promise<boolean> {
    return command === "brew" && this.options.casks !== undefined;
  }
}

async function fakeApp(path: string): Promise<void> {
  await mkdir(join(path, "Contents"), { recursive: true });
  await writeFile(join(path, "Contents", "Info.plist"), "fixture");
}

describe("application discovery", () => {
  test("ignores regular files while walking application roots", async () => {
    const paths = await testPaths();
    await writeFile(join(paths.applications, ".DS_Store"), "metadata");
    const appPath = join(paths.applications, "Example.app");
    await fakeApp(appPath);
    const runner = new IdentityRunner({ Example: { CFBundleIdentifier: "com.example.app", CFBundleDisplayName: "Example" } });
    expect(await listApplications(paths, runner)).toHaveLength(1);
  });

  test("detects Homebrew casks from installed artifact metadata", async () => {
    const paths = await testPaths();
    const appPath = join(paths.applications, "Example.app");
    await fakeApp(appPath);
    const runner = new IdentityRunner(
      { Example: { CFBundleIdentifier: "com.example.app", CFBundleDisplayName: "Example", CFBundleShortVersionString: "1.2.3" } },
      { casks: [{ token: "different-token", name: ["Example"], artifacts: [{ app: ["Example.app"] }] }] },
    );
    const app = await readAppIdentity(appPath, paths, runner);
    expect(app.installSource).toBe("homebrew");
    expect(app.managerId).toBe("different-token");
    expect(app.teamId).toBe("TEAM123");
  });

  test("App Store receipt takes precedence and symlinked app entries are accepted", async () => {
    const paths = await testPaths();
    const staged = join(paths.home, "Caskroom", "StoreExample.app");
    await fakeApp(staged);
    await mkdir(join(staged, "Contents", "_MASReceipt"), { recursive: true });
    await writeFile(join(staged, "Contents", "_MASReceipt", "receipt"), "receipt");
    const visible = join(paths.applications, "StoreExample.app");
    await symlink(staged, visible);
    const runner = new IdentityRunner({ StoreExample: { CFBundleIdentifier: "com.example.store", CFBundleDisplayName: "StoreExample" } });
    const apps = await listApplications(paths, runner);
    expect(apps).toHaveLength(1);
    expect(apps[0]?.path).toBe(visible);
    expect(apps[0]?.installSource).toBe("app-store");
  });

  test("detects PKG receipts and rejects ambiguous names", async () => {
    const paths = await testPaths();
    const first = join(paths.applications, "First.app");
    const second = join(paths.userApplications, "Second.app");
    await fakeApp(first);
    await fakeApp(second);
    const runner = new IdentityRunner(
      {
        First: { CFBundleIdentifier: "com.vendor.first", CFBundleDisplayName: "Shared Name" },
        Second: { CFBundleIdentifier: "com.vendor.second", CFBundleDisplayName: "Shared Name" },
      },
      { receipts: ["com.vendor.first.pkg"] },
    );
    expect((await readAppIdentity(first, paths, runner)).installSource).toBe("pkg");
    expect(selectApplication("Shared Name", paths, runner)).rejects.toThrow("ambiguous");
  });

  test("rejects explicit applications outside supported roots", async () => {
    const paths = await testPaths();
    const outside = join(paths.home, "Desktop", "Outside.app");
    await fakeApp(outside);
    const runner = new IdentityRunner({ Outside: { CFBundleIdentifier: "com.example.outside", CFBundleDisplayName: "Outside" } });
    expect(readAppIdentity(outside, paths, runner)).rejects.toThrow("outside supported");
  });
});
