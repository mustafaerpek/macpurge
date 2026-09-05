import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { SCHEMA_VERSION, type AppIdentity, type CandidateKind, type RiskClass, type RuleCandidate, type RuleProfile, type SystemPaths } from "./types";
import { isPersonalProtectedPath, isWithin, protectedRoots, SafetyError, validateLiteralPath } from "./safety";
import { isValidBundleId, isValidDisplayName } from "./app-policy";

export type RuleOrigin = "builtin" | "user";
type RuleProfileInput = Omit<RuleProfile, "origin">;

export const BUILTIN_RULES: RuleProfileInput[] = [
  {
    schemaVersion: SCHEMA_VERSION,
    id: "visual-studio-code",
    bundleIds: ["com.microsoft.VSCode"],
    platform: "darwin",
    candidates: [
      { pathTemplate: "{home}/Library/Application Support/Code", kind: "application-support", risk: "confirmed", reason: "Official VS Code user data directory" },
      { pathTemplate: "{home}/.vscode", kind: "application-support", risk: "confirmed", reason: "Official VS Code extensions directory" },
      { pathTemplate: "{home}/.vscode-shared", kind: "application-support", risk: "confirmed", reason: "Official VS Code shared extensions directory" },
      { pathTemplate: "{home}/Library/Caches/{bundleId}", kind: "cache", risk: "confirmed", reason: "Bundle cache" },
      { pathTemplate: "{home}/Library/Caches/{bundleId}.ShipIt", kind: "cache", risk: "confirmed", reason: "VS Code updater cache" },
      { pathTemplate: "{home}/Library/HTTPStorages/{bundleId}", kind: "http-storage", risk: "confirmed", reason: "Bundle HTTP storage" },
      { pathTemplate: "{home}/Library/Preferences/{bundleId}.plist", kind: "preference", risk: "confirmed", reason: "Bundle preferences" },
      { pathTemplate: "/usr/local/bin/code", kind: "cli-symlink", risk: "confirmed", reason: "VS Code shell command", requiresSymlinkIntoApp: true },
      { pathTemplate: "/opt/homebrew/bin/code", kind: "cli-symlink", risk: "confirmed", reason: "VS Code shell command", requiresSymlinkIntoApp: true },
      { pathTemplate: "{temp}/{bundleId}.ShipIt.", match: "prefix", kind: "temporary", risk: "confirmed", reason: "VS Code updater temporary directory" },
    ],
  },
  {
    schemaVersion: SCHEMA_VERSION,
    id: "floodtide",
    bundleIds: ["com.getfloodtide.floodtide"],
    platform: "darwin",
    candidates: [
      { pathTemplate: "{home}/Library/Application Support/Floodtide", kind: "application-support", risk: "confirmed", reason: "Floodtide application data and managed backups" },
      { pathTemplate: "{home}/Library/Caches/{bundleId}", kind: "cache", risk: "confirmed", reason: "Bundle cache" },
      { pathTemplate: "{home}/Library/HTTPStorages/{bundleId}", kind: "http-storage", risk: "confirmed", reason: "Bundle HTTP storage" },
      { pathTemplate: "{home}/Library/HTTPStorages/{bundleId}.binarycookies", kind: "http-storage", risk: "confirmed", reason: "Bundle HTTP cookies" },
      { pathTemplate: "{home}/Library/Preferences/{bundleId}.plist", kind: "preference", risk: "confirmed", reason: "Bundle preferences" },
    ],
  },
];

const ALLOWED_TOKENS = new Set(["home", "bundleId", "appName", "temp"]);
const CANDIDATE_KINDS: readonly CandidateKind[] = [
  "application",
  "application-support",
  "cache",
  "preference",
  "http-storage",
  "saved-state",
  "log",
  "container",
  "cli-symlink",
  "launch-agent",
  "launch-daemon",
  "privileged-helper",
  "temporary",
  "package-payload",
  "other",
];
const RISK_CLASSES: readonly RiskClass[] = ["confirmed", "possible", "protected"];

