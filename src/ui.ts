import pc from "picocolors";
import { basename } from "node:path";
import { humanBytes } from "./fs-utils";
import { isProtectedAppleApp } from "./app-policy";
import { APP_VERSION } from "./version";
import type { AppIdentity, Candidate, DeferredAction, InstallSource, ScanResult, SessionManifest } from "./types";

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

export function printScanReport(scan: ScanResult): void {
  printBanner("Inspect deeply. Remove deliberately.");
  printAppCard(scan.app);

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
  printSection("History", `${sessions.length} sessions`);
  for (const session of sessions) {
    console.log(`  ${statusVisual(session.status)}  ${pc.bold(session.app.displayName)}`);
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
  warnings: string[];
}): void {
  printBanner("System readiness and safety checks.");
  printSection("Health", statusVisual(report.status));
  printKeyValue("System", `${report.platform} · ${report.architecture}`);
  printKeyValue("Runtime", `Bun ${report.bunVersion}`);
  printKeyValue("Quarantine", report.quarantineWritable ? pc.green("Writable") : pc.red("Unavailable"));
  printKeyValue("Admin", report.sudoCredentialCached ? pc.green("Ready") : pc.dim("On demand"));
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
    ["macpurge history", "Review previous sessions"],
    ["macpurge restore <session>", "Put quarantined files back"],
    ["macpurge purge <session>", "Permanently remove one quarantine"],
    ["macpurge verify <app|session>", "Check for remaining files"],
    ["macpurge doctor", "Check system readiness"],
    ["macpurge rules <action>", "Validate, list, or explain rules"],
  ];
  for (const [command, description] of commands) {
    console.log(`  ${pc.cyan(pad(command!, 34))} ${pc.dim(description!)}`);
  }
  printSection("Safety model");
  console.log(`  ${pc.green("●")} Confirmed files are selected by default and moved to quarantine.`);
  console.log(`  ${pc.yellow("◐")} Possible matches always require your explicit selection.`);
  console.log(`  ${pc.dim("○")} Protected paths can never be selected.`);
  console.log(`\n  ${pc.dim("Use --json for stable machine output and --help for this guide.")}`);
}

export function appChoiceLabel(app: AppIdentity): string {
  return isProtectedAppleApp(app) ? pc.dim(app.displayName) : pc.bold(app.displayName);
}

export function appChoiceHint(app: AppIdentity): string {
  return `${app.version ?? "version unknown"} · ${sourceLabel(app.installSource)}${isProtectedAppleApp(app) ? " · protected" : ""}`;
}

export function sessionOutro(manifest: SessionManifest): string {
  return `${manifest.status === "quarantined" ? "✓" : "!"} ${manifest.app.displayName} · ${manifest.status}\nRestore: macpurge restore ${manifest.id}\nPurge:   macpurge purge ${manifest.id}`;
}

export function candidateChoiceLabel(candidate: Candidate): string {
  return `${basename(candidate.path)}  ${pc.dim(humanBytes(candidate.sizeBytes))}`;
}
