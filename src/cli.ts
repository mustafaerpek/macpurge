#!/usr/bin/env bun
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { BunCommandRunner } from "./command";
import { listApplications, selectApplication } from "./apps";
import { isProtectedAppleApp } from "./app-policy";
import { APP_VERSION } from "./version";
import { loadRules, rulesForApp } from "./rules";
import { scanApplication } from "./scanner";
import { defaultSystemPaths } from "./system-paths";
import { closeApplication } from "./processes";
import { QuarantineService } from "./quarantine";
import { SCHEMA_VERSION, type AppIdentity, type ScanResult } from "./types";
import { interactive } from "./interactive";
import {
  activity,
  confirmForce,
  output,
  parse,
  selectedCandidates,
  typedConfirmation,
  CliError,
  type CliDeps,
  type Parsed,
} from "./cli-helpers";
import {
  printApplicationList,
  printBanner,
  printDoctor,
  printError,
  printHelp,
  printHistory,
  printKeyValue,
  printScanReport,
  printSection,
  printSessionReport,
  printSuccess,
  printWarning,
} from "./ui";

export type { CliDeps };
export { CliError };

export function createDefaultDeps(): CliDeps {
  const paths = defaultSystemPaths();
  const runner = new BunCommandRunner();
  return { paths, runner, quarantine: new QuarantineService(paths, runner) };
}

async function commandList(deps: CliDeps, json: boolean): Promise<number> {
  const apps = await activity("Discovering installed applications", "Application inventory ready", !json, () => listApplications(deps.paths, deps.runner));
  if (json) output({ schemaVersion: SCHEMA_VERSION, status: "ok", applications: apps, warnings: [], errors: [] }, true);
  else printApplicationList(apps);
  return 0;
}

async function commandScan(deps: CliDeps, selector: string | undefined, json: boolean, deep: boolean): Promise<number> {
  if (!selector) throw new CliError("scan requires an application selector", 2);
  const app = await activity("Resolving application identity", "Application identified", !json, () => selectApplication(selector, deps.paths, deps.runner));
  const result = await activity("Inspecting local files and registrations", "Deep scan complete", !json, () => scanApplication(app, deps.paths, deps.runner, deep));
  if (json) output(result, true);
  else printScanReport(result);
  return 0;
}

async function commandUninstall(deps: CliDeps, parsed: Parsed): Promise<number> {
  const selector = parsed.positionals[1];
  if (!selector) throw new CliError("uninstall requires an application selector", 2);
  const rich = parsed.values.json !== true;
  const app = await activity("Resolving application identity", "Application identified", rich, () => selectApplication(selector, deps.paths, deps.runner));
  if (isProtectedAppleApp(app)) throw new CliError("Apple system applications are protected and cannot be uninstalled", 2);
  const scan = await activity("Building a safe removal plan", "Removal plan ready", rich, () => scanApplication(app, deps.paths, deps.runner, parsed.values["no-deep"] !== true));
  const selected = selectedCandidates(scan, parsed.values.include ?? []);
  if (selected.length === 0) throw new CliError("No confirmed candidates were found", 5);

  if (parsed.values["dry-run"]) {
    const result = { ...scan, status: "found", selectedCandidateIds: selected.map((candidate) => candidate.id), dryRun: true };
    if (parsed.values.json) output(result, true);
    else {
      printScanReport(scan);
      printSuccess(`Dry run complete · ${selected.length} item(s) would enter quarantine.`);
    }
    return 0;
  }

  await typedConfirmation(app.displayName, parsed.values.confirm);
  const closed = await closeApplication(app, deps.runner, confirmForce);
  if (!closed) throw new CliError("Application is still running; no files were moved", 3);
  const manifest = await activity("Moving verified files into quarantine", "Quarantine transaction complete", rich, () => deps.quarantine.quarantine(app, selected, scan.deferredActions));
  if (parsed.values.json) output({ schemaVersion: SCHEMA_VERSION, status: manifest.status, app, sessionId: manifest.id, warnings: manifest.warnings, errors: manifest.errors }, true);
  else printSessionReport(manifest);
  return manifest.status === "quarantined" ? 0 : 4;
}

