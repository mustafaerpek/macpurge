import type { AppIdentity } from "./types";
import type { CommandRunner } from "./command";

function escapeAppleScript(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export async function applicationPids(app: AppIdentity, runner: CommandRunner): Promise<number[]> {
  const result = await runner.run(["/usr/bin/pgrep", "-f", app.path]);
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split(/\r?\n/u)
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isInteger(value) && value > 0 && value !== process.pid);
}

async function waitUntilClosed(app: AppIdentity, runner: CommandRunner, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await applicationPids(app, runner)).length === 0) return true;
    await Bun.sleep(250);
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
  if (await waitUntilClosed(app, runner, 5_000)) return true;

  pids = await applicationPids(app, runner);
  if (!(await confirmForce("SIGTERM", pids))) return false;
  for (const pid of pids) await runner.run(["/bin/kill", "-TERM", String(pid)]);
  if (await waitUntilClosed(app, runner, 3_000)) return true;

  pids = await applicationPids(app, runner);
  if (!(await confirmForce("SIGKILL", pids))) return false;
  for (const pid of pids) await runner.run(["/bin/kill", "-KILL", String(pid)]);
  return waitUntilClosed(app, runner, 2_000);
}

export function loginItemDeleteScript(name: string): string {
  return `tell application "System Events" to delete login item "${escapeAppleScript(name)}"`;
}
