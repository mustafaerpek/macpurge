import { autocomplete, cancel, intro, isCancel, multiselect, note, outro } from "@clack/prompts";
import { listApplications, selectApplication } from "./apps";
import { humanBytes } from "./fs-utils";
import { isProtectedAppleApp } from "./app-policy";
import { scanApplication } from "./scanner";
import { closeApplication } from "./processes";
import { activity, confirmForce, selectedCandidates, typedConfirmation, CliError, type CliDeps } from "./cli-helpers";
import { appChoiceHint, appChoiceLabel, candidateChoiceLabel, printBanner, printScanReport, sessionOutro } from "./ui";

export async function interactive(deps: CliDeps): Promise<number> {
  if (!process.stdin.isTTY) throw new CliError("Interactive mode requires a TTY", 2);
  printBanner("Choose carefully. Undo confidently.");
  intro("Interactive application removal");
  const apps = await activity("Discovering applications", "Applications ready", true, () => listApplications(deps.paths, deps.runner));
  if (apps.length === 0) throw new CliError("No applications were found in supported local application roots", 1);
  const selectedPath = await autocomplete({
    message: "Search for an application",
    placeholder: "Type an app name…",
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
  const app = await selectApplication(String(selectedPath), deps.paths, deps.runner);
  const scan = await activity("Inspecting files, helpers, receipts, and registrations", "Deep scan complete", true, () => scanApplication(app, deps.paths, deps.runner, true));
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
  const closed = await closeApplication(app, deps.runner, confirmForce);
  if (!closed) throw new CliError("Application is still running; no files were moved", 3);
  const chosen = selectedCandidates(scan, included);
  const manifest = await activity("Moving verified files into quarantine", "Quarantine transaction complete", true, () => deps.quarantine.quarantine(app, chosen, scan.deferredActions));
  outro(sessionOutro(manifest));
  return manifest.status === "quarantined" ? 0 : 4;
}
