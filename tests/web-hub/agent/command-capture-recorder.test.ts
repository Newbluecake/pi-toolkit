/**
 * web-hub-cmd-history plan §4.4 (A1) — `wrapCommandApi`'s recorder integration:
 * observe mode (TUI capture, five zero-display-difference contracts), claimed-mode tee,
 * session-leave interception, and the byte-identical passthrough when no recorder is wired.
 */
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { wrapCommandApi, type CommandCapturePort } from "../../../src/commands/capture.js";
import type { CommandRecorder, RecordHandle } from "../../../src/web-hub/agent/command-record.js";
import type { CmdRecordData } from "../../../src/web-hub/protocol/cmd-record.js";

// ------------------------------------------------------------------ fakes

type RegisterSpy = ReturnType<typeof makeRegisterSpy>;
function makeRegisterSpy() {
  return vi.fn((_name: string, _command: Omit<RegisteredCommand, "name" | "sourceInfo">) => "registered");
}

function spyApiClean(): { api: ExtensionAPI; registerSpy: RegisterSpy } {
  const registerSpy = makeRegisterSpy();
  return { api: { registerCommand: registerSpy as never } as unknown as ExtensionAPI, registerSpy };
}

/** Registers through the proxy and returns the wrapped handler pi actually stores. */
function registerAndGetHandler(
  pi: ExtensionAPI,
  registerSpy: RegisterSpy,
  handler: (args: string, ctx: ExtensionCommandContext) => unknown,
  name = "mycmd",
): (args: string, ctx: ExtensionCommandContext) => Promise<unknown> {
  pi.registerCommand(name, { handler } as unknown as Omit<RegisteredCommand, "name" | "sourceInfo">);
  const calls = (registerSpy as unknown as { mock: { calls: Array<[string, { handler: unknown }]> } }).mock.calls;
  return calls[calls.length - 1]![1].handler as never;
}

/** Configurable fake recorder: every handle's sinks/settles land in inspectable buckets. */
interface FakeRecorderHandle {
  handle: RecordHandle;
  sinks: Array<Record<string, unknown>>;
  events: string[]; // commit:<kind> / cancelled:<msg> / settle:<state>
}
function fakeRecorder(policy = "record"): {
  recorder: CommandRecorder;
  handles: FakeRecorderHandle[];
  begins: Array<{ name: string; args: string; claimed?: { cmdId: string; source: string } }>;
  immediate: Array<Record<string, unknown>>;
  setPolicy(p: string): void;
  setBegin(
    impl: (i: { name: string; args: string; claimed?: { cmdId: string; source: string } }) => RecordHandle | undefined,
  ): void;
} {
  const handles: FakeRecorderHandle[] = [];
  const begins: Array<{ name: string; args: string; claimed?: { cmdId: string; source: string } }> = [];
  const immediate: Array<Record<string, unknown>> = [];
  let currentPolicy = policy;
  let beginImpl:
    | ((i: { name: string; args: string; claimed?: { cmdId: string; source: string } }) => RecordHandle | undefined)
    | undefined;
  const recorder: CommandRecorder = {
    policyFor: () => currentPolicy as "record",
    noteIntent: () => undefined,
    begin(i) {
      begins.push({ name: i.name, args: i.args, claimed: i.claimed });
      if (beginImpl !== undefined) return beginImpl(i);
      if (currentPolicy === "skip") return undefined; // the real recorder returns no handle
      const sinks: Array<Record<string, unknown>> = [];
      const events: string[] = [];
      const h: FakeRecorderHandle = {
        handle: {
          cmdId: i.claimed?.cmdId ?? `c-local-${handles.length + 1}`,
          sink: (e) => sinks.push(e as unknown as Record<string, unknown>),
          commitBeforeLeave: (kind) => events.push(`commit:${kind}`),
          afterLeaveCancelled: (error) => events.push(`cancelled:${error ?? ""}`),
          settle: (o) => events.push(o.error !== undefined || o.failed !== undefined ? "settle:failed" : "settle:done"),
        },
        sinks,
        events,
      };
      handles.push(h);
      return h.handle;
    },
    beginExternal: () => undefined,
    recordImmediate: (r) => immediate.push(r as unknown as Record<string, unknown>),
    running: () => [],
    counters: () => ({ appended: 0, skipped: 0, failed: 0 }),
    dispose: () => undefined,
  };
  return {
    recorder,
    handles,
    begins,
    immediate,
    setPolicy: (p) => (currentPolicy = p),
    setBegin: (impl) => (beginImpl = impl),
  };
}

