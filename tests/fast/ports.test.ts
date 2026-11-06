import { describe, expect, expectTypeOf, it } from "vitest";
import type { FastMode, FastRecord, FastSeed, SessionSpec, SpawnRequest } from "../../src/core/types.js";
import { threadThroughRequestFields } from "../../src/service/request-threading.js";
import type {
  FastChildStatePort,
  FastOwner,
  FastParentPort,
  FastSnapshot,
  FastWorkflowPort,
} from "../../src/fast/ports.js";

describe("Fast shared data and port contracts (not runtime wiring)", () => {
  it("keeps legacy request/spec callers valid and seed keys absent", () => {
    const request: SpawnRequest = { type: "main", prompt: "task" };
    const spec: SessionSpec = {};
    expect(Object.hasOwn(request, "fastSeed")).toBe(false);
    expect(Object.hasOwn(spec, "fastSeed")).toBe(false);
    expectTypeOf<SpawnRequest["fastSeed"]>().toEqualTypeOf<FastSeed | undefined>();
    expectTypeOf<SessionSpec["fastSeed"]>().toEqualTypeOf<FastSeed | undefined>();
    expectTypeOf<FastMode>().toEqualTypeOf<"inherit" | "on" | "off">();
    expectTypeOf<keyof FastSeed>().toEqualTypeOf<"v" | "mode">();
    expectTypeOf<keyof FastRecord>().toEqualTypeOf<"v" | "mode">();
    expectTypeOf<FastSeed["v"]>().toEqualTypeOf<1>();
  });

  it("carries only version/mode across the request and session boundary", () => {
    for (const mode of ["inherit", "on", "off"] as const) {
      const snapshot: FastSnapshot = { mode, revision: 7, incarnation: {} };
      const seed: FastSeed = { v: 1, mode: snapshot.mode };
      const record: FastRecord = seed;
      const request: SpawnRequest = { type: "main", prompt: "task", fastSeed: seed };
      const spec: SessionSpec = { fastSeed: request.fastSeed! };
      expect(JSON.stringify(spec.fastSeed)).toBe(`{"v":1,"mode":"${mode}"}`);
      expect(record).toEqual({ v: 1, mode });
      expect(Object.keys(seed)).toEqual(["v", "mode"]);
      expectTypeOf<keyof FastSnapshot>().toEqualTypeOf<"mode" | "revision" | "incarnation">();
    }
  });

  it("excludes the control-plane seed from runner projection without dropping existing fields", () => {
    const seed: FastSeed = { v: 1, mode: "on" };
    const request: SpawnRequest = { type: "main", prompt: "task", parentRunId: "parent", fastSeed: seed };
    const runnerFields = threadThroughRequestFields(request);
    expect(runnerFields).toEqual({ parentRunId: "parent" });
    expect(Object.hasOwn(runnerFields, "fastSeed")).toBe(false);
    expect(request.fastSeed).toBe(seed);
    expectTypeOf<keyof typeof runnerFields>().exclude<"fastSeed">().toEqualTypeOf<keyof typeof runnerFields>();
  });

  it("declares synchronous read/capture and owner-scoped bind cleanup", () => {
    expectTypeOf<FastParentPort["snapshot"]>().toEqualTypeOf<(parentRunId?: string) => FastSeed | undefined>();
    expectTypeOf<FastWorkflowPort["capture"]>().toEqualTypeOf<() => FastSeed | undefined>();
    expectTypeOf<FastOwner>().toEqualTypeOf<{
      readonly parentRunId: string;
      readonly incarnation: object;
    }>();
    expectTypeOf<FastChildStatePort["bind"]>().toEqualTypeOf<
      (owner: FastOwner, readMode: () => FastMode) => () => void
    >();
    expectTypeOf<FastSeed>().toEqualTypeOf<{ readonly v: 1; readonly mode: FastMode }>();
    expectTypeOf<FastRecord>().toEqualTypeOf<{ readonly v: 1; readonly mode: FastMode }>();
  });
});
