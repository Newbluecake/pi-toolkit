// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { computed, nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Composer from "../../../src/web-hub/ui/src/components/control/Composer.vue";
import { CONTROL_VIEW, type ControlView } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import { CONTROL_CTX } from "../../../src/web-hub/ui/src/composables/useControl.js";
import type { AgentState, ControlHandle } from "../../../src/web-hub/ui/src/types.js";

/**
 * `control/Composer.vue` `/name␠` argument completion (web-hub-slash-args plan §6/r1 — P3):
 * the arg-zone state machine against a FAKE fetch (the hub route is P2, parallel): request
 * rhythm (immediate discovery / 150ms debounce / abort + seq stale-drop), the D2/#5 keyboard
 * model (Enter applies ONLY after an explicit ↑↓ navigation; any non-navigation input
 * re-disarms it), latches (Esc `argDismissed`, name-palette coordination), the §7 compat rule
 * (no `args` in the commands slot ⇒ zero fetches, name palette untouched), query gating
 * (deny/sendAsText/commandsEnabled=false/offline agent), and the E_RATE pause with the r1 #9
 * cache fallback.
 */

function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

beforeEach(() => {
  stubMatchMedia(false);
  window.localStorage.clear();
});

function fakeControl(): ControlHandle & { drafts: Map<string, string> } {
  const drafts = new Map<string, string>();
  const noop = () => Promise.resolve({ ok: true as const });
  return {
    drafts,
    sendPrompt: noop as ControlHandle["sendPrompt"],
    abort: noop as ControlHandle["abort"],
    steerSub: noop as ControlHandle["steerSub"],
    stopSub: noop as ControlHandle["stopSub"],
    answerDialog: noop as ControlHandle["answerDialog"],
    cancelDialog: noop as ControlHandle["cancelDialog"],
    runCommand: noop as ControlHandle["runCommand"],
    query: noop,
    retry: noop,
    discard: () => {},
    draft: (k) => drafts.get(k) ?? "",
    setDraft: (k, t) => void drafts.set(k, t),
  };
}

const USAGE = "<subcommand> [args]";
/** Rows carrying `args` = the cmd.args.v1 positive signal (§6.1 capPresent). */
const COMMANDS: readonly Record<string, unknown>[] = [
  {
    name: "cache-ttl",
    kind: "extension",
    description: "cache ttl",
    policy: "allow",
    args: { usage: USAGE, complete: true },
  },
  {
    name: "webhub",
    kind: "extension",
    description: "web hub",
    policy: "allow",
    args: { usage: "manage the hub", complete: true },
  },
  { name: "static-only", kind: "extension", description: "static", policy: "allow", args: { usage: "<x>" } },
  {
    name: "denied",
    kind: "extension",
    description: "denied cmd",
    policy: "deny",
    args: { usage: "nope", complete: true },
  },
];
/** §7 compat: a pre-feature agent — no `args` anywhere ⇒ the whole layer is inert. */
const LEGACY_COMMANDS: readonly Record<string, unknown>[] = COMMANDS.map((c) => {
  const { args: _args, ...rest } = c as { args?: unknown };
  return rest;
});

const OK_ITEMS = [
  { value: "keepalive", label: "keepalive" },
  { value: "status", label: "status", policy: "confirm" },
];

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

interface MountOpts {
  commands?: readonly Record<string, unknown>[];
  commandsEnabled?: boolean;
  fetchImpl?: typeof fetch;
  down?: boolean;
  fleet?: readonly unknown[];
}

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  for (const w of mounted.splice(0)) w.unmount();
});

