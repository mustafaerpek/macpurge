import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { APP_VERSION } from "../src/version";

const cli = resolve(import.meta.dir, "..", "src", "cli.ts");

async function run(args: string[]) {
  const proc = Bun.spawn({
    cmd: [process.execPath, cli, ...args],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("CLI contract", () => {
  test("prints version and help", async () => {
    const version = await run(["--version"]);
    expect(version.exitCode).toBe(0);
    expect(version.stdout.trim()).toBe(APP_VERSION);
    const help = await run(["--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("macpurge uninstall");
  });

  test("uses exit code 2 for invalid commands", async () => {
    const result = await run(["not-a-command"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unknown command");
  });

  test("emits the stable JSON error envelope", async () => {
    const result = await run(["not-a-command", "--json"]);
    expect(result.exitCode).toBe(2);
    const payload = JSON.parse(result.stdout) as { schemaVersion: number; status: string; errors: string[] };
    expect(payload.schemaVersion).toBe(1);
    expect(payload.status).toBe("error");
    expect(payload.errors[0]).toContain("Unknown command");
  });

  test("importing the CLI module does not run the command router", () => {
    // Regression: importing cli.ts used to execute main() with the host's argv
    // and stamp process.exitCode (bun test exited 2 despite every test passing).
    const proc = Bun.spawnSync([process.execPath, "-e", `import ${JSON.stringify(cli)}`]);
    expect(proc.exitCode).toBe(0);
  });
});
