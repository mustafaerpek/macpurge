import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { assertQuarantinePath, isWithin, SafetyError, validateLiteralPath } from "./safety";
import { candidateId } from "./fs-utils";
import { candidateKeychainServices, isValidBundleId } from "./app-policy";
import { SCHEMA_VERSION, type DeferredAction, type SessionManifest, type SystemPaths } from "./types";

export class ManifestStore {
  constructor(private readonly paths: SystemPaths) {}

  private manifestPath(id: string): string {
    if (!/^[0-9a-f-]{36}$/u.test(id)) throw new Error(`Invalid session id: ${id}`);
    return join(this.paths.sessionRoot, `${id}.json`);
  }

  async save(manifest: SessionManifest): Promise<void> {
    await mkdir(this.paths.sessionRoot, { recursive: true, mode: 0o700 });
    const destination = this.manifestPath(manifest.id);
    const temporary = `${destination}.${process.pid}.tmp`;
    manifest.updatedAt = new Date().toISOString();
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, destination);
  }

  async load(id: string): Promise<SessionManifest> {
    const content = await readFile(this.manifestPath(id), "utf8");
    return this.validate(JSON.parse(content), id);
  }

  async list(): Promise<SessionManifest[]> {
    let files: string[] = [];
    try {
      files = (await readdir(this.paths.sessionRoot)).filter((file) => file.endsWith(".json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const manifests: SessionManifest[] = [];
    for (const file of files) {
      try {
        const id = file.slice(0, -".json".length);
        manifests.push(this.validate(JSON.parse(await readFile(join(this.paths.sessionRoot, file), "utf8")), id));
      } catch (error) {
        // Corrupt manifests are omitted here and reported by doctor/explicit load.
        if (process.env.MACPURGE_DEBUG) console.warn(`Skipping corrupt manifest ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private validate(raw: unknown, expectedId: string): SessionManifest {
    if (!raw || typeof raw !== "object") throw new SafetyError("Session manifest must be an object");
    const manifest = raw as SessionManifest;
    if (manifest.schemaVersion !== SCHEMA_VERSION || manifest.id !== expectedId) throw new SafetyError("Session manifest identity or schema is invalid");
    if (!manifest.app || !isValidBundleId(manifest.app.bundleId)) {
      throw new SafetyError("Session application identity is invalid");
    }
    validateLiteralPath(manifest.app.path, this.paths);
    if (!Array.isArray(manifest.items) || !Array.isArray(manifest.deferredActions) || !Array.isArray(manifest.errors) || !Array.isArray(manifest.warnings)) {
      throw new SafetyError("Session manifest collections are invalid");
    }
    for (const item of manifest.items) {
      if (!item.candidate || item.originalPath !== item.candidate.path) throw new SafetyError("Session item identity is invalid");
      validateLiteralPath(item.originalPath, this.paths);
      assertQuarantinePath(item.quarantinePath, this.paths);
      if (!isWithin(item.quarantinePath, join(this.paths.quarantineRoot, manifest.id))) {
        throw new SafetyError("Session item points outside its own quarantine directory");
      }
      if (candidateId(item.candidate.path, item.candidate.kind) !== item.candidate.id) throw new SafetyError("Session candidate id is invalid");
      if (item.candidate.risk === "protected") throw new SafetyError("Protected candidate found in session manifest");
    }
    for (const action of manifest.deferredActions) this.validateDeferred(action, manifest);
    return manifest;
  }

  private validateDeferred(action: DeferredAction, manifest: SessionManifest): void {
    if (!action || typeof action.value !== "string" || action.value.length === 0 || action.value.length > 256 || action.value.includes("\0")) {
      throw new SafetyError("Deferred action value is invalid");
    }
    switch (action.type) {
      case "tcc":
        if (action.value !== manifest.app.bundleId) throw new SafetyError("TCC action does not match the session application");
        break;
      case "preferences-domain":
        if (action.value !== manifest.app.bundleId) throw new SafetyError("Preferences action does not match the session application");
        break;
      case "homebrew-cask":
        if (!manifest.app.managerId || action.value !== manifest.app.managerId || !/^[a-z0-9@+_.-]+$/u.test(action.value)) {
          throw new SafetyError("Homebrew action does not match the session application");
        }
        break;
      case "pkg-receipt":
        if (!manifest.app.packageReceipts.includes(action.value) || !/^[A-Za-z0-9@+_.-]+$/u.test(action.value)) {
          throw new SafetyError("Package receipt action does not match the session application");
        }
        break;
      case "login-item": {
        const validNames = new Set([manifest.app.displayName, basename(manifest.app.path, ".app")]);
        if (!validNames.has(action.value)) throw new SafetyError("Login item action does not match the session application");
        break;
      }
      case "keychain":
        if (/[\r\n]/u.test(action.value)) throw new SafetyError("Keychain action contains invalid characters");
        {
          const validServices = new Set(candidateKeychainServices(manifest.app));
          if (!validServices.has(action.value)) throw new SafetyError("Keychain action does not match the session application");
        }
        break;
      default:
        throw new SafetyError("Unknown deferred action type");
    }
  }
}
