import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunCommandRunner, type CommandResult, type CommandRunner } from "../src/command";
import { scanApplication } from "../src/scanner";
import type { AppIdentity, SystemPaths } from "../src/types";

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

class InstrumentedRunner implements CommandRunner {
  readonly calls: Array<{ command: string[]; durationMs: number }> = [];
  private readonly realDu = new BunCommandRunner();

  constructor(
    private readonly findOutput: string[],
    private readonly loginItems: string[] = [],
  ) {}

  async run(command: readonly string[], options?: { timeoutMs?: number }): Promise<CommandResult> {
    const start = performance.now();
    let result: CommandResult;
    if (command[0] === "/usr/bin/du") {
      result = await this.realDu.run(command);
    } else if (command[0] === "/usr/bin/find") {
      result = { exitCode: 0, stdout: `${this.findOutput.join("\n")}\n`, stderr: "" };
    } else if (command[0] === "/usr/bin/mdfind") {
      result = { exitCode: 0, stdout: "", stderr: "" };
    } else if (command[0] === "/usr/bin/security") {
      result = { exitCode: 44, stdout: "", stderr: "not found" };
    } else if (command[0] === "/usr/bin/osascript") {
      result = { exitCode: 0, stdout: "false\n", stderr: "" };
    } else if (command[0] === "/usr/bin/pgrep" || command[0] === "/usr/bin/sfltool" || command[0] === "/usr/sbin/pkgutil") {
      result = { exitCode: 1, stdout: "", stderr: "" };
    } else {
      result = { exitCode: 127, stdout: "", stderr: "" };
    }
    this.calls.push({ command: [...command], durationMs: performance.now() - start });
    void options;
    return result;
  }

  async exists(): Promise<boolean> {
    return false;
  }
}

async function buildFixture(fileCount: number): Promise<{ paths: SystemPaths; app: AppIdentity; findOutput: string[] }> {
  const root = await mkdtemp(join(tmpdir(), "macpurge-bench-"));
  const home = join(root, "Users", "bench");
  const userLibrary = join(home, "Library");
  const paths: SystemPaths = {
    home,
    applications: join(root, "Applications"),
    userApplications: join(home, "Applications"),
    userLibrary,
    systemLibrary: join(root, "Library"),
    temp: join(root, "tmp"),
    supportRoot: join(userLibrary, "Application Support", "macpurge"),
    quarantineRoot: join(userLibrary, "Application Support", "macpurge", "quarantine"),
    sessionRoot: join(userLibrary, "Application Support", "macpurge", "sessions"),
    userRuleRoot: join(home, ".config", "macpurge", "rules"),
    binRoots: [join(root, "usr", "local", "bin")],
  };
  const appPath = join(paths.applications, "Bench.app");
  await mkdir(join(appPath, "Contents", "MacOS"), { recursive: true });
  await writeFile(join(appPath, "Contents", "MacOS", "Bench"), "binary");
  const findOutput: string[] = [];
  for (let i = 0; i < fileCount; i++) {
    const dir = join(userLibrary, "Caches", "com.example.bench", `entry-${i}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "data.bin"), "x".repeat(1024));
    if (i % 2 === 0) findOutput.push(join(dir, "data.bin"));
  }
  const app: AppIdentity = {
    displayName: "Bench",
    bundleId: "com.example.bench",
    path: appPath,
    installSource: "standalone",
    packageReceipts: [],
  };
  return { paths, app, findOutput };
}

const fileCount = Number.parseInt(process.argv[2] ?? "100", 10);
const { paths, app, findOutput } = await buildFixture(Number.isFinite(fileCount) ? fileCount : 100);
const runner = new InstrumentedRunner(findOutput);
const start = performance.now();
const scan = await scanApplication(app, paths, runner, true);
const wallMs = performance.now() - start;

const duCalls = runner.calls.filter((c) => c.command[0] === "/usr/bin/du").map((c) => c.durationMs).sort((a, b) => a - b);
const byPrefix = new Map<string, { count: number; totalMs: number }>();
for (const call of runner.calls) {
  const key = String(call.command[0]);
  const entry = byPrefix.get(key) ?? { count: 0, totalMs: 0 };
  entry.count += 1;
  entry.totalMs += call.durationMs;
  byPrefix.set(key, entry);
}
const duTotal = duCalls.reduce((a, b) => a + b, 0);

console.log(`scan wall: ${wallMs.toFixed(1)}ms · candidates: ${scan.candidates.length} · files: ${fileCount}`);
console.log(`du calls: ${duCalls.length} · total ${duTotal.toFixed(1)}ms · p50 ${percentile(duCalls, 50).toFixed(2)}ms · p95 ${percentile(duCalls, 95).toFixed(2)}ms`);
for (const [cmd, stats] of [...byPrefix.entries()].sort()) {
  console.log(`  ${cmd}: ${stats.count}x · ${stats.totalMs.toFixed(1)}ms`);
}
console.log(JSON.stringify({ wallMs, candidates: scan.candidates.length, duCount: duCalls.length, duTotalMs: duTotal }, null, 2));