/** A terminal-shaped UI recording every call; editor returns ONE stable promise object. */
function realUi() {
  const editorPromise = Promise.resolve("edited-text");
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const push =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return `${method}-ret`;
    };
  const ui = {
    calls,
    theme: { fg: (_c: string, t: string) => t },
    notify: push("notify"),
    setWidget: push("setWidget"),
    setStatus: push("setStatus"),
    editor(...args: unknown[]) {
      calls.push({ method: "editor", args });
      return editorPromise;
    },
    select: push("select"),
    input: push("input"),
    confirm: push("confirm"),
    custom: push("custom"),
    setEditorText: push("setEditorText"),
    pasteToEditor: push("pasteToEditor"),
    setTitle: push("setTitle"),
  };
  return { ui, editorPromise };
}

function makeCtx() {
  const { ui, editorPromise } = realUi();
  let newSessionImpl: (...a: unknown[]) => Promise<{ cancelled?: boolean }> = async () => ({});
  const ctx = {
    mode: "tui",
    cwd: "/tmp",
    ui,
    newSession: (...a: unknown[]) => newSessionImpl(...a),
    fork: async () => ({}),
    switchSession: async (_p: string) => ({}),
    reload: async () => undefined,
  };
  return {
    ctx: ctx as unknown as ExtensionCommandContext,
    ui,
    editorPromise,
    setNewSession(impl: (...a: unknown[]) => Promise<{ cancelled?: boolean }>) {
      newSessionImpl = impl;
    },
  };
}

const noCapture: CommandCapturePort = { arm: () => undefined, take: () => undefined, finish: vi.fn() };

// ------------------------------------------------------------------ tests

describe("wrapCommandApi — recorder not wired ⇒ byte-identical passthrough", () => {
  it("no recorder, no capture claim ⇒ handler receives the RAW ctx object", async () => {
    const { api, registerSpy } = spyApiClean();
    const pi = wrapCommandApi(api, () => noCapture);
    const seen: unknown[] = [];
    const handler = registerAndGetHandler(pi, registerSpy, async (_a, c) => {
      seen.push(c);
      return "ok";
    });
    const { ctx } = makeCtx();
    expect(await handler("x", ctx)).toBe("ok");
    expect(seen[0]).toBe(ctx); // identical reference — no observe proxy at all
  });

  it("recorder wired but begin ⇒ undefined (skip policy) ⇒ handler receives the RAW ctx", async () => {
    const { api, registerSpy } = spyApiClean();
    const { recorder } = fakeRecorder("skip");
    const pi = wrapCommandApi(
      api,
      () => noCapture,
      undefined,
      undefined,
      () => recorder,
    );
    const seen: unknown[] = [];
    const handler = registerAndGetHandler(pi, registerSpy, async (_a, c) => {
      seen.push(c);
    });
    const { ctx } = makeCtx();
    await handler("x", ctx);
    expect(seen[0]).toBe(ctx);
  });
});

