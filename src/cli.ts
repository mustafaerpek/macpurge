#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import {
  autocomplete,
  cancel,
  confirm,
  intro,
  isCancel,
  multiselect,
  note,
  outro,
  spinner,
  text,
} from "@clack/prompts";
import { BunCommandRunner } from "./command";
import { listApplications, selectApplication } from "./apps";
import { humanBytes } from "./fs-utils";
import { isProtectedAppleApp } from "./app-policy";
import { APP_VERSION } from "./version";
import { loadRules, rulesForApp } from "./rules";
import { scanApplication } from "./scanner";
import { defaultSystemPaths } from "./system-paths";
import { closeApplication } from "./processes";
import { QuarantineService } from "./quarantine";
import { SCHEMA_VERSION, type AppIdentity, type Candidate, type ScanResult } from "./types";
import {
  appChoiceHint,
  appChoiceLabel,
  candidateChoiceLabel,
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
  sessionOutro,
} from "./ui";

const paths = defaultSystemPaths();
const runner = new BunCommandRunner();
const quarantine = new QuarantineService(paths, runner);

class CliError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
    this.name = "CliError";
  }
}

interface Parsed {
  positionals: string[];
  values: {
    json?: boolean;
    help?: boolean;
    version?: boolean;
    "no-deep"?: boolean;
    "dry-run"?: boolean;
    include?: string[];
    confirm?: string;
  };
}

function parse(argv: string[]): Parsed {
  const result = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      "no-deep": { type: "boolean" },
      "dry-run": { type: "boolean" },
      include: { type: "string", multiple: true },
      confirm: { type: "string" },
    },
  });
  return { positionals: result.positionals, values: result.values } as Parsed;
}

function output(value: unknown, json: boolean): void {
  if (json) console.log(JSON.stringify(value, null, 2));
}

async function activity<T>(startMessage: string, doneMessage: string, enabled: boolean, operation: () => Promise<T>): Promise<T> {
  if (!enabled || !process.stdout.isTTY) return operation();
  const indicator = spinner();
  indicator.start(startMessage);
  try {
    const result = await operation();
    indicator.stop(doneMessage);
    return result;
  } catch (error) {
    indicator.stop("Stopped");
    throw error;
  }
}

async function typedConfirmation(expected: string, provided?: string): Promise<void> {
  if (provided !== undefined) {
    if (provided !== expected) throw new CliError(`Confirmation does not match exactly: ${expected}`, 2);
    return;
  }
  if (!process.stdin.isTTY) throw new CliError(`Non-interactive mutation requires --confirm "${expected}"`, 2);
  const answer = await text({
    message: `Type exactly "${expected}" to continue`,
    validate: (value) => (value === expected ? undefined : "The value does not match"),
  });
  if (isCancel(answer)) {
    cancel("Cancelled. No changes were made.");
    throw new CliError("Cancelled", 3);
  }
}

async function confirmForce(signal: "SIGTERM" | "SIGKILL", pids: number[]): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const answer = await confirm({
    message: `${signal} is required for processes ${pids.join(", ")}. Continue?`,
    initialValue: false,
  });
  return !isCancel(answer) && answer === true;
}

async function commandList(json: boolean): Promise<number> {
  const apps = await activity("Discovering installed applications", "Application inventory ready", !json, () => listApplications(paths, runner));
  if (json) output({ schemaVersion: SCHEMA_VERSION, status: "ok", applications: apps, warnings: [], errors: [] }, true);
  else printApplicationList(apps);
  return 0;
}

async function commandScan(selector: string | undefined, json: boolean, deep: boolean): Promise<number> {
  if (!selector) throw new CliError("scan requires an application selector", 2);
  const app = await activity("Resolving application identity", "Application identified", !json, () => selectApplication(selector, paths, runner));
  const result = await activity("Inspecting local files and registrations", "Deep scan complete", !json, () => scanApplication(app, paths, runner, deep));
  if (json) output(result, true);
  else printScanReport(result);
  return 0;
}

function selectedCandidates(scan: ScanResult, includes: string[]): Candidate[] {
  const byId = new Map(scan.candidates.map((candidate) => [candidate.id, candidate]));
  const selected = scan.candidates.filter((candidate) => candidate.risk === "confirmed");
  for (const id of includes) {
    const candidate = byId.get(id);
    if (!candidate) throw new CliError(`Unknown candidate id: ${id}`, 2);
    if (candidate.risk === "protected") throw new CliError(`Protected candidate cannot be included: ${candidate.path}`, 2);
    if (!selected.some((item) => item.id === candidate.id)) selected.push(candidate);
  }
  return selected;
}

