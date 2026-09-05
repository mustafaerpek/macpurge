import { describe, expect, test } from "bun:test";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { BunCommandRunner } from "../src/command";
import { applicationPids } from "../src/processes";
import type { AppIdentity } from "../src/types";

// Real macOS integration coverage: detection must work against the live
// pgrep implementation, not only mocked command output. Requires a compiler
// to build a long-lived process whose executable lives inside a fake bundle.
const canRun = process.platform === "darwin" && Boolean(Bun.which("cc"));

const SLEEPER_SOURCE = "#include <unistd.h>\nint main(void) { for (;;) pause(); }\n";

function identityFor(path: string): AppIdentity {
  return { displayName: "Fake", bundleId: "com.example.fake", path, installSource: "standalone", packageReceipts: [] };
}

interface Sleeper {
  root: string;
  bundle: string;
  executable: string;
  spawn: () => Bun.Subprocess<"ignore", "ignore", "ignore">;
}

async function buildSleeper(root: string, bundleName = "Fake.app"): Promise<Sleeper> {
  const bundle = join(root, bundleName);
  const executable = join(bundle, "Contents", "MacOS", "sleeper");
  await mkdir(dirname(executable), { recursive: true });
  const source = join(root, "sleeper.c");
  await writeFile(source, SLEEPER_SOURCE);
  const compiled = Bun.spawnSync(["cc", "-O0", "-o", executable, source]);
  if (compiled.exitCode !== 0) {
    throw new Error(`Integration test could not compile sleeper: ${new TextDecoder().decode(compiled.stderr)}`);
  }
  return {
    root,
    bundle,
    executable,
    spawn: () => Bun.spawn([executable], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }),
  };
}

describe.skipIf(!canRun)("real macOS process detection", () => {
  test("detects a live process whose executable is inside the bundle", async () => {
    const root = await Bun.$`mktemp -d ${join(tmpdir(), "macpurge-proc-XXXXXX")}`.text().then((value) => value.trim());
    const sleeper = await buildSleeper(root);
    const process_ = sleeper.spawn();
    try {
      const pids = await applicationPids(identityFor(sleeper.bundle), new BunCommandRunner());
      expect(pids).toContain(process_.pid);
    } finally {
      process_.kill(9);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("excludes processes that only mention the bundle path in their arguments", async () => {
    const root = await Bun.$`mktemp -d ${join(tmpdir(), "macpurge-proc-XXXXXX")}`.text().then((value) => value.trim());
    const sleeper = await buildSleeper(root);
    const app = sleeper.spawn();
    // Long-lived decoy: /bin/sh is the executable, the bundle path is only a
    // comment inside the argument list. Raw pgrep must see it; macpurge must
    // not report it as a running application process.
    const decoy = Bun.spawn(["/bin/sh", "-c", `while :; do sleep 1; done # ${sleeper.bundle}`], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    try {
      const rawPgrep = await new BunCommandRunner().run(["/usr/bin/pgrep", "-fl", sleeper.bundle]);
      expect(rawPgrep.stdout).toContain(String(decoy.pid));
      const pids = await applicationPids(identityFor(sleeper.bundle), new BunCommandRunner());
      expect(pids).toContain(app.pid);
      expect(pids).not.toContain(decoy.pid);
    } finally {
      app.kill(9);
      decoy.kill(9);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("detects the process when the bundle is installed through a symlink", async () => {
    const root = await Bun.$`mktemp -d ${join(tmpdir(), "macpurge-proc-XXXXXX")}`.text().then((value) => value.trim());
    const realBundleDirectory = join(root, "Caskroom");
    await mkdir(realBundleDirectory, { recursive: true });
    const sleeper = await buildSleeper(realBundleDirectory, "Linked.app");
    const visibleBundle = join(root, "Linked.app");
    await symlink(sleeper.bundle, visibleBundle);
    const process_ = sleeper.spawn();
    try {
      const pids = await applicationPids(identityFor(visibleBundle), new BunCommandRunner());
      expect(pids).toContain(process_.pid);
    } finally {
      process_.kill(9);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports no processes for a bundle that is not running", async () => {
    const root = await Bun.$`mktemp -d ${join(tmpdir(), "macpurge-proc-XXXXXX")}`.text().then((value) => value.trim());
    try {
      const sleeper = await buildSleeper(root);
      const pids = await applicationPids(identityFor(sleeper.bundle), new BunCommandRunner());
      expect(pids).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
