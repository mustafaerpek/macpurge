import { access, lstat, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path";
import type { Candidate, SystemPaths } from "./types";

export class SafetyError extends Error {
  override name = "SafetyError";
}

function isWithin(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

export function protectedRoots(paths: SystemPaths): string[] {
  return [
    "/",
    paths.home,
    paths.userLibrary,
    paths.applications,
    paths.userApplications,
    paths.systemLibrary,
    "/usr",
    "/usr/local",
    "/opt",
    "/opt/homebrew",
  ].map((path) => resolve(path));
}

export function allowedRoots(paths: SystemPaths): string[] {
  return [
    paths.applications,
    paths.userApplications,
    paths.userLibrary,
    paths.systemLibrary,
    paths.temp,
    ...paths.binRoots,
    "/usr/local/bin",
    "/opt/homebrew/bin",
    paths.home,
  ].map((path) => resolve(path));
}

export function personalProtectedRoots(paths: SystemPaths): string[] {
  return [
    resolve(paths.home, "Documents"),
    resolve(paths.home, "Desktop"),
    resolve(paths.home, "Downloads"),
    resolve(paths.systemLibrary, "Developer"),
  ];
}

export function isPersonalProtectedPath(path: string, paths: SystemPaths): boolean {
  const resolved = resolve(path);
  return personalProtectedRoots(paths).some((root) => isWithin(resolved, root));
}

export function validateLiteralPath(input: string, paths: SystemPaths): string {
  if (!input || input.includes("\0")) throw new SafetyError("Path is empty or contains a null byte");
  if (!isAbsolute(input)) throw new SafetyError(`Path is not absolute: ${input}`);
  if (/[*?\[\]{}]/u.test(input)) throw new SafetyError(`Wildcards are not allowed in mutation paths: ${input}`);

  const normalized = normalize(input);
  // Intentionally inspect the literal input segments (not the normalized form)
  // so traversal syntax itself is rejected even when it would canonicalize inside.
  if (input.split(sep).includes("..")) throw new SafetyError(`Parent traversal is not allowed: ${input}`);
  if (protectedRoots(paths).includes(resolve(normalized))) {
    throw new SafetyError(`Protected root cannot be mutated: ${input}`);
  }
  if (isPersonalProtectedPath(normalized, paths)) {
    throw new SafetyError(`Personal or developer data is protected: ${input}`);
  }
  if (!allowedRoots(paths).some((root) => isWithin(normalized, root))) {
    throw new SafetyError(`Path is outside supported roots: ${input}`);
  }
  return normalized;
}

export async function revalidateCandidate(candidate: Candidate, paths: SystemPaths): Promise<string> {
  const literal = validateLiteralPath(candidate.path, paths);
  // lstat inspects the link object itself (does not follow); realpath below
  // resolves the final target so symlink drift can be detected.
  await lstat(literal);
  const resolved = await realpath(literal);

  if (candidate.kind === "cli-symlink") {
    if (!candidate.realPath || resolve(candidate.realPath) !== resolve(resolved)) {
      throw new SafetyError(`Symlink target changed since scan: ${literal}`);
    }
  } else if (candidate.realPath && resolve(candidate.realPath) !== resolve(resolved)) {
    throw new SafetyError(`Path target changed since scan: ${literal}`);
  }
  return literal;
}

export function assertQuarantinePath(path: string, paths: SystemPaths): string {
  const resolved = resolve(path);
  if (!isWithin(resolved, paths.quarantineRoot) || resolved === resolve(paths.quarantineRoot)) {
    throw new SafetyError(`Invalid quarantine payload path: ${path}`);
  }
  return resolved;
}

export async function parentNeedsAdmin(path: string): Promise<boolean> {
  try {
    await access(dirname(path), constants.W_OK);
    return false;
  } catch {
    return true;
  }
}

export { isWithin };
