// @vitest-environment node
import { describe, expect, it } from "vitest";
import { initialState, needsRunSubscribe, reduce } from "../../../src/web-hub/ui/src/logic/state.js";

/**
 * fleet-drawer plan §3.3 (browser column) + §6.5: the runTx state machine — every rule the
 * plan freezes for the browser side of the run-transcript channel. The main-session halves of
 * the shared cores (`historyCore`/`pageCore`/`eventCore`) are pinned unchanged by
 * logic-state.test.ts; this suite owns the run-only wrappers around them.
 */

type Msg = { event: string; data: any; id?: number };
const run = (msgs: Msg[], s = initialState()) => msgs.reduce((acc, m) => reduce(acc, m), s);

const card = (agentKey: string) => ({
  agentKey,
  kind: "tui",
  pid: 1,
  cwd: "/tmp/p",
  state: "live",
  pluginVersion: "1.0.0",
  outdated: false,
  session: {
    sessionId: "s1",
    sessionFile: "/tmp/s1.jsonl",
    cwd: "/tmp/p",
    reason: "startup",
    leafId: null,
    mode: "tui",
  },
  prompts: [],
});

const entry = (id: string, role: string, ts: number, text = `m-${id}`) => ({
  id,
  parentId: null,
  type: "message",
  timestamp: new Date(ts).toISOString(),
  message: { role, content: text, timestamp: ts },
});

const fleetRow = (runId: string, extra: Record<string, unknown> = {}) => ({
  runId,
  status: "running",
  phaseLabel: "working",
  elapsedMs: 1,
  phaseMs: 1,
  highlight: "none",
  terminal: false,
  ...extra,
});

const RUN = "r_AB12CD34"; // §3.1 RUN_ID_PATTERN shape (r_ + 8 base32 chars)

/** hello + agents + run_select + run_subscribing ⇒ agent A with a pending runTx. */
function pending(runId = RUN) {
  return run([
    { event: "hello", data: { clientId: "c1" } },
    { event: "agents", data: [card("A")] },
    { event: "run_select", data: { agentKey: "A", runId } },
    { event: "run_subscribing", data: { agentKey: "A", runId, at: 100, retries: 0 } },
  ]);
}

/** pending() + a live run_history snapshot at watermark `fromSeq - 1 = w`. */
function loaded(runId = RUN, fromSeq = 11, entries: unknown[] = [entry("e1", "user", 1000)]) {
  return run(
    [
      {
        event: "run_history",
        data: {
          agentKey: "A",
          runId,
          entries,
          tailMessages: [],
          tapId: "tap_1",
          fromSeq,
          hasMore: false,
          source: "live",
          terminal: false,
          status: "running",
          live: true,
        },
      },
    ],
    pending(runId),
  );
}

const tx = (s: ReturnType<typeof initialState>) => s.agents.get("A")!.runTx!;
const rev = (seq: number, e: Record<string, unknown>, tapId = "tap_1", runId = RUN): Msg => ({
  event: "run_ev",
  data: { agentKey: "A", runId, tapId, seq, e },
});

