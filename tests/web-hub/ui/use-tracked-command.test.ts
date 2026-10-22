// @vitest-environment happy-dom
/** alias-plan r4 §7.1 / §9 ALU: useTrackedCommand — own-cmdId tracking to the final output. */
import { ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  commandOutputText,
  useTrackedCommand,
  type TrackedCommandResult,
  type TrackedCommandView,
} from "../../../src/web-hub/ui/src/composables/useTrackedCommand.js";
import type { CmdOutcome, ControlHandle } from "../../../src/web-hub/ui/src/types.js";

interface Call {
  agentKey: string;
  name: string;
  args: string;
  opts?: { confirm?: true; id?: string };
}

interface Harness {
  view(): TrackedCommandView | null;
  calls: Call[];
  queries: Array<{ agentKey: string; id: string }>;
  pendingCtl: ReturnType<typeof ref<readonly unknown[]>>;
  agentKey: ReturnType<typeof ref<string>>;
  /** Queue of outcomes the next runCommand calls settle with; default sync ok. */
  runImpl: (call: Call) => Promise<CmdOutcome>;
  queryImpl: (id: string) => Promise<CmdOutcome>;
  setRun(fn: (call: Call) => Promise<CmdOutcome>): void;
  setQuery(fn: (id: string) => Promise<CmdOutcome>): void;
}

function harness(): Harness {
  const calls: Call[] = [];
  const queries: Array<{ agentKey: string; id: string }> = [];
  const pendingCtl = ref<readonly unknown[]>([]);
  const agentKey = ref("k1");
  let runImpl: Harness["runImpl"] = () => Promise.resolve({ ok: true, data: { completion: "sync", output: null } });
  let queryImpl: Harness["queryImpl"] = () => Promise.resolve({ ok: false, error: "E_UNKNOWN_ID" });
  const control = {
    runCommand: (k: string, name: string, args: string, opts?: { confirm?: true; id?: string }) => {
      const call: Call = { agentKey: k, name, args, ...(opts === undefined ? {} : { opts }) };
      calls.push(call);
      return runImpl(call);
    },
    query: (k: string, id: string) => {
      queries.push({ agentKey: k, id });
      return queryImpl(id);
    },
  } as unknown as ControlHandle;
  return {
    calls,
    queries,
    pendingCtl,
    agentKey,
    get runImpl() {
      return runImpl;
    },
    get queryImpl() {
      return queryImpl;
    },
    setRun(fn) {
      runImpl = fn;
    },
    setQuery(fn) {
      queryImpl = fn;
    },
    view: () => ({ control, agentKey: agentKey.value, pendingCtl: pendingCtl.value }),
  };
}

const out = (text: string) => ({ entries: [{ kind: "text", text }] });
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe("commandOutputText", () => {
  it("flattens entries' text, tolerates junk", () => {
    expect(commandOutputText(out("a"))).toBe("a");
    expect(
      commandOutputText({
        entries: [
          { kind: "text", text: "a" },
          { kind: "error", text: "b" },
        ],
      }),
    ).toBe("a\nb");
    expect(commandOutputText(null)).toBe("");
    expect(commandOutputText({})).toBe("");
    expect(commandOutputText({ entries: [{ kind: "widget" }, "x"] })).toBe("");
  });
});

