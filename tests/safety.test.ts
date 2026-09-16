import { describe, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { testPaths } from "./helpers";
import { assertQuarantinePath, parentNeedsAdmin, revalidateWriteParent, SafetyError, validateLiteralPath } from "../src/safety";
import { hasMaclLock, makeCandidate } from "../src/fs-utils";
import { FakeCommandRunner } from "../src/command";

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

  test("flags root-owned entries for admin even with a writable parent", async () => {
    const paths = await testPaths();
    const appDir = join(paths.applications, "Root.app");
    await mkdir(appDir, { recursive: true });
    try {
      const proc = Bun.spawnSync(["/usr/sbin/chown", "0:0", appDir]);
      if (proc.exitCode !== 0) return;
    } catch {
      return;
    }
    expect(await parentNeedsAdmin(appDir)).toBeTrue();
  });

  test("marks MACL-locked containers as protected", async () => {
    const paths = await testPaths();
    const container = join(paths.userLibrary, "Containers", "com.example.locked");
    await mkdir(container, { recursive: true });
    await writeFile(join(container, "data"), "x");
    const locked = new FakeCommandRunner([
      { match: (c) => c[0] === "/usr/bin/du", result: { exitCode: 0, stdout: "4\tplace\n", stderr: "" } },
      { match: (c) => c[0] === "/bin/ls", result: { exitCode: 0, stdout: "drwx------@ 1 u g - 64 Jan 1 00:00 Foo\n\tcom.apple.macl\t -1 \n", stderr: "" } },
    ]);
    const candidate = await makeCandidate({ path: container, kind: "container", risk: "confirmed", evidence: [], runner: locked, checkMacl: true });
    expect(candidate?.risk).toBe("protected");
    expect(candidate?.evidence.some((e) => e.detail.includes("macl"))).toBeTrue();
    expect(await hasMaclLock(container, locked)).toBeTrue();
    const clean = new FakeCommandRunner([
      { match: (c) => c[0] === "/usr/bin/du", result: { exitCode: 0, stdout: "4\tplace\n", stderr: "" } },
      { match: (c) => c[0] === "/bin/ls", result: { exitCode: 0, stdout: "drwx------ 1 u g - 64 Jan 1 00:00 Foo\n", stderr: "" } },
    ]);
    const normal = await makeCandidate({ path: container, kind: "container", risk: "confirmed", evidence: [], runner: clean, checkMacl: true });
    expect(normal?.risk).toBe("confirmed");
  });
});
