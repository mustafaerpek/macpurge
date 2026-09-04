import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SystemPaths } from "../src/types";

export async function testPaths(): Promise<SystemPaths> {
  const root = await mkdtemp(join(tmpdir(), "macpurge-test-"));
  const home = join(root, "Users", "tester");
  const userLibrary = join(home, "Library");
  const supportRoot = join(userLibrary, "Application Support", "macpurge");
  const paths: SystemPaths = {
    home,
    applications: join(root, "Applications"),
    userApplications: join(home, "Applications"),
    userLibrary,
    systemLibrary: join(root, "Library"),
    temp: join(root, "tmp"),
    supportRoot,
    quarantineRoot: join(supportRoot, "quarantine"),
    sessionRoot: join(supportRoot, "sessions"),
    userRuleRoot: join(home, ".config", "macpurge", "rules"),
    binRoots: [join(root, "usr", "local", "bin"), join(root, "opt", "homebrew", "bin"), join(home, ".bun", "bin")],
  };
  await Promise.all([
    mkdir(paths.applications, { recursive: true }),
    mkdir(paths.userApplications, { recursive: true }),
    mkdir(paths.userLibrary, { recursive: true }),
    mkdir(paths.systemLibrary, { recursive: true }),
    mkdir(paths.temp, { recursive: true }),
    ...paths.binRoots.map((path) => mkdir(path, { recursive: true })),
  ]);
  return paths;
}
