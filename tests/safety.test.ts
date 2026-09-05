import { describe, expect, test } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { testPaths } from "./helpers";
import { assertQuarantinePath, revalidateWriteParent, SafetyError, validateLiteralPath } from "../src/safety";

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

  test("accepts a real parent inside the supported roots", async () => {
    const paths = await testPaths();
    const destination = join(paths.userLibrary, "Caches", "com.example.app", "data");
    await mkdir(join(paths.userLibrary, "Caches", "com.example.app"), { recursive: true });
    await expect(revalidateWriteParent(destination, paths)).resolves.toBeUndefined();
  });

  test("rejects a symlinked parent that redirects into personal data", async () => {
    const paths = await testPaths();
    const escape = join(paths.userLibrary, "Caches", "escape");
    await mkdir(join(paths.userLibrary, "Caches"), { recursive: true });
    await mkdir(join(paths.home, "Desktop"), { recursive: true });
    await symlink(join(paths.home, "Desktop"), escape);
    await expect(revalidateWriteParent(join(escape, "restored"), paths)).rejects.toThrow("personal or developer data");
  });

  test("rejects a symlinked parent that redirects outside supported roots", async () => {
    const paths = await testPaths();
    const escape = join(paths.userLibrary, "Caches", "escape-outer");
    const outside = join(dirname(paths.home), "outside");
    await Promise.all([mkdir(join(paths.userLibrary, "Caches"), { recursive: true }), mkdir(outside, { recursive: true })]);
    await symlink(outside, escape);
    await expect(revalidateWriteParent(join(escape, "restored"), paths)).rejects.toThrow("outside supported roots");
  });
});
