import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanExpertSnapshot } from "../../src/consult/fork-store.js";

function session(entries: unknown[]): string {
  return (
    [JSON.stringify({ type: "session", id: "fork-id" }), ...entries.map((entry) => JSON.stringify(entry))].join("\n") +
    "\n"
  );
}

const message = (message: unknown, id = Math.random().toString(36)): unknown => ({
  type: "message",
  id,
  parentId: null,
  timestamp: new Date().toISOString(),
  message,
});

describe("scanExpertSnapshot", () => {
  it("replays system tool deltas through pi-ai and records the latest model, thinking and usage", () => {
    const dir = mkdtempSync(join(tmpdir(), "consult-snapshot-"));
    const file = join(dir, "expert.jsonl");
    const read = { name: "read", description: "read", parameters: { type: "object" } };
    const write = { name: "write", description: "write", parameters: { type: "object" } };
    writeFileSync(
      file,
      session([
        { type: "model_change", provider: "p1", modelId: "m1" },
        { type: "thinking_level_change", thinkingLevel: "low" },
        message({ role: "system", content: "base", sections: { agent: "one" }, toolsAdded: [read, write] }),
        message({
          role: "assistant",
          content: [],
          api: "x",
          provider: "p1",
          model: "m1",
          usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 4 },
        }),
        { type: "model_change", provider: "p2", modelId: "m2" },
        { type: "thinking_level_change", thinkingLevel: "high" },
        message({ role: "system", content: "delta", sections: { agent: "two" }, toolsRemoved: [{ name: "write" }] }),
        message({
          role: "assistant",
          content: [],
          api: "x",
          provider: "p2",
          model: "m2",
          usage: { input: 20, output: 3, cacheRead: 5, cacheWrite: 6 },
        }),
      ]),
      "utf8",
    );
    expect(scanExpertSnapshot(file)).toEqual({
      ok: true,
      snapshot: {
        tools: [read],
        systemSections: { agent: "two" },
        model: { provider: "p2", id: "m2" },
        thinkingLevel: "high",
        sourceSessionId: "fork-id",
        lastRequestUsage: { input: 20, cacheRead: 5, cacheWrite: 6 },
      },
    });
  });

  it("fails closed for a missing system loadout and a malformed candidate line", () => {
    const dir = mkdtempSync(join(tmpdir(), "consult-snapshot-"));
    const noSystem = join(dir, "no-system.jsonl");
    writeFileSync(noSystem, session([{ type: "model_change", provider: "p", modelId: "m" }]), "utf8");
    expect(scanExpertSnapshot(noSystem)).toMatchObject({ ok: false, code: "identity_mismatch:no-recorded-loadout" });

    const malformed = join(dir, "malformed.jsonl");
    writeFileSync(malformed, `${JSON.stringify({ type: "session", id: "s" })}\n{"type":"model_change"}\n`, "utf8");
    expect(scanExpertSnapshot(malformed)).toMatchObject({ ok: false, code: "identity_mismatch:unreadable-snapshot" });
  });

  it("never throws for an unreadable path", () => {
    expect(scanExpertSnapshot("/definitely/not/a/session.jsonl")).toMatchObject({
      ok: false,
      code: "identity_mismatch:unreadable-snapshot",
    });
  });
});