describe("wrapCommandApi — observe mode (TUI), five contracts (freeze F2)", () => {
  it("contract 1: ui methods forward SAME args and return the ORIGINAL value / promise object", async () => {
    const { api, registerSpy } = spyApiClean();
    const { recorder } = fakeRecorder();
    const pi = wrapCommandApi(
      api,
      () => noCapture,
      undefined,
      undefined,
      () => recorder,
    );
    let held: ExtensionCommandContext | undefined;
    const handler = registerAndGetHandler(pi, registerSpy, async (_a, c) => {
      held = c;
    });
    const { ctx, ui, editorPromise } = makeCtx();
    await handler("x", ctx);
    expect(held).toBeDefined();
    expect(held).not.toBe(ctx);
    const p = held!.ui.editor("Title", "prefill-draft");
    expect(p).toBe(editorPromise); // SAME Promise object — not an async wrapper
    expect(ui.calls[0]).toEqual({ method: "editor", args: ["Title", "prefill-draft"] });
    expect(held!.ui.notify("hello", "warning")).toBe("notify-ret");
    expect(ui.calls[1]).toEqual({ method: "notify", args: ["hello", "warning"] });
    expect(held!.ui.setWidget("k", ["line1", "line2"])).toBe("setWidget-ret");
    expect(ui.calls[2]).toEqual({ method: "setWidget", args: ["k", ["line1", "line2"], undefined] });
  });

  it("contract 2: side-channel bookkeeping — no answers, no prefill, no editor text", async () => {
    const { api, registerSpy } = spyApiClean();
    const fake = fakeRecorder();
    const pi = wrapCommandApi(
      api,
      () => noCapture,
      undefined,
      undefined,
      () => fake.recorder,
    );
    const handler = registerAndGetHandler(pi, registerSpy, async (_a, c) => {
      const u = c.ui as unknown as Record<string, (...a: unknown[]) => unknown>;
      u.notify("n", "info");
      u.setWidget("wk", ["w1", "w2"]);
      u.setWidget("fk", () => "component"); // component factory → marker text
      u.setStatus("sk", "st");
      u.editor("ET", "SECRET-PREFILL");
      u.select("ST");
      u.input("IT");
      u.confirm("CT");
      (u as { custom: (...a: unknown[]) => unknown }).custom(1, 2);
      u.setEditorText("not-recorded");
      void u.pasteToEditor?.("also-not");
    });
    await handler("x", makeCtx().ctx);
    const sinks = fake.handles[0]!.sinks;
    const compact = sinks.map((e) => ({ kind: e.kind, key: e.key, title: e.title, text: e.text, level: e.level }));
    expect(compact).toEqual([
      { kind: "notify", key: undefined, title: undefined, text: "n", level: "info" },
      { kind: "widget", key: "wk", title: undefined, text: "w1\nw2", level: undefined },
      { kind: "widget", key: "fk", title: undefined, text: "(rendered in terminal)", level: undefined },
      { kind: "status", key: "sk", title: undefined, text: "st", level: undefined },
      { kind: "interactive", key: undefined, title: "ET", text: "editor", level: undefined },
      { kind: "interactive", key: undefined, title: "ST", text: "select", level: undefined },
      { kind: "interactive", key: undefined, title: "IT", text: "input", level: undefined },
      { kind: "interactive", key: undefined, title: "CT", text: "confirm", level: undefined },
      { kind: "interactive", key: undefined, title: undefined, text: "custom", level: undefined },
    ]);
    // no sink entry carries the prefill or the editor text
    expect(sinks.some((e) => String(e.text).includes("SECRET-PREFILL"))).toBe(false);
    expect(sinks.some((e) => String(e.text).includes("not-recorded"))).toBe(false);
    // setStatus(undefined) forwards but records nothing
  });

  it("contract 3: no webInvocation/feishuInvocation synthesized; plain ctx fields delegate", async () => {
    const { api, registerSpy } = spyApiClean();
    const { recorder } = fakeRecorder();
    const pi = wrapCommandApi(
      api,
      () => noCapture,
      undefined,
      undefined,
      () => recorder,
    );
    const handler = registerAndGetHandler(pi, registerSpy, async (_a, c) => c);
    const { ctx } = makeCtx();
    const observed = (await handler("x", ctx)) as unknown as ExtensionCommandContext;
    expect(observed.mode).toBe("tui");
    expect(observed.cwd).toBe("/tmp");
    expect("webInvocation" in (observed as object)).toBe(false);
    expect("feishuInvocation" in (observed as object)).toBe(false);
  });

  it("contract 4: handler throw ⇒ error entry sunk + settle(failed) + rethrown unchanged", async () => {
    const { api, registerSpy } = spyApiClean();
    const fake = fakeRecorder();
    const pi = wrapCommandApi(
      api,
      () => noCapture,
      undefined,
      undefined,
      () => fake.recorder,
    );
    const boom = new Error("kaboom");
    const handler = registerAndGetHandler(pi, registerSpy, async () => {
      throw boom;
    });
    await expect(handler("x", makeCtx().ctx)).rejects.toBe(boom);
    expect(fake.handles[0]!.sinks).toEqual([{ kind: "error", text: "kaboom" }]);
    expect(fake.handles[0]!.events).toEqual(["settle:failed"]);
  });

  it("contract 5: a sync handler's body still runs synchronously; handler promise resolves its value", async () => {
    const { api, registerSpy } = spyApiClean();
    const { recorder } = fakeRecorder();
    const pi = wrapCommandApi(
      api,
      () => noCapture,
      undefined,
      undefined,
      () => recorder,
    );
    const handler = registerAndGetHandler(pi, registerSpy, () => "sync-value");
    const { ctx } = makeCtx();
    const p = handler("x", ctx);
    expect(p).toBeInstanceOf(Promise);
    expect(await p).toBe("sync-value");
    expect(ctx.ui.calls).toHaveLength(0); // nothing displayed by the wrapper itself
  });
});