describe("useTrackedCommand", () => {
  it("sync completion resolves with this cmdId's captured output text", async () => {
    const h = harness();
    h.setRun(() => Promise.resolve({ ok: true, data: { completion: "sync", output: out("别名已设置：web") } }));
    const t = useTrackedCommand({ view: h.view });
    const r = await t.run("fabric", "alias web");
    expect(r).toEqual({ ok: true, output: "别名已设置：web" });
    expect(h.calls).toHaveLength(1);
    expect(typeof h.calls[0]!.opts?.id).toBe("string");
    expect(h.queries).toHaveLength(0);
    expect(t.phase.value).toBe("idle");
  });

  it("async: pendingCtl item disappears ⇒ exactly ONE queryOnly, unwraps result.data.output", async () => {
    const h = harness();
    h.setRun((call) => {
      // the optimistic item lands synchronously (the real control's ctl_send does this)
      h.pendingCtl.value = [{ id: call.opts?.id, kind: "command", name: call.name, state: "sending" }];
      return Promise.resolve({ ok: true, data: { completion: "async", captured: true } });
    });
    h.setQuery(() =>
      Promise.resolve({ ok: true, data: { result: { ok: true, data: { captured: true, output: out("LATE") } } } }),
    );
    const t = useTrackedCommand({ view: h.view });
    const p = t.run("fabric", "alias web");
    await vi.waitFor(() => expect(t.phase.value).toBe("running"));
    expect(h.queries).toHaveLength(0); // still in flight
    h.pendingCtl.value = []; // cmd_late settled it
    const r = await p;
    expect(r).toEqual({ ok: true, output: "LATE" });
    expect(h.queries).toEqual([{ agentKey: "k1", id: h.calls[0]!.opts?.id }]);
  });

  it("async item turning failed/notExecuted fails the run from the item, no query", async () => {
    const h = harness();
    h.setRun((call) => {
      h.pendingCtl.value = [{ id: call.opts?.id, kind: "command", name: call.name, state: "sending" }];
      return Promise.resolve({ ok: true, data: { completion: "unknown" } });
    });
    const t = useTrackedCommand({ view: h.view });
    const p = t.run("fabric", "alias web");
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    h.pendingCtl.value = [
      { id: h.calls[0]!.opts?.id, kind: "command", name: "fabric", state: "failed", error: "E_DENIED", message: "no" },
    ];
    const r = await p;
    expect(r).toEqual({ ok: false, error: "E_DENIED", message: "no" });
    expect(h.queries).toHaveLength(0);
  });

  it("E_CONFIRM_REQUIRED ⇒ confirm phase; confirm() re-sends with a NEW id + confirm:true", async () => {
    const h = harness();
    let n = 0;
    h.setRun(() => {
      n++;
      return n === 1
        ? Promise.resolve({ ok: false, error: "E_CONFIRM_REQUIRED", message: "policy" })
        : Promise.resolve({ ok: true, data: { completion: "sync", output: out("OK") } });
    });
    const t = useTrackedCommand({ view: h.view });
    const p = t.run("fabric", "alias web");
    await vi.waitFor(() => expect(t.phase.value).toBe("confirm"));
    expect(t.confirmReq.value).toEqual({ name: "fabric", args: "alias web" });
    t.confirm();
    const r = await p;
    expect(r).toEqual({ ok: true, output: "OK" });
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.opts?.confirm).toBe(true);
    expect(h.calls[1]!.opts?.id).not.toBe(h.calls[0]!.opts?.id);
  });

  it("cancel() during the policy confirm settles cancelled, never re-sends", async () => {
    const h = harness();
    h.setRun(() => Promise.resolve({ ok: false, error: "E_CONFIRM_REQUIRED" }));
    const t = useTrackedCommand({ view: h.view });
    const p = t.run("fabric", "alias --clear");
    await vi.waitFor(() => expect(t.phase.value).toBe("confirm"));
    t.cancel();
    expect(await p).toEqual({ ok: false, cancelled: true });
    expect(h.calls).toHaveLength(1);
    expect(t.phase.value).toBe("idle");
  });

  it("cancel() mid-async drops the late settle: no queryOnly, promise resolves cancelled", async () => {
    const h = harness();
    h.setRun((call) => {
      h.pendingCtl.value = [{ id: call.opts?.id, kind: "command", name: call.name, state: "sending" }];
      return Promise.resolve({ ok: true, data: { completion: "async" } });
    });
    const t = useTrackedCommand({ view: h.view });
    const p = t.run("fabric", "alias web");
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    t.cancel();
    const r = await p;
    expect(r).toEqual({ ok: false, cancelled: true });
    h.pendingCtl.value = []; // late settle arrives afterwards
    await flush();
    expect(h.queries).toHaveLength(0);
  });

  it("agentKey change mid-flight cancels and drops late results", async () => {
    const h = harness();
    h.setRun((call) => {
      h.pendingCtl.value = [{ id: call.opts?.id, kind: "command", name: call.name, state: "sending" }];
      return Promise.resolve({ ok: true, data: { completion: "async" } });
    });
    const t = useTrackedCommand({ view: h.view });
    const p = t.run("fabric", "alias web");
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    h.agentKey.value = "k2"; // session switch under a still-mounted dialog
    const r = await p;
    expect(r).toEqual({ ok: false, cancelled: true });
    h.pendingCtl.value = [];
    await flush();
    expect(h.queries).toHaveLength(0);
  });

  it("15s timeout settles E_TIMEOUT and ignores the late outcome", async () => {
    vi.useFakeTimers();
    const h = harness();
    let release: (o: CmdOutcome) => void = () => {};
    h.setRun(() => new Promise<CmdOutcome>((r) => (release = r)));
    const t = useTrackedCommand({ view: h.view, timeoutMs: 15_000 });
    const p = t.run("fabric", "alias web");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await p).toMatchObject({ ok: false, error: "E_TIMEOUT" });
    release({ ok: true, data: { completion: "sync", output: out("late") } });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.phase.value).toBe("idle");
  });

  it("user think time is not on the clock; the confirm re-send arms a fresh budget", async () => {
    vi.useFakeTimers();
    const h = harness();
    let n = 0;
    h.setRun(() => {
      n++;
      return n === 1 ? Promise.resolve({ ok: false, error: "E_CONFIRM_REQUIRED" }) : new Promise<CmdOutcome>(() => {}); // the re-sent command never settles on its own
    });
    const t = useTrackedCommand({ view: h.view, timeoutMs: 15_000 });
    const p = t.run("fabric", "alias web");
    await vi.advanceTimersByTimeAsync(60_000); // user thinks for a minute
    expect(t.phase.value).toBe("confirm");
    t.confirm();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(t.phase.value).toBe("running"); // fresh budget not yet exhausted
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toMatchObject({ ok: false, error: "E_TIMEOUT" });
  });

  it("a second run() supersedes the first (one logical operation at a time)", async () => {
    const h = harness();
    h.setRun((call) => {
      if (call.args === "alias a")
        h.pendingCtl.value = [{ id: call.opts?.id, kind: "command", name: call.name, state: "sending" }];
      return Promise.resolve(
        call.args === "alias a"
          ? { ok: true, data: { completion: "async" } }
          : { ok: true, data: { completion: "sync", output: out("B") } },
      );
    });
    const t = useTrackedCommand({ view: h.view });
    const p1 = t.run("fabric", "alias a");
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    const p2 = t.run("fabric", "alias b");
    expect(await p1).toEqual({ ok: false, cancelled: true });
    expect(await p2).toEqual({ ok: true, output: "B" });
  });

  it("no control channel ⇒ E_UNAVAILABLE without touching the wire", async () => {
    const h = harness();
    const t = useTrackedCommand({ view: () => null });
    const r: TrackedCommandResult = await t.run("fabric", "alias web");
    expect(r).toMatchObject({ ok: false, error: "E_UNAVAILABLE" });
    expect(h.calls).toHaveLength(0);
  });
});
