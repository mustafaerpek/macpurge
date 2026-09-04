import { basename } from "node:path";
import type { AppIdentity } from "./types";

export function isProtectedAppleApp(app: Pick<AppIdentity, "bundleId">): boolean {
  return app.bundleId.startsWith("com.apple.");
}

export function isAppleBundleId(bundleId: string): boolean {
  return bundleId.startsWith("com.apple.");
}

const BUNDLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]+$/u;

export function isValidBundleId(bundleId: string): boolean {
  return BUNDLE_ID_PATTERN.test(bundleId) && !bundleId.includes("..");
}

export function isValidDisplayName(displayName: string): boolean {
  return displayName.length > 0 && !/[/\0]/u.test(displayName) && displayName !== "." && displayName !== "..";
}

const KNOWN_KEYCHAIN_SERVICES: Record<string, readonly string[]> = {
  "com.microsoft.VSCode": ["Code Safe Storage"],
};

export function knownKeychainServices(bundleId: string): readonly string[] {
  return KNOWN_KEYCHAIN_SERVICES[bundleId] ?? [];
}

export function candidateKeychainServices(app: Pick<AppIdentity, "displayName" | "bundleId" | "path">): string[] {
  return [
    ...new Set([
      `${app.displayName} Safe Storage`,
      `${basename(app.path, ".app")} Safe Storage`,
      app.bundleId,
      ...knownKeychainServices(app.bundleId),
    ]),
  ];
}