function mountComposer(opts: MountOpts = {}) {
  const agent = ref({
    pendingCtl: [],
    fleet: opts.fleet ?? [],
    down: opts.down === true,
  } as unknown as AgentState);
  const view: ControlView = {
    agentKey: "agent-a",
    control: null,
    enabled: computed(() => true),
    readonlyReason: computed(() => null),
    agent: computed(() => agent.value),
    busy: computed(() => false),
    commands: computed(() => [...(opts.commands ?? COMMANDS)]),
    commandsEnabled: computed(() => opts.commandsEnabled !== false),
    sending: computed(() => false),
    queueItems: computed(() => []),
    isWebMessage: () => false,
  };
  if (opts.fetchImpl !== undefined) vi.stubGlobal("fetch", opts.fetchImpl);
  const control = fakeControl();
  const wrapper = mount(Composer, {
    props: { enabled: true, busy: false },
    attachTo: document.body,
    global: {
      provide: {
        [CONTROL_VIEW as symbol]: view,
        [CONTROL_CTX as symbol]: { agentKey: "agent-a", control, enabled: true },
      },
    },
  });
  mounted.push(wrapper);
  wrapper.find("textarea").element.focus();
  return { wrapper, agent };
}

async function type(wrapper: ReturnType<typeof mount>, value: string): Promise<void> {
  const ta = wrapper.find("textarea");
  await ta.setValue(value);
  (ta.element as HTMLTextAreaElement).setSelectionRange(value.length, value.length);
  await ta.trigger("input");
}

/** Raw dispatch so preventDefault is observable (test-utils `trigger` hides the event). */
async function press(wrapper: ReturnType<typeof mount>, init: KeyboardEventInit): Promise<{ prevented: boolean }> {
  const el = wrapper.find("textarea").element as HTMLTextAreaElement;
  const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init });
  const spy = vi.spyOn(ev, "preventDefault");
  el.dispatchEvent(ev);
  await nextTick();
  await nextTick();
  return { prevented: spy.mock.calls.length > 0 };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** The immediate (0ms) discovery query + microtask settle. */
const soon = async (): Promise<void> => {
  await sleep(60);
  await Promise.resolve();
};
/** The 150ms debounce + settle. */
const settle = async (): Promise<void> => {
  await sleep(220);
  await Promise.resolve();
};

const ta = (w: ReturnType<typeof mount>) => w.find("textarea");
const value = (w: ReturnType<typeof mount>) => (ta(w).element as HTMLTextAreaElement).value;
const argPanel = (w: ReturnType<typeof mount>) => w.find(".command-palette.arg-palette");
const namePalette = (w: ReturnType<typeof mount>) => w.find(".command-palette:not(.arg-palette)");
const argRows = (w: ReturnType<typeof mount>) => w.findAll(".arg-palette .arg-item");

/** Bodies of every fetch call so far (the POST JSON of API.commandComplete). */
const bodies = (fetchImpl: ReturnType<typeof vi.fn>): Array<{ agentKey: string; name: string; prefix: string }> =>
  fetchImpl.mock.calls.map((c) => JSON.parse((c[1] as RequestInit | undefined)?.body as string));

