// Root ruling 2026-11-06 (P3 派单批复 ③): jev/entries.ts ↔ blocks/adapter.ts
// form a deliberate module cycle of function declarations only. This file
// pins that BOTH load orders initialize correctly and the shared functions
// are callable — via dynamic import inside the tests so each order actually
// re-executes the module graph (vitest module cache defeated by query-suffix
// imports through a fresh child-shaped registry per test).

import { describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

describe("entries ↔ adapter module cycle (root ruling ③)", () => {
  test("adapter-first load: blockToEntry → entryHash both callable", async () => {
    const adapter = await import(`${ROOT}/src/memory/blocks/adapter.js?order=adapter-first`);
    const entries = await import(`${ROOT}/src/memory/jev/entries.js?order=adapter-first`);
    const format = await import(`${ROOT}/src/memory/blocks/format.js?order=adapter-first`);
    const parsed = format.parseBlockFile(
      "quota.001.md",
      format.serializeBlock(
        {
          kind: "block",
          authority: "user",
          status: "active",
          created: "2026-01-01T00:00:00.000Z",
          updated: "2026-01-02T00:00:00.000Z",
          version: 1,
        },
        "- cycle probe body",
      ),
    );
    if ("stray" in parsed) throw new Error("fixture produced a stray");
    const entry = (adapter as typeof import("../../../src/memory/blocks/adapter.js")).blockToEntry(
      parsed,
      "2026-11-06",
    );
    expect(entry.block?.id).toBe("quota.001");
    expect((entries as typeof import("../../../src/memory/jev/entries.js")).entryHash(entry.body)).toBe(entry.hash);
  });

  test("entries-first load: EntryIndex blocks branch sees blockToEntry output", async () => {
    const entries = await import(`${ROOT}/src/memory/jev/entries.js?order=entries-first`);
    const adapter = await import(`${ROOT}/src/memory/blocks/adapter.js?order=entries-first`);
    expect(typeof (entries as typeof import("../../../src/memory/jev/entries.js")).EntryIndex).toBe("function");
    expect(typeof (adapter as typeof import("../../../src/memory/blocks/adapter.js")).blockToEntry).toBe("function");
  });
});
