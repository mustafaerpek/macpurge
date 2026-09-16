import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ManifestStore, transitionStatus } from "../src/manifest-store";
import { testPaths } from "./helpers";
import type { SessionManifest } from "../src/types";

describe("session state transitions", () => {
  test("allows the documented lifecycle", () => {
    expect(transitionStatus("planned", "quarantining")).toBe("quarantining");
    expect(transitionStatus("quarantining", "quarantined")).toBe("quarantined");
    expect(transitionStatus("quarantining", "partial")).toBe("partial");
    expect(transitionStatus("quarantined", "restored")).toBe("restored");
    expect(transitionStatus("quarantined", "purging")).toBe("purging");
    expect(transitionStatus("partial", "restored")).toBe("restored");
    expect(transitionStatus("partial", "purging")).toBe("purging");
    expect(transitionStatus("purging", "purged")).toBe("purged");
    expect(transitionStatus("purging", "partial")).toBe("partial");
  });

  test("rejects jumps that would skip filesystem work", () => {
    expect(() => transitionStatus("planned", "quarantined")).toThrow("Invalid session status transition");
    expect(() => transitionStatus("planned", "purged")).toThrow("Invalid session status transition");
    expect(() => transitionStatus("quarantined", "purged")).toThrow("Invalid session status transition");
    expect(() => transitionStatus("restored", "purging")).toThrow("Invalid session status transition");
    expect(() => transitionStatus("purged", "quarantining")).toThrow("Invalid session status transition");
    expect(() => transitionStatus("failed", "quarantined")).toThrow("Invalid session status transition");
  });

  test("resolves latest, short prefixes, and case-insensitive UUIDs", async () => {
    const paths = await testPaths();
    const store = new ManifestStore(paths);
    await mkdir(paths.sessionRoot, { recursive: true });
    const base = {
      schemaVersion: 1 as const,
      updatedAt: "2026-01-02T00:00:00.000Z",
      status: "quarantined" as const,
      app: { displayName: "Example", bundleId: "com.example.app", path: join(paths.applications, "Example.app"), installSource: "standalone" as const, packageReceipts: [] },
      items: [],
      deferredActions: [],
      warnings: [],
      errors: [],
    };
    const first: SessionManifest = { ...base, id: "abcd1111-1111-4111-8111-111111111111", createdAt: "2026-01-01T00:00:00.000Z" };
    const second: SessionManifest = { ...base, id: "abcd2222-2222-4222-8222-222222222222", createdAt: "2026-01-02T00:00:00.000Z" };
    await writeFile(join(paths.sessionRoot, `${first.id}.json`), JSON.stringify(first));
    await writeFile(join(paths.sessionRoot, `${second.id}.json`), JSON.stringify(second));
    expect((await store.load("latest")).id).toBe(second.id);
    expect(await store.resolve(second.id.slice(0, 8))).toBe(second.id);
    expect((await store.load(second.id.toUpperCase())).id).toBe(second.id);
    await expect(store.resolve("abcd")).rejects.toThrow("ambiguous");
    await expect(store.resolve("nope")).rejects.toThrow("Invalid session id");
  });
});