describe("Composer /-argument completion — zone + request rhythm (§6.1/§6.3)", () => {
  it('entering the zone fires the IMMEDIATE discovery query (prefix "") and renders header + rows', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ items: OK_ITEMS, source: "own" }));
    const w = mountComposer({ fetchImpl }).wrapper;
    await type(w, "/cache-ttl ");
    await soon();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0]!;
    expect(call[0]).toBe("/api/command/complete");
    const init = call[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-PWH"]).toBe("1");
    expect(init.credentials).toBe("same-origin");
    expect(bodies(fetchImpl)).toEqual([{ agentKey: "agent-a", name: "cache-ttl", prefix: "" }]);
    expect(argPanel(w).exists()).toBe(true);
    expect(argPanel(w).find(".arg-head .command-name").text()).toBe("/cache-ttl");
    expect(argPanel(w).find(".arg-usage").attributes("title")).toBe(USAGE);
    expect(argRows(w)).toHaveLength(2);
  });

  it("the name palette hides once the zone opens (the /record␠ linger bug, §6.1)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ items: [], source: "own" }));
    const w = mountComposer({ fetchImpl }).wrapper;
    await type(w, "/cache-ttl");
    expect(namePalette(w).exists()).toBe(true);
    await type(w, "/cache-ttl ");
    expect(namePalette(w).exists()).toBe(false);
  });

  it("prefix edits are 150ms-debounced; one request per settled prefix (no per-keystroke storm)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ items: [], source: "own" }));
    const w = mountComposer({ fetchImpl }).wrapper;
    await type(w, "/cache-ttl ");
    await soon();
    await type(w, "/cache-ttl k");
    await sleep(80);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // debounce window: still just the discovery ask
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(bodies(fetchImpl)[1]).toMatchObject({ name: "cache-ttl", prefix: "k" });
  });

  it("a newer query ABORTS the previous fetch and stale replies are dropped (seq guard)", async () => {
    const resolvers: Array<(r: Response) => void> = [];
    const signals: AbortSignal[] = [];
    const fetchImpl = vi.fn(((_url: unknown, init?: RequestInit) => {
      signals.push(init!.signal as AbortSignal);
      return new Promise<Response>((resolve) => resolvers.push(resolve));
    }) as unknown as typeof fetch);
    const w = mountComposer({ fetchImpl }).wrapper;
    await type(w, "/cache-ttl ");
    await soon();
    await type(w, "/cache-ttl k"); // second query: aborts the first
    await settle();
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
    // the STALE reply lands last — its rows must be dropped
    resolvers[1]!(jsonResponse({ items: [{ value: "new", label: "new" }], source: "own" }));
    await soon();
    expect(argRows(w).map((r) => r.text())).toEqual(["new"]);
    resolvers[0]!(jsonResponse({ items: [{ value: "stale", label: "stale" }], source: "own" }));
    await soon();
    expect(argRows(w).map((r) => r.text())).toEqual(["new"]); // unchanged
  });

  it("leaving the zone resets the panel (no rows leak into the next command's zone)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ items: OK_ITEMS, source: "own" }));
    const w = mountComposer({ fetchImpl }).wrapper;
    await type(w, "/cache-ttl ");
    await soon();
    expect(argRows(w)).toHaveLength(2);
    await type(w, "/webhub ");
    await soon();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(bodies(fetchImpl)[1]).toMatchObject({ name: "webhub", prefix: "" });
  });

  it("backstep cache: re-typing a recently-fetched prefix shows ITS cached rows instantly (never a local filter)", async () => {
    const fetchImpl = vi.fn(async (u: unknown, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as { prefix: string };
      return jsonResponse({
        items:
          body.prefix === "k" ? [{ value: "keepalive", label: "keepalive" }] : [{ value: "reset", label: "reset" }], // "" and every other prefix
        source: "own",
      });
    });
    const w = mountComposer({ fetchImpl }).wrapper;
    await type(w, "/cache-ttl "); // discovery: "" cached as [reset]
    await soon();
    await type(w, "/cache-ttl k"); // debounced query: [keepalive]
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(argRows(w).map((r) => r.text())).toEqual(["keepalive"]);
    await type(w, "/cache-ttl "); // backspace into the cached "" — rows swap INSTANTLY
    await sleep(10); // long before any new reply
    expect(argRows(w).map((r) => r.text())).toEqual(["reset"]); // the cache's own rows — not a filtered [keepalive]
    expect(fetchImpl).toHaveBeenCalledTimes(2); // the backstep itself scheduled nothing yet
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(3); // the debounced re-query did fire afterwards
  });
});