async function commandHistory(deps: CliDeps, json: boolean): Promise<number> {
  const sessions = await deps.quarantine.store.list();
  if (json) output({ schemaVersion: SCHEMA_VERSION, status: "ok", sessions, warnings: [], errors: [] }, true);
  else printHistory(sessions);
  return 0;
}

async function commandRestore(deps: CliDeps, parsed: Parsed): Promise<number> {
  const id = parsed.positionals[1];
  if (!id) throw new CliError("restore requires a session id", 2);
  const existing = await deps.quarantine.store.load(id);
  await typedConfirmation(existing.app.displayName, parsed.values.confirm);
  const manifest = await activity("Restoring quarantined files", "Restore transaction complete", parsed.values.json !== true, () => deps.quarantine.restore(id));
  if (parsed.values.json) output({ schemaVersion: SCHEMA_VERSION, status: manifest.status, app: manifest.app, sessionId: id, warnings: manifest.warnings, errors: manifest.errors }, true);
  else printSessionReport(manifest);
  return manifest.status === "restored" ? 0 : 4;
}

async function commandPurge(deps: CliDeps, parsed: Parsed): Promise<number> {
  const id = parsed.positionals[1];
  if (!id) throw new CliError("purge requires a session id", 2);
  await deps.quarantine.store.load(id);
  await typedConfirmation(id, parsed.values.confirm);
  const manifest = await activity("Permanently purging this quarantine", "Permanent purge complete", parsed.values.json !== true, () => deps.quarantine.purge(id));
  if (parsed.values.json) output({ schemaVersion: SCHEMA_VERSION, status: manifest.status, app: manifest.app, sessionId: id, warnings: manifest.warnings, errors: manifest.errors }, true);
  else printSessionReport(manifest);
  return manifest.status === "purged" ? 0 : 4;
}

async function identityForVerify(deps: CliDeps, selector: string): Promise<AppIdentity> {
  if (/^[0-9a-f-]{36}$/u.test(selector)) return (await deps.quarantine.store.load(selector)).app;
  return selectApplication(selector, deps.paths, deps.runner);
}

async function commandVerify(deps: CliDeps, selector: string | undefined, json: boolean, deep: boolean): Promise<number> {
  if (!selector) throw new CliError("verify requires an application selector or session id", 2);
  const app = await activity("Resolving application or session", "Target identified", !json, () => identityForVerify(deps, selector));
  const scan = await activity("Checking for remaining files and processes", "Verification scan complete", !json, () => scanApplication(app, deps.paths, deps.runner, deep));
  const residue = scan.candidates.filter((candidate) => candidate.risk !== "protected");
  const runtimeResidue = scan.warnings.some((warning) => warning.startsWith("RUNTIME_RESIDUE:"));
  const result: ScanResult = { ...scan, status: residue.length === 0 && !runtimeResidue ? "clean" : "found" };
  if (json) output(result, true);
  else {
    printScanReport(result);
    if (result.status === "clean") printSuccess("Verification passed · no removable residue found.");
    else printWarning("Verification found remaining files or active registrations.");
  }
  return residue.length === 0 && !runtimeResidue ? 0 : 5;
}

async function commandDoctor(deps: CliDeps, json: boolean): Promise<number> {
  const required = ["mdls", "mdfind", "plutil", "defaults", "security", "launchctl", "sfltool", "tccutil", "pkgutil", "osascript", "du", "stat", "codesign", "find"];
  const tools = Object.fromEntries(await Promise.all(required.map(async (tool) => [tool, await deps.runner.exists(tool)] as const)));
  let quarantineWritable = true;
  try {
    await access(deps.paths.userLibrary, constants.W_OK);
  } catch {
    quarantineWritable = false;
  }
  const sudo = await deps.runner.run(["/usr/bin/sudo", "-n", "/usr/bin/true"]);
  const status: "ok" | "error" = process.platform === "darwin" && process.arch === "arm64" && quarantineWritable && Object.values(tools).every(Boolean) ? "ok" : "error";
  const report = {
    schemaVersion: SCHEMA_VERSION,
    status,
    platform: process.platform,
    architecture: process.arch,
    bunVersion: Bun.version,
    paths: deps.paths,
    tools,
    quarantineWritable,
    sudoCredentialCached: sudo.exitCode === 0,
    warnings: sudo.exitCode === 0 ? [] : ["Administrator password will be requested only when a selected target requires it."],
    errors: [],
  };
  if (json) output(report, true);
  else printDoctor(report);
  return report.status === "ok" ? 0 : 1;
}

