import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { SystemPaths } from "./types";

export function defaultSystemPaths(): SystemPaths {
  const home = homedir();
  const supportRoot = join(home, "Library", "Application Support", "macpurge");
  const configRoot = join(home, ".config", "macpurge");
  return {
    home,
    applications: "/Applications",
    userApplications: join(home, "Applications"),
    userLibrary: join(home, "Library"),
    systemLibrary: "/Library",
    temp: tmpdir(),
    supportRoot,
    quarantineRoot: join(supportRoot, "quarantine"),
    sessionRoot: join(supportRoot, "sessions"),
    userRuleRoot: join(configRoot, "rules"),
    cleanWhitelistPath: join(configRoot, "clean-whitelist.json"),
    binRoots: ["/usr/local/bin", "/opt/homebrew/bin", join(home, ".bun", "bin")],
  };
}