describe("Composer /-argument completion — keyboard model (§6.4, D2 + r1 #5)", () => {
  it("Tab applies the highlighted row (whole-prefix replacement) and immediately queries the next level", async () => {
    const fetchImpl = vi.fn(async (u: unknown, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as { prefix: string };
      return jsonResponse({
        items:
          body.prefix === ""
            ? [{ value: "keepalive", label: "keepalive" }]
            : [{ value: "keepalive on", label: "keepalive on" }],
        source: "own",
      });
    });
    const w = mountComposer({ fetchImpl }).wrapper;
    await type(w, "/cache-ttl ");
    await soon();
    const { prevented } = await press(w, { key: "Tab" });
    expect(prevented).toBe(true);
    expect(value(w)).toBe("/cache-ttl keepalive");
    await soon(); // the apply forces the IMMEDIATE next-level query
    expect(bodies(fetchImpl)[1]).toMatchObject({ name: "cache-ttl", prefix: "keepalive" });
    // multi-token value: the zone STAYS open (single space after the name, spaces in prefix fine)
    expect(argPanel(w).exists()).toBe(true);
    await press(w, { key: "Tab" });
    expect(value(w)).toBe("/cache-ttl keepalive on");
  });

  it("Tab with the panel visible but ZERO rows is still consumed (focus never escapes)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ items: [], source: "own" }));
    const w = mountComposer({ fetchImpl }).wrapper;
    await type(w, "/cache-ttl ");
    await soon();
    expect(argRows(w)).toHaveLength(0);
    const { prevented } = await press(w, { key: "Tab" });
    expect(prevented).toBe(true);
    expect(value(w)).toBe("/cache-ttl "); // nothing applied
  });

  it("↑/↓/Shift+Tab move the highlight (wrapping) and aria-activedescendant follows", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ items: OK_ITEMS, source: "own" }));
    const w = mountComposer({ fetchImpl }).wrapper;
    await type(w, "/cache-ttl ");
    await soon();
    const desc = () => ta(w).attributes("aria-activedescendant");
    const argId = ta(w).attributes("aria-controls")!;
    expect(desc()).toBe(`${argId}-opt-0`);
    await press(w, { key: "ArrowDown" });
    expect(desc()).toBe(`${argId}-opt-1`);
    await press(w, { key: "ArrowDown" }); // wraps to 0
    expect(desc()).toBe(`${argId}-opt-0`);
    await press(w, { key: "Tab", shiftKey: true }); // Shift+Tab moves UP (0 → last)
    expect(desc()).toBe(`${argId}-opt-1`);
  });

  it("D2: Enter WITHOUT navigation keeps the send/execute semantics (falls through, emits)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ items: OK_ITEMS, source: "own" }));
    const w = mountComposer({ fetchImpl }).wrapper;
    await type(w, "/cache-ttl keepalive");
    await settle();
    const { prevented } = await press(w, { key: "Enter" });
    expect(prevented).toBe(true); // composerKeyAction still prevents (send path)
    expect(w.emitted("send")).toEqual([["/cache-ttl keepalive", "steer"]]); // the COMMAND text, not a completion
  });

  it("D2: Enter AFTER an explicit ↓ navigation applies the highlighted row instead of sending", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ items: OK_ITEMS, source: "own" }));
    const w = mountComposer({ fetchImpl }).wrapper;
    await type(w, "/cache-ttl ");
    await soon();
    await press(w, { key: "ArrowDown" }); // highlight on "status" (index 1)
    const { prevented } = await press(w, { key: "Enter" });
    expect(prevented).toBe(true);
    expect(value(w)).toBe("/cache-ttl status");
    expect(w.emitted("send")).toBeUndefined();
  });

  it("r1 #5: any NON-navigation input re-disarms Enter (D2) — typing after ↓ makes Enter send again", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ items: OK_ITEMS, source: "own" }));
    const w = mountComposer({ fetchImpl }).wrapper;
    await type(w, "/cache-ttl ");
    await soon();
    await press(w, { key: "ArrowDown" });
    await type(w, "/cache-ttl s"); // an input event: navigated reset
    await press(w, { key: "Enter" });
    expect(w.emitted("send")).toEqual([["/cache-ttl s", "steer"]]);
  });

  it("Enter with navigation armed but ZERO rows falls through to send (no dead Enter)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ items: [], source: "own" }));
    const w = mountComposer({ fetchImpl }).wrapper;
    await type(w, "/cache-ttl ");
    await soon();
    await press(w, { key: "ArrowDown" }); // consumed, but arms nothing (no rows)
    await press(w, { key: "Enter" });
    expect(w.emitted("send")).toEqual([["/cache-ttl ", "steer"]]);
  });

  it("Esc latches the panel closed; any later input re-opens it (mentionDismissed discipline)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ items: OK_ITEMS, source: "own" }));
    const w = mountComposer({ fetchImpl }).wrapper;
    await type(w, "/cache-ttl ");
    await soon();
    expect(argPanel(w).exists()).toBe(true);
    const { prevented } = await press(w, { key: "Escape" });
    expect(prevented).toBe(true);
    expect(argPanel(w).exists()).toBe(false); // latched closed, text kept
    expect(value(w)).toBe("/cache-ttl ");
    await type(w, "/cache-ttl k"); // input resets the latch
    await settle();
    expect(argPanel(w).exists()).toBe(true);
  });

  it("IME keys are never taken by the arg layer (isComposing / keyCode 229)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ items: OK_ITEMS, source: "own" }));
    const w = mountComposer({ fetchImpl }).wrapper;
    await type(w, "/cache-ttl ");
    await soon();
    const before = ta(w).attributes("aria-activedescendant");
    const { prevented: p1 } = await press(w, { key: "ArrowDown", isComposing: true });
    expect(p1).toBe(false);
    expect(ta(w).attributes("aria-activedescendant")).toBe(before); // highlight untouched
    const { prevented: p2 } = await press(w, { key: "Enter", keyCode: 229 });
    expect(p2).toBe(false);
    expect(w.emitted("send")).toBeUndefined(); // composerKeyAction's own IME guard: newline, no send
  });

  it("mobile: tapping a row applies through the same path (@mousedown.prevent keeps focus)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ items: OK_ITEMS, source: "own" }));
    const w = mountComposer({ fetchImpl }).wrapper;
    await type(w, "/cache-ttl ");
    await soon();
    await argRows(w)[1]!.trigger("click");
    expect(value(w)).toBe("/cache-ttl status");
  });
});