async function commandRules(deps: CliDeps, parsed: Parsed): Promise<number> {
  const action = parsed.positionals[1] ?? "list";
  const loaded = await loadRules(deps.paths);
  if (action === "validate") {
    const result = { schemaVersion: SCHEMA_VERSION, status: loaded.warnings.length === 0 ? "ok" : "error", ruleCount: loaded.rules.length, warnings: loaded.warnings, errors: [] };
    if (parsed.values.json) output(result, true);
    else {
      printBanner("Rules stay declarative, bounded, and explainable.");
      printSection("Validation", result.status.toUpperCase());
      printKeyValue("Profiles", String(loaded.rules.length));
      for (const warning of loaded.warnings) printWarning(warning);
    }
    return loaded.warnings.length === 0 ? 0 : 2;
  }
  if (action === "list") {
    if (parsed.values.json) output({ schemaVersion: SCHEMA_VERSION, status: "ok", rules: loaded.rules, warnings: loaded.warnings, errors: [] }, true);
    else {
      printBanner("Built-in and user-defined matching profiles.");
      printSection("Rules", `${loaded.rules.length} profiles`);
      for (const rule of loaded.rules) {
        console.log(`  ◆ ${rule.id}`);
        console.log(`    ${rule.bundleIds.join(", ")}`);
      }
      for (const warning of loaded.warnings) printWarning(warning);
    }
    return 0;
  }
  if (action === "explain") {
    const selector = parsed.positionals[2];
    if (!selector) throw new CliError("rules explain requires an application selector", 2);
    const app = await selectApplication(selector, deps.paths, deps.runner);
    const matching = rulesForApp(loaded.rules, app);
    if (parsed.values.json) output({ schemaVersion: SCHEMA_VERSION, status: "ok", app, rules: matching, warnings: loaded.warnings, errors: [] }, true);
    else {
      printBanner("See exactly why application files match.");
      printSection(app.displayName, app.bundleId);
      if (matching.length === 0) console.log("  ○ No application-specific rule matches this bundle.");
      for (const rule of matching) {
        printSection(rule.id, `${rule.candidates.length} candidates`);
        for (const candidate of rule.candidates) console.log(`  ◇ ${candidate.risk.toUpperCase()} · ${candidate.pathTemplate}\n    ${candidate.reason}`);
      }
      for (const warning of loaded.warnings) printWarning(warning);
    }
    return 0;
  }
  throw new CliError(`Unknown rules action: ${action}`, 2);
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const parsed = parse(argv);
  if (parsed.values.help) {
    printHelp();
    return 0;
  }
  if (parsed.values.version) {
    console.log(APP_VERSION);
    return 0;
  }
  const command = parsed.positionals[0];
  if (!command) return interactive(deps);
  switch (command) {
    case "list": return commandList(deps, parsed.values.json === true);
    case "scan": return commandScan(deps, parsed.positionals[1], parsed.values.json === true, parsed.values["no-deep"] !== true);
    case "uninstall": return commandUninstall(deps, parsed);
    case "history": return commandHistory(deps, parsed.values.json === true);
    case "restore": return commandRestore(deps, parsed);
    case "purge": return commandPurge(deps, parsed);
    case "verify": return commandVerify(deps, parsed.positionals[1], parsed.values.json === true, parsed.values["no-deep"] !== true);
    case "doctor": return commandDoctor(deps, parsed.values.json === true);
    case "rules": return commandRules(deps, parsed);
    case "help": printHelp(); return 0;
    default: throw new CliError(`Unknown command: ${command}. Run macpurge --help for available commands.`, 2);
  }
}

async function main(): Promise<number> {
  return runCli(process.argv.slice(2), createDefaultDeps());
}

try {
  process.exitCode = await main();
} catch (error) {
  const exitCode = error instanceof CliError ? error.exitCode : 1;
  const message = error instanceof Error ? error.message : String(error);
  const wantsJson = process.argv.includes("--json");
  if (wantsJson) console.log(JSON.stringify({ schemaVersion: SCHEMA_VERSION, status: "error", warnings: [], errors: [message] }, null, 2));
  else printError(message);
  process.exitCode = exitCode;
}
