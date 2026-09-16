#!/usr/bin/env bun
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { BunCommandRunner } from "./command";
import { listApplications, readAppIdentity, selectApplication } from "./apps";
import { isProtectedAppleApp } from "./app-policy";
import { APP_VERSION } from "./version";
import { loadRules, rulesForApp } from "./rules";
import { scanApplication } from "./scanner";
import { addWhitelistCategory, addWhitelistPath, CLEAN_CATEGORIES, cleanIdentity, emptyTrash, loadCleanWhitelist, saveCleanWhitelist, scanClean, selectCleanItems } from "./clean";
import { defaultSystemPaths } from "./system-paths";
import { closeApplication } from "./processes";
import { QuarantineService } from "./quarantine";
import { SCHEMA_VERSION, type AppIdentity, type CleanCategoryId, type ScanResult } from "./types";
import { interactive } from "./interactive";
import {
  activity,
  confirmSudo,
  forceConfirmer,
  output,
  parse,
  selectedCandidates,
  typedConfirmation,
  CliError,
  type CliDeps,
  type Parsed,
} from "./cli-helpers";
import {
  cleanCategoryLabel,
  printApplicationList,
  printBanner,
  printCleanReport,
  printDoctor,
  printError,
  printHelp,
  printHistory,
  printKeyValue,
  printNextSteps,
  printPartialGuidance,
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

async function readAppIdentityForCli(selector: string, deps: CliDeps): Promise<AppIdentity> {
  return readAppIdentity(resolve(selector), deps.paths, deps.runner);
}

async function commandList(deps: CliDeps, json: boolean): Promise<number> {
  const apps = await activity("Discovering installed applications", "Application inventory ready", !json, () => listApplications(deps.paths, deps.runner));
  if (json) output({ schemaVersion: SCHEMA_VERSION, status: "ok", applications: apps, warnings: [], errors: [] }, true);
  else printApplicationList(apps);
  return 0;
}

async function commandScan(deps: CliDeps, selector: string | undefined, parsed: Parsed): Promise<number> {
  if (!selector) throw new CliError("scan requires an application selector", 2);
  const json = parsed.values.json === true;
  const deep = parsed.values["no-deep"] !== true;
  const summaryOnly = parsed.values.summary === true;
  const app = await activity("Resolving application identity", "Application identified", !json, () => selectApplication(selector, deps.paths, deps.runner));
  const result = await activity("Inspecting local files and registrations", "Deep scan complete", !json, () => scanApplication(app, deps.paths, deps.runner, deep));
  if (json) output(result, true);
  else printScanReport(result, { summaryOnly });
  return 0;
}

function mutationConfirmation(parsed: Parsed, fallback: string): string | undefined {
  if (parsed.values.confirm !== undefined) return parsed.values.confirm;
  if (parsed.values.yes === true) return fallback;
  return undefined;
}

async function commandUninstall(deps: CliDeps, parsed: Parsed): Promise<number> {
  const selector = parsed.positionals[1];
  if (!selector) throw new CliError("uninstall requires an application selector", 2);
  const rich = parsed.values.json !== true;
  const assumeYes = parsed.values.yes === true;
  if (selector.startsWith("/")) {
    try {
      const direct = await readAppIdentityForCli(selector, deps);
      if (isProtectedAppleApp(direct)) throw new CliError("Apple system applications are protected and cannot be uninstalled", 2);
    } catch (error) {
      if (error instanceof CliError && error.message.includes("protected")) throw error;
    }
  }
  const app = await activity("Resolving application identity", "Application identified", rich, () => selectApplication(selector, deps.paths, deps.runner));
  if (isProtectedAppleApp(app)) throw new CliError("Apple system applications are protected and cannot be uninstalled", 2);
  const scan = await activity("Building a safe removal plan", "Removal plan ready", rich, () => scanApplication(app, deps.paths, deps.runner, parsed.values["no-deep"] !== true));
  const selected = selectedCandidates(scan, parsed.values.include ?? [], parsed.values["include-possible"] === true);
  if (selected.length === 0) throw new CliError("No confirmed candidates were found", 5);

  if (parsed.values["dry-run"]) {
    const result = { ...scan, status: "found", selectedCandidateIds: selected.map((candidate) => candidate.id), dryRun: true };
    if (parsed.values.json) output(result, true);
    else {
      printScanReport(scan, { summaryOnly: parsed.values.summary === true });
      printSuccess(`Dry run complete · ${selected.length} item(s) would enter quarantine.`);
    }
    return 0;
  }

  await typedConfirmation(app.displayName, mutationConfirmation(parsed, app.displayName));
  const closed = await closeApplication(app, deps.runner, forceConfirmer(assumeYes));
  if (!closed) throw new CliError("Application is still running; no files were moved", 3);
  if (selected.some((item) => item.requiresAdmin) && rich && !assumeYes) {
    const sudoCheck = await deps.runner.run(["/usr/bin/sudo", "-n", "/usr/bin/true"]);
    if (sudoCheck.exitCode !== 0) {
      printWarning("Some items need administrator access. macOS will ask for your password now — approve it in the terminal prompt.");
      if (!(await confirmSudo())) throw new CliError("Cancelled", 3);
    }
  }
  const manifest = await activity("Moving verified files into quarantine", "Quarantine transaction complete", false, () => deps.quarantine.quarantine(app, selected, scan.deferredActions));
  if (parsed.values.json) output({ schemaVersion: SCHEMA_VERSION, status: manifest.status, app, sessionId: manifest.id, warnings: manifest.warnings, errors: manifest.errors }, true);
  else {
    printSessionReport(manifest);
    if (manifest.status === "partial") printPartialGuidance(manifest.id);
    else printNextSteps(manifest.id, manifest.app.displayName);
  }
  return manifest.status === "quarantined" ? 0 : 4;
}

async function commandHistory(deps: CliDeps, json: boolean): Promise<number> {
  const sessions = await deps.quarantine.store.list();
  if (json) output({ schemaVersion: SCHEMA_VERSION, status: "ok", sessions, warnings: [], errors: [] }, true);
  else printHistory(sessions);
  return 0;
}

function parseCleanCategories(values: string[] | undefined, includeAll: boolean): CleanCategoryId[] | undefined {
  const known = new Set(CLEAN_CATEGORIES.map((category) => category.id));
  if (values !== undefined && values.length > 0) {
    const ids = values as CleanCategoryId[];
    for (const id of ids) {
      if (!known.has(id)) throw new CliError(`Unknown clean category: ${id}. Available: ${[...known].join(", ")}`, 2);
    }
    return ids;
  }
  if (includeAll) return undefined;
  return CLEAN_CATEGORIES.filter((category) => category.id !== "orphaned-leftovers").map((category) => category.id);
}

async function commandCleanWhitelist(deps: CliDeps, raw: string | boolean | undefined, json: boolean): Promise<number> {
  const value = typeof raw === "string" ? raw : undefined;
  if (!value) throw new CliError("clean --whitelist needs a path (~/..., /...) or a category id", 2);
  const whitelist = await loadCleanWhitelist(deps.paths);
  const known = new Set(CLEAN_CATEGORIES.map((category) => category.id));
  const updated = known.has(value as CleanCategoryId)
    ? addWhitelistCategory(whitelist, value as CleanCategoryId)
    : addWhitelistPath(whitelist, value);
  await saveCleanWhitelist(deps.paths, updated);
  const message = `Whitelisted ${value}. It will be skipped by future clean scans.`;
  if (json) output({ schemaVersion: SCHEMA_VERSION, status: "ok", whitelist: updated, warnings: [], errors: [] }, true);
  else {
    printBanner("This stays out of your way from now on.");
    printSection("Whitelist", message);
    printKeyValue("Categories", updated.categories.join(", ") || "—");
    printKeyValue("Paths", String(updated.paths.length));
  }
  return 0;
}

async function commandClean(deps: CliDeps, parsed: Parsed): Promise<number> {
  if (parsed.values.whitelist !== undefined) {
    return commandCleanWhitelist(deps, parsed.values.whitelist, parsed.values.json === true);
  }
  const json = parsed.values.json === true;
  const rich = !json;
  const assumeYes = parsed.values.yes === true;
  const categories = parseCleanCategories(parsed.values.category, parsed.values["all-categories"] === true);
  const result = await activity("Scanning caches, logs, trash, and leftovers", "Cleanup scan complete", rich, () =>
    scanClean(deps.paths, deps.runner, categories === undefined ? {} : { categories }),
  );
  const selected = selectCleanItems(result.items, categories ?? result.categories.map((category) => category.id), parsed.values.include ?? []);
  if (selected.length === 0) {
    if (json) output({ ...result, selectedItemIds: [], dryRun: parsed.values["dry-run"] === true }, true);
    else {
      printCleanReport(result, { summaryOnly: parsed.values.summary === true });
      printSuccess("Nothing to clean · no candidates matched.");
    }
    return 0;
  }
  if (parsed.values["dry-run"]) {
    if (json) output({ ...result, selectedItemIds: selected.map((item) => item.id), dryRun: true }, true);
    else {
      printCleanReport({ ...result, items: selected }, { summaryOnly: parsed.values.summary === true });
      printSuccess(`Dry run complete · ${selected.length} item(s) would enter quarantine.`);
    }
    return 0;
  }
  if (rich && !assumeYes) {
    const prompts = await import("@clack/prompts");
    printCleanReport(result, { summaryOnly: true });
    const picked = await prompts.multiselect({
      message: "Select cleanup categories",
      options: result.categories.filter((category) => category.itemCount > 0).map((category) => ({
        value: category.id,
        label: cleanCategoryLabel(category.title, category.itemCount, category.totalBytes, category.selectedByDefault),
        hint: category.description,
      })),
      initialValues: result.categories.filter((category) => category.selectedByDefault && category.itemCount > 0).map((category) => category.id),
      required: false,
    });
    if (prompts.isCancel(picked)) {
      prompts.cancel("Cancelled. No changes were made.");
      return 3;
    }
    const enabled = new Set((picked as string[]).map(String));
    const rescoped = selected.filter((item) => enabled.has(item.category));
    if (rescoped.length === 0) throw new CliError("Nothing selected: no cleanup categories were chosen", 5);
    return quarantineClean(deps, parsed, result, rescoped, assumeYes);
  }
  return quarantineClean(deps, parsed, result, selected, assumeYes);
}

async function quarantineClean(
  deps: CliDeps,
  parsed: Parsed,
  result: import("./types").CleanResult & { trashInventory?: import("./clean").TrashInventory },
  selected: import("./types").CleanItem[],
  assumeYes: boolean,
): Promise<number> {
  const rich = parsed.values.json !== true;
  const trashSelected = selected.some((item) => item.category === "trash" || item.id === "finder:trash");
  const trashCount = result.trashInventory?.count ?? 0;
  const trashUnavailable = result.trashInventory?.unavailable === true;
  const nonTrash = selected.filter((item) => item.category !== "trash");
  if (rich) printCleanReport({ ...result, items: selected }, { summaryOnly: parsed.values.summary === true });
  if (trashSelected && !trashUnavailable && trashCount > 0) {
    printWarning(`Trash (${trashCount} item(s)) will be emptied permanently via Finder — this cannot enter quarantine or be restored.`);
  }
  await typedConfirmation("System Cleanup", mutationConfirmation(parsed, "System Cleanup"));
  void assumeYes;
  let trashDetail: string | undefined;
  if (trashSelected && !trashUnavailable && trashCount > 0) {
    const emptied = await activity("Emptying Trash via Finder", "Trash emptied", rich, () => emptyTrash(deps.runner));
    trashDetail = emptied.detail;
    if (!emptied.emptied) {
      if (parsed.values.json) {
        output({ schemaVersion: SCHEMA_VERSION, status: "error", trashEmptied: false, trashDetail, warnings: result.warnings, errors: [...result.errors, trashDetail] }, true);
      } else {
        printError(`Trash was not emptied: ${trashDetail}`);
      }
      if (nonTrash.length === 0) return 1;
    } else if (rich) {
      printSuccess(trashDetail);
    }
  }
  if (nonTrash.length === 0) {
    if (parsed.values.json) {
      output({ schemaVersion: SCHEMA_VERSION, status: "ok", trashEmptied: trashDetail !== undefined, trashDetail, warnings: result.warnings, errors: result.errors }, true);
    }
    return 0;
  }
  const manifest = await activity("Moving cleanup candidates into quarantine", "Quarantine transaction complete", rich, () =>
    deps.quarantine.quarantine(cleanIdentity(), nonTrash, []),
  );
  const warnings = trashDetail ? [...manifest.warnings, trashDetail] : manifest.warnings;
  if (parsed.values.json) output({ schemaVersion: SCHEMA_VERSION, status: manifest.status, app: manifest.app, sessionId: manifest.id, trashEmptied: trashDetail !== undefined, trashDetail, warnings, errors: manifest.errors }, true);
  else {
    printSessionReport({ ...manifest, warnings });
    printNextSteps(manifest.id, manifest.app.displayName);
  }
  return manifest.status === "quarantined" ? 0 : 4;
}

async function commandRestore(deps: CliDeps, parsed: Parsed): Promise<number> {
  const raw = parsed.positionals[1];
  if (!raw) throw new CliError("restore requires a session id (or 'latest')", 2);
  const id = await deps.quarantine.store.resolve(raw);
  const existing = await deps.quarantine.store.load(id);
  await typedConfirmation(existing.app.displayName, mutationConfirmation(parsed, existing.app.displayName));
  const manifest = await activity("Restoring quarantined files", "Restore transaction complete", parsed.values.json !== true, () => deps.quarantine.restore(id));
  if (parsed.values.json) output({ schemaVersion: SCHEMA_VERSION, status: manifest.status, app: manifest.app, sessionId: manifest.id, warnings: manifest.warnings, errors: manifest.errors }, true);
  else printSessionReport(manifest);
  return manifest.status === "restored" ? 0 : 4;
}

async function commandPurge(deps: CliDeps, parsed: Parsed): Promise<number> {
  const raw = parsed.positionals[1];
  if (!raw) throw new CliError("purge requires a session id (or 'latest')", 2);
  const id = await deps.quarantine.store.resolve(raw);
  const existing = await deps.quarantine.store.load(id);
  if (existing.status === "partial" && !parsed.values["dry-run"]) {
    const unmoved = existing.items.filter((item) => item.status !== "moved" && item.status !== "purged");
    if (parsed.values.json) {
      output({ schemaVersion: SCHEMA_VERSION, status: existing.status, app: existing.app, sessionId: id, unmoved: unmoved.map((item) => ({ path: item.originalPath, error: item.error })), warnings: existing.warnings, errors: existing.errors }, true);
    } else {
      printSessionReport(existing);
      printWarning(`${unmoved.length} item(s) never reached quarantine and cannot be purged.`);
      for (const item of unmoved.slice(0, 5)) printError(`${item.originalPath}: ${item.error ?? "not moved"}`);
      printPartialGuidance(id);
    }
    throw new CliError("A partial session with unmoved items must be restored or repaired before purge", 4);
  }
  if (parsed.values["dry-run"]) {
    if (parsed.values.json) {
      const unmovedDry = existing.status === "partial" ? existing.items.filter((item) => item.status !== "moved" && item.status !== "purged") : [];
      output({ schemaVersion: SCHEMA_VERSION, status: existing.status, app: existing.app, sessionId: id, itemCount: existing.items.length, unmoved: unmovedDry.map((item) => ({ path: item.originalPath, error: item.error })), deferredActions: existing.deferredActions, dryRun: true, warnings: existing.warnings, errors: existing.errors }, true);
    } else {
      printSessionReport(existing);
      if (existing.status === "partial") {
        printWarning("This session is partial: unmoved items would block a real purge. Restore first, then retry.");
        printPartialGuidance(id);
      } else {
        printSuccess(`Dry run complete · ${existing.items.length} item(s) would be permanently deleted.`);
      }
    }
    return 0;
  }
  printSessionReport(existing);
  if (parsed.values.json !== true) printNextSteps(id, existing.app.displayName);
  await typedConfirmation(existing.app.displayName, mutationConfirmation(parsed, existing.app.displayName));
  const manifest = await activity("Permanently purging this quarantine", "Permanent purge complete", parsed.values.json !== true, () => deps.quarantine.purge(id));
  if (parsed.values.json) output({ schemaVersion: SCHEMA_VERSION, status: manifest.status, app: manifest.app, sessionId: manifest.id, warnings: manifest.warnings, errors: manifest.errors }, true);
  else printSessionReport(manifest);
  return manifest.status === "purged" ? 0 : 4;
}

async function identityForVerify(deps: CliDeps, selector: string): Promise<AppIdentity> {
  try {
    return (await deps.quarantine.store.load(await deps.quarantine.store.resolve(selector))).app;
  } catch {
    return selectApplication(selector, deps.paths, deps.runner);
  }
}

async function commandVerify(deps: CliDeps, parsed: Parsed): Promise<number> {
  const selector = parsed.positionals[1];
  if (!selector) throw new CliError("verify requires an application selector or session id", 2);
  const json = parsed.values.json === true;
  const deep = parsed.values["no-deep"] !== true;
  const app = await activity("Resolving application or session", "Target identified", !json, () => identityForVerify(deps, selector));
  const scan = await activity("Checking for remaining files and processes", "Verification scan complete", !json, () => scanApplication(app, deps.paths, deps.runner, deep));
  const residue = scan.candidates.filter((candidate) => candidate.risk !== "protected");
  const runtimeResidue = scan.warnings.some((warning) => warning.startsWith("RUNTIME_RESIDUE:"));
  const result: ScanResult = { ...scan, status: residue.length === 0 && !runtimeResidue ? "clean" : "found" };
  if (json) output(result, true);
  else {
    printScanReport(result, { summaryOnly: parsed.values.summary === true });
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
  let trashReadable = true;
  try {
    await access(join(deps.paths.home, ".Trash"), constants.R_OK | constants.X_OK);
  } catch {
    trashReadable = false;
  }
  const sudo = await deps.runner.run(["/usr/bin/sudo", "-n", "/usr/bin/true"]);
  const status: "ok" | "error" = process.platform === "darwin" && process.arch === "arm64" && quarantineWritable && Object.values(tools).every(Boolean) ? "ok" : "error";
  const warnings = sudo.exitCode === 0 ? [] : ["Administrator password will be requested only when a selected target requires it."];
  if (!trashReadable) warnings.push("Trash is not directly readable (Full Disk Access not granted). Clean reads Trash through Finder and empties it permanently via Finder.");
  const report = {
    schemaVersion: SCHEMA_VERSION,
    status,
    platform: process.platform,
    architecture: process.arch,
    bunVersion: Bun.version,
    paths: deps.paths,
    tools,
    quarantineWritable,
    trashDirectlyReadable: trashReadable,
    sudoCredentialCached: sudo.exitCode === 0,
    warnings,
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
    const app = await activity("Resolving application identity", "Application identified", parsed.values.json !== true, () => selectApplication(selector, deps.paths, deps.runner));
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
  if (!command) return interactive(deps, { confirm: parsed.values.confirm, assumeYes: parsed.values.yes === true });
  switch (command) {
    case "list": return commandList(deps, parsed.values.json === true);
    case "scan": return commandScan(deps, parsed.positionals[1], parsed);
    case "uninstall": return commandUninstall(deps, parsed);
    case "clean": return commandClean(deps, parsed);
    case "history": return commandHistory(deps, parsed.values.json === true);
    case "restore": return commandRestore(deps, parsed);
    case "purge": return commandPurge(deps, parsed);
    case "verify": return commandVerify(deps, parsed);
    case "doctor": return commandDoctor(deps, parsed.values.json === true);
    case "rules": return commandRules(deps, parsed);
    case "help": printHelp(); return 0;
    default: throw new CliError(`Unknown command: ${command}. Run macpurge --help for available commands.`, 2);
  }
}

async function main(): Promise<number> {
  return runCli(process.argv.slice(2), createDefaultDeps());
}

// Only run the command router when this file is the entrypoint. Importing the
// module (tests, tooling) must never execute main() or leak an exit code into
// the host process.
if (import.meta.main) {
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
}