async function commandUninstall(parsed: Parsed): Promise<number> {
  const selector = parsed.positionals[1];
  if (!selector) throw new CliError("uninstall requires an application selector", 2);
  const rich = parsed.values.json !== true;
  const app = await activity("Resolving application identity", "Application identified", rich, () => selectApplication(selector, paths, runner));
  if (isProtectedAppleApp(app)) throw new CliError("Apple system applications are protected and cannot be uninstalled", 2);
  const scan = await activity("Building a safe removal plan", "Removal plan ready", rich, () => scanApplication(app, paths, runner, parsed.values["no-deep"] !== true));
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
  const closed = await closeApplication(app, runner, confirmForce);
  if (!closed) throw new CliError("Application is still running; no files were moved", 3);
  const manifest = await activity("Moving verified files into quarantine", "Quarantine transaction complete", rich, () => quarantine.quarantine(app, selected, scan.deferredActions));
  if (parsed.values.json) output({ schemaVersion: SCHEMA_VERSION, status: manifest.status, app, sessionId: manifest.id, warnings: manifest.warnings, errors: manifest.errors }, true);
  else printSessionReport(manifest);
  return manifest.status === "quarantined" ? 0 : 4;
}

async function commandHistory(json: boolean): Promise<number> {
  const sessions = await quarantine.store.list();
  if (json) output({ schemaVersion: SCHEMA_VERSION, status: "ok", sessions, warnings: [], errors: [] }, true);
  else printHistory(sessions);
  return 0;
}

async function commandRestore(parsed: Parsed): Promise<number> {
  const id = parsed.positionals[1];
  if (!id) throw new CliError("restore requires a session id", 2);
  const existing = await quarantine.store.load(id);
  await typedConfirmation(existing.app.displayName, parsed.values.confirm);
  const manifest = await activity("Restoring quarantined files", "Restore transaction complete", parsed.values.json !== true, () => quarantine.restore(id));
  if (parsed.values.json) output({ schemaVersion: SCHEMA_VERSION, status: manifest.status, app: manifest.app, sessionId: id, warnings: manifest.warnings, errors: manifest.errors }, true);
  else printSessionReport(manifest);
  return manifest.status === "restored" ? 0 : 4;
}

async function commandPurge(parsed: Parsed): Promise<number> {
  const id = parsed.positionals[1];
  if (!id) throw new CliError("purge requires a session id", 2);
  await quarantine.store.load(id);
  await typedConfirmation(id, parsed.values.confirm);
  const manifest = await activity("Permanently purging this quarantine", "Permanent purge complete", parsed.values.json !== true, () => quarantine.purge(id));
  if (parsed.values.json) output({ schemaVersion: SCHEMA_VERSION, status: manifest.status, app: manifest.app, sessionId: id, warnings: manifest.warnings, errors: manifest.errors }, true);
  else printSessionReport(manifest);
  return manifest.status === "purged" ? 0 : 4;
}

async function identityForVerify(selector: string): Promise<AppIdentity> {
  if (/^[0-9a-f-]{36}$/u.test(selector)) return (await quarantine.store.load(selector)).app;
  return selectApplication(selector, paths, runner);
}

