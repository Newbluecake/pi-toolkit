/**
 * Tool-duration plan (2026-10): `subagent:web-tool-timing` durability entries.
 *  - `appendToolTimingEntries`: one bounded entry (≤256 ids) per flush, split on overflow,
 *    nothing when no timings, never throws (stale ctx skipped);
 *  - `registerToolTimingEntryRenderer`: registers a renderer whose return is `undefined`
 *    (pi's sanctioned "no content" — the TUI renders NOTHING, not even a blank line);
 *  - wiring: the web-hub event loop flushes at `turn_end` — exactly one entry per turn with
 *    tools, none on a tools-less turn — and the live ev frames carry `startedAt`/`durationMs`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wireWebHub, type WebHubDeps } from "../../../src/web-hub/agent/index.js";
import {
  appendToolTimingEntries,
  registerToolTimingEntryRenderer,
  TOOL_TIMING_ENTRY_IDS,
  WEB_TOOL_TIMING_ENTRY_TYPE,
} from "../../../src/web-hub/agent/tool-timing.js";
import {
  fakeCtx,
  fakePi,
  pathsIn,
  resetGlobals,
  SETTINGS,
  startFakeHub,
  tmpDir,
  waitUntil,
  type FakeHub,
} from "./helpers.js";

let tmp: ReturnType<typeof tmpDir>;
let hub: FakeHub | undefined;
beforeEach(() => {
  tmp = tmpDir("wh-timing-");
  resetGlobals();
});
afterEach(async () => {
  resetGlobals();
  await hub?.close();
  hub = undefined;
  tmp.cleanup();
});

function ids(n: number): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < n; i += 1) m.set(`t${i}`, 100 + i);
  return m;
}

describe("appendToolTimingEntries", () => {
  it("appends NOTHING when the map is empty (a tools-less turn flushes no entry)", () => {
    const { pi } = fakePi();
    const spy = vi.spyOn(pi, "appendEntry");
    expect(appendToolTimingEntries(pi, new Map())).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it("appends ONE entry with {v:1, t:{id→ms}} for a turn's timings", () => {
    const { pi } = fakePi();
    const spy = vi.spyOn(pi, "appendEntry");
    expect(appendToolTimingEntries(pi, ids(3))).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(WEB_TOOL_TIMING_ENTRY_TYPE, {
      v: 1,
      t: { t0: 100, t1: 101, t2: 102 },
    });
  });

  it(`splits into further entries past ${TOOL_TIMING_ENTRY_IDS} ids (600 → 256/256/88)`, () => {
    const { pi } = fakePi();
    const spy = vi.spyOn(pi, "appendEntry");
    expect(appendToolTimingEntries(pi, ids(600))).toBe(3);
    const chunks = spy.mock.calls.map((c) => Object.keys((c[1] as { t: Record<string, number> }).t));
    expect(chunks.map((k) => k.length)).toEqual([256, 256, 88]);
    expect(chunks[0]![0]).toBe("t0");
    expect(chunks[2]!.at(-1)).toBe("t599");
    for (const c of spy.mock.calls) expect(c[0]).toBe(WEB_TOOL_TIMING_ENTRY_TYPE);
  });

  it("filters invalid ids/values (empty id, NaN, negative) instead of failing the batch", () => {
    const { pi } = fakePi();
    const spy = vi.spyOn(pi, "appendEntry");
    appendToolTimingEntries(
      pi,
      new Map<string, number>([
        ["ok", 42],
        ["", 7],
        ["nan", Number.NaN],
        ["neg", -1],
        ["inf", Number.POSITIVE_INFINITY],
      ]),
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![1]).toEqual({ v: 1, t: { ok: 42 } });
  });

  it("swallows appendEntry throwing (stale ctx) and still tries the next chunk", () => {
    const { pi } = fakePi();
    let calls = 0;
    pi.appendEntry = () => {
      calls += 1;
      if (calls === 1) throw new Error("stale ctx");
    };
    expect(() => appendToolTimingEntries(pi, ids(600))).not.toThrow();
    expect(calls).toBe(3); // first chunk failed, the other two still attempted
  });
});

describe("registerToolTimingEntryRenderer", () => {
  it("registers a renderer that renders NOTHING (undefined — pi's no-content contract)", () => {
    const { pi } = fakePi();
    const spy = vi.spyOn(pi, "registerEntryRenderer");
    registerToolTimingEntryRenderer(pi);
    expect(spy).toHaveBeenCalledTimes(1);
    const [type, renderer] = spy.mock.calls[0]! as [string, (e: unknown, o: unknown, t: unknown) => unknown];
    expect(type).toBe(WEB_TOOL_TIMING_ENTRY_TYPE);
    expect(renderer({}, { expanded: false }, {})).toBeUndefined();
  });

  it("degrades silently on a pre-0.87-shaped pi without registerEntryRenderer", () => {
    const pi = { registerEntryRenderer: undefined } as unknown as Parameters<typeof registerToolTimingEntryRenderer>[0];
    expect(() => registerToolTimingEntryRenderer(pi)).not.toThrow();
  });
});

describe("wiring — turn_end flush (one bounded entry per turn; none without tools)", () => {
  function deps(over: Partial<WebHubDeps> = {}): WebHubDeps {
    return {
      settings: SETTINGS,
      fleet: () => [],
      env: { HOME: tmp.dir },
      paths: pathsIn(tmp.dir),
      buildInfo: async () => ({ pluginVersion: "1.2.3", buildId: "1.2.3@test" }),
      argv1: "/nonexistent/pi",
      now: () => clock,
      ...over,
    };
  }
  let clock = 10_000; // agent clock: start 10_000 → end 11_500 ⇒ durationMs 1_500

  it("tool start/end → turn_end appends exactly one entry; a tools-less turn_end appends none", async () => {
    hub = await startFakeHub(pathsIn(tmp.dir).socketPath);
    const { pi, fire } = fakePi();
    wireWebHub(pi, deps());
    const { ctx } = fakeCtx({ mode: "tui" });
    fire("session_start", { type: "session_start", reason: "startup" }, ctx);
    await waitUntil(() => hub!.all().some((f) => f.t === "hello"), 3_000, "hello");

    const spy = vi.spyOn(pi, "appendEntry");
    fire("tool_execution_start", { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: {} }, ctx);
    clock = 11_500;
    fire(
      "tool_execution_end",
      { type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: "ok", isError: false },
      ctx,
    );
    fire("turn_end", { type: "turn_end", turnIndex: 0, messageEntryId: "e1", toolResultEntryIds: ["r1"] }, ctx);

    // live frames carry the agent-clock timing fields through the hub
    await waitUntil(() => hub!.all().some((f) => f.t === "ev" && f.e.type === "turn_end"), 3_000, "turn_end ev");
    const evs = hub!.all().filter((f): f is Extract<{ t: string; e: any }, { t: "ev" }> => f.t === "ev");
    expect(evs.find((f) => f.e.type === "tool_execution_start")!.e.startedAt).toBe(10_000);
    expect(evs.find((f) => f.e.type === "tool_execution_end")!.e.durationMs).toBe(1_500);

    // exactly one durability entry for the turn
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(WEB_TOOL_TIMING_ENTRY_TYPE, { v: 1, t: { c1: 1_500 } });

    // next turn with no tools: no further entries
    spy.mockClear();
    fire("turn_end", { type: "turn_end", turnIndex: 1, messageEntryId: "e2", toolResultEntryIds: [] }, ctx);
    await new Promise((r) => setTimeout(r, 20));
    expect(spy).not.toHaveBeenCalled();

    fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
    await waitUntil(() => hub!.all().some((f) => f.t === "bye"), 3_000, "bye");
  });

  it("the timing entry's renderer is registered at wiring time (renders nothing)", () => {
    const { pi } = fakePi();
    const spy = vi.spyOn(pi, "registerEntryRenderer");
    wireWebHub(pi, deps());
    const call = spy.mock.calls.find((c) => c[0] === WEB_TOOL_TIMING_ENTRY_TYPE);
    expect(call).toBeDefined();
    expect((call![1] as (e: unknown, o: unknown, t: unknown) => unknown)({}, { expanded: false }, {})).toBeUndefined();
  });
});
