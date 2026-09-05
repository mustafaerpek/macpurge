import { describe, expect, test } from "bun:test";
import { transitionStatus } from "../src/manifest-store";

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
});