describe("runTx: run_select / run_subscribing / run_unsubscribed (§6.5)", () => {
  it("run_select sets runSel and resets runTx; deselect nulls both; re-select of the SAME run resets (manual retry)", () => {
    let s = run([
      { event: "hello", data: { clientId: "c1" } },
      { event: "agents", data: [card("A")] },
      { event: "run_select", data: { agentKey: "A", runId: RUN } },
    ]);
    expect(s.agents.get("A")!.runSel).toBe(RUN);
    expect(s.agents.get("A")!.runTx).toBeNull();
    s = loaded(RUN, 11, [entry("e1", "user", 1000)]);
    expect(tx(s).items).toHaveLength(1);

    // re-select same run ⇒ reset (the error-state retry path)
    s = run([{ event: "run_select", data: { agentKey: "A", runId: RUN } }], s);
    expect(s.agents.get("A")!.runSel).toBe(RUN);
    expect(s.agents.get("A")!.runTx).toBeNull();

    // deselect
    s = run([{ event: "run_select", data: { agentKey: "A", runId: null } }], s);
    expect(s.agents.get("A")!.runSel).toBeNull();
    expect(s.agents.get("A")!.runTx).toBeNull();

    // a no-op re-select of null doesn't churn state
    const before = s;
    s = reduce(s, { event: "run_select", data: { agentKey: "A", runId: null } });
    expect(s).toBe(before);
  });

  it("run_subscribing creates a waiting pending tx; a re-subscribe KEEPS loaded content (§6.5 hello badge)", () => {
    const s = pending();
    expect(tx(s)).toMatchObject({ runId: RUN, history: "waiting", pendingSince: 100, retries: 0, needsResync: false });

    let s2 = loaded();
    // reconnect re-subscribe: content preserved, history stays loaded, fresh pendingSince
    s2 = run([{ event: "run_subscribing", data: { agentKey: "A", runId: RUN, at: 999, retries: 1 } }], s2);
    expect(tx(s2)).toMatchObject({ history: "loaded", pendingSince: 999, retries: 1 });
    expect(tx(s2).items.map((i: any) => i.entryId)).toEqual(["e1"]);

    // error content also survives a re-subscribe attempt (waiting again)
    let s3 = run([{ event: "run_history", data: { agentKey: "A", runId: RUN, error: "E_AGENT_GONE" } }], loaded());
    expect(tx(s3).history).toBe("error");
    s3 = run([{ event: "run_subscribing", data: { agentKey: "A", runId: RUN, at: 1000, retries: 0 } }], s3);
    expect(tx(s3)).toMatchObject({ history: "waiting", pendingSince: 1000, historyError: undefined });
    expect(tx(s3).items.map((i: any) => i.entryId)).toEqual(["e1"]);
  });

  it("run_unsubscribed clears only the pending mark — content and needsResync survive (rate-limited re-subscribe still fires)", () => {
    let s = loaded();
    s = run(
      [{ event: "run_ev", data: { agentKey: "A", runId: RUN, tapId: "tap_1", seq: 20, e: { type: "turn_start" } } }],
      s,
    );
    expect(tx(s).needsResync).toBe(true);
    s = run([{ event: "run_subscribing", data: { agentKey: "A", runId: RUN, at: 200, retries: 0 } }], s);
    expect(tx(s).pendingSince).toBe(200);
    s = run([{ event: "run_unsubscribed", data: { agentKey: "A", runId: RUN } }], s);
    expect(tx(s).pendingSince).toBeUndefined();
    expect(tx(s).needsResync).toBe(false); // consumed by the run_subscribing attempt above
    expect(tx(s).items.map((i: any) => i.entryId)).toEqual(["e1"]);

    // without an intervening attempt, run_unsubscribed alone keeps needsResync armed
    let s2 = run(
      [{ event: "run_ev", data: { agentKey: "A", runId: RUN, tapId: "tap_1", seq: 20, e: { type: "turn_start" } } }],
      loaded(),
    );
    s2 = run([{ event: "run_unsubscribed", data: { agentKey: "A", runId: RUN } }], s2);
    expect(tx(s2).needsResync).toBe(true);
    expect(tx(s2).items.map((i: any) => i.entryId)).toEqual(["e1"]);
  });

  it("events for a different runId are dropped wholesale (runId mismatch ⇒ 丢弃)", () => {
    const s = loaded();
    const other = rev(
      11,
      { type: "message_start", message: { role: "assistant", content: [], timestamp: 1 } },
      "tap_1",
      "r_ZZZZZZZZ",
    );
    const s2 = reduce(s, other);
    expect(s2).toBe(s);
  });
});

