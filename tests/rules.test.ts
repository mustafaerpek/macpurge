import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BUILTIN_RULES, expandRulePath, loadRules, validateRule } from "../src/rules";
import type { SystemPaths } from "../src/types";
import { testPaths } from "./helpers";

function userRule(overrides: Record<string, unknown> = {}, candidateOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "custom-app",
    bundleIds: ["com.example.custom"],
    platform: "darwin",
    candidates: [
      {
        pathTemplate: "{home}/Library/Caches/{bundleId}",
        kind: "cache",
        risk: "confirmed",
        reason: "Custom cache",
        ...candidateOverrides,
      },
    ],
    ...overrides,
  };
}

describe("rule profiles", () => {
  test("validates built-in rules and expands allowed tokens", async () => {
    const paths = await testPaths();
    for (const rule of BUILTIN_RULES) expect(validateRule(rule, paths).id).toBe(rule.id);
    const app = { displayName: "Example", bundleId: "com.example.app", path: join(paths.applications, "Example.app"), installSource: "standalone" as const, packageReceipts: [] };
    expect(expandRulePath("{home}/Library/Caches/{bundleId}", app, paths)).toBe(join(paths.userLibrary, "Caches", app.bundleId));
  });

  test("rejects wildcard, traversal, unknown token, and protected root rules", async () => {
    const paths = await testPaths();
    const base = {
      schemaVersion: 1 as const,
      id: "bad-rule",
      bundleIds: ["com.example.bad"],
      candidates: [{ pathTemplate: "{home}/Library/Caches/value", kind: "cache" as const, risk: "confirmed" as const, reason: "test" }],
    };
    expect(() => validateRule({ ...base, candidates: [{ ...base.candidates[0], pathTemplate: "{home}/Library/*" }] }, paths)).toThrow("Unsafe");
    expect(() => validateRule({ ...base, candidates: [{ ...base.candidates[0], pathTemplate: "{home}/../tmp" }] }, paths)).toThrow("Unsafe");
    expect(() => validateRule({ ...base, candidates: [{ ...base.candidates[0], pathTemplate: "{unknown}/x" }] }, paths)).toThrow("Unknown");
    expect(() => validateRule({ ...base, candidates: [{ ...base.candidates[0], pathTemplate: "{home}" }] }, paths)).toThrow("protected root");
  });

  test("rejects user rules that target sensitive credential or source directories", async () => {
    const paths = await testPaths();
    for (const template of ["{home}/.ssh", "{home}/.ssh/config", "{home}/.gnupg", "{home}/.aws", "{home}/Projects/{appName}", "{home}/.config/MyApp"]) {
      expect(() => validateRule(userRule({}, { pathTemplate: template, reason: "sensitive target" }), paths)).toThrow("sensitive");
    }
  });

  test("rejects user rules that target the macpurge support root", async () => {
    const paths = await testPaths();
    const template = "{home}/Library/Application Support/macpurge";
    expect(() => validateRule(userRule({}, { pathTemplate: template, reason: "self target" }), paths)).toThrow("not allowed");
  });

  test("downgrades confirmed user rules outside trusted app-data roots to possible", async () => {
    const paths = await testPaths();
    const demoted = validateRule(userRule({}, { pathTemplate: "{home}/.myapp-data", reason: "not a standard location" }), paths);
    expect(demoted.candidates[0]?.risk).toBe("possible");
    const trusted = validateRule(userRule(), paths);
    expect(trusted.candidates[0]?.risk).toBe("confirmed");
  });

  test("keeps built-in rules exempt from the trusted-root downgrade", async () => {
    const paths = await testPaths();
    const vscode = BUILTIN_RULES.find((rule) => rule.id === "visual-studio-code")!;
    const validated = validateRule(vscode, paths, "builtin");
    const extensions = validated.candidates.find((candidate) => candidate.pathTemplate === "{home}/.vscode");
    expect(extensions?.risk).toBe("confirmed");
  });

  test("validates kind, risk, platform, and bundleIds against the domain vocabularies", async () => {
    const paths = await testPaths();
    expect(() => validateRule(userRule({}, { kind: "not-a-kind" }), paths)).toThrow("unsupported kind");
    expect(() => validateRule(userRule({}, { risk: "definitely" }), paths)).toThrow("unsupported risk");
    expect(() => validateRule(userRule({ platform: "linux" }), paths)).toThrow("platform");
    expect(() => validateRule(userRule({ bundleIds: ["nodot"] }), paths)).toThrow("valid bundleIds");
    expect(() => validateRule(userRule({ bundleIds: ["com..example"] }), paths)).toThrow("valid bundleIds");
    expect(() => validateRule(userRule({ candidates: [] }), paths)).toThrow("at least one candidate");
    expect(() => validateRule(userRule({}, { requiresSymlinkIntoApp: "yes" }), paths)).toThrow("boolean");
    expect(() => validateRule(userRule({}, { reason: "   " }), paths)).toThrow("reason");
  });

  test("validation must not mutate the parsed input", async () => {
    const paths = await testPaths();
    const rule = userRule({}, { pathTemplate: "{home}/.myapp-data", reason: "not a standard location" });
    validateRule(rule, paths);
    expect((rule.candidates as Array<{ risk: string }>)[0]?.risk).toBe("confirmed");
  });

  test("loads valid user rules and reports invalid ones", async () => {
    const paths = await testPaths();
    await mkdir(paths.userRuleRoot, { recursive: true });
    await writeFile(join(paths.userRuleRoot, "valid.json"), JSON.stringify(userRule()));
    await writeFile(join(paths.userRuleRoot, "invalid.json"), "{not-json");
    const loaded = await loadRules(paths);
    expect(loaded.rules.some((rule) => rule.id === "custom-app" && rule.origin === "user")).toBeTrue();
    expect(loaded.warnings).toHaveLength(1);
  });

  test("user rules for sensitive paths are rejected at load time with a warning", async () => {
    const paths = await testPaths();
    await mkdir(paths.userRuleRoot, { recursive: true });
    await writeFile(join(paths.userRuleRoot, "ssh.json"), JSON.stringify(userRule({ id: "ssh-rule" }, { pathTemplate: "{home}/.ssh", reason: "bad idea" })));
    const loaded = await loadRules(paths);
    expect(loaded.rules.some((rule) => rule.id === "ssh-rule")).toBeFalse();
    expect(loaded.warnings.some((warning) => warning.includes("ssh.json") && warning.includes("sensitive"))).toBeTrue();
  });

  test("built-in rules keep the builtin origin after loading", async () => {
    const paths: SystemPaths = await testPaths();
    const loaded = await loadRules(paths);
    expect(loaded.rules.filter((rule) => rule.origin === "builtin")).toHaveLength(BUILTIN_RULES.length);
  });
});
