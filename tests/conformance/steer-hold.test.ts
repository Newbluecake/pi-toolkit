/**
 * Fast, NON-GATING reference-driver run of the plan §1.2 path matrix (v4.3 Y1-amended), via the TS
 * port in `steer-hold-ref-driver.ts`. This is a cheap pi-upgrade tripwire, not the merge gate — see
 * `steer-hold-driver.test.ts` (G0 hard gate, real production modules) for the authoritative suite.
 */
import { describe, expect, it } from "vitest";
import { refHelpers, runRefRow, tool, text, err, type RefHooks } from "./steer-hold-ref-driver.js";

const { all, once, never, firstIn, before } = refHelpers;

describe("steer-hold reference driver (fast, non-gating)", () => {
  it("M1 first turn: turn_start#1 refused (idle), context#1 holds ⇒ LLM#2", async () => {
    let n = 0;
    const hooks: RefHooks = {
      turn_start: (api) => {
        if (n++ === 0) api.hold("PRE-ARM");
      },
      context: (api) => {
        if (api.st.events.filter((e) => e === "context").length === 1) api.hold("H1");
      },
    };
    const res = await runRefRow(
      { scripted: [tool("a"), text("done")], hooks },
      all(once("H1"), never("PRE-ARM"), firstIn("H1", 2)),
    );
    expect(res.ok, res.why).toBe(true);
  });

  it("M2 tool loop + recall: S1/S2/S3 FIFO, RECALLME never sent", async () => {
    let r2 = 0;
    const hooks: RefHooks = {
      tool: (api) => {
        r2++;
        api.hold(`S${r2}`);
        if (r2 === 2) {
          api.hold("RECALLME");
          api.recall("RECALLME");
        }
      },
    };
    const res = await runRefRow(
      { scripted: [tool("a"), tool("b"), tool("c"), text("done")], hooks },
      all(once("S1"), once("S2"), once("S3"), never("RECALLME"), firstIn("S1", 2), firstIn("S2", 3), firstIn("S3", 4)),
    );
    expect(res.ok, res.why).toBe(true);
  });

  it("M3 followUp on a stopping turn, steer held in continuation; exactly one agent_end", async () => {
    let r3 = 0;
    const hooks: RefHooks = {
      context: (api) => {
        r3++;
        if (r3 === 1) api.hold("FU1", "followUp");
        if (r3 === 2) api.hold("S-IN-CONT");
      },
    };
    const res = await runRefRow(
      { scripted: [text("t1"), text("t2"), text("t3")], hooks },
      all(once("FU1"), once("S-IN-CONT"), firstIn("FU1", 2), firstIn("S-IN-CONT", 3), (_fu, _c, _l, hk) =>
        hk.__api!.st.events.filter((e) => e.startsWith("agent_end")).length === 1
          ? { ok: true }
          : { ok: false, why: "agent_end count" },
      ),
    );
    expect(res.ok, res.why).toBe(true);
  });

  it("M5 retryable error turn: steer dispatched on the errored turn_end", async () => {
    let r5 = 0;
    const hooks: RefHooks = {
      context: (api) => {
        r5++;
        if (r5 === 2) api.hold("H-ERR-STEER");
      },
    };
    const res = await runRefRow(
      { scripted: [tool("a"), err("overloaded_error: server overloaded"), text("ok"), text("ok2")], hooks },
      all(once("H-ERR-STEER"), firstIn("H-ERR-STEER", 3)),
    );
    expect(res.ok, res.why).toBe(true);
  });

  it("M6 abort mid-tool ⇒ returned(aborted), never sent", async () => {
    const hooks: RefHooks = {
      tool: (api, ctx) => {
        api.hold("H-ABORT");
        api.hold("H-ABORT-FU", "followUp");
        ctx.abort();
      },
    };
    const res = await runRefRow(
      { scripted: [tool("a"), text("done")], hooks },
      all(never("H-ABORT"), never("H-ABORT-FU"), (_fu, _c, _l, hk) =>
        hk.__api!.st.outcome.get("H-ABORT") === "returned(aborted)" &&
        hk.__api!.st.outcome.get("H-ABORT-FU") === "returned(aborted)"
          ? { ok: true }
          : { ok: false, why: "not returned(aborted)" },
      ),
    );
    expect(res.ok, res.why).toBe(true);
  });

  it("M7 non-retryable error turn: both steer and followUp dispatched", async () => {
    let r7 = 0;
    const hooks: RefHooks = {
      context: (api) => {
        r7++;
        if (r7 === 2) {
          api.hold("H-E7");
          api.hold("H-E7-FU", "followUp");
        }
      },
    };
    const res = await runRefRow(
      { scripted: [tool("a"), err("invalid_request_error: bad schema"), text("ok"), text("ok2")], hooks },
      all(once("H-E7")),
    );
    expect(res.ok, res.why).toBe(true);
  });

  it("M9 missing entryId (turn_end skipped) ⇒ phase-based skip-detect at next turn_start", async () => {
    const noEntry = (s: unknown) => {
      (s as { _findPersistedMessageEntryId: () => undefined })._findPersistedMessageEntryId = () => undefined;
    };
    const hooks: RefHooks = {
      tool: (api) => {
        if (!api.st.held.length && !api.st.outcome.size) api.hold("H-SKIP");
      },
    };
    const res = await runRefRow(
      { scripted: [tool("a"), tool("b"), text("done")], hooks, patch: noEntry },
      all(once("H-SKIP"), firstIn("H-SKIP", 3), (_fu, _c, _l, hk) =>
        hk.__api!.st.skipFired >= 1 ? { ok: true } : { ok: false, why: "skip not fired" },
      ),
    );
    expect(res.ok, res.why).toBe(true);
  });

  it("M11 SETTLED-DEFENSIVE: forced leftover + authFail ⇒ returned(stale), zero sends", async () => {
    const hooks: RefHooks = {
      allowLeftover: true,
      settledPre: (api) => {
        hooks.authFail = true; // only flips AFTER the real run already completed with valid auth
        api.forceHold("H-LEFTOVER");
      },
    };
    const res = await runRefRow({ scripted: [tool("a"), text("done")], hooks }, (_fu, _calls, log, hk) => {
      const st = hk.__api!.st;
      const ok =
        st.outcome.get("H-LEFTOVER") === "returned(stale)" &&
        !st.sendCalls.includes("H-LEFTOVER") &&
        !log.some((l) => l.startsWith("input:H-LEFTOVER"));
      return ok ? { ok: true } : { ok: false, why: `outcome=${st.outcome.get("H-LEFTOVER")}` };
    });
    expect(res.ok, res.why).toBe(true);
  });

  it("M12 Q2: web-held then TUI steer natively ⇒ TUI first (accepted)", async () => {
    const h12: RefHooks & { session?: { prompt: (t: string, o?: unknown) => Promise<void> } } = {};
    h12.tool = (api) => {
      if (!api.st.held.length && !api.st.outcome.size) {
        api.hold("WEB-S1");
        void h12.session!.prompt("TUI-S2", { streamingBehavior: "steer" }).catch(() => undefined);
      }
    };
    const res = await runRefRow(
      { scripted: [tool("a"), text("t2"), text("t3")], hooks: h12 },
      all(once("WEB-S1"), once("TUI-S2"), before("TUI-S2", "WEB-S1")),
    );
    expect(res.ok, res.why).toBe(true);
  });

  it("M13/M13b: confirm await never adds latency; a 50ms downstream handler doesn't push it off the next request", async () => {
    const hooks: RefHooks = {
      tool: (api) => {
        if (!api.st.outcome.size) api.hold("H13B");
      },
      after: [
        (pi) =>
          pi.on("input", async (e: { text: string }) => {
            if (e.text === "H13B") await new Promise((r) => setTimeout(r, 50));
          }),
      ],
    };
    const res = await runRefRow(
      { scripted: [tool("a"), text("done")], hooks },
      all(once("H13B"), firstIn("H13B", 2), (_fu, _c, _l, hk) =>
        hk.__api!.st.confirmTimeouts === 0 ? { ok: true } : { ok: false, why: "confirm timed out" },
      ),
    );
    expect(res.ok, res.why).toBe(true);
  });

  it("M20 two steers one pass: FIFO + one-at-a-time", async () => {
    const hooks: RefHooks = {
      tool: (api) => {
        if (!api.st.outcome.size) {
          api.hold("S-A");
          api.hold("S-B");
        }
      },
    };
    const res = await runRefRow(
      { scripted: [tool("a"), text("x"), text("y"), text("z")], hooks },
      all(once("S-A"), once("S-B"), firstIn("S-A", 2), firstIn("S-B", 3)),
    );
    expect(res.ok, res.why).toBe(true);
  });

  it("M24 slow first / fast second: serialized ⇒ FIFO kept (Y1: B1 unlocked only by consumption)", async () => {
    const hooks: RefHooks = {
      tool: (api) => {
        if (!api.st.outcome.size) {
          api.hold("S1-SLOW");
          api.hold("S2-FAST");
        }
      },
      after: [
        (pi) =>
          pi.on("input", async (e: { text: string }) => {
            if (e.text === "S1-SLOW") await new Promise((r) => setTimeout(r, 400));
          }),
      ],
    };
    const res = await runRefRow(
      {
        scripted: [tool("a", 1, true), tool("b", 1, true), tool("c", 1, true), tool("d"), text("done"), text("x")],
        hooks,
        settleWaitMs: 600,
      },
      all(once("S1-SLOW"), once("S2-FAST"), before("S1-SLOW", "S2-FAST"), (_fu, _c, _l, hk) =>
        hk.__api!.st.blocked >= 1 ? { ok: true } : { ok: false, why: "block rule never engaged" },
      ),
    );
    expect(res.ok, res.why).toBe(true);
  });

  it("M28 swallowing handler ⇒ remaining held returned at run end, never sent", async () => {
    const hooks: RefHooks = { allowLeftover: true };
    hooks.tool = (api) => {
      if (!api.st.outcome.size) {
        api.hold("S1-SWALLOW");
        api.hold("S2");
      }
    };
    hooks.before = [
      (pi) => pi.on("input", (e: { text: string }) => (e.text === "S1-SWALLOW" ? { action: "handled" } : undefined)),
    ];
    const res = await runRefRow(
      { scripted: [tool("a"), tool("b"), text("done"), text("x")], hooks },
      (fu, _c, _l, hk) => {
        const st = hk.__api!.st;
        const ok =
          refHelpers.count(fu, "S1-SWALLOW") === 0 &&
          refHelpers.count(fu, "S2") === 0 &&
          st.sendCalls.join() === "S1-SWALLOW" &&
          st.outcome.get("S2") === "returned(stale)";
        return ok ? { ok: true } : { ok: false, why: `sends=${st.sendCalls} S2=${st.outcome.get("S2")}` };
      },
    );
    expect(res.ok, res.why).toBe(true);
  });
});
