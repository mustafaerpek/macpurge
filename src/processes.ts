import { resolve } from "node:path";
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

export function isAppProcessCommand(commandLine: string, appPath: string): boolean {
  const executable = executableFromCommandLine(commandLine);
  if (!executable) return false;
  try {
    return isWithin(resolve(executable), resolve(appPath));
  } catch {
    return false;
  }
}

export async function applicationPids(app: AppIdentity, runner: CommandRunner): Promise<number[]> {
  // Use pgrep -af to get PID + full command, then keep only processes whose
  // executable lives inside the bundle. A raw `pgrep -f <app.path>` substring
  // match would also hit editors/terminals that merely mention the path.
  const result = await runner.run(["/usr/bin/pgrep", "-af", app.path]);
  if (result.exitCode !== 0) return [];
  const pids: number[] = [];
  for (const line of result.stdout.split(/\r?\n/u)) {
    const match = line.match(/^(\d+)\s+(.*)$/u);
    if (!match) continue;
    const pid = Number.parseInt(match[1]!, 10);
    const commandLine = match[2] ?? "";
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    if (!isAppProcessCommand(commandLine, app.path)) continue;
    pids.push(pid);
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
