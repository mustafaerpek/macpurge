import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { basename } from "node:path";
import type { Candidate, CandidateKind, Evidence, RiskClass } from "./types";
import { fileTypeOf, parentNeedsAdmin } from "./safety";
import type { CommandRunner } from "./command";

export async function hasMaclLock(path: string, runner: CommandRunner | null): Promise<boolean> {
  // The macl xattr shows on EITHER the entry itself or its children,
  // depending on flags used (-lO shows it on the parent row, -l@ on the
  // child row). Probe the parent with both spellings; a listing denial
  // (TCC on Containers/) is itself proof the entry cannot be moved.
  const probeFlags = async (target: string): Promise<{ output: string | null; denied: boolean }> => {
    const outputs: string[] = [];
    let denied = false;
    for (const flag of ["-lO", "-l@"]) {
      let exitCode: number;
      let stdout: string;
      let stderr: string;
      if (runner) {
        const result = await runner.run(["/bin/ls", flag, target]);
        exitCode = result.exitCode;
        stdout = result.stdout;
        stderr = result.stderr;
      } else {
        const proc = Bun.spawn({ cmd: ["/bin/ls", flag, target], stdin: "ignore", stdout: "pipe", stderr: "pipe" });
        [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      }
      if (exitCode === 0) {
        if (stdout.includes("com.apple.macl")) return { output: stdout, denied: false };
        outputs.push(stdout);
      } else if (stderr.includes("Operation not permitted") || stderr.includes("EPERM")) {
        denied = true;
      }
    }
    return outputs.length > 0 ? { output: outputs.join("\n"), denied } : { output: null, denied };
  };
  const self = await probeFlags(path);
  if (self.output?.includes("com.apple.macl")) return true;
  const children = await probeFlags(`${path}/Data`);
  if (children.output?.includes("com.apple.macl")) return true;
  // A container whose Data/ cannot even be listed is unmovable by definition
  // (the earlier rename probe proved EPERM) — regardless of xattr visibility.
  if (path.includes("/Containers/") && children.denied) return true;
  if (self.output !== null) return false;
  if (self.denied) return children.denied;
  return false;
}

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
  checkMacl?: boolean;
}): Promise<Candidate | undefined> {
  const protectedCandidate = (
    detail: string,
    extra?: Pick<Candidate, "owner" | "group" | "mode" | "dev" | "ino" | "fileType">,
  ): Candidate => ({
    id: candidateId(input.path, input.kind),
    path: input.path,
    kind: input.kind,
    risk: "protected",
    evidence: [...input.evidence, { source: "standard-path", detail }],
    sizeBytes: 0,
    ...extra,
    requiresAdmin: true,
    selectedByDefault: false,
  });
  let info;
  try {
    info = await lstat(input.path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    if (code === "EACCES" || code === "EPERM") {
      return protectedCandidate(`Inaccessible without additional system permission (${code})`);
    }
    throw error;
  }
  let resolved: string;
  try {
    resolved = await realpath(input.path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      return protectedCandidate(`Target cannot be resolved safely (${code})`, {
        owner: String(info.uid),
        group: String(info.gid),
        mode: (info.mode & 0o7777).toString(8),
        dev: info.dev,
        ino: info.ino,
        fileType: fileTypeOf(info),
      });
    }
    // Dangling symlink or entry vanishing mid-scan: skip instead of crashing.
    if (code === "ENOENT") return undefined;
    throw error;
  }
  const requiresAdmin = await parentNeedsAdmin(input.path);
  if (input.checkMacl && (input.kind === "container" || input.path.includes("/Containers/"))) {
    try {
      if (await hasMaclLock(input.path, input.runner)) {
        return protectedCandidate("Sandbox container carries a com.apple.macl privacy lock; even the owner cannot move it");
      }
    } catch {
      // MACL probe failure must not block the scan; the move will surface it.
    }
  }
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
    dev: info.dev,
    ino: info.ino,
    fileType: fileTypeOf(info),
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
