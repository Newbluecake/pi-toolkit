/**
 * web-hub spawn SP4 acceptance (plan v2.1 §SP4 / arch v2 §4.4): the rpc stdio end for a
 * managed `pi --mode rpc` child — LF-only framing with bounded memory, the §4.4 method
 * table, the #9 hard gate (over-limit `extension_ui_request` lines answered from a ≤512-byte
 * head BEFORE `push()` returns), the ask_user marker hold with its three fallbacks, answer
 * dedupe and dispose semantics.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRpcStdio,
  type RpcClearTimeout,
  type RpcSetTimeout,
  type RpcTimerHandle,
} from "../../../../src/web-hub/hub/spawn/rpc-stdio.js";
import { MARKER_HOLD_GRACE_MS, RPC_ASK_USER_TITLE, STDOUT_LINE_MAX } from "../../../../src/web-hub/protocol/spawn.js";

// ---------------------------------------------------------------- harness & builders

interface UiCancelledEvent {
  method: string;
  title?: string;
  at: number;
}

function makeIo(over: Partial<{ holdAllowed(): boolean; now(): number }> & RpcTimerDeps = {}) {
  const writes: string[] = [];
  const uiCancelled: UiCancelledEvent[] = [];
  const protocolErrors: string[] = [];
  const holdAllowed = vi.fn(over.holdAllowed ?? (() => false));
  const deps: Parameters<typeof createRpcStdio>[0] = {
    write: (line) => {
      writes.push(line);
      return true;
    },
    onUiCancelled: (e) => {
      uiCancelled.push(e);
    },
    onProtocolError: (detail) => {
      protocolErrors.push(detail);
    },
    holdAllowed,
    now: over.now ?? (() => 0),
  };
  if (over.setTimeout !== undefined) deps.setTimeout = over.setTimeout;
  if (over.clearTimeout !== undefined) deps.clearTimeout = over.clearTimeout;
  const io = createRpcStdio(deps);
  return { io, writes, uiCancelled, protocolErrors, holdAllowed };
}

interface RpcTimerDeps {
  setTimeout?: RpcSetTimeout;
  clearTimeout?: RpcClearTimeout;
}

function line(obj: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(obj)}\n`, "utf8");
}

/** Field order is protocol-relevant: `type`, `id`, `method`, then `title` (assumption V1). */
function uiReq(id: string, method: string, rest: Record<string, unknown> = {}): Buffer {
  const obj: Record<string, unknown> = { type: "extension_ui_request", id, method };
  for (const [k, v] of Object.entries(rest)) obj[k] = v;
  return line(obj);
}

function markerLine(id: string): Buffer {
  return uiReq(id, "select", { title: RPC_ASK_USER_TITLE, options: ["a", "b"] });
}

function cancelledFrame(id: string): string {
  return `${JSON.stringify({ type: "extension_ui_response", id, cancelled: true })}\n`;
}

/** A >STDOUT_LINE_MAX ui_request line whose head (≤512 bytes) carries id/method/title. */
function hugeUiLine(id: string, method: string, bigKey: string, title: string, size = 1024 * 1024): Buffer {
  const head = `{"type":"extension_ui_request","id":"${id}","method":"${method}","title":${JSON.stringify(title)},"${bigKey}":"`;
  const tail = '"}\n';
  const pad = "x".repeat(Math.max(0, size - head.length - tail.length));
  return Buffer.from(head + pad + tail, "utf8");
}

function hugeMarkerLine(id: string): Buffer {
  return hugeUiLine(id, "select", "options", RPC_ASK_USER_TITLE);
}

/** Deterministic injected timer pair (the deps exist precisely so no fake-timer magic is
 * needed): `advance` fires due timers in deadline order, letting re-arms settle correctly. */
