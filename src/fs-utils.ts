import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { basename } from "node:path";
import type { Candidate, CandidateKind, Evidence, RiskClass } from "./types";
import { parentNeedsAdmin } from "./safety";
import type { CommandRunner } from "./command";

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function candidateId(path: string, kind: CandidateKind): string {
  return createHash("sha256").update(`${kind}\0${path}`).digest("hex").slice(0, 12);
}

export async function diskUsage(path: string, runner: CommandRunner): Promise<number> {
  const result = await runner.run(["/usr/bin/du", "-sk", path]);
  if (result.exitCode !== 0) return 0;
  const kib = Number.parseInt(result.stdout.trim().split(/\s+/u)[0] ?? "0", 10);
  return Number.isFinite(kib) ? kib * 1024 : 0;
}

export async function makeCandidate(input: {
  path: string;
  kind: CandidateKind;
  risk: RiskClass;
  evidence: Evidence[];
  runner: CommandRunner;
}): Promise<Candidate | undefined> {
  let info;
  try {
    info = await lstat(input.path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    if (code === "EACCES" || code === "EPERM") {
      return {
        id: candidateId(input.path, input.kind),
        path: input.path,
        kind: input.kind,
        risk: "protected",
        evidence: [...input.evidence, { source: "standard-path", detail: `Inaccessible without additional system permission (${code})` }],
        sizeBytes: 0,
        requiresAdmin: true,
        selectedByDefault: false,
      };
    }
    throw error;
  }
  let resolved: string;
  try {
    resolved = await realpath(input.path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      return {
        id: candidateId(input.path, input.kind),
        path: input.path,
        kind: input.kind,
        risk: "protected",
        evidence: [...input.evidence, { source: "standard-path", detail: `Target cannot be resolved safely (${code})` }],
        sizeBytes: 0,
        owner: String(info.uid),
        group: String(info.gid),
        mode: (info.mode & 0o7777).toString(8),
        requiresAdmin: true,
        selectedByDefault: false,
      };
    }
    throw error;
  }
  const requiresAdmin = await parentNeedsAdmin(input.path);
  return {
    id: candidateId(input.path, input.kind),
    path: input.path,
    realPath: resolved,
    kind: input.kind,
    risk: input.risk,
    evidence: input.evidence,
    sizeBytes: await diskUsage(input.path, input.runner),
    owner: String(info.uid),
    group: String(info.gid),
    mode: (info.mode & 0o7777).toString(8),
    requiresAdmin,
    selectedByDefault: input.risk === "confirmed",
  };
}

export function humanBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

export function inferKind(path: string): CandidateKind {
  const lower = path.toLowerCase();
  if (lower.endsWith(".app")) return "application";
  if (lower.includes("application support")) return "application-support";
  if (lower.includes("/caches/")) return "cache";
  if (lower.includes("/preferences/")) return "preference";
  if (lower.includes("/httpstorages/")) return "http-storage";
  if (lower.includes("saved application state")) return "saved-state";
  if (lower.includes("/logs/")) return "log";
  if (lower.includes("/containers/")) return "container";
  if (lower.includes("launchagents")) return "launch-agent";
  if (lower.includes("launchdaemons")) return "launch-daemon";
  if (lower.includes("privilegedhelpertools")) return "privileged-helper";
  if (lower.includes("/var/folders/") || lower.includes("/tmp/")) return "temporary";
  if (["/usr/local/bin", "/opt/homebrew/bin"].some((root) => path.startsWith(`${root}/`))) return "cli-symlink";
  return "other";
}

export function appBaseName(path: string): string {
  return basename(path).replace(/\.app$/iu, "");
}
