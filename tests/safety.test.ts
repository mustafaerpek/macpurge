import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { testPaths } from "./helpers";
import { assertQuarantinePath, SafetyError, validateLiteralPath } from "../src/safety";

describe("path safety", () => {
  test("rejects broad protected roots", async () => {
    const paths = await testPaths();
    expect(() => validateLiteralPath("/", paths)).toThrow(SafetyError);
    expect(() => validateLiteralPath(paths.home, paths)).toThrow("Protected root");
    expect(() => validateLiteralPath(paths.userLibrary, paths)).toThrow("Protected root");
    expect(() => validateLiteralPath(paths.applications, paths)).toThrow("Protected root");
  });

  test("rejects traversal, wildcards, and relative paths", async () => {
    const paths = await testPaths();
    expect(() => validateLiteralPath("relative/path", paths)).toThrow("not absolute");
    expect(() => validateLiteralPath(`${paths.home}/Library/../secret`, paths)).toThrow("Parent traversal");
    expect(() => validateLiteralPath(join(paths.home, "Library", "Caches", "*.cache"), paths)).toThrow("Wildcards");
  });

  test("accepts exact supported paths and bounds quarantine payloads", async () => {
    const paths = await testPaths();
    const cache = join(paths.userLibrary, "Caches", "com.example.app");
    expect(validateLiteralPath(cache, paths)).toBe(cache);
    expect(assertQuarantinePath(join(paths.quarantineRoot, "session", "payload"), paths)).toContain("payload");
    expect(() => assertQuarantinePath(paths.quarantineRoot, paths)).toThrow("Invalid quarantine");
  });
});
