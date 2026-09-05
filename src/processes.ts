import { realpath } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import type { AppIdentity } from "./types";
import type { CommandRunner } from "./command";
import { isWithin } from "./safety";

const QUIT_TIMEOUT_MS = 5_000;
const TERM_TIMEOUT_MS = 3_000;
const KILL_TIMEOUT_MS = 2_000;
const POLL_INTERVAL_MS = 250;

function escapeAppleScript(value: string): string {
  // AppleScript string literal: escape backslash + quote, encode CR/LF so a
  // crafted name cannot break out of the literal. Other characters ($ ; ` etc.)
  // stay inert inside the literal and never reach a shell (arg-array spawn).
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n").replaceAll("\r", "\\r");
}

// pgrep -f treats the pattern as an extended regular expression, so a literal
// app path must be escaped; otherwise metacharacters such as "C++" fail to
// compile (exit 2) and a running app would be misread as "not running".
function escapeEre(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function executableFromCommandLine(commandLine: string): string {
  const trimmed = commandLine.trim();
  if (!trimmed) return "";
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const end = trimmed.indexOf(quote, 1);
    if (end > 0) return trimmed.slice(1, end);
    return trimmed.slice(1);
  }
  const space = trimmed.search(/\s/u);
  return space === -1 ? trimmed : trimmed.slice(0, space);
}

async function candidateProcessRoots(app: AppIdentity): Promise<string[]> {
  const roots = [app.path];
  try {
    const real = await realpath(app.path);
    if (resolve(real) !== resolve(app.path)) roots.push(real);
  } catch {
    // Verification may target a bundle that no longer exists; the literal path
    // is then the only root.
  }
  return roots;
}

/**
 * Lexical comparison against the known bundle roots. This rejects the common
 * false-positive cases (editors, shells, grep) whose argument list merely
 * mentions the bundle path.
 */
export function isAppProcessCommand(commandLine: string, appPaths: string | readonly string[]): boolean {
  const executable = executableFromCommandLine(commandLine);
  if (!executable) return false;
  try {
    const resolved = resolve(executable);
    const roots = Array.isArray(appPaths) ? appPaths : [appPaths];
    return roots.some((root) => isWithin(resolved, resolve(root)));
  } catch {
    return false;
  }
}

/**
 * Resolves the reported executable and retries the comparison. Needed because
 * the path a process was launched with keeps ancestor symlink spellings
 * (/var vs /private/var, or a bundle installed through a symlink), which can
 * never match the scan-time roots lexically.
 */
async function resolvedExecutableWithinRoots(commandLine: string, roots: readonly string[]): Promise<boolean> {
  const executable = executableFromCommandLine(commandLine);
  if (!executable) return false;
  try {
    const real = await realpath(resolve(executable));
    return roots.some((root) => isWithin(real, resolve(root)));
  } catch {
    return false;
  }
}

export async function applicationPids(app: AppIdentity, runner: CommandRunner): Promise<number[]> {
  // macOS pgrep differs from Linux: -a means "include ancestors" (not "print
  // the command line"), so -fl is the combination that yields "PID args"
  // lines. The pattern is a case-insensitive ERE over the full argument list.
  // Matching on the bundle basename (instead of a full-path pattern) is
  // deliberate: the path a running process reports keeps the spelling it was
  // launched with, which can differ from both the literal and the fully
  // resolved bundle path. Exact ownership is verified per process below in
  // TypeScript, so pattern over-matching is harmless.
  const roots = await candidateProcessRoots(app);
  const bundleName = basename(app.path);
  const pattern = bundleName && bundleName !== sep ? escapeEre(bundleName) : roots.map((root) => escapeEre(root)).join("|");
  const result = await runner.run(["/usr/bin/pgrep", "-fil", pattern]);
  // Exit 1 is "no processes matched"; anything else is a lookup failure that
  // must surface instead of masquerading as a quiet app.
  if (result.exitCode === 1) return [];
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim();
    throw new Error(`Process lookup failed: pgrep exited with code ${result.exitCode}${detail ? `: ${detail}` : ""}`);
  }
  const pids: number[] = [];
  for (const line of result.stdout.split(/\r?\n/u)) {
    const match = line.match(/^(\d+)\s+(.*)$/u);
    if (!match) continue;
    const pid = Number.parseInt(match[1]!, 10);
    const commandLine = match[2] ?? "";
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    if (isAppProcessCommand(commandLine, roots)) {
      pids.push(pid);
      continue;
    }
    if (await resolvedExecutableWithinRoots(commandLine, roots)) pids.push(pid);
  }
  return pids;
}

async function waitUntilClosed(app: AppIdentity, runner: CommandRunner, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await applicationPids(app, runner)).length === 0) return true;
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  return (await applicationPids(app, runner)).length === 0;
}

export async function closeApplication(
  app: AppIdentity,
  runner: CommandRunner,
  confirmForce: (signal: "SIGTERM" | "SIGKILL", pids: number[]) => Promise<boolean>,
): Promise<boolean> {
  let pids = await applicationPids(app, runner);
  if (pids.length === 0) return true;

  const script = `tell application id "${escapeAppleScript(app.bundleId)}" to quit`;
  await runner.run(["/usr/bin/osascript", "-e", script]);
  if (await waitUntilClosed(app, runner, QUIT_TIMEOUT_MS)) return true;

  pids = await applicationPids(app, runner);
  if (!(await confirmForce("SIGTERM", pids))) return false;
  for (const pid of pids) await runner.run(["/bin/kill", "-TERM", String(pid)]);
  if (await waitUntilClosed(app, runner, TERM_TIMEOUT_MS)) return true;

  pids = await applicationPids(app, runner);
  if (!(await confirmForce("SIGKILL", pids))) return false;
  for (const pid of pids) await runner.run(["/bin/kill", "-KILL", String(pid)]);
  return waitUntilClosed(app, runner, KILL_TIMEOUT_MS);
}

export function loginItemDeleteScript(name: string): string {
  return `tell application "System Events" to delete login item "${escapeAppleScript(name)}"`;
}

export function loginItemExistsScript(name: string): string {
  return `tell application "System Events" to exists login item "${escapeAppleScript(name)}"`;
}

export async function loginItemExists(name: string, runner: CommandRunner): Promise<boolean> {
  // Exact-match query: avoids parsing the comma-joined `get the name of every
  // login item` list, where a legitimate comma in a name corrupts detection.
  const result = await runner.run(["/usr/bin/osascript", "-e", loginItemExistsScript(name)]);
  return result.exitCode === 0 && result.stdout.trim().toLowerCase() === "true";
}
