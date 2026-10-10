import { describe, expect, it } from "vitest";
import {
  BATCH_MAX_FILES,
  TIDY_MAX_FILES,
  TIDY_SCHEMA,
  TRIAGE_SCHEMA,
  type JournalEvent,
  type Loc,
  type OpSpec,
  type TidyManifestV2,
} from "../../src/memory/contracts.js";
import { DEFAULT_TIDY_BATCH_SETTINGS, resolveTidyBatchSettings } from "../../src/memory/tidy/batch-settings.js";
import { SCHEMA_LIMITS } from "../../src/memory/tidy/validate.js";
import { parseTmpName, TMP_RE, tmpNameFor } from "../../src/memory/tmp-names.js";

describe("tidy batch frozen contracts", () => {
  it("pins the shared file limit and batch headroom", () => {
    const schemaFiles = (TIDY_SCHEMA.properties as Record<string, { maxItems?: number }>).files;
    expect(schemaFiles?.maxItems).toBe(TIDY_MAX_FILES);
    expect(SCHEMA_LIMITS.maxFiles).toBe(TIDY_MAX_FILES);
    expect(BATCH_MAX_FILES).toBe(TIDY_MAX_FILES - 4);
    expect((TRIAGE_SCHEMA.properties as Record<string, { maxItems?: number }>).files?.maxItems).toBe(TIDY_MAX_FILES);
  });

  it("keeps the v2 journal shapes available to pi-free consumers", () => {
    const live: Loc = { area: "live", name: "topic.md" };
    const obj = { dev: 1, ino: 2, sha: "a".repeat(64), size: 3 };
    const op: OpSpec = { prim: "MOVE", src: live, dst: { area: "archive", name: "topic.md" }, obj };
    const event: JournalEvent = { ev: "intent", opId: "op-1", seq: 1, step: 0, phase: "archive", op };
    const manifest: TidyManifestV2 = {
      v: 2,
      id: "run",
      kind: "batch",
      createdAt: "2026-01-01T00:00:00.000Z",
      events: [event],
    };
    expect(manifest.events).toHaveLength(1);
  });

  it("parses only the one transaction tmp grammar", () => {
    const name = tmpNameFor("deadbeef", 12, "b");
    expect(TMP_RE.test(name)).toBe(true);
    expect(parseTmpName(name)).toEqual({ nonce8: "deadbeef", seq: 12, kind: "b" });
    expect(parseTmpName(".topic.123.tmp")).toBeUndefined();
    expect(() => tmpNameFor("deadbeef", 1, "m")).toThrow();
  });

  it("resolves batch settings field by field without mutating defaults", () => {
    expect(resolveTidyBatchSettings(undefined)).toEqual(DEFAULT_TIDY_BATCH_SETTINGS);
    expect(resolveTidyBatchSettings({ targetBytes: 1, maxModelRuns: 99, enabled: false })).toEqual({
      ...DEFAULT_TIDY_BATCH_SETTINGS,
      enabled: false,
    });
    expect(resolveTidyBatchSettings({ targetBytes: 40_000 }, 16_384).targetBytes).toBe(16_384);
  });
});
