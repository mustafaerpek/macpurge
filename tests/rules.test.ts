import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BUILTIN_RULES, expandRulePath, loadRules, validateRule } from "../src/rules";
import { testPaths } from "./helpers";

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

  test("loads valid user rules and reports invalid ones", async () => {
    const paths = await testPaths();
    await mkdir(paths.userRuleRoot, { recursive: true });
    await writeFile(join(paths.userRuleRoot, "valid.json"), JSON.stringify({
      schemaVersion: 1,
      id: "custom-app",
      bundleIds: ["com.example.custom"],
      platform: "darwin",
      candidates: [{ pathTemplate: "{home}/Library/Caches/{bundleId}", kind: "cache", risk: "confirmed", reason: "Custom cache" }],
    }));
    await writeFile(join(paths.userRuleRoot, "invalid.json"), "{not-json");
    const loaded = await loadRules(paths);
    expect(loaded.rules.some((rule) => rule.id === "custom-app")).toBeTrue();
    expect(loaded.warnings).toHaveLength(1);
  });
});
