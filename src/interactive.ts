import { cancel, confirm, intro, isCancel, multiselect, note, outro, select, text } from "@clack/prompts";
import { listApplications, scoreMatch, selectApplication } from "./apps";
import { diskUsage, humanBytes } from "./fs-utils";
import { isProtectedAppleApp } from "./app-policy";
import { scanApplication } from "./scanner";
import { closeApplication } from "./processes";
import { activity, forceConfirmer, selectedCandidates, typedConfirmation, CliError, type CliDeps } from "./cli-helpers";
import { appChoiceLabel, candidateChoiceLabel, printBanner, printRiskSummary, printScanReport, sessionOutro } from "./ui";
import type { AppIdentity } from "./types";

function queryScore(app: AppIdentity, needle: string): number {
  if (!needle.trim()) return 1;
  return scoreMatch(app, needle);
}

export async function interactive(deps: CliDeps, options: { confirm?: string | undefined; assumeYes?: boolean } = {}): Promise<number> {
  if (!process.stdin.isTTY) throw new CliError("Interactive mode requires a TTY", 2);
  const assumeYes = options.assumeYes === true;
  printBanner("Choose carefully. Undo confidently.");
  intro("Interactive application removal");
  const apps = await activity("Discovering applications", "Applications ready", true, () => listApplications(deps.paths, deps.runner));
  if (apps.length === 0) throw new CliError("No applications were found in supported local application roots", 1);
  const sizes = await activity("Measuring application sizes", "Sizes ready", true, async () => {
    const entries = await Promise.all(apps.map(async (app) => [app.path, await diskUsage(app.path, deps.runner)] as const));
    return new Map(entries);
  });
  const keyword = await text({ message: "Search for an application", placeholder: "Type an app name…" });
  if (isCancel(keyword)) {
    cancel("Cancelled. No changes were made.");
    return 3;
  }
  const needle = String(keyword ?? "").trim();
  const ranked = apps
    .map((app) => ({ app, score: queryScore(app, needle) }))
    .filter((entry) => !needle || entry.score > 0)
    .sort((a, b) => b.score - a.score || a.app.displayName.localeCompare(b.app.displayName));
  if (ranked.length === 0) throw new CliError(`No installed application matches: ${needle || "(empty search)"}`, 2);
  const shortlist = ranked.slice(0, 10);
  const picked = await select({
    message: shortlist.length === 1 ? `One match for "${needle || "all applications"}"` : `Matches for "${needle || "all applications"}"`,
    options: shortlist.map(({ app }) => ({
      value: app.path,
      label: appChoiceLabel(app, sizes.get(app.path)),
      ...(isProtectedAppleApp(app) ? { disabled: true } : {}),
    })),
  });
  if (isCancel(picked)) {
    cancel("Cancelled. No changes were made.");
    return 3;
  }
  const selectedPath = String(picked);
  const listed = apps.find((app) => app.path === String(selectedPath));
  const app = listed ?? (await selectApplication(String(selectedPath), deps.paths, deps.runner));
  const scan = await activity("Inspecting files, helpers, receipts, and registrations", "Deep scan complete", true, () => scanApplication(app, deps.paths, deps.runner, true));
  printScanReport(scan, { summaryOnly: true });
  const confirmed = scan.candidates.filter((candidate) => candidate.risk === "confirmed");
  const possible = scan.candidates.filter((candidate) => candidate.risk === "possible");
  const protectedItems = scan.candidates.filter((candidate) => candidate.risk === "protected");
  console.log("");
  note(
    [
      `${confirmed.length} confirmed (${humanBytes(confirmed.reduce((sum, item) => sum + item.sizeBytes, 0))}) · selected by default`,
      `${possible.length} possible — opt in below, never automatic`,
      `${protectedItems.length} protected — cannot be selected`,
    ].join("\n"),
    "Scan complete",
  );
  let included: string[] = [];
  let includePossible = false;
  if (possible.length > 0 && !assumeYes) {
    const scope = await confirm({
      message: `Include all ${possible.length} possible leftovers, or pick individually?`,
      initialValue: false,
    });
    if (isCancel(scope)) {
      cancel("Cancelled. No changes were made.");
      return 3;
    }
    if (scope === true) {
      includePossible = true;
    } else {
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
  } else if (possible.length > 0 && assumeYes) {
    includePossible = false;
  }
  const chosen = selectedCandidates(scan, included, includePossible);
  if (chosen.length === 0) throw new CliError("Nothing selected: no confirmed candidates were found", 5);
  const payloadBytes = humanBytes(chosen.reduce((sum, item) => sum + item.sizeBytes, 0));
  printRiskSummary(scan.candidates);
  if (!assumeYes) {
    const review = await confirm({
      message: `Move ${chosen.length} item(s) (${payloadBytes}) into quarantine?`,
      initialValue: true,
    });
    if (isCancel(review) || review !== true) {
      cancel("Cancelled. No changes were made.");
      return 3;
    }
  }
  const provided = options.confirm ?? (assumeYes ? app.displayName : undefined);
  await typedConfirmation(app.displayName, provided);
  const closed = await closeApplication(app, deps.runner, forceConfirmer(assumeYes));
  if (!closed) throw new CliError("Application is still running; no files were moved", 3);
  const manifest = await activity("Moving verified files into quarantine", "Quarantine transaction complete", true, () => deps.quarantine.quarantine(app, chosen, scan.deferredActions));
  outro(sessionOutro(manifest));
  return manifest.status === "quarantined" ? 0 : 4;
}