// Home-relative entries whose loss or exposure would be catastrophic: stores of
// credentials, package-manager/developer state, and broad source trees. User
// rules pointing here are rejected outright, never merely downgraded.
const SENSITIVE_HOME_ENTRIES = new Set([
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".config",
  ".kube",
  ".docker",
  ".cargo",
  ".rustup",
  ".m2",
  ".gradle",
  ".nvm",
  ".pyenv",
  ".rbenv",
  ".bun",
  ".npm",
  ".cache",
  ".local",
  ".ollama",
  "Projects",
  "Developer",
  "src",
  "code",
  "dev",
  "work",
]);

// The only locations where a user-defined rule may still mark a match as
// "confirmed". Anything else is demoted to "possible" and requires explicit
// opt-in. Built-in rules ship with the binary and are exempt from this policy.
const TRUSTED_RULE_ROOTS = (paths: SystemPaths): string[] =>
  [
    join(paths.userLibrary, "Application Support"),
    join(paths.userLibrary, "Caches"),
    join(paths.userLibrary, "HTTPStorages"),
    join(paths.userLibrary, "Preferences"),
    join(paths.userLibrary, "Saved Application State"),
    join(paths.userLibrary, "WebKit"),
    join(paths.userLibrary, "Containers"),
    join(paths.userLibrary, "Application Scripts"),
    join(paths.userLibrary, "Logs"),
    join(paths.systemLibrary, "Application Support"),
    join(paths.systemLibrary, "Caches"),
    join(paths.systemLibrary, "LaunchAgents"),
    join(paths.systemLibrary, "LaunchDaemons"),
    join(paths.systemLibrary, "PrivilegedHelperTools"),
    paths.temp,
    paths.applications,
    paths.userApplications,
    ...paths.binRoots,
  ].map((root) => resolve(root));

function isSensitiveRulePath(resolved: string, paths: SystemPaths): boolean {
  const rel = relative(resolve(paths.home), resolved);
  if (!rel || rel.startsWith(`..${sep}`) || rel === "..") return false;
  const head = rel.split(sep)[0];
  return head !== undefined && SENSITIVE_HOME_ENTRIES.has(head);
}

export type RulePathVerdict = { allowed: true; risk: RiskClass } | { allowed: false; reason: string };

/**
 * Single policy for rule-derived paths, applied both when a rule is validated
 * (sample expansion) and when the scanner expands it with a real application
 * identity. Sensitive or protected locations are blocked; user rules may only
 * confirm matches inside trusted app-data roots.
 */
export function assessRulePath(path: string, paths: SystemPaths, requested: RiskClass, origin: RuleOrigin): RulePathVerdict {
  const resolved = resolve(path);
  if (protectedRoots(paths).includes(resolved)) return { allowed: false, reason: "path resolves to a protected root" };
  if (isWithin(resolved, resolve(paths.supportRoot))) return { allowed: false, reason: "path is inside the macpurge support root" };
  if (isPersonalProtectedPath(resolved, paths)) return { allowed: false, reason: "path is personal or developer data" };
  if (isSensitiveRulePath(resolved, paths)) return { allowed: false, reason: "path is a sensitive credential or source location" };
  if (origin === "user" && requested === "confirmed" && !TRUSTED_RULE_ROOTS(paths).some((root) => isWithin(resolved, root))) {
    return { allowed: true, risk: "possible" };
  }
  return { allowed: true, risk: requested };
}

export function validateRule(rule: unknown, paths: SystemPaths, origin: RuleOrigin = "user"): RuleProfile {
  if (!rule || typeof rule !== "object") throw new SafetyError("Rule must be an object");
  // Work on a copy: validation may demote risk values, and callers must never
  // observe mutation of the parsed JSON or the built-in table.
  const value = structuredClone(rule) as Partial<RuleProfile>;
  if (value.schemaVersion !== SCHEMA_VERSION) throw new SafetyError("Unsupported rule schemaVersion");
  if (typeof value.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/u.test(value.id)) throw new SafetyError("Rule id must be lowercase kebab-case");
  if (value.platform !== undefined && value.platform !== "darwin") throw new SafetyError("Rule platform must be darwin");
  if (!Array.isArray(value.bundleIds) || value.bundleIds.length === 0 || value.bundleIds.some((id) => typeof id !== "string" || !isValidBundleId(id) || !id.includes("."))) {
    throw new SafetyError("Rule must contain valid bundleIds");
  }
  if (!Array.isArray(value.candidates) || value.candidates.length === 0) throw new SafetyError("Rule must declare at least one candidate");

  for (const candidate of value.candidates as unknown[]) validateRuleCandidate(candidate, paths, origin);
  return { ...value, origin } as RuleProfile;
}