describe("wrapCommandApi — claimed (web) mode tee", () => {
  function claimedCapture() {
    const entries: Array<Record<string, unknown>> = [];
    let closed = false;
    const port = {
      arm: () => undefined,
      take: (name: string) => ({
        cmdId: "w-cl00000000000001",
        reqId: "r",
        origin: { listener: "loopback", ip: "127.0.0.1", reqId: "r" },
        name,
        args: "",
        deadlineAt: 0,
      }),
      finish: () => {
        closed = true;
      },
      collectFor: (_cmdId: string, e: Record<string, unknown>) => {
        if (!closed) entries.push(e);
      },
      windowEntries: () => entries,
    };
    return port as unknown as CommandCapturePort & { windowEntries(): Array<Record<string, unknown>> };
  }

  it("window output identical to today; sink tees; editor prefill replaced in the SINK only", async () => {
    const capture = claimedCapture();
    const { api, registerSpy } = spyApiClean();
    const fake = fakeRecorder();
    const pi = wrapCommandApi(
      api,
      () => capture,
      undefined,
      undefined,
      () => fake.recorder,
    );
    const handler = registerAndGetHandler(pi, registerSpy, async (_a, c) => {
      const u = c.ui as unknown as Record<string, (...a: unknown[]) => unknown>;
      u.notify("out", "info");
      u.editor("ET", "PREFILL-SECRET");
    });
    const { ctx } = makeCtx();
    await handler("", ctx);
    // window (web real-time channel) keeps today's semantics — prefill text included
    const win = (capture as unknown as { windowEntries(): Array<Record<string, unknown>> }).windowEntries();
    expect(win.map((e) => e.kind)).toEqual(["notify", "text", "interactive"]);
    expect(win[1]).toMatchObject({ kind: "text", title: "ET", text: "PREFILL-SECRET" });
    // claimed mode keeps today's forwarding semantics: notify/setWidget/setStatus DO reach the
    // terminal (interactive methods stay synthetic — editor never opened the dialog)
    expect(ctx.ui.calls).toEqual([{ method: "notify", args: ["out", "info"] }]);
    // the RECORD sink got the notify + redacted text + interactive marker
    expect(fake.handles[0]!.sinks).toEqual([
      { kind: "notify", level: "info", text: "out" },
      { kind: "text", title: "ET", text: "(编辑器内容未记录)" },
      { kind: "interactive", text: "editor" },
    ]);
    expect(fake.handles[0]!.events).toEqual(["settle:done"]);
    expect(fake.begins[0]!.claimed).toMatchObject({ cmdId: "w-cl00000000000001", source: "web" });
  });
});

