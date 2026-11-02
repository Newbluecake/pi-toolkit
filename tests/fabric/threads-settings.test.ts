/**
 * fabric-thread P0 contract tests (docs/dev/fabric-thread/arch.md r3 §8.2/§9.2/§9.3/§11.1 P0).
 *
 * Covers, in one place (the P0 owner's test domain):
 *   - the `fabric.threads.*` settings block: frozen defaults, per-field tolerance, receipt
 *     vocabulary, non-liveness (parsed identically with fabric on/off);
 *   - the SHARED window clamp (protocol/thread.ts `clampThreadWindowParams`): the §11.1 P0 row's
 *     six acceptance combos verbatim, the warn lines, and "hub clamp ≡ agent clamp";
 *   - the §7 wire contract: cap constants, RE parity with the mirrored sources, decode
 *     accept/reject for thr_req/thr_res/thr_closed, `cmd.thread` on the prompt variant (closed
 *     schema!), `cmd_result.data.thread`, the `status.threads` open slot and the 12 KiB byte gate;
 *   - I11/D8: secure and locked domains force `fabric.threads.enabled:false`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSettings } from "../../src/config/settings.js";
import {
  DEFAULT_FABRIC_SETTINGS,
  parseFabricSettings,
  parseFabricThreadSettings,
  type FabricThreadSettings,
} from "../../src/fabric/settings.js";
import { resetSecureDomainForTests } from "../../src/secure/domain.js";
import { isRunId } from "../../src/core/ids.js";
import { decodeAgentFrame, decodeHubFrame, type CmdFrame } from "../../src/web-hub/protocol/messages.js";
import { FEISHU_CMD_ID_RE } from "../../src/web-hub/protocol/feishu.js";
import {
  THREAD_EVENT_ID_RE,
  THREAD_LABEL_MAX_CP,
  THREAD_POST_ID_RE,
  THREAD_POST_TEXT_MAX_BYTES,
  THREAD_REQ_MAX_BYTES,
  THREAD_RUN_ID_RE,
  THREAD_WINDOW_DEFAULTS,
  clampThreadWindowParams,
  utf8ByteLength,
} from "../../src/web-hub/protocol/thread.js";
import {
  THREAD_AGENT_CAPS as V_AGENT,
  THREAD_CAP,
  THREAD_HUB_CAPS as V_HUB,
} from "../../src/web-hub/protocol/version.js";
import { freezeDomain, makeFakeVault, type FakeVault } from "../secure/helpers.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TRACE = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/governance/activate-trace.json", import.meta.url)), "utf8"),
) as Record<string, { calls: string[]; count: number; phase2: string[]; phase2Count: number }>;

const windowOf = (s: FabricThreadSettings): [number, number, number] => [
  s.handbackWindowMin,
  s.startTimeoutMin,
  s.retainMin,
];

describe("fabric.threads settings (P0 §11.1)", () => {
  it("frozen defaults match the arch's listing exactly", () => {
    expect(DEFAULT_FABRIC_SETTINGS.threads).toEqual({
      enabled: false,
      maxSubsPerRun: 4,
      maxSubsPerThread: 4,
      maxSubs: 32,
      routedPerThreadPerHour: 60,
      laneWait: 8,
      steerTimeoutMs: 4_000,
      startTimeoutMin: 8,
      retainMin: 15,
      handbackWindowMin: 10,
      replyPerThreadPerMin: 6,
      replyPerThreadPerHour: 60,
      receipt: "first",
    } satisfies FabricThreadSettings);
  });

  it("defaults satisfy the window constraint R ≥ max(H,S)+2 (15 ≥ 12)", () => {
    const { handbackWindowMin: h, startTimeoutMin: s, retainMin: r } = DEFAULT_FABRIC_SETTINGS.threads;
    expect(r).toBeGreaterThanOrEqual(Math.max(h, s) + 2);
    expect(DEFAULT_FABRIC_SETTINGS.threads).toEqual({ ...DEFAULT_FABRIC_SETTINGS.threads });
  });

  it("parses user values; non-object and absent blocks fall back to defaults", () => {
    const parsed = parseFabricThreadSettings({
      enabled: true,
      maxSubsPerRun: 2,
      maxSubsPerThread: 3,
      maxSubs: 10,
      routedPerThreadPerHour: 30,
      laneWait: 4,
      steerTimeoutMs: 2_000,
      replyPerThreadPerMin: 2,
      replyPerThreadPerHour: 20,
      receipt: "first",
    });
    expect(parsed.enabled).toBe(true);
    expect(parsed.maxSubsPerRun).toBe(2);
    expect(parsed.steerTimeoutMs).toBe(2_000);
    // window keys untouched (valid) → defaults stay
    expect(windowOf(parsed)).toEqual([10, 8, 15]);
    for (const bad of [undefined, null, 3, "x", [], true]) {
      expect(parseFabricThreadSettings(bad)).toEqual(DEFAULT_FABRIC_SETTINGS.threads);
    }
  });

  it("per-field tolerance: wrong types keep defaults, out-of-range clamps, non-integers floor", () => {
    const p = parseFabricThreadSettings({
      enabled: "yes",
      maxSubsPerRun: 99,
      maxSubsPerThread: 0,
      maxSubs: -5,
      routedPerThreadPerHour: "60",
      laneWait: 1.9,
      steerTimeoutMs: 10,
      replyPerThreadPerMin: 999,
      replyPerThreadPerHour: -1,
      receipt: "all",
    });
    expect(p.enabled).toBe(false);
    expect(p.maxSubsPerRun).toBe(8); // above max → 8
    expect(p.maxSubsPerThread).toBe(1); // below min → 1
    expect(p.maxSubs).toBe(1); // below min → 1
    expect(p.routedPerThreadPerHour).toBe(60); // wrong type → default
    expect(p.laneWait).toBe(1); // floored
    expect(p.steerTimeoutMs).toBe(500); // below min → 500 (the R6 floor)
    expect(p.replyPerThreadPerMin).toBe(60); // above max → 60
    expect(p.replyPerThreadPerHour).toBe(0); // below min → 0 (0 = replies forbidden)
    expect(p.receipt).toBe("first"); // unknown vocabulary → default (phase-1: only "first")
  });

  it("non-live + gating: the block is parsed identically whether fabric.enabled is on or off", () => {
    const threads = { enabled: true, retainMin: 20 };
    const on = parseFabricSettings({ enabled: true, threads });
    const off = parseFabricSettings({ enabled: false, threads });
    expect(on.threads).toEqual(off.threads);
    // and it exists in every parsed block (like wake/crossSession), default off
    expect(parseFabricSettings({}).threads).toEqual(DEFAULT_FABRIC_SETTINGS.threads);
    expect(loadSettings({}).fabric.threads).toEqual(DEFAULT_FABRIC_SETTINGS.threads);
  });

  it("the file stores steerTimeoutS and loadSettings converts it (TIME_SETTING_MS_PATHS boundary)", () => {
    const s = loadSettings({ fabric: { threads: { steerTimeoutS: 6 } } });
    expect(s.fabric.threads.steerTimeoutMs).toBe(6_000);
  });
});

describe("shared window clamp — the §11.1 P0 six acceptance combos", () => {
  let warns: string[];
  beforeEach(() => {
    warns = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warns.push(args.map(String).join(" "));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("① default (H10,S8,R15): unchanged, no warn", () => {
    const out = clampThreadWindowParams({ handbackWindowMin: 10, startTimeoutMin: 8, retainMin: 15 });
    expect(out.value).toEqual(THREAD_WINDOW_DEFAULTS);
    expect(out.changes).toEqual([]);
    const parsed = parseFabricThreadSettings({ handbackWindowMin: 10, startTimeoutMin: 8, retainMin: 15 });
    expect(windowOf(parsed)).toEqual([10, 8, 15]);
    expect(warns).toEqual([]);
  });

  it("② (H30,S30,R60): legal, unchanged, no warn", () => {
    const out = clampThreadWindowParams({ handbackWindowMin: 30, startTimeoutMin: 30, retainMin: 60 });
    expect(out.value).toEqual({ handbackWindowMin: 30, startTimeoutMin: 30, retainMin: 60 });
    expect(out.changes).toEqual([]);
    expect(warns).toEqual([]);
  });

  it("③ (H10,S8,R5): R=12 with exactly one warn", () => {
    const out = clampThreadWindowParams({ handbackWindowMin: 10, startTimeoutMin: 8, retainMin: 5 });
    expect(out.value).toEqual({ handbackWindowMin: 10, startTimeoutMin: 8, retainMin: 12 });
    expect(out.changes).toEqual([
      {
        key: "retainMin",
        from: 5,
        to: 12,
        reason: "must be ≥ max(handbackWindowMin, startTimeoutMin)+2",
      },
    ]);
    const parsed = parseFabricThreadSettings({ handbackWindowMin: 10, startTimeoutMin: 8, retainMin: 5 });
    expect(windowOf(parsed)).toEqual([10, 8, 12]);
    expect(warns).toEqual([
      "[pi-subagent] fabric.threads.retainMin 5 → 12 (must be ≥ max(handbackWindowMin, startTimeoutMin)+2)",
    ]);
  });

  it("④ (H0,S8,R15): H=1 with exactly one warn", () => {
    const out = clampThreadWindowParams({ handbackWindowMin: 0, startTimeoutMin: 8, retainMin: 15 });
    expect(out.value).toEqual({ handbackWindowMin: 1, startTimeoutMin: 8, retainMin: 15 });
    expect(out.changes).toEqual([{ key: "handbackWindowMin", from: 0, to: 1, reason: "below min 1" }]);
    const parsed = parseFabricThreadSettings({ handbackWindowMin: 0, startTimeoutMin: 8, retainMin: 15 });
    expect(windowOf(parsed)).toEqual([1, 8, 15]);
    expect(warns).toEqual(["[pi-subagent] fabric.threads.handbackWindowMin 0 → 1 (below min 1)"]);
  });

  it("⑤ (H10,S40,R15): S=30 and R=32, two warns", () => {
    const out = clampThreadWindowParams({ handbackWindowMin: 10, startTimeoutMin: 40, retainMin: 15 });
    expect(out.value).toEqual({ handbackWindowMin: 10, startTimeoutMin: 30, retainMin: 32 });
    expect(out.changes).toEqual([
      { key: "startTimeoutMin", from: 40, to: 30, reason: "above max 30" },
      { key: "retainMin", from: 15, to: 32, reason: "must be ≥ max(handbackWindowMin, startTimeoutMin)+2" },
    ]);
    const parsed = parseFabricThreadSettings({ handbackWindowMin: 10, startTimeoutMin: 40, retainMin: 15 });
    expect(windowOf(parsed)).toEqual([10, 30, 32]);
    expect(warns).toEqual([
      "[pi-subagent] fabric.threads.startTimeoutMin 40 → 30 (above max 30)",
      "[pi-subagent] fabric.threads.retainMin 15 → 32 (must be ≥ max(handbackWindowMin, startTimeoutMin)+2)",
    ]);
  });

  it("⑥ R=100 (H,S default): R=60 with exactly one warn", () => {
    const out = clampThreadWindowParams({ retainMin: 100 });
    expect(out.value).toEqual({ handbackWindowMin: 10, startTimeoutMin: 8, retainMin: 60 });
    expect(out.changes).toEqual([{ key: "retainMin", from: 100, to: 60, reason: "above max 60" }]);
    const parsed = parseFabricThreadSettings({ retainMin: 100 });
    expect(windowOf(parsed)).toEqual([10, 8, 60]);
    expect(warns).toEqual(["[pi-subagent] fabric.threads.retainMin 100 → 60 (above max 60)"]);
  });

  it("hub clamp ≡ agent clamp: the same function on HubConfig-shaped numbers gives the parse result", () => {
    // The agent writes only clamped values into HubConfig (§8.2); the hub re-clamps defensively
    // with this same function — by construction the second pass is a no-op (idempotent).
    for (const input of [
      { handbackWindowMin: 10, startTimeoutMin: 8, retainMin: 15 },
      { handbackWindowMin: 10, startTimeoutMin: 8, retainMin: 5 },
      { handbackWindowMin: 0, startTimeoutMin: 8, retainMin: 15 },
      { handbackWindowMin: 10, startTimeoutMin: 40, retainMin: 15 },
      { retainMin: 100 },
      { handbackWindowMin: 30, startTimeoutMin: 30, retainMin: 60 },
    ]) {
      const first = clampThreadWindowParams(input);
      const second = clampThreadWindowParams(first.value);
      expect(second.changes, JSON.stringify(input)).toEqual([]);
      expect(second.value).toEqual(first.value);
      const viaParse = parseFabricThreadSettings(input);
      expect(windowOf(viaParse), JSON.stringify(input)).toEqual([
        first.value.handbackWindowMin,
        first.value.startTimeoutMin,
        first.value.retainMin,
      ]);
    }
  });

  it("the cross-rule raise can never overflow R's own ceiling (H,S ≤ 30 ⇒ floor ≤ 32 ≤ 60)", () => {
    const worst = clampThreadWindowParams({ handbackWindowMin: 30, startTimeoutMin: 30, retainMin: 5 });
    expect(worst.value.retainMin).toBe(32);
    expect(worst.value.retainMin).toBeLessThanOrEqual(60);
  });

  it("present-but-invalid values fall back to the default with a warn; absent ones are silent", () => {
    const out = clampThreadWindowParams({ handbackWindowMin: "soon", retainMin: NaN });
    expect(out.value).toEqual({ handbackWindowMin: 10, startTimeoutMin: 8, retainMin: 15 });
    expect(out.changes.map((c) => `${c.key}:${c.reason}`)).toEqual(["handbackWindowMin:invalid", "retainMin:invalid"]);
    const silent = clampThreadWindowParams({});
    expect(silent.changes).toEqual([]);
  });

  it("never rejects: every path returns a fully-populated, in-range value", () => {
    for (const h of [undefined, -1, 0, 1, 10, 30, 31, 1e9, 2.5, "x", null]) {
      for (const s of [undefined, -1, 0, 8, 30, 40, 1e9]) {
        for (const r of [undefined, -1, 0, 5, 15, 60, 100, 1e9]) {
          const { value } = clampThreadWindowParams({
            handbackWindowMin: h,
            startTimeoutMin: s,
            retainMin: r,
          });
          expect(value.handbackWindowMin).toBeGreaterThanOrEqual(1);
          expect(value.handbackWindowMin).toBeLessThanOrEqual(30);
          expect(value.startTimeoutMin).toBeGreaterThanOrEqual(1);
          expect(value.startTimeoutMin).toBeLessThanOrEqual(30);
          expect(value.retainMin).toBeGreaterThanOrEqual(5);
          expect(value.retainMin).toBeLessThanOrEqual(60);
          expect(value.retainMin).toBeGreaterThanOrEqual(Math.max(value.handbackWindowMin, value.startTimeoutMin) + 2);
        }
      }
    }
  });
});

describe("§7 wire contract (protocol/thread.ts + messages.ts)", () => {
  it("cap constants: thr.v1, two faces, version.ts is the canonical home", () => {
    expect(THREAD_CAP).toBe("thr.v1");
    expect(V_HUB).toEqual(["thr.v1"]);
    expect(V_AGENT).toEqual(["thr.v1"]);
  });

  it("mirrored REs stay in parity with their frozen sources", () => {
    expect(THREAD_EVENT_ID_RE.source).toBe(FEISHU_CMD_ID_RE.source);
    // RUN_ID_RE is not exported from core/ids.ts — behavioural parity instead: every id the
    // thread wire accepts must satisfy core's own predicate (and our fixture ids do).
    for (const id of ["r_0123456Q", "r_0123456W", "r_abcdefgh"]) {
      expect(THREAD_RUN_ID_RE.test(id), id).toBe(isRunId(id));
    }
    expect(THREAD_RUN_ID_RE.test("r_0123456I")).toBe(false); // I excluded from the base32 alphabet
  });

  it("decodeAgentFrame accepts a well-formed thr_req{post} and rejects every mutation", () => {
    const good = {
      t: "thr_req",
      rid: "rid-1",
      op: "post",
      h: "fs:AbCdEf0123_-",
      sessionId: "019a0000-aaaa-7bbb-8ccc-dddddddddddd",
      by: { runId: "r_0123456Q", label: "worker-a" },
      postId: "r_0123456Q:1",
      text: "done",
    };
    expect(decodeAgentFrame(good)).toEqual(good);
    for (const bad of [
      { ...good, h: "fs:short" },
      { ...good, op: "nope" },
      { ...good, by: { runId: "x", label: "y" } },
      { ...good, postId: "r_0123456Q-1" },
      { ...good, extra: 1 },
      { ...good, text: "" },
      { t: "thr_req", rid: "r", op: "post" },
    ]) {
      expect(decodeAgentFrame(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it('decodeAgentFrame accepts thr_req{handback} with by:"system" and validates note/eventId', () => {
    const good = {
      t: "thr_req",
      rid: "rid-2",
      op: "handback",
      eventId: "fsA".padEnd(32, "B"),
      sessionId: "sess-1",
      by: "system",
      note: "subscriber failed to start",
    };
    expect(decodeAgentFrame(good)).toEqual(good);
    expect(decodeAgentFrame({ ...good, by: { runId: "r_0123456Q", label: "w" } })).toEqual({
      ...good,
      by: { runId: "r_0123456Q", label: "w" },
    });
    expect(decodeAgentFrame({ ...good, eventId: "not-fs" })).toBeUndefined();
  });

  it("thr_req over the 12 KiB byte cap is invalid (xs precedent)", () => {
    const frame = {
      t: "thr_req",
      rid: "rid-3",
      op: "post",
      h: "fs:AbCdEf0123_-",
      sessionId: "sess-1",
      by: { runId: "r_0123456Q", label: "w" },
      postId: "r_0123456Q:2",
      text: "x".repeat(THREAD_REQ_MAX_BYTES),
    };
    expect(JSON.stringify(frame).length).toBeGreaterThan(THREAD_REQ_MAX_BYTES);
    expect(decodeAgentFrame(frame)).toBeUndefined();
  });

  it("decodeHubFrame accepts thr_res ok/error shapes and thr_closed; rejects bad codes", () => {
    const post: { t: "thr_res"; rid: string; ok: true; data: { queued: true } } = {
      t: "thr_res",
      rid: "rid-1",
      ok: true,
      data: { queued: true },
    };
    expect(decodeHubFrame(post)).toEqual(post);
    const dup = {
      t: "thr_res",
      rid: "rid-1",
      ok: true,
      data: { requestId: "fs".padEnd(32, "X"), dup: true },
    };
    expect(decodeHubFrame(dup)).toEqual(dup);
    const err = { t: "thr_res", rid: "rid-1", ok: false, code: "E_THR_RATE", effect: "none" as const };
    expect(decodeHubFrame(err)).toEqual(err);
    const unknown = { t: "thr_res", rid: "rid-1", ok: false, code: "E_THR_STATE", effect: "unknown" as const };
    expect(decodeHubFrame(unknown)).toEqual(unknown);
    expect(decodeHubFrame({ ...err, code: "E_NOT_THR" })).toBeUndefined();
    expect(decodeHubFrame({ ...err, effect: "maybe" })).toBeUndefined();
    for (const reason of ["unbound", "rebound", "reset"] as const) {
      const closed = { t: "thr_closed", h: "fs:AbCdEf0123_-", reason };
      expect(decodeHubFrame(closed)).toEqual(closed);
    }
    expect(decodeHubFrame({ t: "thr_closed", h: "fs:AbCdEf0123_-", reason: "other" })).toBeUndefined();
  });

  it("the prompt cmd variant carries the optional thread meta (closed schema — extra fields drop the frame)", () => {
    const meta = { h: "fs:AbCdEf0123_-", label: "proj · 话题", sentAt: 1_769_000_000_000 };
    const frame = {
      t: "cmd",
      rid: "r1",
      id: "fs".padEnd(32, "Y"),
      deadlineMs: 8_000,
      origin: { listener: "loopback", ip: "127.0.0.1", reqId: "abcdef0123456789" },
      cmd: { op: "prompt", text: "hi", deliver: "steer", thread: meta },
    };
    expect(decodeHubFrame(frame)).toEqual(frame);
    // without the field: byte-identical to the pre-feature shape (G2b)
    const bare = { ...frame, cmd: { op: "prompt", text: "hi", deliver: "steer" } };
    expect(decodeHubFrame(bare)).toEqual(bare);
    // unknown field inside thread drops the WHOLE frame — why the hub gates on the cap (§7.1)
    expect(decodeHubFrame({ ...frame, cmd: { ...frame.cmd, thread: { ...meta, x: 1 } } })).toBeUndefined();
    // bypass is a literal true only
    expect(decodeHubFrame({ ...frame, cmd: { ...frame.cmd, thread: { ...meta, bypass: true } } })).toBeDefined();
    expect(decodeHubFrame({ ...frame, cmd: { ...frame.cmd, thread: { ...meta, bypass: false } } })).toBeUndefined();
  });

  it("cmd.thread rejects malformed handles and negative sentAt", () => {
    const base = {
      t: "cmd",
      rid: "r1",
      id: "fs".padEnd(32, "Y"),
      deadlineMs: 8_000,
      origin: { listener: "loopback", ip: "127.0.0.1", reqId: "abcdef0123456789" },
    };
    const withThread = (thread: unknown): unknown =>
      decodeHubFrame({ ...base, cmd: { op: "prompt", text: "hi", deliver: "steer", thread } });
    expect(withThread({ h: "not-a-handle", label: "l", sentAt: 0 })).toBeUndefined();
    expect(withThread({ h: "fs:AbCdEf0123_-", label: "", sentAt: 0 })).toBeUndefined();
    expect(withThread({ h: "fs:AbCdEf0123_-", label: "l", sentAt: -1 })).toBeUndefined();
    expect(withThread({ h: "fs:AbCdEf0123_-", label: "l", sentAt: 1.5 })).toBeUndefined();
  });

  it("status.threads: open slot accepts ≤8 handles × ≤4 subscribers; agent frames ignore it", () => {
    const slot = [
      {
        h: "fs:AbCdEf0123_-",
        subs: [
          { runId: "r_0123456Q", label: "a" },
          { runId: "r_0123456W", label: "b" },
        ],
      },
    ];
    const status = {
      t: "status",
      leafId: null,
      busy: false,
      pending: false,
      threads: slot,
    };
    expect(decodeAgentFrame(status)).toEqual(status);
    expect(decodeHubFrame(status)).toBeUndefined(); // status is agent→hub
    const over =
      decodeAgentFrame({
        ...status,
        threads: Array.from({ length: 9 }, () => slot[0]!),
      }) ?? undefined;
    expect(over).toBeUndefined();
    const subsOver = decodeAgentFrame({
      ...status,
      threads: [{ h: "fs:AbCdEf0123_-", subs: Array.from({ length: 5 }, () => slot[0]!.subs[0]!) }],
    });
    expect(subsOver).toBeUndefined();
  });

  it("data.thread routed result shape: ≤4 runs, run ids verified (hub re-validates with this schema)", () => {
    // CmdDataSchema is Type.Unknown() on the wire — this pins the TYPED shape the agent emits and
    // the hub re-validates (§8.1 step 1): {outcome:"routed", runs:[{runId,label}] ≤4}.
    const runs = [
      { runId: "r_0123456Q", label: "a" },
      { runId: "r_0123456W", label: "b" },
    ];
    const data = { op: "prompt", delivery: "observed", thread: { outcome: "routed", runs } };
    const frame = {
      t: "cmd_result",
      rid: "r1",
      id: "fs".padEnd(32, "Y"),
      ok: true,
      data,
    };
    expect(decodeAgentFrame(frame)).toEqual(frame);
    // postId/handback shapes live on thr_req/thr_res; THREAD_POST_ID_RE is the dedup-key grammar
    expect(THREAD_POST_ID_RE.test("r_0123456Q:0")).toBe(true);
    expect(THREAD_POST_ID_RE.test("r_0123456Q:9999999999")).toBe(true);
    expect(THREAD_POST_ID_RE.test("r_0123456Q:")).toBe(false);
    expect(THREAD_POST_ID_RE.test("r_0123456Q:x")).toBe(false);
  });

  it("frames decode deterministically and unknown thr_* types stay unknown", () => {
    expect(decodeHubFrame({ t: "thr_unknown", rid: "r" })).toBeUndefined();
    expect(decodeAgentFrame({ t: "thr_unknown", rid: "r" })).toBeUndefined();
  });
});

describe("governance trace: the thread profiles' P0 baseline (§9.3)", () => {
  it("thread-main registers NO thread tool yet (it arrives in P3 — then this pin flips with the refreshed trace)", () => {
    const main = TRACE["thread-main"]!;
    const tools = main.calls.filter((c) => c.startsWith("registerTool("));
    expect(tools.some((c) => c.includes("thread"))).toBe(false);
    // P0-inert means the thread-main profile is byte-identical to `max` (threads.enabled flips
    // nothing until P3 wires the tool / cap): a drift here means something jumped the gun.
    expect(main.calls).toEqual(TRACE["max"]!.calls);
    expect(main.phase2).toEqual(TRACE["max"]!.phase2);
  });

  it("thread-child gains NO thread registration (§9.2 customTools injection, never registerTool)", () => {
    const child = TRACE["thread-child"]!;
    expect(child.calls.filter((c) => c.includes("thread")).length).toBe(0);
    // Note: thread-child runs the max-style settings (fabric on — per §9.3 “同样的设置”), so its
    // call list is NOT comparable to the BASELINE `child` profile; the pinned fact is the absence
    // of any thread registration on a child activation while the feature flag is on.
  });
});

describe("unit semantics: code points vs UTF-16 units vs UTF-8 bytes (review follow-up)", () => {
  const ORIGIN = { listener: "loopback" as const, ip: "127.0.0.1", reqId: "abcdef0123456789" };
  const cmdWithThread = (thread: unknown): unknown =>
    decodeHubFrame({
      t: "cmd",
      rid: "r1",
      id: "fs".padEnd(32, "Y"),
      deadlineMs: 8_000,
      origin: { ...ORIGIN },
      cmd: { op: "prompt", text: "hi", deliver: "steer", thread },
    });
  const postFrame = (over: Record<string, unknown>): unknown =>
    decodeAgentFrame({
      t: "thr_req",
      rid: "rid-1",
      op: "post",
      h: "fs:AbCdEf0123_-",
      sessionId: "sess-1",
      by: { runId: "r_0123456Q", label: "w" },
      postId: "r_0123456Q:1",
      ...over,
    });

  it("utf8ByteLength is byte-exact: ascii/2/3-byte/astral pairs, lone surrogates as U+FFFD (3)", () => {
    expect(utf8ByteLength("")).toBe(0);
    expect(utf8ByteLength("abc")).toBe(3);
    expect(utf8ByteLength("\u00e9")).toBe(2); // U+00E9
    expect(utf8ByteLength("\u20ac")).toBe(3); // €
    expect(utf8ByteLength("话")).toBe(3);
    expect(utf8ByteLength("🧵")).toBe(4); // U+1F9F5 — one surrogate pair, ONE code point
    expect(utf8ByteLength("\ud83e")).toBe(3); // lone high surrogate → substitution
    expect(utf8ByteLength("\uddf5")).toBe(3); // lone low surrogate → substitution
    expect(utf8ByteLength("a\ud83e\uddf5b")).toBe(6); // 1 + 4 + 1 — the pair is counted once
    expect(utf8ByteLength("🧵".repeat(2048))).toBe(8192);
  });

  it("label counts CODE POINTS: a 32-cp astral label (64 UTF-16 units) is NOT dropped", () => {
    const astral32 = "🧵".repeat(THREAD_LABEL_MAX_CP);
    expect(astral32.length).toBe(64); // sanity: over the old UTF-16-unit cap of 32 — the false drop
    const frame = {
      t: "cmd",
      rid: "r1",
      id: "fs".padEnd(32, "Y"),
      deadlineMs: 8_000,
      origin: { ...ORIGIN },
      cmd: {
        op: "prompt",
        text: "hi",
        deliver: "steer",
        thread: { h: "fs:AbCdEf0123_-", label: astral32, sentAt: 0 },
      },
    };
    expect(decodeHubFrame(frame)).toEqual(frame);
    // mixed BMP + astral at exactly the cap
    expect(cmdWithThread({ h: "fs:AbCdEf0123_-", label: "a".repeat(31) + "🧵", sentAt: 0 })).toBeDefined();
    // 33 code points (BMP or astral) are still over the cap
    expect(cmdWithThread({ h: "fs:AbCdEf0123_-", label: "a".repeat(33), sentAt: 0 })).toBeUndefined();
    expect(cmdWithThread({ h: "fs:AbCdEf0123_-", label: "🧵".repeat(33), sentAt: 0 })).toBeUndefined();
    // empty label stays invalid
    expect(cmdWithThread({ h: "fs:AbCdEf0123_-", label: "", sentAt: 0 })).toBeUndefined();
  });

  it("by.label (thr_req) and status.threads labels count code points the same way", () => {
    const astral32 = "🧵".repeat(32);
    expect(postFrame({ by: { runId: "r_0123456Q", label: astral32 }, text: "ok" })).toBeDefined();
    expect(postFrame({ by: { runId: "r_0123456Q", label: "🧵".repeat(33) }, text: "ok" })).toBeUndefined();
    const status = {
      t: "status",
      leafId: null,
      busy: false,
      pending: false,
      threads: [{ h: "fs:AbCdEf0123_-", subs: [{ runId: "r_0123456Q", label: astral32 }] }],
    };
    expect(decodeAgentFrame(status)).toEqual(status);
    expect(
      decodeAgentFrame({
        ...status,
        threads: [{ h: "fs:AbCdEf0123_-", subs: [{ runId: "r_0123456Q", label: "🧵".repeat(33) }] }],
      }),
    ).toBeUndefined();
  });

  it("post.text budget is UTF-8 BYTES: 3000 × € (3000 units, 9000 bytes) passes the envelope but is rejected", () => {
    const text = "€".repeat(3000);
    expect(text.length).toBeLessThanOrEqual(THREAD_POST_TEXT_MAX_BYTES); // under the UTF-16 envelope
    expect(utf8ByteLength(text)).toBe(9000); // over the byte budget
    expect(postFrame({ text })).toBeUndefined();
  });

  it("post.text at exactly 8192 bytes passes; 8193 bytes fails (BMP and astral variants)", () => {
    const at = "€".repeat(2730) + "ab"; // 8190 + 2 bytes
    expect(utf8ByteLength(at)).toBe(8192);
    expect(postFrame({ text: at })).toBeDefined();
    const overBmp = "€".repeat(2731); // 8193 bytes, 2731 units — envelope cannot catch this
    expect(utf8ByteLength(overBmp)).toBe(8193);
    expect(postFrame({ text: overBmp })).toBeUndefined();
    const atAstral = "🧵".repeat(2048); // exactly 8192 bytes in 4096 units
    expect(utf8ByteLength(atAstral)).toBe(8192);
    expect(postFrame({ text: atAstral })).toBeDefined();
    const overAstral = "🧵".repeat(2049); // 8196 bytes in 4098 units
    expect(postFrame({ text: overAstral })).toBeUndefined();
  });

  it("handback note counts CODE POINTS: 200 astral cp accepted (400 units), 201 rejected", () => {
    const base = {
      t: "thr_req",
      rid: "rid-2",
      op: "handback",
      eventId: "fsA".padEnd(32, "B"),
      sessionId: "sess-1",
      by: "system",
    };
    expect(decodeAgentFrame({ ...base, note: "😀".repeat(200) })).toBeDefined();
    expect(decodeAgentFrame({ ...base, note: "😀".repeat(201) })).toBeUndefined();
    // empty note is legal (≤200 cp)
    expect(decodeAgentFrame({ ...base, note: "" })).toBeDefined();
  });
});

describe("I11/D8: secure and locked domains force fabric.threads off", () => {
  let v: FakeVault | undefined;
  afterEach(() => {
    resetSecureDomainForTests();
    v?.cleanup();
    v = undefined;
  });

  it("secure ⇒ threads.enabled false whatever the file says; siblings keep user values", () => {
    v = makeFakeVault();
    freezeDomain(v);
    const s = loadSettings({ fabric: { enabled: true, threads: { enabled: true, laneWait: 5 } } });
    expect(s.fabric.threads.enabled).toBe(false);
    expect(s.fabric.threads.laneWait).toBe(5); // non-overridden siblings keep the user's values
    expect(s.fabric.enabled).toBe(true); // tree fabric is not a D8 push
  });

  it("locked ⇒ threads.enabled false too", () => {
    v = makeFakeVault();
    freezeDomain(v, { mountinfo: v.unmounted });
    const s = loadSettings({ fabric: { threads: { enabled: true } } });
    expect(s.fabric.threads.enabled).toBe(false);
  });

  it("plain domain ⇒ the user's value survives", () => {
    v = makeFakeVault();
    freezeDomain(v, { cwd: v.outside });
    expect(loadSettings({ fabric: { threads: { enabled: true } } }).fabric.threads.enabled).toBe(true);
  });
});