describe("Composer /-argument completion — latches, gating and compat (§6.4/§7)", () => {
  it("Tab on the NAME palette (`completeCommand`) lands in the zone: name palette stays suppressed, arg query fires", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ items: OK_ITEMS, source: "own" }));
    const w = mountComposer({ fetchImpl }).wrapper;
    await type(w, "/cache");
    expect(namePalette(w).exists()).toBe(true);
    await press(w, { key: "Tab" }); // completes the highlighted name row
    expect(value(w)).toBe("/cache-ttl ");
    await soon();
    expect(namePalette(w).exists()).toBe(false); // suppressed by the completion latch…
    expect(argPanel(w).exists()).toBe(true); // …and the arg panel takes over
    expect(bodies(fetchImpl)).toEqual([{ agentKey: "agent-a", name: "cache-ttl", prefix: "" }]);
  });

  it("argActive and mentionOpen are mutually exclusive (commandMode splits them)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ items: OK_ITEMS, source: "own" }));
    const w = mountComposer({
      fetchImpl,
      fleet: [{ runId: "r1", label: "bot", status: "running", terminal: false }],
    }).wrapper;
    await type(w, "@bo");
    expect(w.find(".mention-panel").exists()).toBe(true);
    expect(argPanel(w).exists()).toBe(false);
    await type(w, "/cache-ttl ");
    await soon();
    expect(w.find(".mention-panel").exists()).toBe(false);
    expect(argPanel(w).exists()).toBe(true);
  });

  it("deny row: no panel, no fetch — the name palette keeps its deny presentation", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ items: [], source: "own" }));
    const w = mountComposer({ fetchImpl }).wrapper;
    await type(w, "/denied x");
    await settle();
    expect(argPanel(w).exists()).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(namePalette(w).exists()).toBe(true); // unchanged deny-row behaviour
  });

  it("sendAsText: the zone goes inert (no panel, no further queries)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ items: [], source: "own" }));
    const w = mountComposer({ fetchImpl }).wrapper;
    await type(w, "/cache-ttl ");
    await soon();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await w.find('input[name="send-as-text"]').setValue(true);
    expect(argPanel(w).exists()).toBe(false);
    await type(w, "/cache-ttl k");
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(1); // no new queries
  });

  it("commandsEnabled=false: no command mode, no panel, no fetch", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ items: [], source: "own" }));
    const w = mountComposer({ fetchImpl, commandsEnabled: false }).wrapper;
    await type(w, "/cache-ttl k");
    await settle();
    expect(argPanel(w).exists()).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("offline agent (down): the zone never queries", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ items: [], source: "own" }));
    const w = mountComposer({ fetchImpl, down: true }).wrapper;
    await type(w, "/cache-ttl ");
    await settle();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(argPanel(w).exists()).toBe(true); // static header still shows (zero-request surface)
  });

  it("static-only row (args without complete): usage header + empty hint, ZERO requests", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ items: [], source: "own" }));
    const w = mountComposer({ fetchImpl }).wrapper;
    await type(w, "/static-only ");
    await settle();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(argPanel(w).exists()).toBe(true);
    expect(argPanel(w).find(".arg-usage").attributes("title")).toBe("<x>");
    expect(argPanel(w).find(".command-empty").exists()).toBe(true);
  });

  it("§7 compat: no `args` in the commands slot ⇒ byte-identical — zero fetches, name palette untouched, no arg panel", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ items: [], source: "own" }));
    const w = mountComposer({ fetchImpl, commands: LEGACY_COMMANDS }).wrapper;
    await type(w, "/cache-ttl ");
    await settle();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(argPanel(w).exists()).toBe(false);
    // the pre-feature behaviour: the name palette stays up with the query (no linger fix)
    expect(namePalette(w).exists()).toBe(true);
    expect(ta(w).attributes("aria-controls")).not.toBe(""); // combobox wiring still the name palette's
  });
});

