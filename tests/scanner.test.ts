import { describe, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandResult, CommandRunner } from "../src/command";
import type { AppIdentity } from "../src/types";
import { scanApplication } from "../src/scanner";
import { testPaths } from "./helpers";

class ScannerRunner implements CommandRunner {
  constructor(
    private readonly findOutput: string[] = [],
    private readonly options: { keychainServices?: string[]; loginItems?: string[]; backgroundBundleId?: string } = {},
  ) {}

  async run(command: readonly string[]): Promise<CommandResult> {
    if (command[0] === "/usr/bin/find") return { exitCode: 0, stdout: `${this.findOutput.join("\n")}\n`, stderr: "" };
    if (command[0] === "/usr/bin/du") return { exitCode: 0, stdout: `1\t${command.at(-1)}\n`, stderr: "" };
    if (command[0] === "/usr/bin/mdfind") return { exitCode: 0, stdout: "", stderr: "" };
    if (command[0] === "/usr/bin/osascript") return { exitCode: 0, stdout: `${(this.options.loginItems ?? ["Other App", "Raycast"]).join(", ")}\n`, stderr: "" };
    if (command[0] === "/usr/bin/security") {
      const found = (this.options.keychainServices ?? []).includes(command.at(-1) ?? "");
      return { exitCode: found ? 0 : 44, stdout: "", stderr: found ? "" : "not found" };
    }
    if (command[0] === "/usr/bin/sfltool") return { exitCode: 0, stdout: this.options.backgroundBundleId ?? "", stderr: "" };
    if (command[0] === "/usr/sbin/pkgutil") return { exitCode: 1, stdout: "", stderr: "" };
    return { exitCode: 127, stdout: "", stderr: "" };
  }

  async exists(): Promise<boolean> {
    return false;
  }
}

describe("application scanner", () => {
  test("classifies exact bundle data, project settings, nested copies, and app symlinks", async () => {
    const paths = await testPaths();
    const appPath = join(paths.applications, "Example.app");
    const executable = join(appPath, "Contents", "MacOS", "Example");
    const cache = join(paths.userLibrary, "Caches", "com.example.app");
    const projectSettings = join(paths.home, "Documents", "Project", ".vscode");
    const nestedCopy = join(paths.userLibrary, "Application Support", "Updater", "com.example.app-backup", "Example.app");
    const cli = join(paths.binRoots[0]!, "example");
    await Promise.all([
      mkdir(join(appPath, "Contents", "MacOS"), { recursive: true }),
      mkdir(cache, { recursive: true }),
      mkdir(projectSettings, { recursive: true }),
      mkdir(nestedCopy, { recursive: true }),
    ]);
    await writeFile(executable, "binary");
    await symlink(executable, cli);
    const app: AppIdentity = {
      displayName: "Example",
      bundleId: "com.example.app",
      path: appPath,
      installSource: "standalone",
      packageReceipts: [],
    };
    const scan = await scanApplication(app, paths, new ScannerRunner([cache, projectSettings, nestedCopy]), true);
    expect(scan.candidates.find((item) => item.path === appPath)?.risk).toBe("confirmed");
    expect(scan.candidates.find((item) => item.path === cache)?.risk).toBe("confirmed");
    expect(scan.candidates.find((item) => item.path === projectSettings)?.risk).toBe("protected");
    expect(scan.candidates.find((item) => item.path === nestedCopy)?.risk).toBe("possible");
    expect(scan.candidates.find((item) => item.path === cli)?.risk).toBe("confirmed");
  });

  test("built-in VS Code rule finds official hidden data without selecting project settings", async () => {
    const paths = await testPaths();
    const appPath = join(paths.applications, "Visual Studio Code.app");
    const extensions = join(paths.home, ".vscode");
    const shared = join(paths.home, ".vscode-shared");
    const projectSettings = join(paths.home, "Documents", "Project", ".vscode");
    await Promise.all([mkdir(appPath, { recursive: true }), mkdir(extensions, { recursive: true }), mkdir(shared, { recursive: true }), mkdir(projectSettings, { recursive: true })]);
    const app: AppIdentity = {
      displayName: "Visual Studio Code",
      bundleId: "com.microsoft.VSCode",
      path: appPath,
      installSource: "standalone",
      packageReceipts: [],
    };
    const scan = await scanApplication(
      app,
      paths,
      new ScannerRunner([projectSettings], { keychainServices: ["Code Safe Storage"], loginItems: ["Visual Studio Code"], backgroundBundleId: app.bundleId }),
      true,
    );
    expect(scan.candidates.find((item) => item.path === extensions)?.risk).toBe("confirmed");
    expect(scan.candidates.find((item) => item.path === shared)?.risk).toBe("confirmed");
    expect(scan.candidates.find((item) => item.path === projectSettings)?.risk).toBe("protected");
    expect(scan.deferredActions.some((action) => action.type === "keychain" && action.value === "Code Safe Storage")).toBeTrue();
    expect(scan.deferredActions.some((action) => action.type === "login-item")).toBeTrue();
    expect(scan.warnings.some((warning) => warning.startsWith("RUNTIME_RESIDUE:"))).toBeTrue();
  });

  test("protects every candidate belonging to an Apple system application", async () => {
    const paths = await testPaths();
    const appPath = join(paths.applications, "System Example.app");
    const cache = join(paths.userLibrary, "Caches", "com.apple.example");
    await Promise.all([mkdir(appPath, { recursive: true }), mkdir(cache, { recursive: true })]);
    const app: AppIdentity = {
      displayName: "System Example",
      bundleId: "com.apple.example",
      path: appPath,
      installSource: "standalone",
      packageReceipts: [],
    };
    const scan = await scanApplication(app, paths, new ScannerRunner([cache]), true);
    expect(scan.candidates.length).toBeGreaterThan(0);
    expect(scan.candidates.every((candidate) => candidate.risk === "protected")).toBeTrue();
  });
});