function validateRuleCandidate(candidate: unknown, paths: SystemPaths, origin: RuleOrigin): void {
  if (!candidate || typeof candidate !== "object") throw new SafetyError("Rule candidate must be an object");
  const value = candidate as Partial<RuleCandidate> & Record<string, unknown>;
  if (typeof value.pathTemplate !== "string" || value.pathTemplate.length === 0) throw new SafetyError("Rule candidate needs pathTemplate");
  if (typeof value.reason !== "string" || value.reason.trim().length === 0) throw new SafetyError("Rule candidate needs reason");
  if (typeof value.kind !== "string" || !CANDIDATE_KINDS.includes(value.kind as CandidateKind)) {
    throw new SafetyError(`Rule candidate has an unsupported kind: ${String(value.kind)}`);
  }
  if (typeof value.risk !== "string" || !RISK_CLASSES.includes(value.risk as RiskClass)) {
    throw new SafetyError(`Rule candidate has an unsupported risk: ${String(value.risk)}`);
  }
  if (value.requiresSymlinkIntoApp !== undefined && typeof value.requiresSymlinkIntoApp !== "boolean") {
    throw new SafetyError("Rule requiresSymlinkIntoApp must be a boolean");
  }
  if (value.match !== undefined && !["exact", "prefix"].includes(value.match)) throw new SafetyError("Unsupported rule match mode");
  if (value.pathTemplate.includes("..") || /[*?\[\]]/u.test(value.pathTemplate)) {
    throw new SafetyError(`Unsafe path template: ${value.pathTemplate}`);
  }
  const tokens = [...value.pathTemplate.matchAll(/\{([^}]+)\}/gu)].map((match) => match[1]);
  if (tokens.some((token) => !token || !ALLOWED_TOKENS.has(token))) throw new SafetyError(`Unknown path template token: ${value.pathTemplate}`);

  const sample = expandRulePath(value.pathTemplate, {
    displayName: "Sample App",
    bundleId: "com.example.sample",
    path: join(paths.applications, "Sample App.app"),
    installSource: "standalone",
    packageReceipts: [],
  }, paths);
  const verdict = assessRulePath(sample, paths, value.risk as RiskClass, origin);
  if (!verdict.allowed) throw new SafetyError(`Rule path is not allowed: ${value.pathTemplate} (${verdict.reason})`);
  value.risk = verdict.risk;
  validateLiteralPath(sample, paths);
  if (value.match === "prefix" && basename(sample).length < 4) throw new SafetyError(`Rule prefix is too broad: ${value.pathTemplate}`);
}

export function expandRulePath(template: string, app: AppIdentity, paths: SystemPaths): string {
  if (!isValidDisplayName(app.displayName)) {
    throw new SafetyError("Application display name is unsafe for rule expansion");
  }
  if (!isValidBundleId(app.bundleId)) {
    throw new SafetyError("Application bundle id is unsafe for rule expansion");
  }
  return template
    .replaceAll("{home}", paths.home)
    .replaceAll("{bundleId}", app.bundleId)
    .replaceAll("{appName}", app.displayName)
    .replaceAll("{temp}", paths.temp);
}

export async function loadRules(paths: SystemPaths): Promise<{ rules: RuleProfile[]; warnings: string[] }> {
  const rules: RuleProfile[] = BUILTIN_RULES.map((rule) => validateRule(rule, paths, "builtin"));
  const warnings: string[] = [];
  let files: string[] = [];
  try {
    files = (await readdir(paths.userRuleRoot)).filter((file) => file.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnings.push(`Could not read user rule directory: ${String(error)}`);
  }

  for (const file of files) {
    try {
      const content = await readFile(join(paths.userRuleRoot, file), "utf8");
      rules.push(validateRule(JSON.parse(content), paths, "user"));
    } catch (error) {
      warnings.push(`Invalid user rule ${basename(file)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { rules, warnings };
}

export function rulesForApp(rules: RuleProfile[], app: AppIdentity): RuleProfile[] {
  return rules.filter((rule) => rule.bundleIds.includes(app.bundleId));
}