describe("wrapCommandApi — session-leave interception (both modes)", () => {
  it("successful newSession ⇒ commitBeforeLeave('new') BEFORE the call; ORIGINAL promise returned", async () => {
    const { api, registerSpy } = spyApiClean();
    const fake = fakeRecorder();
    const pi = wrapCommandApi(
      api,
      () => noCapture,
      undefined,
      undefined,
      () => fake.recorder,
    );
    const { ctx, setNewSession } = makeCtx();
    const realPromise = Promise.resolve({});
    setNewSession(() => realPromise);
    let seenPromise: unknown;
    const handler = registerAndGetHandler(pi, registerSpy, async (_a, c) => {
      const p = c.newSession();
      seenPromise = p; // what the HANDLER sees through the ctx proxy
      return p;
    });
    await handler("x", ctx);
    expect(seenPromise).toBe(realPromise); // the ctx method returned the ORIGINAL promise object
    // settle after a successful leave is a no-op — the recorder itself enforces this; here the
    // wrapper must still CALL settle without effect on the fake (recorded for observability)
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.handles[0]!.events).toEqual(["commit:new", "settle:done"]);
  });

  it("cancelled newSession ⇒ afterLeaveCancelled fires (second end path)", async () => {
    const { api, registerSpy } = spyApiClean();
    const fake = fakeRecorder();
    const pi = wrapCommandApi(
      api,
      () => noCapture,
      undefined,
      undefined,
      () => fake.recorder,
    );
    const { ctx, setNewSession } = makeCtx();
    setNewSession(() => Promise.resolve({ cancelled: true }));
    const handler = registerAndGetHandler(pi, registerSpy, async (_a, c) => {
      await c.newSession();
    });
    await handler("x", ctx);
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.handles[0]!.events).toEqual(["commit:new", "cancelled:", "settle:done"]);
  });

  it("rejected switchSession ⇒ afterLeaveCancelled carries the error message", async () => {
    const { api, registerSpy } = spyApiClean();
    const fake = fakeRecorder();
    const pi = wrapCommandApi(
      api,
      () => noCapture,
      undefined,
      undefined,
      () => fake.recorder,
    );
    const { ctx } = makeCtx();
    (ctx as unknown as { switchSession: () => Promise<unknown> }).switchSession = () =>
      Promise.reject(new Error("nope"));
    const handler = registerAndGetHandler(pi, registerSpy, async (_a, c) => {
      await c.switchSession("/target").catch(() => undefined);
    });
    await handler("x", ctx);
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.handles[0]!.events).toEqual(["commit:switch", "cancelled:nope", "settle:done"]);
  });

  it("fork/reload are intercepted the same way (kind fork / reload)", async () => {
    const { api, registerSpy } = spyApiClean();
    const fake = fakeRecorder();
    const pi = wrapCommandApi(
      api,
      () => noCapture,
      undefined,
      undefined,
      () => fake.recorder,
    );
    const realPromise = Promise.resolve();
    const { ctx } = makeCtx();
    (ctx as unknown as { reload: () => Promise<void> }).reload = () => realPromise;
    let seenReload: unknown;
    const handler = registerAndGetHandler(pi, registerSpy, async (_a, c) => {
      void c.fork();
      seenReload = c.reload();
    });
    await handler("x", ctx);
    expect(seenReload).toBe(realPromise); // ORIGINAL promise object through the ctx proxy
    expect(fake.handles[0]!.events[0]).toBe("commit:fork");
    expect(fake.handles[0]!.events[1]).toBe("commit:reload");
  });
});

describe("wrapCommandApi — nested commands (m8①)", () => {
  it("a handler dispatching another toolkit command creates a SECOND independent record; sinks never cross", async () => {
    const { api, registerSpy } = spyApiClean();
    const fake = fakeRecorder();
    const pi = wrapCommandApi(
      api,
      () => noCapture,
      undefined,
      undefined,
      () => fake.recorder,
    );
    const innerHandler = registerAndGetHandler(
      pi,
      registerSpy,
      async (_a, c) => {
        c.ui.notify("inner-out", "info");
      },
      "inner",
    );
    const outerHandler = registerAndGetHandler(
      pi,
      registerSpy,
      async (_a, c) => {
        c.ui.notify("outer-out", "info");
        // pi's sendUserMessage would hand the inner handler its OWN fresh ctx — never the
        // outer handler's proxy — so the nested invocation gets an independent sink.
        await innerHandler("y", makeCtx().ctx);
        c.ui.notify("after-inner", "info");
      },
      "outer",
    );
    await outerHandler("x", makeCtx().ctx);
    expect(fake.handles).toHaveLength(2);
    expect(fake.handles[0]!.sinks.map((e) => e.text)).toEqual(["outer-out", "after-inner"]);
    expect(fake.handles[1]!.sinks.map((e) => e.text)).toEqual(["inner-out"]);
  });
});

// ---------------------------------------------------------------------------
// wiring: the commandRecorderRef pattern (mirrors the capture's todo #32 fix) and the
// production timer discipline (every recorder timer must unref — `pi -p` must never wedge).
// ---------------------------------------------------------------------------
import { wireWebHub, type WebHubControl } from "../../../src/web-hub/agent/index.js";
import { SETTINGS, fakePi } from "./helpers.js";

