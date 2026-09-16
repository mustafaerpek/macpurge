import pc from "picocolors";
import { basename } from "node:path";
import { humanBytes } from "./fs-utils";
import { isProtectedAppleApp } from "./app-policy";
import { APP_VERSION } from "./version";
import type { AppIdentity, Candidate, CleanItem, CleanResult, DeferredAction, InstallSource, ScanResult, SessionManifest } from "./types";

const MIN_WIDTH = 62;
const MAX_WIDTH = 96;

function width(): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, process.stdout.columns ?? 80));
}

function shorten(value: string, maximum: number): string {
  const home = process.env.HOME;
  const compact = home && value.startsWith(`${home}/`) ? `~${value.slice(home.length)}` : value;
  if (compact.length <= maximum) return compact;
  const tail = compact.slice(-(maximum - 2));
  return `…/${tail.replace(/^\/+/, "")}`;
}

function pad(value: string, length: number): string {
  return value.length >= length ? value : `${value}${" ".repeat(length - value.length)}`;
}

function border(character = "─"): string {
  return character.repeat(width() - 2);
}

function sourceLabel(source: InstallSource): string {
  switch (source) {
    case "homebrew": return pc.magenta("Homebrew");
    case "app-store": return pc.blue("App Store");
    case "pkg": return pc.yellow("PKG");
    case "standalone": return pc.cyan("Standalone");
    default: return pc.dim("Unknown");
  }
}

function riskVisual(risk: Candidate["risk"]): { icon: string; label: string } {
  switch (risk) {
    case "confirmed": return { icon: pc.green("●"), label: pc.green(pc.bold("CONFIRMED")) };
    case "possible": return { icon: pc.yellow("◐"), label: pc.yellow(pc.bold("REVIEW")) };
    case "protected": return { icon: pc.dim("○"), label: pc.dim(pc.bold("PROTECTED")) };
  }
}

function statusVisual(status: SessionManifest["status"] | "clean" | "found" | "ok" | "error"): string {
  switch (status) {
    case "quarantined":
    case "restored":
    case "purged":
    case "clean":
    case "ok":
      return pc.green(`● ${status.toUpperCase()}`);
    case "partial":
    case "found":
    case "planned":
    case "quarantining":
    case "purging":
      return pc.yellow(`◐ ${status.toUpperCase()}`);
    case "failed":
    case "error":
      return pc.red(`● ${status.toUpperCase()}`);
  }
}

export function printBanner(tagline = "Safe removal. Reversible by default."): void {
  const inner = width() - 4;
  const title = "◆ MACPURGE";
  const version = `v${APP_VERSION}`;
  const gap = Math.max(1, inner - title.length - version.length);
  console.log(pc.cyan(`╭${border()}╮`));
  console.log(`${pc.cyan("│")} ${pc.bold(pc.cyan("◆ MAC"))}${pc.bold(pc.magenta("PURGE"))}${" ".repeat(gap)}${pc.dim(version)} ${pc.cyan("│")}`);
  console.log(`${pc.cyan("│")} ${pc.dim(pad(tagline, inner))} ${pc.cyan("│")}`);
  console.log(pc.cyan(`╰${border()}╯`));
}

export function printSection(title: string, detail?: string): void {
  const suffix = detail ? `  ${pc.dim(detail)}` : "";
  console.log(`\n${pc.cyan("◆")} ${pc.bold(title)}${suffix}`);
}

export function printKeyValue(label: string, value: string): void {
  console.log(`  ${pc.dim(pad(label, 14))} ${value}`);
}

export function printAppCard(app: AppIdentity): void {
  printSection(app.displayName, app.version ? `v${app.version}` : undefined);
  printKeyValue("Bundle ID", pc.cyan(app.bundleId));
  printKeyValue("Source", `${sourceLabel(app.installSource)}${app.managerId ? pc.dim(` · ${app.managerId}`) : ""}`);
  printKeyValue("Location", shorten(app.path, width() - 20));
  if (app.teamId) printKeyValue("Team", app.teamId);
}

