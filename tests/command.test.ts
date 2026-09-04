import { describe, expect, test } from "bun:test";
import { FakeCommandRunner } from "../src/command";

describe("command runner doubles", () => {
  test("exists models which probes or an explicit installed set", async () => {
    const withWhich = new FakeCommandRunner([
      { match: (c) => c[0] === "/usr/bin/which" && c[1] === "brew", result: { exitCode: 0, stdout: "/opt/homebrew/bin/brew\n", stderr: "" } },
    ]);
    expect(await withWhich.exists("brew")).toBeTrue();
    expect(await withWhich.exists("missing")).toBeFalse();

    const withSet = new FakeCommandRunner([], new Set(["brew"]));
    expect(await withSet.exists("brew")).toBeTrue();
    expect(await withSet.exists("other")).toBeFalse();
  });

  test("run records calls and falls back to 127", async () => {
    const runner = new FakeCommandRunner();
    const result = await runner.run(["/usr/bin/du", "-sk", "/tmp"]);
    expect(result.exitCode).toBe(127);
    expect(runner.calls).toHaveLength(1);
  });
});
