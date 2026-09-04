import { parseArgs } from "node:util";
import { cancel, confirm, isCancel, spinner, text } from "@clack/prompts";
import type { CommandRunner } from "./command";
import type { QuarantineService } from "./quarantine";
import type { Candidate, ScanResult, SystemPaths } from "./types";

export interface CliDeps {
  paths: SystemPaths;
  runner: CommandRunner;
  quarantine: QuarantineService;
}

export class CliError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
    this.name = "CliError";
  }
}

export interface Parsed {
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

export function parse(argv: string[]): Parsed {
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

export function output(value: unknown, json: boolean): void {
  if (json) console.log(JSON.stringify(value, null, 2));
}

export async function activity<T>(startMessage: string, doneMessage: string, enabled: boolean, operation: () => Promise<T>): Promise<T> {
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

export async function typedConfirmation(expected: string, provided?: string): Promise<void> {
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

export async function confirmForce(signal: "SIGTERM" | "SIGKILL", pids: number[]): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const answer = await confirm({
    message: `${signal} is required for processes ${pids.join(", ")}. Continue?`,
    initialValue: false,
  });
  return !isCancel(answer) && answer === true;
}

export function selectedCandidates(scan: ScanResult, includes: string[]): Candidate[] {
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
