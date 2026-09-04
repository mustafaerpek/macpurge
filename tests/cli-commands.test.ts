import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FakeCommandRunner } from "../src/command";
import { QuarantineService } from "../src/quarantine";
import { createDefaultDeps, runCli, CliError } from "../src/cli";
import { parse, selectedCandidates } from "../src/cli-helpers";
import { testPaths } from "./helpers";
import type { ScanResult } from "../src/types";

async function fakeDeps() {
  const paths = await testPaths();
  const runner = new FakeCommandRunner();
  return { paths, runner, quarantine: new QuarantineService(paths, runner) };
}

describe("CLI composition", () => {
  test("creates default deps without throwing", () => {
    expect(() => createDefaultDeps()).not.toThrow();
  });

  test("parses json/include/confirm flags", () => {
    const parsed = parse(["uninstall", "Example", "--json", "--include", "a", "--include", "b", "--confirm", "Example"]);
    expect(parsed.positionals[0]).toBe("uninstall");
    expect(parsed.values.json).toBeTrue();
    expect(parsed.values.include).toEqual(["a", "b"]);
    expect(parsed.values.confirm).toBe("Example");
  });

  test("selects confirmed by default and guards protected/unknown", () => {
    const base = { id: "c1", path: "/tmp/a", kind: "cache" as const, risk: "confirmed" as const, evidence: [], sizeBytes: 1, requiresAdmin: false, selectedByDefault: true };
    const possible = { ...base, id: "p1", risk: "possible" as const, selectedByDefault: false };
    const prot = { ...base, id: "x1", risk: "protected" as const, selectedByDefault: false };
    const scan = { candidates: [base, possible, prot] } as unknown as ScanResult;
    expect(selectedCandidates(scan, []).map((c) => c.id)).toEqual(["c1"]);
    expect(selectedCandidates(scan, ["p1"]).map((c) => c.id).sort()).toEqual(["c1", "p1"]);
    expect(() => selectedCandidates(scan, ["missing"])).toThrow("Unknown candidate");
    expect(() => selectedCandidates(scan, ["x1"])).toThrow("Protected candidate");
  });

  test("rejects unknown commands with exit code 2", async () => {
    const deps = await fakeDeps();
    await expect(runCli(["not-a-command"], deps)).rejects.toThrow("Unknown command");
    try {
      await runCli(["not-a-command"], deps);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).exitCode).toBe(2);
    }
  });

  test("lists applications as JSON without subprocess", async () => {
    const paths = await testPaths();
    const appPath = join(paths.applications, "Example.app");
    await mkdir(join(appPath, "Contents"), { recursive: true });
    await writeFile(join(appPath, "Contents", "Info.plist"), "fixture");
    const runner = new FakeCommandRunner([
      { match: (c) => c[0] === "/usr/bin/plutil", result: { exitCode: 0, stdout: "com.example.app\n", stderr: "" } },
      { match: (c) => c[0] === "/usr/bin/codesign", result: { exitCode: 1, stdout: "", stderr: "" } },
      { match: (c) => c[0] === "/usr/sbin/pkgutil", result: { exitCode: 1, stdout: "", stderr: "" } },
    ], new Set());
    const deps = { paths, runner, quarantine: new QuarantineService(paths, runner) };
    const lines: string[] = [];
    const original = console.log;
    console.log = (msg: string) => { lines.push(String(msg)); };
    try {
      expect(await runCli(["list", "--json"], deps)).toBe(0);
    } finally {
      console.log = original;
    }
    const payload = JSON.parse(lines.join("\n")) as { status: string };
    expect(payload.status).toBe("ok");
  });
});