describe("runTx: run_history (§3.3 — 覆盖语义)", () => {
  it("replaces the whole state: fresh dedupe sets, lastSeq = fromSeq - 1, inflight-derived streaming/tools", () => {
    const s = loaded(RUN, 11, [
      entry("e1", "user", 1000),
      entry("e2", "user", 1001),
      { ...entry("e1", "user", 1000) }, // duplicate id in one snapshot ⇒ dropped by the fresh entryIds set
    ]);
    expect(tx(s).items.map((i: any) => i.entryId)).toEqual(["e1", "e2"]);
    expect(tx(s).lastSeq).toBe(10);
    expect(tx(s).history).toBe("loaded");
    expect(tx(s).pendingSince).toBeUndefined();
    expect(tx(s).tapId).toBe("tap_1");
    expect(tx(s)).toMatchObject({ terminal: false, status: "running", live: true, source: "live" });

    const s2 = run(
      [
        {
          event: "run_history",
          data: {
            agentKey: "A",
            runId: RUN,
            entries: [entry("e5", "user", 1005)],
            tailMessages: [],
            inflight: {
              message: { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 5 },
              tools: [{ toolCallId: "t1", toolName: "bash", args: {} }],
            },
            tapId: "tap_2",
            fromSeq: 30,
            hasMore: true,
            oldestEntryId: "e0",
            source: "live",
            terminal: false,
            status: "running",
            live: true,
          },
        },
      ],
      s,
    );
    // wholesale replace: old items GONE (unlike append), watermark moved
    expect(tx(s2).items.map((i: any) => i.entryId)).toEqual(["e5"]);
    expect(tx(s2).lastSeq).toBe(29);
    expect(tx(s2).hasMore).toBe(true);
    expect(tx(s2).oldestEntryId).toBe("e0");
    expect((tx(s2).streaming as any).content[0].text).toBe("hi");
    expect(tx(s2).tools).toHaveLength(1);
    expect(tx(s2).tapId).toBe("tap_2");
    expect(tx(s2).needsResync).toBe(false);
  });

  it("file-source terminal snapshot: fromSeq 0 ⇒ lastSeq -1, terminal true, live false", () => {
    const s = run(
      [
        {
          event: "run_history",
          data: {
            agentKey: "A",
            runId: RUN,
            entries: [entry("e1", "assistant", 1000)],
            tailMessages: [],
            fromSeq: 0,
            hasMore: false,
            source: "file",
            terminal: true,
            status: "done",
            live: false,
          },
        },
      ],
      pending(),
    );
    expect(tx(s)).toMatchObject({ lastSeq: -1, terminal: true, live: false, source: "file", status: "done" });
  });

  it("error payloads keep already-received content and clear the pending mark (§3.5/§3.6)", () => {
    let s = loaded();
    s = run([{ event: "run_history", data: { agentKey: "A", runId: RUN, error: "E_AGENT_GONE" } }], s);
    expect(tx(s)).toMatchObject({
      history: "error",
      historyError: "E_AGENT_GONE",
      pendingSince: undefined,
      needsResync: false,
    });
    expect(tx(s).items.map((i: any) => i.entryId)).toEqual(["e1"]); // live viewer keeps the content
    // denial reason rides along (§3.6) once a run_subscribing put the tx back into an attempt
    s = run(
      [
        { event: "run_subscribing", data: { agentKey: "A", runId: RUN, at: 500, retries: 0 } },
        { event: "run_history", data: { agentKey: "A", runId: RUN, error: "E_NOT_FOUND", reason: "not_persisted" } },
      ],
      s,
    );
    expect(tx(s)).toMatchObject({ history: "error", historyError: "E_NOT_FOUND", reason: "not_persisted" });
  });

  it("a snapshot without a runTx slot (never selected) is dropped", () => {
    const s0 = run([
      { event: "hello", data: { clientId: "c1" } },
      { event: "agents", data: [card("A")] },
    ]);
    const s = reduce(s0, {
      event: "run_history",
      data: {
        agentKey: "A",
        runId: RUN,
        entries: [],
        tailMessages: [],
        fromSeq: 1,
        hasMore: false,
        source: "live",
        terminal: false,
        status: "running",
        live: true,
      },
    });
    expect(s).toBe(s0);
  });
});

