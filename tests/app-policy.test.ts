import { describe, expect, test } from "bun:test";
import { candidateKeychainServices, isProtectedAppleApp, isValidBundleId, isValidDisplayName, knownKeychainServices } from "../src/app-policy";

describe("app policy", () => {
  test("classifies Apple system applications", () => {
    expect(isProtectedAppleApp({ bundleId: "com.apple.Finder" })).toBeTrue();
    expect(isProtectedAppleApp({ bundleId: "com.apple.example" })).toBeTrue();
    expect(isProtectedAppleApp({ bundleId: "com.example.app" })).toBeFalse();
    expect(isProtectedAppleApp({ bundleId: "com.microsoft.VSCode" })).toBeFalse();
  });

  test("validates bundle identifiers", () => {
    for (const valid of ["com.example.app", "com.microsoft.VSCode", "a.b", "A0-a.b1"]) {
      expect(isValidBundleId(valid)).toBeTrue();
    }
    for (const invalid of ["", ".leading", "com..example", "com/example", "com example", "..", "com_example.app"]) {
      expect(isValidBundleId(invalid)).toBeFalse();
    }
  });

  test("validates display names", () => {
    for (const valid of ["Example", "Visual Studio Code", "Comma, App", 'Quote "App"']) {
      expect(isValidDisplayName(valid)).toBeTrue();
    }
    for (const invalid of ["", ".", "..", "a/b", "a\0b"]) {
      expect(isValidDisplayName(invalid)).toBeFalse();
    }
  });

  test("owns the canonical keychain allow-list", () => {
    expect(knownKeychainServices("com.microsoft.VSCode")).toContain("Code Safe Storage");
    expect(knownKeychainServices("com.example.other")).toHaveLength(0);
    const services = candidateKeychainServices({ displayName: "Example", bundleId: "com.example.app", path: "/Applications/Example.app" });
    expect(services).toContain("Example Safe Storage");
    expect(services).toContain("com.example.app");
    const vscode = candidateKeychainServices({ displayName: "Visual Studio Code", bundleId: "com.microsoft.VSCode", path: "/Applications/Visual Studio Code.app" });
    expect(vscode).toContain("Code Safe Storage");
  });
});
