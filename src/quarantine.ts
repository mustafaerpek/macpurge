import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { CommandRunner } from "./command";
import { ManifestStore } from "./manifest-store";
import { assertQuarantinePath, isWithin, revalidateCandidate, SafetyError, validateLiteralPath } from "./safety";
import { loginItemDeleteScript } from "./processes";
import { pathExists } from "./fs-utils";
import {
  SCHEMA_VERSION,
  type Candidate,
  type DeferredAction,
  type SessionManifest,
  type SystemPaths,
} from "./types";

export function collapseCandidates(candidates: Candidate[]): Candidate[] {
  const sorted = [...candidates].sort((a, b) => a.path.split(sep).length - b.path.split(sep).length || a.path.localeCompare(b.path));
  const kept: Candidate[] = [];
  for (const candidate of sorted) {
    if (kept.some((parent) => parent.path !== candidate.path && isWithin(candidate.path, parent.path))) continue;
    kept.push(candidate);
  }
  return kept;
}

function payloadPath(sessionRoot: string, original: string): string {
  const relativePath = original.replace(/^\/+/, "");
  return join(sessionRoot, "payload", relativePath);
}

async function sameDevice(source: string, destinationRoot: string): Promise<boolean> {
  // stat (follow) is intentional here: rename(2) moves the link object, but the
  // volume check must compare the containing filesystems. lstat would report the
  // link itself; realpath/lstat drift is already enforced by revalidateCandidate.
  const [sourceInfo, destinationInfo] = await Promise.all([stat(source), stat(destinationRoot)]);
  return sourceInfo.dev === destinationInfo.dev;
}

export class QuarantineService {
  readonly store: ManifestStore;

  constructor(
    private readonly paths: SystemPaths,
    private readonly runner: CommandRunner,
  ) {
    this.store = new ManifestStore(paths);
  }

  private async move(source: string, destination: string, admin: boolean): Promise<void> {
    if (admin) {
      const prepared = await this.runner.run(["/usr/bin/sudo", "/bin/mkdir", "-p", dirname(destination)], { interactive: true });
      if (prepared.exitCode !== 0) throw new Error(`sudo mkdir failed with exit code ${prepared.exitCode}`);
      const result = await this.runner.run(["/usr/bin/sudo", "/bin/mv", source, destination], { interactive: true });
      if (result.exitCode !== 0) throw new Error(`sudo mv failed with exit code ${result.exitCode}`);
    } else {
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await rename(source, destination);
    }
  }

  async quarantine(app: SessionManifest["app"], candidates: Candidate[], deferredActions: DeferredAction[]): Promise<SessionManifest> {
    if (candidates.some((candidate) => candidate.risk === "protected")) {
      throw new SafetyError("Protected candidates cannot be quarantined");
    }
    const id = randomUUID();
    const sessionDirectory = join(this.paths.quarantineRoot, id);
    await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
    const chosen = collapseCandidates(candidates);
    const now = new Date().toISOString();
    const manifest: SessionManifest = {
      schemaVersion: SCHEMA_VERSION,
      id,
      createdAt: now,
      updatedAt: now,
      status: "planned",
      app,
      items: chosen.map((candidate) => ({
        candidate,
        originalPath: candidate.path,
        quarantinePath: payloadPath(sessionDirectory, candidate.path),
        status: "pending",
      })),
      deferredActions,
      warnings: [],
      errors: [],
    };
    await this.store.save(manifest);
    manifest.status = "quarantining";
    await this.store.save(manifest);

    for (const item of manifest.items) {
      try {
        const source = await revalidateCandidate(item.candidate, this.paths);
        const destination = assertQuarantinePath(item.quarantinePath, this.paths);
        if (await pathExists(destination)) throw new SafetyError(`Quarantine destination already exists: ${destination}`);
        if (!(await sameDevice(source, sessionDirectory))) throw new SafetyError(`Cross-volume quarantine is not supported: ${source}`);
        await this.move(source, destination, item.candidate.requiresAdmin);
        item.status = "moved";
      } catch (error) {
        item.status = "failed";
        item.error = error instanceof Error ? error.message : String(error);
        manifest.errors.push(`${item.originalPath}: ${item.error}`);
      }
      await this.store.save(manifest);
    }

    manifest.status = manifest.items.every((item) => item.status === "moved") ? "quarantined" : "partial";
    await this.store.save(manifest);
    return manifest;
  }