describe("runTx: run_ev seq rules (§3.3 — 丢弃/重订/追加)", () => {
  it("seq === lastSeq + 1 applies through the shared event core and advances the watermark", () => {
    let s = loaded(); // lastSeq 10
    s = run(
      [
        rev(11, { type: "message_start", message: { role: "assistant", content: [], timestamp: 2000 } }),
        rev(12, { type: "message_update", contentIndex: 0, deltaType: "text_delta", delta: "Hel" }),
        rev(13, { type: "message_update", contentIndex: 0, deltaType: "text_delta", delta: "lo" }),
        rev(14, {
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "Hello" }], timestamp: 2000 },
        }),
      ],
      s,
    );
    expect(tx(s).lastSeq).toBe(14);
    expect(tx(s).streaming).toBeNull();
    expect(tx(s).items.at(-1)!.message!.content[0]).toMatchObject({ type: "text", text: "Hello" });
    expect(tx(s).needsResync).toBe(false);
  });

  it("seq <= lastSeq is dropped as a duplicate (ring/buffered overlap)", () => {
    const s = loaded(); // lastSeq 10
    const s2 = reduce(s, rev(10, { type: "message_start", message: { role: "assistant", content: [], timestamp: 1 } }));
    expect(s2).toBe(s);
  });

  it("a hole (seq !== lastSeq + 1) sets needsResync and drops the frame — the re-snapshot replays it", () => {
    const s = loaded(); // lastSeq 10
    const s2 = reduce(s, rev(13, { type: "message_start", message: { role: "assistant", content: [], timestamp: 1 } }));
    expect(s2).not.toBe(s);
    expect(tx(s2).needsResync).toBe(true);
    expect(tx(s2).lastSeq).toBe(10); // watermark unmoved
    expect(tx(s2).streaming).toBeNull(); // frame NOT applied
  });

  it("tapId mismatch drops the frame (stale pre-resync tap); a missing local tapId accepts", () => {
    const s = loaded(); // tapId tap_1
    const s2 = reduce(
      s,
      rev(11, { type: "message_start", message: { role: "assistant", content: [], timestamp: 1 } }, "tap_OLD"),
    );
    expect(s2).toBe(s);

    // watching:false snapshot carries no tapId — subsequent evs (if any) still seq-guarded
    let s3 = run(
      [
        {
          event: "run_history",
          data: {
            agentKey: "A",
            runId: RUN,
            entries: [],
            tailMessages: [],
            fromSeq: 5,
            hasMore: false,
            source: "live",
            terminal: false,
            status: "running",
            live: false,
          },
        },
      ],
      pending(),
    );
    expect(tx(s3).tapId).toBeUndefined();
    s3 = reduce(s3, rev(5, { type: "agent_start" }));
    expect(tx(s3).lastSeq).toBe(5); // accepted (defensive path — no tap means no identity to check)
  });

  it("frames before the first snapshot are dropped (hub buffers them behind run_history)", () => {
    const s = pending(); // history "waiting"
    const s2 = reduce(s, rev(1, { type: "agent_start" }));
    expect(s2).toBe(s);
  });

  it("session_info_changed / model_select are inert for a run (no session slot — kernel scope)", () => {
    const s = loaded();
    const s2 = reduce(s, rev(11, { type: "session_info_changed", name: "renamed" }));
    const s3 = reduce(s2, rev(12, { type: "model_select", model: { provider: "p", id: "m" } }));
    expect(tx(s3).lastSeq).toBe(12); // seq advances, but no session/card side effects exist to fire
  });
});

