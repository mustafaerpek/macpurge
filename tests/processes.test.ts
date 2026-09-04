import { describe, expect, test } from "bun:test";
import type { CommandResult, CommandRunner } from "../src/command";
import { applicationPids, closeApplication, loginItemDeleteScript } from "../src/processes";
import type { AppIdentity } from "../src/types";

class ProcessRunner implements CommandRunner {
  readonly calls: string[][] = [];
  private pgrepCount = 0;

  async run(command: readonly string[]): Promise<CommandResult> {
    this.calls.push([...command]);
    if (command[0] === "/usr/bin/pgrep") {
      this.pgrepCount += 1;
      return this.pgrepCount === 1
        ? { exitCode: 0, stdout: `123\n${process.pid}\n`, stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  async exists(): Promise<boolean> {
    return true;
  }
}

const app: AppIdentity = {
  displayName: "Example",
  bundleId: "com.example.app",
  path: "/Applications/Example.app",
  installSource: "standalone",
  packageReceipts: [],
};

describe("process handling", () => {
  test("filters the macpurge process from pgrep results", async () => {
    const runner = new ProcessRunner();
    expect(await applicationPids(app, runner)).toEqual([123]);
  });

  test("requests a normal bundle-id quit before force signals", async () => {
    const runner = new ProcessRunner();
    let forceRequested = false;
    const closed = await closeApplication(app, runner, async () => {
      forceRequested = true;
      return false;
    });
    expect(closed).toBeTrue();
    expect(forceRequested).toBeFalse();
    expect(runner.calls.some((command) => command[0] === "/usr/bin/osascript" && command.at(-1)?.includes(app.bundleId))).toBeTrue();
  });

  test("escapes login item names as AppleScript string literals", () => {
    expect(loginItemDeleteScript('Bad "Name"\\Value')).toBe('tell application "System Events" to delete login item "Bad \\"Name\\"\\\\Value"');
  });
});
