// @vitest-environment happy-dom
/**
 * `ResumeDialog.vue` + `useResume.ts` (web-resume plan v2 §2.6/§4 P3) — the dialog flows
 * over a scripted CONTROL_VIEW: list load, `resume:scanning` retries (≤4, 1s), the 300ms
 * search debounce with stale-reply drop, `reset:true` replacement, cursor load-more, the
 * switch state machine (success close / switched-elsewhere / late_failed one-query / 10s
 * unconfirmed), the D4 busy banner (browsable, rows disabled), and BOTH D5-a confirms
 * (local second click + server E_CONFIRM_REQUIRED ⇒ confirm ⇒ resend with confirm:true).
 * Fake timers drive every debounce/retry/watchdog; PickerSheet teleports to document.body.
 */
import { mount, flushPromises } from "@vue/test-utils";
import { computed, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ResumeDialog from "../../../src/web-hub/ui/src/components/control/ResumeDialog.vue";
import {
  CONTROL_VIEW,
  HUB_CTX,
  type ControlView,
} from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import type { AgentState, CmdOutcome, ControlHandle, HubHandle, HubState } from "../../../src/web-hub/ui/src/types.js";
import { resetLangForTests, setLangOverride } from "../../../src/web-hub/ui/src/composables/useI18n.js";

const NOW = 1_700_000_000_000;

interface ListCall {
  readonly args: string;
  at: number;
}
interface PickCall {
  readonly args: string;
  readonly opts: { confirm?: true; id?: string } | undefined;
}

function wire(over: Record<string, unknown> = {}): CmdOutcome {
  return {
    ok: true as const,
    data: {
      sessions: {
        v: 1,
        scope: "recent",
        windowHours: 48,
        gen: "g1",
        total: 1,
        rows: [],
        provenance: "complete",
        builtAt: NOW,
        ...over,
      },
    },
  };
}

function row(id: string, over: Record<string, unknown> = {}) {
  return { id, title: `t-${id}`, titleSource: "name", modifiedMs: NOW - 60_000, ...over };
}

function makeHarness() {
  const lists: ListCall[] = [];
  const picks: PickCall[] = [];
  const queries: string[] = [];
  // Queued per-call resolvers: tests resolve each round-trip manually to pin stale drops.
  const listPending: Array<(o: CmdOutcome) => void> = [];
  const pickPending: Array<(o: CmdOutcome) => void> = [];
  const pickScript = { outcome: undefined as CmdOutcome | undefined };
  const queryScript = { outcome: undefined as CmdOutcome | undefined };

  const control: ControlHandle = {
    queryCommand: (key, name, args) => {
      lists.push({ args, at: lists.length });
      return new Promise<CmdOutcome>((resolve) => listPending.push(resolve));
    },
    runCommand: (key, name, args, opts) => {
      picks.push({ args, opts });
      return new Promise<CmdOutcome>((resolve) => pickPending.push(resolve));
    },
    query: (key, id) => {
      queries.push(id);
      return Promise.resolve(
        queryScript.outcome ?? { ok: false, error: "E_UNKNOWN_ID", message: "x", retryable: false, effect: "none" },
      );
    },
    sendPrompt: (() => Promise.resolve({ ok: true })) as ControlHandle["sendPrompt"],
    abort: (() => Promise.resolve({ ok: true })) as ControlHandle["abort"],
    steerSub: (() => Promise.resolve({ ok: true })) as ControlHandle["steerSub"],
    stopSub: (() => Promise.resolve({ ok: true })) as ControlHandle["stopSub"],
    answerDialog: (() => Promise.resolve({ ok: true })) as ControlHandle["answerDialog"],
    cancelDialog: (() => Promise.resolve({ ok: true })) as ControlHandle["cancelDialog"],
    retry: (() => Promise.resolve({ ok: true })) as ControlHandle["retry"],
    discard: () => {},
    draft: () => "",
    setDraft: () => {},
  };

  const agent = ref({
    key: "a1",
    session: { sessionId: "cur-1" },
    pendingCtl: [],
    status: { busy: false, features: ["resume.v1"] },
    prompts: [],
    fleet: [],
    commands: [],
  } as unknown as AgentState);
  const agentsMap = ref(new Map<string, { key: string; down?: boolean; session?: { sessionId?: unknown } }>());
  const busyRef = ref(false);
  const view: ControlView = {
    agentKey: "a1",
    control,
    enabled: computed(() => true),
    readonlyReason: computed(() => null),
    agent: computed(() => agent.value),
    busy: computed(() => busyRef.value),
    commands: computed(() => []),
    commandsEnabled: computed(() => true),
    sending: computed(() => false),
    queueItems: computed(() => []),
    isWebMessage: () => false,
  };
  function busy(v: boolean): void {
    busyRef.value = v;
  }
  const hub: HubHandle = {
    state: ref({ agents: agentsMap.value } as unknown as HubState) as HubHandle["state"],
    dispatch: () => {},
  };
  return {
    lists,
    picks,
    queries,
    listPending,
    pickPending,
    pickScript,
    queryScript,
    agent,
    agentsMap,
    busy,
    setSession(sessionId: string | undefined): void {
      agent.value = { ...agent.value, session: sessionId === undefined ? undefined : { sessionId } };
    },
    setPending(items: readonly Record<string, unknown>[]): void {
      agent.value = { ...agent.value, pendingCtl: [...items] };
    },
    mountDialog(scope: "recent" | "all" = "recent") {
      const w = mount(ResumeDialog, {
        props: { scope },
        global: { provide: { [CONTROL_VIEW as symbol]: view, [HUB_CTX as symbol]: hub } },
      });
      mounted.push(w);
      return w;
    },
  };
}
const mounted: Array<ReturnType<typeof mount>> = [];
// The copy assertions pin the zh dictionaries — pin the language per test (the shared
// override is reset after each one for the other suites).
beforeEach(() => {
  setLangOverride("zh");
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
  vi.useRealTimers();
  resetLangForTests();
});

const rowsIn = (): readonly HTMLElement[] => Array.from(document.body.querySelectorAll<HTMLElement>(".resume-row"));

describe("ResumeDialog — list flow", () => {
  it("open(recent) ⇒ __list {scope:recent}; rows + badges + relative time render", async () => {
    const h = makeHarness();
    const w = h.mountDialog();
    await flushPromises();
    expect(h.lists[0]?.args).toBe('__list {"scope":"recent"}');
    h.listPending[0]!(wire({ rows: [row("s1"), row("s2", { current: true, forked: true })] }));
    await flushPromises();
    expect(rowsIn().length).toBe(2);
    expect(document.body.textContent).toContain("t-s1");
    expect(document.body.textContent).toContain("当前");
    expect(document.body.textContent).toContain("⑂");
    w.unmount();
  });

  it("resume:scanning ⇒ 4 retries 1s apart (5 calls), then the error state + retry works", async () => {
    const h = makeHarness();
    const w = h.mountDialog();
    await flushPromises();
    for (let i = 0; i < 5; i++) {
      expect(h.listPending.length).toBe(i + 1);
      h.listPending[i]!({
        ok: false,
        error: "E_DEADLINE",
        message: "resume:scanning",
        retryable: true,
        effect: "none",
      });
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(h.lists.length).toBe(5);
    expect(document.body.textContent).toContain("加载失败");
    // retry ⇒ a fresh logical load (seq reset, one more call)
    const retryBtn = document.body.querySelector<HTMLButtonElement>(".resume-error .btn");
    expect(retryBtn).not.toBeNull();
    retryBtn!.click();
    await flushPromises();
    expect(h.listPending.length).toBe(6);
    h.listPending[5]!(wire({ rows: [row("s9")] }));
    await flushPromises();
    expect(rowsIn().length).toBe(1);
    w.unmount();
  });

  it("search debounces 300ms; a stale reply is dropped (generation counter)", async () => {
    const h = makeHarness();
    const w = h.mountDialog();
    await flushPromises();
    h.listPending[0]!(wire({ rows: [row("s1")] }));
    await flushPromises();
    const input = document.body.querySelector<HTMLInputElement>(".resume-search input");
    input!.value = "ab";
    input!.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(299);
    expect(h.lists.length).toBe(1); // still debouncing
    await vi.advanceTimersByTimeAsync(1);
    expect(h.lists.length).toBe(2);
    expect(h.lists[1]!.args).toContain('"q":"ab"');
    // resolve the STALE (first) reply last — it must not overwrite the fresh one
    h.listPending[1]!(wire({ rows: [row("fresh")] }));
    await flushPromises();
    h.listPending[0]!(wire({ rows: [row("stale")] }));
    await flushPromises();
    expect(rowsIn().length).toBe(1);
    expect(document.body.textContent).toContain("t-fresh");
    w.unmount();
  });

  it("reset:true on a cursor page replaces the rows instead of appending (§2.4 paging)", async () => {
    const h = makeHarness();
    const w = h.mountDialog();
    await flushPromises();
    h.listPending[0]!(wire({ rows: [row("s1")], next: "g1.1.h" }));
    await flushPromises();
    (document.body.querySelector<HTMLButtonElement>(".resume-foot .btn") as HTMLButtonElement).click();
    await flushPromises();
    h.listPending[1]!(wire({ rows: [row("s2")], reset: true, gen: "g2" }));
    await flushPromises();
    expect(rowsIn().length).toBe(1); // replaced, not [s1, s2]
    expect(document.body.textContent).toContain("t-s2");
    w.unmount();
  });

  it("load more pages the cursor and appends; the note flags partial/truncated", async () => {
    const h = makeHarness();
    const w = h.mountDialog();
    await flushPromises();
    h.listPending[0]!(wire({ rows: [row("s1")], next: "g1.1.h", partial: true, truncated: true, total: 500 }));
    await flushPromises();
    expect(document.body.textContent).toContain("列表可能不完整");
    expect(document.body.textContent).toContain("仅显示前 500 个会话");
    (document.body.querySelector<HTMLButtonElement>(".resume-foot .btn") as HTMLButtonElement).click();
    await flushPromises();
    expect(h.lists[1]!.args).toContain('"cursor":"g1.1.h"');
    h.listPending[1]!(wire({ rows: [row("s2")], gen: "g1" }));
    await flushPromises();
    expect(rowsIn().length).toBe(2);
    w.unmount();
  });

  it("the permanent D5 footer line is always rendered", async () => {
    const h = makeHarness();
    const w = h.mountDialog();
    await flushPromises();
    expect(document.body.querySelector(".resume-d5")?.textContent).toContain("pi 不锁会话文件");
    w.unmount();
  });
});

describe("ResumeDialog — pick / switch machine", () => {
  async function loadedDialog(h: ReturnType<typeof makeHarness>, over: Parameters<typeof wire>[0] = {}) {
    const w = h.mountDialog();
    await flushPromises();
    h.listPending[0]!(wire({ rows: [row("s1"), row("s2")], ...over }));
    await flushPromises();
    return w;
  }

  it("pick ⇒ __pick {id,gen}; ok-async ⇒ switching until sessionId matches ⇒ close", async () => {
    const h = makeHarness();
    const w = await loadedDialog(h);
    rowsIn()[1]!.click();
    await flushPromises();
    expect(h.picks[0]!.args).toBe('__pick {"id":"s2","gen":"g1"}');
    h.pickPending[0]!({ ok: true, data: { op: "command", kind: "builtin", completion: "async" } });
    await flushPromises();
    // switching: rows disabled while the switch is in flight
    expect(rowsIn()[1]!.disabled).toBe(true);
    h.setSession("s2");
    await flushPromises();
    expect(w.emitted("close")).toHaveLength(1);
    w.unmount();
  });

  it("sessionId flipping to ANOTHER id ⇒ 已切换到其他会话, closes after a beat", async () => {
    const h = makeHarness();
    const w = await loadedDialog(h);
    rowsIn()[0]!.click();
    await flushPromises();
    h.pickPending[0]!({ ok: true, data: { completion: "async" } });
    await flushPromises();
    h.setSession("someone-else");
    await flushPromises();
    expect(document.body.textContent).toContain("已切换到其他会话");
    expect(w.emitted("close")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_200);
    expect(w.emitted("close")).toHaveLength(1);
    w.unmount();
  });

  it("ctl item turning late_failed ⇒ exactly one query; the notice carries its message", async () => {
    const h = makeHarness();
    const w = await loadedDialog(h);
    rowsIn()[0]!.click();
    await flushPromises();
    const pickId = h.picks[0]!.opts?.id;
    expect(typeof pickId).toBe("string");
    h.pickPending[0]!({ ok: true, data: { completion: "async" } });
    await flushPromises();
    h.queryScript.outcome = {
      ok: false,
      error: "E_STALE_CTX",
      message: "resume:mismatch",
      retryable: false,
      effect: "unknown",
    };
    h.setPending([{ id: pickId, kind: "command", state: "failed", error: "E_STALE_CTX" }]);
    await flushPromises();
    expect(h.queries).toEqual([pickId]); // §2.6: exactly ONE query
    expect(document.body.textContent).toContain("切换失败（resume:mismatch）");
    // rows usable again (ready, not stuck in switching)
    expect(rowsIn()[0]!.disabled).toBe(false);
    w.unmount();
  });

  it("10s without a sessionId flip ⇒ 未确认切换，请查看终端; rows stay usable", async () => {
    const h = makeHarness();
    const w = await loadedDialog(h);
    rowsIn()[0]!.click();
    await flushPromises();
    h.pickPending[0]!({ ok: true, data: { completion: "async" } });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(document.body.textContent).toContain("未确认切换，请查看终端");
    expect(rowsIn()[0]!.disabled).toBe(false);
    w.unmount();
  });

  it("stale-list (E_NOT_FOUND resume:stale-list) ⇒ notice + the list reloads", async () => {
    const h = makeHarness();
    const w = await loadedDialog(h);
    rowsIn()[0]!.click();
    await flushPromises();
    h.pickPending[0]!({
      ok: false,
      error: "E_NOT_FOUND",
      message: "resume:stale-list",
      retryable: false,
      effect: "none",
    });
    await flushPromises();
    expect(document.body.textContent).toContain("已重新加载");
    expect(h.lists.length).toBe(2);
    h.listPending[1]!(wire({ rows: [row("fresh")] }));
    await flushPromises();
    expect(rowsIn().length).toBe(1);
    w.unmount();
  });
});

describe("ResumeDialog — D4 busy + D5 confirms", () => {
  async function loadedDialog(h: ReturnType<typeof makeHarness>) {
    const w = h.mountDialog();
    await flushPromises();
    h.listPending[0]!(wire({ rows: [row("s1")] }));
    await flushPromises();
    return w;
  }

  it("busy ⇒ banner + rows disabled but rendered (D4 browsable-not-switchable)", async () => {
    const h = makeHarness();
    const w = await loadedDialog(h);
    h.busy(true);
    await flushPromises();
    expect(document.body.textContent).toContain("Agent 正在回复，结束后再切换");
    expect(rowsIn().length).toBe(1);
    expect(rowsIn()[0]!.disabled).toBe(true);
    rowsIn()[0]!.click(); // a disabled button won't fire, and the guard doubles up:
    h.busy(false);
    await flushPromises();
    expect(h.picks.length).toBe(0);
    w.unmount();
  });

  it("D5 local: a known-live-elsewhere row needs a SECOND click", async () => {
    const h = makeHarness();
    h.agentsMap.value.set("b2", { key: "b2", session: { sessionId: "s1" } });
    const w = await loadedDialog(h);
    rowsIn()[0]!.click();
    await flushPromises();
    expect(h.picks.length).toBe(0); // armed, not sent
    expect(document.body.textContent).toContain("再点一次确认切换");
    expect(rowsIn()[0]!.classList.contains("armed")).toBe(true);
    rowsIn()[0]!.click();
    await flushPromises();
    expect(h.picks.length).toBe(1);
    w.unmount();
  });

  it("D5 server: E_CONFIRM_REQUIRED resume:active-elsewhere ⇒ inline confirm ⇒ resend with confirm:true", async () => {
    const h = makeHarness();
    const w = await loadedDialog(h);
    rowsIn()[0]!.click();
    await flushPromises();
    h.pickPending[0]!({
      ok: false,
      error: "E_CONFIRM_REQUIRED",
      message: "resume:active-elsewhere",
      retryable: false,
      effect: "none",
    });
    await flushPromises();
    expect(document.body.textContent).toContain("仍要切换吗？");
    (
      document.body.querySelector<HTMLButtonElement>(".resume-confirm-actions .btn-primary") as HTMLButtonElement
    ).click();
    await flushPromises();
    expect(h.picks.length).toBe(2);
    expect(h.picks[1]!.opts?.confirm).toBe(true);
    // a NEW id for the confirmed resend
    expect(h.picks[1]!.opts?.id).not.toBe(h.picks[0]!.opts?.id);
    h.pickPending[1]!({ ok: true, data: { completion: "async" } });
    await flushPromises();
    h.setSession("s1");
    await flushPromises();
    expect(w.emitted("close")).toHaveLength(1);
    w.unmount();
  });

  it("D5 server: cancel returns to the list without sending anything more", async () => {
    const h = makeHarness();
    const w = await loadedDialog(h);
    rowsIn()[0]!.click();
    await flushPromises();
    h.pickPending[0]!({
      ok: false,
      error: "E_CONFIRM_REQUIRED",
      message: "resume:active-elsewhere",
      retryable: false,
      effect: "none",
    });
    await flushPromises();
    (document.body.querySelector<HTMLButtonElement>(".resume-confirm-actions .btn-ghost") as HTMLButtonElement).click();
    await flushPromises();
    expect(h.picks.length).toBe(1);
    expect(rowsIn().length).toBe(1); // list back
    w.unmount();
  });
});