describe("wireWebHub ⇒ recorder assembly (web-hub-cmd-history §4.9)", () => {
  it("cmdHistory on (default) ⇒ control.recorder is a live recorder; off ⇒ undefined", () => {
    const on = wireWebHub(fakePi().pi, { settings: SETTINGS, fleet: () => [] }) as WebHubControl;
    expect(on.recorder).toBeDefined();
    expect(typeof on.recorder!.begin).toBe("function");
    expect(typeof on.recorder!.recordImmediate).toBe("function");
    const off = wireWebHub(fakePi().pi, {
      settings: { ...SETTINGS, cmdHistory: false },
      fleet: () => [],
    }) as WebHubControl;
    expect(off.recorder).toBeUndefined();
    // §4.9: the status slot itself is ALWAYS present — off prints its own confirmation line
    expect(off.cmdHistory?.statusLines()).toEqual(["cmd-history: off"]);
  });

  it("end-to-end: commandRecorderRef gets populated and a TUI invocation records through the SAME wrapped api src/index.ts builds", async () => {
    const { api, registerSpy } = spyApiClean();
    const commandRecorderRef: { current?: WebHubControl["recorder"] } = {};
    const pi = wrapCommandApi(
      api,
      () => undefined,
      undefined,
      undefined,
      () => commandRecorderRef.current,
    );
    const handler = registerAndGetHandler(
      pi,
      registerSpy,
      async (args: string, c: ExtensionCommandContext) => {
        c.ui.notify("from-tui", "info");
        return `ran:${args}`;
      },
      "mycmd",
    );
    // wireWebHub runs later, inside the settings.webHub.enabled gate — then the ref populates
    const control = wireWebHub(fakePi().pi, { settings: SETTINGS, fleet: () => [] }) as WebHubControl;
    commandRecorderRef.current = control.recorder;
    const appended: unknown[] = [];
    const recorder = control.recorder!;
    const origBegin = recorder.begin.bind(recorder);
    (recorder as unknown as { begin: unknown }).begin = (i: unknown) => {
      const h = origBegin(i as Parameters<typeof origBegin>[0]);
      if (h !== undefined) {
        h.settle({});
        appended.push(h.cmdId);
      }
      return h;
    };
    const { ctx } = makeCtx();
    const out = await handler("go", ctx);
    expect(out).toBe("ran:go");
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatch(/^c[A-Za-z0-9_-]{20}$/); // local id (TUI source)
  });

  it("every setTimeout the production recorder wiring creates is unref'd", async () => {
    const unrefSpied: Array<{ unrefCalled: boolean }> = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout");
    spy.mockImplementation(((fn: () => void, ms?: number) => {
      const t = realSetTimeout(fn, ms) as NodeJS.Timeout & { unref(): void };
      let unrefCalled = false;
      const origUnref = t.unref.bind(t);
      t.unref = () => {
        unrefCalled = true;
        origUnref();
      };
      unrefSpied.push({
        get unrefCalled() {
          return unrefCalled;
        },
      });
      return t;
    }) as typeof setTimeout);
    try {
      const control = wireWebHub(fakePi().pi, { settings: SETTINGS, fleet: () => [] }) as WebHubControl;
      const handle = control.recorder!.begin({
        name: "slow",
        args: "",
        ctx: makeCtx().ctx,
      })!;
      // one lazy-start timer + one RECORD_MAX_MS timer — both must unref
      const timerCount = unrefSpied.length;
      expect(timerCount).toBeGreaterThanOrEqual(2);
      expect(unrefSpied.every((t) => t.unrefCalled)).toBe(true);
      control.recorder!.dispose();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("cmd-history §8.3 — the record entry is NEVER given a TUI renderer (D10)", () => {
  it("a full real wiring never calls registerEntryRenderer with subagent:cmd", async () => {
    const renderers: string[] = [];
    const pi = fakePi().pi as unknown as Record<string, unknown>;
    const original = pi.registerEntryRenderer as ((...a: unknown[]) => unknown) | undefined;
    pi.registerEntryRenderer = (type: string, ...rest: unknown[]) => {
      renderers.push(type);
      return typeof original === "function"
        ? (original as (t: string, ...r: unknown[]) => unknown)(type, ...rest)
        : undefined;
    };
    try {
      const control = wireWebHub(pi as unknown as ExtensionAPI, {
        settings: SETTINGS,
        fleet: () => [],
      }) as WebHubControl;
      expect(control.recorder).toBeDefined();
      // a full record lifecycle through the real recorder
      control.recorder!.recordImmediate({
        cmdId: "w-00000000000000ff",
        name: "session",
        args: "",
        source: "web",
        startedAt: 1,
        state: "done",
      });
      control.recorder!.dispose();
    } finally {
      // restore so the shared fakePi shape stays intact for other tests in this file
      if (original === undefined) delete pi.registerEntryRenderer;
      else pi.registerEntryRenderer = original;
    }
    expect(renderers.includes("subagent:cmd")).toBe(false);
  });
});
