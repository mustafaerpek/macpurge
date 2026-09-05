import { describe, expect, test } from "bun:test";
import type { CommandResult, CommandRunner } from "../src/command";
import { applicationPids, closeApplication, isAppProcessCommand, loginItemDeleteScript, loginItemExists, loginItemExistsScript } from "../src/processes";
import type { AppIdentity } from "../src/types";

class ProcessRunner implements CommandRunner {
  readonly calls: string[][] = [];
  private pgrepCount = 0;

  constructor(
    private readonly pgrepOutput = `123 /Applications/Example.app/Contents/MacOS/Example\n${process.pid} /Applications/Example.app/Contents/MacOS/Example\n`,
    private readonly pgrepExitCode = 0,
  ) {}

  async run(command: readonly string[]): Promise<CommandResult> {
    this.calls.push([...command]);
    if (command[0] === "/usr/bin/pgrep") {
      this.pgrepCount += 1;
      return this.pgrepCount === 1
        ? { exitCode: this.pgrepExitCode, stdout: this.pgrepOutput, stderr: this.pgrepExitCode === 0 ? "" : "fatal error" }
        : { exitCode: 1, stdout: "", stderr: "" };
    }
    if (command[0] === "/usr/bin/osascript" && command.at(-1)?.includes("exists login item")) {
      return { exitCode: 0, stdout: "true\n", stderr: "" };
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

  test("matches only inside the bundle using pgrep -fl with an escaped ERE pattern", async () => {
    const runner = new ProcessRunner();
    await applicationPids(app, runner);
    const call = runner.calls.find((command) => command[0] === "/usr/bin/pgrep")!;
    expect(call[1]).toBe("-fil");
    expect(call[2]).toBe(String.raw`Example\.app`);
  });

  test("escapes regex metacharacters in the application name", async () => {
    const runner = new ProcessRunner();
    const cPlusPlus: AppIdentity = { ...app, path: "/Applications/C++ App (v2).app" };
    await applicationPids(cPlusPlus, runner);
    const call = runner.calls.find((command) => command[0] === "/usr/bin/pgrep")!;
    expect(call[2]).toBe(String.raw`C\+\+ App \(v2\)\.app`);
  });

  test("exit 1 means no running process, not an error", async () => {
    const runner = new ProcessRunner("", 1);
    const quiet = await applicationPids(app, runner);
    expect(quiet).toEqual([]);
  });

  test("a pgrep lookup failure is surfaced instead of reported as not running", async () => {
    const runner = new ProcessRunner("", 2);
    await expect(applicationPids(app, runner)).rejects.toThrow("Process lookup failed");
  });

  test("ignores command lines that merely contain the app path as an argument", async () => {
    const runner = new ProcessRunner(
      [
        "200 /Applications/Example.app/Contents/MacOS/Example",
        "201 /usr/bin/vim /Applications/Example.app/Contents/Info.plist",
        "202 /bin/zsh -c 'echo /Applications/Example.app'",
        `203 /Applications/Example.app/Contents/MacOS/Example --arg`,
      ].join("\n") + "\n",
    );
    expect(await applicationPids(app, runner)).toEqual([200, 203]);
  });

  test("matches only executables inside the bundle", () => {
    expect(isAppProcessCommand("/Applications/Example.app/Contents/MacOS/Example", app.path)).toBeTrue();
    expect(isAppProcessCommand("/Applications/Example.app/Contents/MacOS/Example --flag", app.path)).toBeTrue();
    expect(isAppProcessCommand("/usr/bin/vim /Applications/Example.app/file", app.path)).toBeFalse();
    expect(isAppProcessCommand("/bin/zsh -c 'open /Applications/Example.app'", app.path)).toBeFalse();
    expect(isAppProcessCommand("", app.path)).toBeFalse();
  });

  test("accepts the real bundle root of a symlinked application", () => {
    const realExecutable = "/Users/me/Caskroom/Example.app/Contents/MacOS/Example";
    expect(isAppProcessCommand(realExecutable, ["/Applications/Example.app", "/Users/me/Caskroom/Example.app"])).toBeTrue();
    expect(isAppProcessCommand(realExecutable, "/Applications/Example.app")).toBeFalse();
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

  test("escalation operates only on the verified PID set", async () => {
    const runner = new ProcessRunner("300 /usr/bin/vim /Applications/Example.app/file\n");
    const closed = await closeApplication(app, runner, async () => {
      throw new Error("confirmForce must not be called when no verified app process exists");
    });
    expect(closed).toBeTrue();
    expect(runner.calls.some((command) => command[0] === "/bin/kill")).toBeFalse();
  });

  test("escapes login item names as AppleScript string literals", () => {
    expect(loginItemDeleteScript('Bad "Name"\\Value')).toBe('tell application "System Events" to delete login item "Bad \\"Name\\"\\\\Value"');
  });

  test("keeps AppleScript login-item scripts as a single literal with adversarial names", () => {
    for (const name of ['Comma, Name', 'Quote "Name"', "Back\\Slash", "Line\nBreak", "CR\rReturn", "Tab\tName"]) {
      const script = loginItemDeleteScript(name);
      expect(script.startsWith('tell application "System Events" to delete login item "')).toBeTrue();
      expect(script.endsWith('"')).toBeTrue();
      expect(script).toContain(loginItemExistsScript(name).slice('tell application "System Events" to exists login item '.length));
    }
    expect(loginItemDeleteScript("Line\nBreak")).toContain("\\n");
    expect(loginItemDeleteScript("CR\rReturn")).toContain("\\r");
    expect(loginItemDeleteScript('Comma, Name')).toContain("Comma, Name");
  });

  test("checks login items with exact-match queries", async () => {
    const runner = new ProcessRunner();
    expect(await loginItemExists("Example", runner)).toBeTrue();
    expect(runner.calls.some((command) => command.at(-1)?.includes('exists login item "Example"'))).toBeTrue();
  });
});
