import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { SCHEMA_VERSION, type AppIdentity, type RuleCandidate, type RuleProfile, type SystemPaths } from "./types";
import { protectedRoots, SafetyError, validateLiteralPath } from "./safety";

export const BUILTIN_RULES: RuleProfile[] = [
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

export function validateRule(rule: unknown, paths: SystemPaths): RuleProfile {
  if (!rule || typeof rule !== "object") throw new SafetyError("Rule must be an object");
  const value = rule as Partial<RuleProfile>;
  if (value.schemaVersion !== SCHEMA_VERSION) throw new SafetyError("Unsupported rule schemaVersion");
  if (!value.id || !/^[a-z0-9][a-z0-9-]*$/u.test(value.id)) throw new SafetyError("Rule id must be lowercase kebab-case");
  if (!Array.isArray(value.bundleIds) || value.bundleIds.length === 0 || value.bundleIds.some((id) => typeof id !== "string" || !id.includes("."))) {
    throw new SafetyError("Rule must contain valid bundleIds");
  }
  if (!Array.isArray(value.candidates)) throw new SafetyError("Rule candidates must be an array");

  for (const candidate of value.candidates) validateRuleCandidate(candidate, paths);
  return value as RuleProfile;
}

function validateRuleCandidate(candidate: RuleCandidate, paths: SystemPaths): void {
  if (!candidate || typeof candidate.pathTemplate !== "string") throw new SafetyError("Rule candidate needs pathTemplate");
  if (!candidate.reason || typeof candidate.reason !== "string") throw new SafetyError("Rule candidate needs reason");
  if (!candidate.kind || !candidate.risk) throw new SafetyError("Rule candidate needs kind and risk");
  if (candidate.match && !["exact", "prefix"].includes(candidate.match)) throw new SafetyError("Unsupported rule match mode");
  if (candidate.pathTemplate.includes("..") || /[*?\[\]]/u.test(candidate.pathTemplate)) {
    throw new SafetyError(`Unsafe path template: ${candidate.pathTemplate}`);
  }
  const tokens = [...candidate.pathTemplate.matchAll(/\{([^}]+)\}/gu)].map((match) => match[1]);
  if (tokens.some((token) => !token || !ALLOWED_TOKENS.has(token))) throw new SafetyError(`Unknown path template token: ${candidate.pathTemplate}`);

  const sample = expandRulePath(candidate.pathTemplate, {
    displayName: "Sample App",
    bundleId: "com.example.sample",
    path: join(paths.applications, "Sample App.app"),
    installSource: "standalone",
    packageReceipts: [],
  }, paths);
  if (protectedRoots(paths).includes(resolve(sample))) throw new SafetyError(`Rule resolves to a protected root: ${candidate.pathTemplate}`);
  validateLiteralPath(sample, paths);
  if (candidate.match === "prefix" && basename(sample).length < 4) throw new SafetyError(`Rule prefix is too broad: ${candidate.pathTemplate}`);
}

export function expandRulePath(template: string, app: AppIdentity, paths: SystemPaths): string {
  if (/[\/\0]/u.test(app.displayName) || app.displayName === "." || app.displayName === "..") {
    throw new SafetyError("Application display name is unsafe for rule expansion");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]+$/u.test(app.bundleId) || app.bundleId.includes("..")) {
    throw new SafetyError("Application bundle id is unsafe for rule expansion");
  }
  return template
    .replaceAll("{home}", paths.home)
    .replaceAll("{bundleId}", app.bundleId)
    .replaceAll("{appName}", app.displayName)
    .replaceAll("{temp}", paths.temp);
}

export async function loadRules(paths: SystemPaths): Promise<{ rules: RuleProfile[]; warnings: string[] }> {
  const rules = BUILTIN_RULES.map((rule) => validateRule(rule, paths));
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
      rules.push(validateRule(JSON.parse(content), paths));
    } catch (error) {
      warnings.push(`Invalid user rule ${basename(file)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { rules, warnings };
}

export function rulesForApp(rules: RuleProfile[], app: AppIdentity): RuleProfile[] {
  return rules.filter((rule) => rule.bundleIds.includes(app.bundleId));
}