function manualTimers() {
  const timers = new Map<number, { fn: () => void; at: number }>();
  let nextHandle = 1;
  let t = 0;
  const setTimeoutFn: RpcSetTimeout = (fn, ms) => {
    const id = nextHandle++;
    timers.set(id, { fn, at: t + ms });
    return { id, unref() {} } as unknown as RpcTimerHandle;
  };
  const clearTimeoutFn: RpcClearTimeout = (h) => {
    timers.delete((h as unknown as { id: number }).id);
  };
  return {
    now: () => t,
    pending: () => timers.size,
    setTimeout: setTimeoutFn,
    clearTimeout: clearTimeoutFn,
    advance(ms: number): void {
      const target = t + ms;
      for (;;) {
        let dueId: number | undefined;
        let dueAt = Infinity;
        for (const [id, tm] of timers) {
          if (tm.at <= target && tm.at < dueAt) {
            dueId = id;
            dueAt = tm.at;
          }
        }
        if (dueId === undefined) break;
        const tm = timers.get(dueId);
        if (tm === undefined) break;
        timers.delete(dueId);
        t = tm.at;
        tm.fn();
      }
      t = target;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------- framing

describe("createRpcStdio — line framing", () => {
  it("processes one dialog line delivered across 3 chunks (mid-prefix and mid-id splits)", () => {
    const h = makeIo();
    const buf = uiReq("sel-1", "select", { title: "pick one", options: ["a", "b"] });
    h.io.push(buf.subarray(0, 7)); // inside the prefix
    h.io.push(buf.subarray(7, 40)); // inside the id
    h.io.push(buf.subarray(40));
    expect(h.writes).toEqual([cancelledFrame("sel-1")]);
    expect(h.uiCancelled).toEqual([{ method: "select", title: "pick one", at: 0 }]);
  });

  it("processes 5 lines arriving in one chunk, in order", () => {
    const h = makeIo();
    h.io.push(
      Buffer.concat([
        uiReq("l1", "select", { title: "t1" }),
        uiReq("l2", "confirm", { title: "t2" }),
        uiReq("l3", "input", { title: "t3" }),
        uiReq("l4", "editor", { title: "t4" }),
        uiReq("l5", "select", { title: "t5" }),
      ]),
    );
    expect(h.writes).toEqual([
      cancelledFrame("l1"),
      cancelledFrame("l2"),
      cancelledFrame("l3"),
      cancelledFrame("l4"),
      cancelledFrame("l5"),
    ]);
    expect(h.uiCancelled.map((e) => e.method)).toEqual(["select", "confirm", "input", "editor", "select"]);
  });

  it("ordinary event lines never reach JSON.parse", () => {
    const h = makeIo();
    const parseSpy = vi.spyOn(JSON, "parse");
    try {
      h.io.push(line({ type: "agent_event", data: "x".repeat(300) }));
      h.io.push(Buffer.from('{"type":"resp')); // partial non-ui line, no newline yet
      expect(h.writes).toEqual([]);
      expect(h.uiCancelled).toEqual([]);
      expect(parseSpy).not.toHaveBeenCalled();
    } finally {
      parseSpy.mockRestore();
    }
  });

  it("stats() exposes the buffered partial line", () => {
    const h = makeIo();
    h.io.push(Buffer.from('{"type":"exte')); // 13 undecided head bytes
    const s = h.io.stats();
    expect(s.bufferedBytes).toBe(13);
    expect(s.answered).toBe(0);
    expect(s.held).toBe(0);
  });
});

// ---------------------------------------------------------------- memory bounds

describe("createRpcStdio — memory bounds (#9)", () => {
  it("a 1 MiB no-newline ordinary line never grows the buffer past the cap; the next line parses", () => {
    const h = makeIo();
    const flood = Buffer.alloc(1024 * 1024, 0x78); // "x"
    h.io.push(flood);
    expect(h.io.stats().bufferedBytes).toBeLessThanOrEqual(STDOUT_LINE_MAX);
    h.io.push(flood); // second MiB — still no growth
    expect(h.io.stats().bufferedBytes).toBeLessThanOrEqual(STDOUT_LINE_MAX);
    h.io.push(Buffer.from("\n")); // terminate the giant ordinary line — it is dropped whole
    h.io.push(uiReq("after-flood", "confirm", { title: "ok" }));
    expect(h.writes).toEqual([cancelledFrame("after-flood")]);
  });

  it("a line at exactly STDOUT_LINE_MAX parses whole; one byte more goes the head route", () => {
    const h = makeIo();
    const head = '{"type":"extension_ui_request","id":"cap-1","method":"confirm","title":"';
    const tail = '"}\n';
    const titleLen = STDOUT_LINE_MAX - head.length - (tail.length - 1); // line bytes without LF
    const atCap = Buffer.from(`${head}${"t".repeat(titleLen)}${tail}`, "utf8");
    expect(atCap.length).toBe(STDOUT_LINE_MAX + 1); // + LF
    h.io.push(atCap);
    expect(h.writes).toEqual([cancelledFrame("cap-1")]);
    expect(h.uiCancelled[0]?.method).toBe("confirm");
    expect(h.protocolErrors).toEqual([]);

    // one byte over the cap: the head route answers from ≤512 bytes, never buffering the rest
    const over = Buffer.from(
      `{"type":"extension_ui_request","id":"cap-2","method":"confirm","title":"${"t".repeat(titleLen + 1)}"}\n`,
      "utf8",
    );
    h.io.push(over);
    expect(h.writes).toEqual([cancelledFrame("cap-1"), cancelledFrame("cap-2")]);
    expect(h.protocolErrors).toEqual([]);
    expect(h.io.stats().bufferedBytes).toBeLessThanOrEqual(STDOUT_LINE_MAX);
  });
});

// ---------------------------------------------------------------- method table

describe("createRpcStdio — §4.4 method table", () => {
  it("the 5 fire-and-forget methods are never answered", () => {
    const h = makeIo();
    h.io.push(
      Buffer.concat([
        uiReq("n1", "notify", { message: "m" }),
        uiReq("n2", "setStatus", { statusKey: "k", statusText: "t" }),
        uiReq("n3", "setWidget", { widgetKey: "k" }),
        uiReq("n4", "setTitle", { title: "t" }),
        uiReq("n5", "set_editor_text", { text: "t" }),
      ]),
    );
    expect(h.writes).toEqual([]);
    expect(h.uiCancelled).toEqual([]);
  });

  it("unknown and missing methods are answered cancelled (plan SP4: 未知 method 一律 cancelled)", () => {
    const h = makeIo();
    h.io.push(uiReq("u1", "datePicker", { title: "t" }));
    h.io.push(Buffer.from('{"type":"extension_ui_request","id":"u2","title":"t2"}\n'));
    expect(h.writes).toEqual([cancelledFrame("u1"), cancelledFrame("u2")]);
    expect(h.uiCancelled.map((e) => e.method)).toEqual(["datePicker", "unknown"]);
  });

  it("records uiCancelled with the title capped at 120 chars, or without a title key", () => {
    const h = makeIo();
    h.io.push(uiReq("c1", "confirm", { title: "t".repeat(500) }));
    expect(h.uiCancelled[0]?.title?.length).toBe(120);
    h.io.push(Buffer.from('{"type":"extension_ui_request","id":"c2","method":"input"}\n'));
    expect("title" in (h.uiCancelled[1] as UiCancelledEvent)).toBe(false);
  });

  it("a parse-broken line whose head still carries an id is rescued via the bounded regex", () => {
    const h = makeIo();
    h.io.push(Buffer.from('{"type":"extension_ui_request","id":"rescue-1","method":"confirm","title":"t",}\n'));
    // trailing comma → JSON.parse throws → head regex rescues id/method/title
    expect(h.writes).toEqual([cancelledFrame("rescue-1")]);
    expect(h.uiCancelled[0]?.method).toBe("confirm");
    expect(h.protocolErrors).toEqual([]);
  });

  it("a ui line whose head carries no extractable id is a latched protocol error", () => {
    const h = makeIo();
    const pad = "x".repeat(100 * 1024); // head truncated at 512 bytes, id never inside it
    h.io.push(Buffer.from(`{"type":"extension_ui_request","payload":"${pad}"}\n`));
    expect(h.protocolErrors).toEqual(["ui-request-head"]);
    expect(h.writes).toEqual([]);
    h.io.push(Buffer.from('{"type":"extension_ui_request","id":12345,"method":"select"}\n')); // non-string id
    expect(h.protocolErrors).toEqual(["ui-request-head"]); // latched — still exactly one report
    h.io.push(Buffer.from('{"type":"extension_ui_request"}\n')); // valid JSON, no id at all
    expect(h.protocolErrors.length).toBe(1);
    expect(h.io.stats().protocolErrors).toBe(1);
  });
});

// ---------------------------------------------------------------- over-limit hard gate

describe("createRpcStdio — over-limit lines (#9 hard gate)", () => {
  it.each([
    ["select", "options"],
    ["confirm", "message"],
    ["editor", "prefill"],
  ] as const)("1 MiB %s is answered cancelled before push() returns, id intact", (method, bigKey) => {
    const h = makeIo();
    const id = `big-${method}`;
    h.io.push(hugeUiLine(id, method, bigKey, "t"));
    expect(h.writes).toEqual([cancelledFrame(id)]);
    expect(h.uiCancelled).toEqual([{ method, title: "t", at: 0 }]);
    expect(h.io.stats().bufferedBytes).toBeLessThanOrEqual(STDOUT_LINE_MAX);
    expect(h.protocolErrors).toEqual([]);
  });

  it("a 1 MiB marker select is answered immediately when hold is not allowed", () => {
    const h = makeIo({ holdAllowed: () => false });
    h.io.push(hugeMarkerLine("big-marker"));
    expect(h.writes).toEqual([cancelledFrame("big-marker")]);
    expect(h.holdAllowed).toHaveBeenCalledTimes(1);
    expect(h.uiCancelled).toEqual([]); // the marker is never recorded (arch §4.4 table)
  });

  it("a 1 MiB marker select with hold allowed is held, not answered", () => {
    const tm = manualTimers();
    const h = makeIo({
      holdAllowed: () => true,
      now: tm.now,
      setTimeout: tm.setTimeout,
      clearTimeout: tm.clearTimeout,
    });
    h.io.push(hugeMarkerLine("big-marker"));
    expect(h.writes).toEqual([]);
    expect(h.io.stats().held).toBe(1);
    expect(h.io.stats().bufferedBytes).toBeLessThanOrEqual(STDOUT_LINE_MAX);
  });

  it("resets drop mode at the newline: an over-limit line followed by a normal line in one chunk", () => {
    const h = makeIo();
    const huge = hugeUiLine("big-a", "select", "options", "t"); // LF-terminated 1 MiB line
    h.io.push(Buffer.concat([huge, uiReq("next", "confirm", { title: "t" })]));
    expect(h.writes).toEqual([cancelledFrame("big-a"), cancelledFrame("next")]);
  });
});

// ---------------------------------------------------------------- marker hold & fallbacks

describe("createRpcStdio — marker hold fallbacks (arch §4.4)", () => {
  it("(a) no open dialog within the grace cancels the marker — never recorded as uiCancelled", () => {
    const tm = manualTimers();
    const h = makeIo({
      holdAllowed: () => true,
      now: tm.now,
      setTimeout: tm.setTimeout,
      clearTimeout: tm.clearTimeout,
    });
    h.io.push(markerLine("m1"));
    expect(h.writes).toEqual([]);
    expect(tm.pending()).toBe(1);
    tm.advance(MARKER_HOLD_GRACE_MS - 1);
    expect(h.writes).toEqual([]);
    tm.advance(1);
    expect(h.writes).toEqual([cancelledFrame("m1")]);
    expect(h.io.stats().held).toBe(0);
    expect(h.uiCancelled).toEqual([]);
  });

  it("(a) satisfied by a dialog opening within the grace; (c) fires 5s after the slot clears", () => {
    const tm = manualTimers();
    const h = makeIo({
      holdAllowed: () => true,
      now: tm.now,
      setTimeout: tm.setTimeout,
      clearTimeout: tm.clearTimeout,
    });
    h.io.push(markerLine("m2"));
    tm.advance(2_000);
    h.io.onSlot(1, true); // dialog opened within the grace
    tm.advance(10_000); // slot stays open — no fallback armed
    expect(h.writes).toEqual([]);
    h.io.onSlot(0, true); // cleared → (c) armed
    tm.advance(MARKER_HOLD_GRACE_MS - 1);
    expect(h.writes).toEqual([]);
    tm.advance(1);
    expect(h.writes).toEqual([cancelledFrame("m2")]);
  });

  it("(b) unlinked for 5s cancels; a link flap within the grace does not", () => {
    const tm = manualTimers();
    const h = makeIo({
      holdAllowed: () => true,
      now: tm.now,
      setTimeout: tm.setTimeout,
      clearTimeout: tm.clearTimeout,
    });
    h.io.push(markerLine("m3"));
    tm.advance(100);
    h.io.onSlot(1, true); // disarm (a)
    tm.advance(100);
    h.io.onSlot(1, false); // arm (b) at t=200
    tm.advance(1_000);
    h.io.onSlot(1, true); // relinked within the grace → disarm (b)
    tm.advance(60_000);
    expect(h.writes).toEqual([]); // still held
    h.io.onSlot(1, false); // a real outage
    tm.advance(MARKER_HOLD_GRACE_MS - 1);
    expect(h.writes).toEqual([]);
    tm.advance(1);
    expect(h.writes).toEqual([cancelledFrame("m3")]);
  });

  it("skips (a) when a dialog is already open at hold time (dialogs event raced ahead)", () => {
    const tm = manualTimers();
    const h = makeIo({
      holdAllowed: () => true,
      now: tm.now,
      setTimeout: tm.setTimeout,
      clearTimeout: tm.clearTimeout,
    });
    h.io.onSlot(1, true);
    h.io.push(markerLine("m4"));
    tm.advance(MARKER_HOLD_GRACE_MS + 5_000);
    expect(h.writes).toEqual([]); // (a) never armed
    h.io.onSlot(0, true); // cleared → (c)
    tm.advance(MARKER_HOLD_GRACE_MS);
    expect(h.writes).toEqual([cancelledFrame("m4")]);
  });

  it("answers any id at most once — duplicate lines while held, after the fallback, and for dialogs", () => {
    const tm = manualTimers();
    const h = makeIo({
      holdAllowed: () => true,
      now: tm.now,
      setTimeout: tm.setTimeout,
      clearTimeout: tm.clearTimeout,
    });
    h.io.push(markerLine("m5"));
    h.io.push(markerLine("m5")); // duplicate while held — one item only
    expect(h.io.stats().held).toBe(1);
    tm.advance(MARKER_HOLD_GRACE_MS);
    expect(h.writes).toEqual([cancelledFrame("m5")]);
    h.io.push(markerLine("m5")); // same id again after it was answered
    expect(h.writes).toEqual([cancelledFrame("m5")]);
    h.io.push(uiReq("d1", "confirm", { title: "t" }));
    h.io.push(uiReq("d1", "confirm", { title: "t" }));
    expect(h.writes).toEqual([cancelledFrame("m5"), cancelledFrame("d1")]);
    expect(h.uiCancelled.filter((e) => e.method === "confirm").length).toBe(1);
  });

  it("one timer per held item; slot events re-arm both without leaking handles", () => {
    const tm = manualTimers();
    const h = makeIo({
      holdAllowed: () => true,
      now: tm.now,
      setTimeout: tm.setTimeout,
      clearTimeout: tm.clearTimeout,
    });
    h.io.push(markerLine("m6"));
    h.io.push(markerLine("m7"));
    expect(tm.pending()).toBe(2); // armed (a) at hold
    tm.advance(500);
    h.io.onSlot(1, true); // disarm (a) → both timers cleared
    expect(tm.pending()).toBe(0);
    h.io.onSlot(0, true); // (c) armed
    expect(tm.pending()).toBe(2);
    tm.advance(MARKER_HOLD_GRACE_MS);
    expect(h.writes).toEqual([cancelledFrame("m6"), cancelledFrame("m7")]); // deadline order
    expect(tm.pending()).toBe(0);
  });

  it("hold timers are unref'd (never keep the hub's event loop alive)", () => {
    const realSetTimeout = globalThis.setTimeout;
    const captured: NodeJS.Timeout[] = [];
    vi.stubGlobal("setTimeout", ((fn: () => void, ms: number) => {
      const t = realSetTimeout(fn, ms);
      captured.push(t);
      return t;
    }) as typeof setTimeout);
    const h = makeIo({ holdAllowed: () => true });
    try {
      h.io.push(markerLine("u1"));
    } finally {
      vi.unstubAllGlobals();
    }
    expect(captured.length).toBe(1);
    expect(captured[0]?.hasRef?.()).toBe(false);
    h.io.dispose();
  });

  it("works with the default timer pair under fake timers", () => {
    vi.useFakeTimers();
    const clock = { t: 0 };
    const h = makeIo({ holdAllowed: () => true, now: () => clock.t });
    h.io.push(markerLine("f1"));
    expect(h.writes).toEqual([]);
    clock.t = MARKER_HOLD_GRACE_MS;
    vi.advanceTimersByTime(MARKER_HOLD_GRACE_MS);
    expect(h.writes).toEqual([cancelledFrame("f1")]);
  });

  it("holds a marker delivered across 3 chunks (framing × hold)", () => {
    const tm = manualTimers();
    const h = makeIo({
      holdAllowed: () => true,
      now: tm.now,
      setTimeout: tm.setTimeout,
      clearTimeout: tm.clearTimeout,
    });
    const buf = markerLine("split-1");
    h.io.push(buf.subarray(0, 10));
    h.io.push(buf.subarray(10, 30)); // crosses the prefix boundary
    h.io.push(buf.subarray(30));
    expect(h.io.stats().held).toBe(1);
    tm.advance(MARKER_HOLD_GRACE_MS);
    expect(h.writes).toEqual([cancelledFrame("split-1")]);
  });
});

// ---------------------------------------------------------------- dispose

describe("createRpcStdio — dispose", () => {
  it("clears every hold timer, freezes writes, and is idempotent", () => {
    const tm = manualTimers();
    const h = makeIo({
      holdAllowed: () => true,
      now: tm.now,
      setTimeout: tm.setTimeout,
      clearTimeout: tm.clearTimeout,
    });
    h.io.push(markerLine("x1"));
    h.io.push(markerLine("x2"));
    h.io.dispose();
    expect(tm.pending()).toBe(0);
    expect(h.io.stats().held).toBe(0);
    tm.advance(60_000);
    expect(h.writes).toEqual([]); // fallback never fires after dispose
    h.io.push(uiReq("after", "confirm", { title: "t" }));
    h.io.onSlot(0, false);
    expect(h.writes).toEqual([]);
    expect(h.uiCancelled).toEqual([]);
    h.io.dispose(); // idempotent
    expect(h.io.stats().bufferedBytes).toBe(0);
  });
});