async function commandVerify(selector: string | undefined, json: boolean, deep: boolean): Promise<number> {
  if (!selector) throw new CliError("verify requires an application selector or session id", 2);
  const app = await activity("Resolving application or session", "Target identified", !json, () => identityForVerify(selector));
  const scan = await activity("Checking for remaining files and processes", "Verification scan complete", !json, () => scanApplication(app, paths, runner, deep));
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

async function commandDoctor(json: boolean): Promise<number> {
  const required = ["mdls", "mdfind", "plutil", "defaults", "security", "launchctl", "sfltool", "tccutil", "pkgutil", "osascript", "du", "stat", "codesign", "find"];
  const tools = Object.fromEntries(await Promise.all(required.map(async (tool) => [tool, await runner.exists(tool)] as const)));
  let quarantineWritable = true;
  try {
    await access(paths.userLibrary, constants.W_OK);
  } catch {
    quarantineWritable = false;
  }
  const sudo = await runner.run(["/usr/bin/sudo", "-n", "/usr/bin/true"]);
  const status: "ok" | "error" = process.platform === "darwin" && process.arch === "arm64" && quarantineWritable && Object.values(tools).every(Boolean) ? "ok" : "error";
  const report = {
    schemaVersion: SCHEMA_VERSION,
    status,
    platform: process.platform,
    architecture: process.arch,
    bunVersion: Bun.version,
    paths,
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

async function commandRules(parsed: Parsed): Promise<number> {
  const action = parsed.positionals[1] ?? "list";
  const loaded = await loadRules(paths);
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
    const app = await selectApplication(selector, paths, runner);
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

async function interactive(): Promise<number> {
  if (!process.stdin.isTTY) throw new CliError("Interactive mode requires a TTY", 2);
  printBanner("Choose carefully. Undo confidently.");
  intro("Interactive application removal");
  const apps = await activity("Discovering applications", "Applications ready", true, () => listApplications(paths, runner));
  if (apps.length === 0) throw new CliError("No applications were found in supported local application roots", 1);
  const selectedPath = await autocomplete({
    message: "Search for an application",
    placeholder: "Type an app name…",
    maxItems: 8,
    options: apps.map((app) => ({
      value: app.path,
      label: appChoiceLabel(app),
      hint: appChoiceHint(app),
      ...(isProtectedAppleApp(app) ? { disabled: true } : {}),
    })),
  });
  if (isCancel(selectedPath)) {
    cancel("Cancelled. No changes were made.");
    return 3;
  }
  const app = await selectApplication(String(selectedPath), paths, runner);
  const scan = await activity("Inspecting files, helpers, receipts, and registrations", "Deep scan complete", true, () => scanApplication(app, paths, runner, true));
  const confirmed = scan.candidates.filter((candidate) => candidate.risk === "confirmed");
  const possible = scan.candidates.filter((candidate) => candidate.risk === "possible");
  const protectedItems = scan.candidates.filter((candidate) => candidate.risk === "protected");
  printScanReport(scan);
  console.log("");
  note(
    [
      `${confirmed.length} confirmed (${humanBytes(confirmed.reduce((sum, item) => sum + item.sizeBytes, 0))})`,
      `${possible.length} possible — not selected by default`,
      `${protectedItems.length} protected — cannot be selected`,
    ].join("\n"),
    "Scan complete",
  );
  let included: string[] = [];
  if (possible.length > 0) {
    const answer = await multiselect({
      message: "Select any possible leftovers to include",
      options: possible.map((candidate) => ({ value: candidate.id, label: candidateChoiceLabel(candidate), hint: candidate.path })),
      required: false,
    });
    if (isCancel(answer)) {
      cancel("Cancelled. No changes were made.");
      return 3;
    }
    included = answer.map(String);
  }
  await typedConfirmation(app.displayName);
  const closed = await closeApplication(app, runner, confirmForce);
  if (!closed) throw new CliError("Application is still running; no files were moved", 3);
  const chosen = selectedCandidates(scan, included);
  const manifest = await activity("Moving verified files into quarantine", "Quarantine transaction complete", true, () => quarantine.quarantine(app, chosen, scan.deferredActions));
  outro(sessionOutro(manifest));
  return manifest.status === "quarantined" ? 0 : 4;
}

async function main(): Promise<number> {
  const parsed = parse(process.argv.slice(2));
  if (parsed.values.help) {
    printHelp();
    return 0;
  }
  if (parsed.values.version) {
    console.log(APP_VERSION);
    return 0;
  }
  const command = parsed.positionals[0];
  if (!command) return interactive();
  switch (command) {
    case "list": return commandList(parsed.values.json === true);
    case "scan": return commandScan(parsed.positionals[1], parsed.values.json === true, parsed.values["no-deep"] !== true);
    case "uninstall": return commandUninstall(parsed);
    case "history": return commandHistory(parsed.values.json === true);
    case "restore": return commandRestore(parsed);
    case "purge": return commandPurge(parsed);
    case "verify": return commandVerify(parsed.positionals[1], parsed.values.json === true, parsed.values["no-deep"] !== true);
    case "doctor": return commandDoctor(parsed.values.json === true);
    case "rules": return commandRules(parsed);
    case "help": printHelp(); return 0;
    default: throw new CliError(`Unknown command: ${command}. Run macpurge --help for available commands.`, 2);
  }
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