export function printCandidate(candidate: Candidate): void {
  const visual = riskVisual(candidate.risk);
  const size = pad(humanBytes(candidate.sizeBytes), 9);
  const maxPath = width() - 8;
  console.log(`  ${visual.icon} ${pc.dim(size)} ${shorten(candidate.path, maxPath)}`);
  console.log(`    ${visual.label}  ${pc.dim(candidate.kind)}  ${pc.dim(`#${candidate.id}`)}`);
}

export function printScanReport(scan: ScanResult, options: { summaryOnly?: boolean } = {}): void {
  printBanner("Inspect deeply. Remove deliberately.");
  printAppCard(scan.app);

  if (options.summaryOnly) {
    printRiskSummary(scan.candidates);
    if (scan.deferredActions.length > 0) printDeferred(scan.deferredActions);
    for (const warning of scan.warnings) printWarning(warning);
    for (const error of scan.errors) printError(error);
    return;
  }

  const groups: Array<{ risk: Candidate["risk"]; title: string; help: string }> = [
    { risk: "confirmed", title: "Ready to quarantine", help: "Strong ownership evidence" },
    { risk: "possible", title: "Needs your review", help: "Never selected automatically" },
    { risk: "protected", title: "Protected", help: "Cannot be selected" },
  ];
  for (const group of groups) {
    const candidates = scan.candidates.filter((candidate) => candidate.risk === group.risk);
    if (candidates.length === 0) continue;
    const total = candidates.reduce((sum, candidate) => sum + candidate.sizeBytes, 0);
    printSection(group.title, `${candidates.length} items · ${humanBytes(total)} · ${group.help}`);
    for (const candidate of candidates) printCandidate(candidate);
  }

  if (scan.candidates.length === 0) {
    printSection("Nothing found");
    console.log(`  ${pc.green("✓")} No local files matched this application.`);
  }

  if (scan.deferredActions.length > 0) printDeferred(scan.deferredActions);
  printRiskSummary(scan.candidates);
  for (const warning of scan.warnings) printWarning(warning);
  for (const error of scan.errors) printError(error);
}

export function printRiskSummary(candidates: Candidate[]): void {
  const count = (risk: Candidate["risk"]) => candidates.filter((candidate) => candidate.risk === risk).length;
  const bytes = (risk: Candidate["risk"]) => candidates
    .filter((candidate) => candidate.risk === risk)
    .reduce((sum, candidate) => sum + candidate.sizeBytes, 0);
  console.log(`\n${pc.dim(border("═"))}`);
  console.log(
    `${pc.green("●")} ${pc.bold(String(count("confirmed")))} confirmed ${pc.dim(`(${humanBytes(bytes("confirmed"))})`)}   ` +
    `${pc.yellow("◐")} ${pc.bold(String(count("possible")))} review   ` +
    `${pc.dim("○")} ${pc.bold(String(count("protected")))} protected`,
  );
  console.log(pc.dim(border("═")));
}

export function printDeferred(actions: DeferredAction[]): void {
  printSection("Held until permanent purge", `${actions.length} deferred actions`);
  for (const action of actions) console.log(`  ${pc.magenta("◇")} ${action.description}`);
}

export function printCleanReport(result: CleanResult, options: { summaryOnly?: boolean } = {}): void {
  printBanner("Reclaim space. Keep what matters.");
  const finderBytes = (result as CleanResult & { trashInventory?: { totalBytes: number } }).trashInventory?.totalBytes ?? 0;
  const totalBytes = result.items.reduce((sum, item) => sum + item.sizeBytes, 0) + finderBytes;
  printSection("Cleanup plan", `${result.items.length} items · ${humanBytes(totalBytes)}`);
  for (const category of result.categories) {
    if (category.itemCount === 0 && category.id !== "trash") continue;
    if (category.id === "trash") {
      const trash = (result as CleanResult & { trashInventory?: { count: number; totalBytes: number; unavailable: boolean } }).trashInventory;
      const detail = trash?.unavailable
        ? "Finder inventory unavailable"
        : trash && trash.count > 0
          ? `${trash.count} item(s)${trash.totalBytes > 0 ? ` · ${humanBytes(trash.totalBytes)}` : ""} in Finder Trash · emptied permanently, never quarantined`
          : "Trash is empty";
      printSection(category.title, detail);
      if (!options.summaryOnly && category.itemCount > 0) {
        for (const item of result.items.filter((entry) => entry.category === category.id)) {
          printCleanItem(item);
        }
      }
      continue;
    }
    printSection(category.title, `${category.itemCount} items · ${humanBytes(category.totalBytes)} · ${category.description}`);
    if (!options.summaryOnly) {
      for (const item of result.items.filter((entry) => entry.category === category.id)) {
        printCleanItem(item);
      }
    }
  }
  if (result.items.length === 0) {
    printSection("Nothing found");
    console.log(`  ${pc.green("✓")} No cleanup candidates matched this Mac.`);
  }
  for (const warning of result.warnings) printWarning(warning);
  for (const error of result.errors) printError(error);
}

export function printCleanItem(item: CleanItem): void {
  const size = pad(humanBytes(item.sizeBytes), 9);
  const maxPath = width() - 8;
  const marker = item.risk === "possible" ? pc.yellow("◐") : pc.green("●");
  console.log(`  ${marker} ${pc.dim(size)} ${shorten(item.path, maxPath)}`);
  console.log(`    ${pc.dim(item.categoryTitle)}  ${pc.dim(item.kind)}  ${pc.dim(`#${item.id}`)}`);
}

export function cleanCategoryLabel(title: string, count: number, bytes: number, selected: boolean): string {
  const box = selected ? pc.green("●") : pc.dim("○");
  return `${box} ${title}  ${pc.dim(`${count} · ${humanBytes(bytes)}`)}`;
}

export function cleanItemChoiceLabel(item: CleanItem): string {
  return `${basename(item.path)}  ${pc.dim(humanBytes(item.sizeBytes))}`;
}

export function printSessionReport(manifest: SessionManifest): void {
  printBanner("Quarantine gives you a way back.");
  printSection("Operation result", statusVisual(manifest.status));
  printKeyValue("Application", manifest.app.displayName);
  printKeyValue("Session", pc.cyan(manifest.id));
  printKeyValue("Items", String(manifest.items.length));
  const movedBytes = manifest.items.reduce((sum, item) => sum + item.candidate.sizeBytes, 0);
  printKeyValue("Payload", humanBytes(movedBytes));
  for (const warning of manifest.warnings) printWarning(warning);
  for (const error of manifest.errors) printError(error);
}

export function printNextSteps(sessionId: string, displayName: string): void {
  console.log(`\n${pc.dim("Next:")} ${pc.cyan(`macpurge verify "${displayName}"`)} ${pc.dim("·")} ${pc.cyan(`macpurge restore ${sessionId}`)} ${pc.dim("·")} ${pc.cyan(`macpurge purge ${sessionId}`)}`);
}

export function printPartialGuidance(sessionId: string): void {
  console.log(`\n${pc.yellow("Some items could not be moved.")} ${pc.dim("Common causes: root-owned app bundles need sudo, sandbox containers carry a macOS privacy lock (com.apple.macl) that even the owner cannot move.")}`);
  console.log(`${pc.dim("Moved items are safe in quarantine. To finish:")} ${pc.cyan(`macpurge restore ${sessionId}`)} ${pc.dim("puts them back, then retry with")} ${pc.cyan("sudo -v")} ${pc.dim("first, or exclude the locked paths.")}`);
}

export function printApplicationList(apps: AppIdentity[]): void {
  printBanner(`${apps.length} applications discovered on this Mac.`);
  printSection("Applications", "name · version · source");
  for (const app of apps) {
    const protectedApp = isProtectedAppleApp(app);
    const icon = protectedApp ? pc.dim("○") : pc.cyan("●");
    const name = pad(shorten(app.displayName, 30), 30);
    const version = pad(shorten(app.version ?? "—", 12), 12);
    console.log(`  ${icon} ${protectedApp ? pc.dim(name) : pc.bold(name)} ${pc.dim(version)} ${sourceLabel(app.installSource)}`);
    console.log(`    ${pc.dim(shorten(app.bundleId, width() - 8))}`);
  }
}

export function printHistory(sessions: SessionManifest[]): void {
  printBanner("Every mutation leaves a recoverable record.");
  if (sessions.length === 0) {
    printSection("History");
    console.log(`  ${pc.dim("○")} No macpurge sessions yet.`);
    return;
  }
  printSection("History", `${sessions.length} sessions · restore/purge accept a short id or 'latest'`);
  for (const session of sessions) {
    console.log(`  ${statusVisual(session.status)}  ${pc.bold(session.app.displayName)} ${pc.dim(`· ${session.id.slice(0, 8)}`)}`);
    console.log(`    ${pc.dim(`${session.createdAt} · ${session.id}`)}`);
  }
}

export function printDoctor(report: {
  status: "ok" | "error";
  platform: string;
  architecture: string;
  bunVersion: string;
  paths: { quarantineRoot: string };
  tools: Record<string, boolean>;
  quarantineWritable: boolean;
  sudoCredentialCached: boolean;
  trashDirectlyReadable?: boolean;
  warnings: string[];
}): void {
  printBanner("System readiness and safety checks.");
  printSection("Health", statusVisual(report.status));
  printKeyValue("System", `${report.platform} · ${report.architecture}`);
  printKeyValue("Runtime", `Bun ${report.bunVersion}`);
  printKeyValue("Quarantine", report.quarantineWritable ? pc.green("Writable") : pc.red("Unavailable"));
  printKeyValue("Admin", report.sudoCredentialCached ? pc.green("Ready") : pc.dim("On demand"));
  if (report.trashDirectlyReadable !== undefined) {
    printKeyValue("Trash", report.trashDirectlyReadable ? pc.green("Direct read") : pc.yellow("Via Finder"));
  }
  printSection("macOS tools", `${Object.values(report.tools).filter(Boolean).length}/${Object.keys(report.tools).length} available`);
  const entries = Object.entries(report.tools);
  for (let index = 0; index < entries.length; index += 3) {
    const row = entries.slice(index, index + 3).map(([tool, present]) =>
      `${present ? pc.green("✓") : pc.red("×")} ${pad(tool, 12)}`,
    );
    console.log(`  ${row.join("  ")}`);
  }
  printKeyValue("Storage", shorten(report.paths.quarantineRoot, width() - 20));
  for (const warning of report.warnings) printWarning(warning);
}

export function printSuccess(message: string): void {
  console.log(`\n${pc.green("✓")} ${pc.bold(message)}`);
}

export function printWarning(message: string): void {
  console.warn(`\n${pc.yellow("!")} ${pc.yellow(message)}`);
}

export function printError(message: string): void {
  console.error(`${pc.red("×")} ${pc.red(message)}`);
}

export function printHelp(): void {
  printBanner("A careful, reversible macOS app uninstaller.");
  printSection("Commands");
  const commands = [
    ["macpurge", "Choose an application interactively"],
    ["macpurge list", "Browse installed applications"],
    ["macpurge scan <app>", "Inspect files without changing anything"],
    ["macpurge uninstall <app>", "Move confirmed files into quarantine"],
    ["macpurge clean", "Review safe caches, logs, and leftovers"],
    ["macpurge history", "Review previous sessions"],
    ["macpurge restore <session|latest>", "Put quarantined files back"],
    ["macpurge purge <session|latest>", "Permanently remove one quarantine"],
    ["macpurge verify <app|session>", "Check for remaining files"],
    ["macpurge doctor", "Check system readiness"],
    ["macpurge rules <action>", "Validate, list, or explain rules"],
  ];
  for (const [command, description] of commands) {
    console.log(`  ${pc.cyan(pad(command!, 34))} ${pc.dim(description!)}`);
  }
  printSection("Selection");
  console.log(`  ${pc.dim("App selectors accept a path, bundle id, or a fuzzy name (e.g. 'vscode'). Apple apps stay protected.")}`);
  console.log(`  ${pc.dim("Sessions accept a full id, a unique short prefix, or 'latest'.")}`);
  console.log(`  ${pc.dim("Clean accepts --category <id> (repeatable) or --all-categories for orphans too.")}`);
  printSection("Options");
  const options = [
    ["--yes, -y", "Skip typed + process confirmations (scripts)"],
    ["--confirm <text>", "Non-interactive typed confirmation"],
    ["--include <id>", "Also quarantine one possible item (repeatable)"],
    ["--include-possible", "Quarantine every possible/review item"],
    ["--category <id>", "Clean only these categories (repeatable)"],
    ["--all-categories", "Include orphaned leftovers in clean"],
    ["--whitelist <path|id>", "Never offer this path or category again (repeatable)"],
    ["--whitelist-list", "Show the clean whitelist"],
    ["--whitelist-remove <entry>", "Stop skipping this path or category (repeatable)"],
    ["--dry-run", "Preview uninstall, clean, or purge without changing anything"],
    ["--summary", "Show counts instead of the full file list"],
    ["--no-deep", "Skip the bounded filesystem sweep"],
    ["--json", "Stable machine output"],
  ];
  for (const [flag, description] of options) {
    console.log(`  ${pc.cyan(pad(flag!, 34))} ${pc.dim(description!)}`);
  }
  printSection("Safety model");
  console.log(`  ${pc.green("●")} Confirmed files are selected by default and moved to quarantine.`);
  console.log(`  ${pc.yellow("◐")} Possible matches always require your explicit selection.`);
  console.log(`  ${pc.dim("○")} Protected paths can never be selected.`);
}

export function appChoiceLabel(app: AppIdentity, sizeBytes?: number): string {
  const size = sizeBytes === undefined || sizeBytes <= 0 ? "—" : humanBytes(sizeBytes);
  const meta = `${size} · ${shortSource(app.installSource)}${isProtectedAppleApp(app) ? " · protected" : ""}`;
  const name = isProtectedAppleApp(app) ? pc.dim(app.displayName) : pc.bold(app.displayName);
  return `${name} ${pc.dim(`(${meta})`)}`;
}

function shortSource(source: InstallSource): string {
  switch (source) {
    case "homebrew": return "Homebrew";
    case "app-store": return "App Store";
    case "pkg": return "PKG";
    case "standalone": return "Standalone";
    default: return "Unknown";
  }
}

export function sessionOutro(manifest: SessionManifest): string {
  return `${manifest.status === "quarantined" ? "✓" : "!"} ${manifest.app.displayName} · ${manifest.status}\nRestore: macpurge restore ${manifest.id}\nPurge:   macpurge purge ${manifest.id}`;
}

export function candidateChoiceLabel(candidate: Candidate): string {
  return `${basename(candidate.path)}  ${pc.dim(humanBytes(candidate.sizeBytes))}`;
}