describe("Composer /-argument completion — error policy (§6.2/r1 #9)", () => {
  it("transient failure degrades silently to the header (no rows, no empty hint, no error text)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "E_BUSY" }, { status: 503 }));
    const w = mountComposer({ fetchImpl }).wrapper;
    await type(w, "/cache-ttl ");
    await soon();
    expect(argPanel(w).exists()).toBe(true);
    expect(argPanel(w).find(".arg-head").exists()).toBe(true);
    expect(argRows(w)).toHaveLength(0);
    expect(argPanel(w).find(".command-empty").exists()).toBe(false); // error: hint suppressed
  });

  it("E_RATE: queries pause for Retry-After; the cache fallback still shows during the pause (r1 #9)", async () => {
    const fetchImpl = vi.fn(async (u: unknown, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as { prefix: string };
      if (body.prefix === "") return jsonResponse({ items: OK_ITEMS, source: "own" });
      return jsonResponse({ error: "E_RATE" }, { status: 429, headers: { "Retry-After": "1" } });
    });
    const w = mountComposer({ fetchImpl }).wrapper;
    await type(w, "/cache-ttl ");
    await soon();
    expect(argRows(w)).toHaveLength(2);
    await type(w, "/cache-ttl k"); // 429 ⇒ pause
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(argRows(w)).toHaveLength(0); // no cache for "k": header-only degrade
    await type(w, "/cache-ttl "); // backspace INTO a cached prefix during the pause
    await sleep(60);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // paused: no new query
    expect(argRows(w)).toHaveLength(2); // r1 #9: the cache fallback shows the "" rows
  });

  it("E_UNSUPPORTED latches the name for the session; other names still query", async () => {
    const fetchImpl = vi.fn(async (u: unknown, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as { name: string };
      if (body.name === "webhub") return jsonResponse({ error: "E_UNSUPPORTED" }, { status: 404 });
      return jsonResponse({ items: OK_ITEMS, source: "own" });
    });
    const w = mountComposer({ fetchImpl }).wrapper;
    await type(w, "/webhub ");
    await soon();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await type(w, "/webhub s"); // latched: never queried again this session
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(argPanel(w).find(".command-empty").exists()).toBe(false); // header-only degrade
    await type(w, "/cache-ttl ");
    await soon();
    expect(fetchImpl).toHaveBeenCalledTimes(2); // other names unaffected
    expect(argRows(w)).toHaveLength(2);
  });

  it("network failure (offline hub) is a silent degrade too — never an unhandled rejection", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("network down");
    });
    const w = mountComposer({ fetchImpl }).wrapper;
    await type(w, "/cache-ttl ");
    await soon();
    expect(argPanel(w).find(".arg-head").exists()).toBe(true);
    expect(argRows(w)).toHaveLength(0);
  });
});