describe("runTx: run_end (§3.3/§3.6 — terminal 保留已收条目)", () => {
  it("matching lastSeq ⇒ terminal, live off, streaming bubble cleared, items KEPT", () => {
    let s = loaded(); // lastSeq 10
    s = run([rev(11, { type: "message_start", message: { role: "assistant", content: [], timestamp: 1 } })], s);
    expect(tx(s).streaming).not.toBeNull();
    const itemsBefore = tx(s).items.length;
    s = run(
      [{ event: "run_end", data: { agentKey: "A", runId: RUN, tapId: "tap_1", lastSeq: 11, status: "done" } }],
      s,
    );
    expect(tx(s)).toMatchObject({ terminal: true, live: false, status: "done", streaming: null });
    expect(tx(s).items).toHaveLength(itemsBefore); // 不清空已收条目
    expect(tx(s).needsResync).toBe(false);
    // further evs are dropped-by-duplicate (seq <= lastSeq) — terminal is stable
    const s2 = reduce(s, rev(12, { type: "agent_start" }));
    expect(tx(s2).terminal).toBe(true);
  });

  it("lastSeq mismatch ⇒ needsResync (hub takes the terminal-file path on the re-snapshot)", () => {
    const s = loaded(); // lastSeq 10
    const s2 = reduce(s, {
      event: "run_end",
      data: { agentKey: "A", runId: RUN, tapId: "tap_1", lastSeq: 12, status: "done" },
    });
    expect(tx(s2).needsResync).toBe(true);
    expect(tx(s2).terminal).toBe(false); // not terminal yet — the re-snapshot decides
  });

  it("tapId mismatch or pre-snapshot end frames are dropped", () => {
    const s = loaded();
    expect(
      reduce(s, {
        event: "run_end",
        data: { agentKey: "A", runId: RUN, tapId: "tap_OLD", lastSeq: 10, status: "done" },
      }),
    ).toBe(s);
    const p = pending();
    expect(
      reduce(p, { event: "run_end", data: { agentKey: "A", runId: RUN, tapId: "tap_1", lastSeq: 0, status: "done" } }),
    ).toBe(p);
  });
});

describe("runTx: paging (§3.6 — not_persisted 禁用「加载更早」)", () => {
  /** loaded + a second snapshot marking hasMore with oldestEntryId e5. */
  function loadedPaged() {
    return run(
      [
        {
          event: "run_history",
          data: {
            agentKey: "A",
            runId: RUN,
            entries: [entry("e5", "user", 1005)],
            tailMessages: [],
            tapId: "tap_1",
            fromSeq: 11,
            hasMore: true,
            oldestEntryId: "e5",
            source: "live",
            terminal: false,
            status: "running",
            live: true,
          },
        },
      ],
      pending(),
    );
  }

  it("run_paging/run_page prepend an older page and clear the flag", () => {
    let s = loadedPaged();
    s = run([{ event: "run_paging", data: { agentKey: "A", runId: RUN } }], s);
    expect(tx(s).paging).toBe(true);
    s = run(
      [
        {
          event: "run_page",
          data: {
            agentKey: "A",
            runId: RUN,
            entries: [entry("e1", "user", 1001)],
            tailMessages: [],
            hasMore: false,
            oldestEntryId: "e1",
          },
        },
      ],
      s,
    );
    expect(tx(s).paging).toBe(false);
    expect(tx(s).items.map((i: any) => i.entryId)).toEqual(["e1", "e5"]);
    expect(tx(s).hasMore).toBe(false);
    expect(tx(s).oldestEntryId).toBe("e1");
  });

  it("a deny-class run_page_failed disables load-older and records the reason; transient failures don't", () => {
    let s = run(
      [
        { event: "run_paging", data: { agentKey: "A", runId: RUN } },
        {
          event: "run_page_failed",
          data: { agentKey: "A", runId: RUN, error: "E_NOT_FOUND", reason: "not_persisted" },
        },
      ],
      loadedPaged(),
    );
    expect(tx(s)).toMatchObject({ paging: false, hasMore: false, reason: "not_persisted" });

    let s2 = run(
      [
        { event: "run_paging", data: { agentKey: "A", runId: RUN } },
        { event: "run_page_failed", data: { agentKey: "A", runId: RUN, error: "E_BUSY" } },
      ],
      loadedPaged(),
    );
    expect(tx(s2)).toMatchObject({ paging: false, hasMore: true }); // retryable
  });
});