  async restore(id: string): Promise<SessionManifest> {
    const manifest = await this.store.load(id);
    if (!["quarantined", "partial"].includes(manifest.status)) throw new Error(`Session cannot be restored from status ${manifest.status}`);
    manifest.errors = [];

    for (const item of [...manifest.items].reverse()) {
      if (item.status !== "moved") continue;
      try {
        const source = assertQuarantinePath(item.quarantinePath, this.paths);
        const destination = validateLiteralPath(item.originalPath, this.paths);
        if (!(await pathExists(source))) throw new Error(`Quarantined item is missing: ${source}`);
        if (await pathExists(destination)) throw new Error(`Restore destination already exists: ${destination}`);
        await this.move(source, destination, item.candidate.requiresAdmin);
        item.status = "restored";
        delete item.error;
      } catch (error) {
        item.status = "failed";
        item.error = error instanceof Error ? error.message : String(error);
        manifest.errors.push(`${item.originalPath}: ${item.error}`);
      }
      await this.store.save(manifest);
    }
    manifest.status = manifest.items.every((item) => item.status === "restored") ? "restored" : "partial";
    await this.store.save(manifest);
    return manifest;
  }

  private async runDeferred(action: DeferredAction): Promise<string | undefined> {
    let command: string[];
    switch (action.type) {
      case "homebrew-cask": {
        const installed = await this.runner.run(["brew", "list", "--cask", action.value]);
        if (installed.exitCode !== 0) return undefined;
        command = ["brew", "uninstall", "--cask", "--force", action.value];
        break;
      }
      case "pkg-receipt": {
        const found = await this.runner.run(["/usr/sbin/pkgutil", "--pkg-info", action.value]);
        if (found.exitCode !== 0) return undefined;
        command = ["/usr/bin/sudo", "/usr/sbin/pkgutil", "--forget", action.value];
        break;
      }
      case "keychain": {
        const found = await this.runner.run(["/usr/bin/security", "find-generic-password", "-s", action.value]);
        if (found.exitCode !== 0) return undefined;
        command = ["/usr/bin/security", "delete-generic-password", "-s", action.value];
        break;
      }
      case "tcc":
        command = ["/usr/bin/tccutil", "reset", "All", action.value];
        break;
      case "preferences-domain": {
        const found = await this.runner.run(["/usr/bin/defaults", "read", action.value]);
        if (found.exitCode !== 0) return undefined;
        command = ["/usr/bin/defaults", "delete", action.value];
        break;
      }
      case "login-item":
        command = ["/usr/bin/osascript", "-e", loginItemDeleteScript(action.value)];
        break;
      default:
        throw new SafetyError(`Unknown deferred action type: ${JSON.stringify((action as DeferredAction).type)}`);
    }
    const result = await this.runner.run(command, { interactive: action.requiresAdmin });
    return result.exitCode === 0 ? undefined : `${action.description} failed with exit code ${result.exitCode}`;
  }

  async purge(id: string): Promise<SessionManifest> {
    const manifest = await this.store.load(id);
    if (!["quarantined", "partial"].includes(manifest.status)) throw new Error(`Session cannot be purged from status ${manifest.status}`);
    if (manifest.items.some((item) => item.status !== "moved" && item.status !== "purged")) {
      throw new Error("A partial session with unmoved items must be restored or repaired before purge");
    }
    manifest.status = "purging";
    manifest.errors = [];
    await this.store.save(manifest);

    const ordered = [...manifest.deferredActions].sort((a, b) => Number(a.type !== "homebrew-cask") - Number(b.type !== "homebrew-cask"));
    for (const action of ordered) {
      const error = await this.runDeferred(action);
      if (error) {
        manifest.errors.push(error);
        manifest.status = "partial";
        await this.store.save(manifest);
        return manifest;
      }
    }

    const sessionDirectory = assertQuarantinePath(join(this.paths.quarantineRoot, id), this.paths);
    try {
      await rm(sessionDirectory, { recursive: true, force: true });
    } catch {
      const result = await this.runner.run(["/usr/bin/sudo", "/bin/rm", "-rf", sessionDirectory], { interactive: true });
      if (result.exitCode !== 0) {
        manifest.errors.push(`Could not delete quarantine payload: ${sessionDirectory}`);
        manifest.status = "partial";
        await this.store.save(manifest);
        return manifest;
      }
    }
    for (const item of manifest.items) if (item.status === "moved") item.status = "purged";
    manifest.status = "purged";
    await this.store.save(manifest);
    return manifest;
  }
}