describe("runTx: fleet slot (§6.3/#12 — omitted counts + lastRow retention)", () => {
  it("fleet folds omitted counts and keeps runTx.lastRow fresh while the run is listed", () => {
    const s = run(
      [
        {
          event: "fleet",
          data: { agentKey: "A", runs: [fleetRow(RUN, { label: "l1" })], omitted: { active: 6, terminal: 4 } },
        },
      ],
      loaded(),
    );
    expect(s.agents.get("A")!.fleetOmitted).toEqual({ active: 6, terminal: 4 });
    expect(tx(s).lastRow).toMatchObject({ runId: RUN, label: "l1" });

    // absent/invalid omitted ⇒ undefined (never a stale value)
    const s2 = run([{ event: "fleet", data: { agentKey: "A", runs: [fleetRow(RUN)] } }], s);
    expect(s2.agents.get("A")!.fleetOmitted).toBeUndefined();
  });

  it("when the run leaves the rows, lastRow keeps the LAST one seen (§6.3 被选中的 run 移出 rows)", () => {
    let s = run([{ event: "fleet", data: { agentKey: "A", runs: [fleetRow(RUN, { label: "keep-me" })] } }], loaded());
    s = run([{ event: "fleet", data: { agentKey: "A", runs: [fleetRow("r_OTHERRUN")] } }], s);
    expect(tx(s).lastRow).toMatchObject({ runId: RUN, label: "keep-me" });
  });

  it("a snapshot without a prior lastRow captures it from the fleet rows it lands on", () => {
    const s = run([{ event: "fleet", data: { agentKey: "A", runs: [fleetRow(RUN, { label: "snap" })] } }], pending());
    const s2 = run(
      [
        {
          event: "run_history",
          data: {
            agentKey: "A",
            runId: RUN,
            entries: [],
            tailMessages: [],
            fromSeq: 1,
            hasMore: false,
            source: "live",
            terminal: false,
            status: "running",
            live: true,
          },
        },
      ],
      s,
    );
    expect(tx(s2).lastRow).toMatchObject({ runId: RUN, label: "snap" });
  });

  it("agent_up/card merges preserve runSel/runTx (mergeCard spreads)", () => {
    const s = loaded();
    const s2 = run([{ event: "agent_up", data: { agent: card("A") } }], s);
    expect(s2.agents.get("A")!.runSel).toBe(RUN);
    expect(tx(s2).items).toHaveLength(1);
  });
});

describe("needsRunSubscribe (§6.5 derived decision)", () => {
  const base = () =>
    run([
      { event: "hello", data: { clientId: "c1" } },
      { event: "agents", data: [card("A")] },
    ]);

  it("returns the selected live agent's runSel when there is no (or a stale) runTx", () => {
    let s = run([{ event: "run_select", data: { agentKey: "A", runId: RUN } }], base());
    expect(needsRunSubscribe(s)).toEqual({ agentKey: "A", runId: RUN });
    s = loaded(RUN, 11);
    expect(needsRunSubscribe(s)).toBeUndefined(); // loaded, subscribed, healthy
  });

  it("returns undefined while pending, on error (manual retry only), for a down agent, or without a selection", () => {
    expect(needsRunSubscribe(pending())).toBeUndefined();
    let s = run([{ event: "run_history", data: { agentKey: "A", runId: RUN, error: "E_AGENT_GONE" } }], loaded());
    expect(needsRunSubscribe(s)).toBeUndefined();
    s = run([{ event: "agent_down", data: { agentKey: "A", reason: "reap" } }], loaded());
    expect(needsRunSubscribe(s)).toBeUndefined();
    expect(needsRunSubscribe(base())).toBeUndefined();
  });

  it("a needsResync runTx (hole / run_end mismatch) wants a re-subscribe", () => {
    let s = run([rev(20, { type: "agent_start" })], loaded());
    expect(needsRunSubscribe(s)).toEqual({ agentKey: "A", runId: RUN });
    s = run(
      [{ event: "run_end", data: { agentKey: "A", runId: RUN, tapId: "tap_1", lastSeq: 99, status: "done" } }],
      loaded(),
    );
    expect(needsRunSubscribe(s)).toEqual({ agentKey: "A", runId: RUN });
  });
});
