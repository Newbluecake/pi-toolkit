// @vitest-environment happy-dom
/**
 * web-hub-version plan §5.1 (V2): `composables/useVersionInfo.ts` — the phase machine
 * (`unsupported` never requests), single-flight, `parseVersionInfoWire` validation, the
 * `pid:startedAt` generation filter (stale snapshots dropped; generation change clears),
 * the paired visibilitychange listener with its ≥10min floor, and `match` wiring over the
 * live hub state (selected card / other cards).
 */
import { flushPromises } from "@vue/test-utils";
import { ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useVersionInfo, VERSION_VISIBLE_REFRESH_MS } from "../../../src/web-hub/ui/src/composables/useVersionInfo.js";
import { VERSION_CTX } from "../../../src/web-hub/ui/src/composables/useVersionInfo.js";
import type { HubHandle, HubState } from "../../../src/web-hub/ui/src/types.js";

/** Stand-in Document: visibility + listener bookkeeping; querySelectorAll yields nothing
 *  (tab fingerprint null — §4's "unknown", exactly like a dev-server page). */
function fakeDoc() {
  const handlers = new Set<() => void>();
  return {
    visibilityState: "hidden",
    querySelectorAll: () => [],
    addEventListener: (_t: string, h: () => void) => handlers.add(h),
    removeEventListener: (_t: string, h: () => void) => handlers.delete(h),
    fire: () => {
      for (const h of [...handlers]) h();
    },
    listenerCount: () => handlers.size,
  } as unknown as Document;
}

const WIRE_OK = {
  v: 1,
  checkedAt: 5,
  hub: { pid: 11, startedAt: 1000 },
  repo: { head: { commit: "abcdef1234567", time: 9 }, packageVersion: "0.5.5", lastTag: "v0.5.4" },
  changelog: { sections: [{ title: "0.5.5", date: "2026-10-16", markdown: "* fix" }] },
};

function hubHandle(hubFrame: Record<string, unknown> | null, versionInfo?: (signal?: AbortSignal) => unknown) {
  const state = ref({
    hub: hubFrame,
    conn: "open",
    selected: null,
    agents: new Map(),
  }) as unknown as { value: HubState };
  const handle = { state } as unknown as HubHandle;
  if (versionInfo !== undefined) {
    (handle as { transport?: unknown }).transport = { versionInfo };
  }
  return { state, handle };
}

const CAP_HUB = {
  version: "0.5.5",
  buildId: "0.5.5@abcdef1234567",
  pid: 11,
  startedAt: 1000,
  proto: { major: 1 },
  caps: ["version.v1"],
};

function okOutcome(data: unknown = WIRE_OK) {
  return { ok: true, data };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useVersionInfo: phase + cap gating", () => {
  it("no cap (old hub) ⇒ phase unsupported and refresh() NEVER sends a request", () => {
    const versionInfo = vi.fn();
    const { handle } = hubHandle({ ...CAP_HUB, caps: [] }, versionInfo as never);
    const doc = fakeDoc();
    const h = useVersionInfo({ hub: handle, doc, win: null });
    expect(h.phase.value).toBe("unsupported");
    h.refresh();
    h.refresh();
    expect(versionInfo).toHaveBeenCalledTimes(0);
    expect(h.snapshot.value).toBeUndefined();
    h.dispose();
  });

  it("no hub frame yet ⇒ idle (also never requests); cap arriving later unblocks refresh", async () => {
    const versionInfo = vi.fn(async () => okOutcome());
    const { state, handle } = hubHandle(null, versionInfo as never);
    const h = useVersionInfo({ hub: handle, doc: fakeDoc(), win: null });
    expect(h.phase.value).toBe("idle");
    h.refresh();
    expect(versionInfo).toHaveBeenCalledTimes(0);
    state.value = { ...state.value, hub: CAP_HUB } as HubState;
    h.refresh();
    await flushPromises();
    expect(versionInfo).toHaveBeenCalledTimes(1);
    expect(h.phase.value).toBe("ok");
    h.dispose();
  });

  it("cap on but transport lacks the method ⇒ error phase (still no throw)", async () => {
    const { handle } = hubHandle(CAP_HUB);
    const h = useVersionInfo({ hub: handle, doc: fakeDoc(), win: null });
    h.refresh();
    await flushPromises();
    expect(h.phase.value).toBe("error");
    h.dispose();
  });
});

describe("useVersionInfo: single flight + validation + generation", () => {
  it("two concurrent refresh() calls share ONE request (single flight)", async () => {
    let resolveFn: (v: unknown) => void = () => {};
    const versionInfo = vi.fn(
      () =>
        new Promise((res) => {
          resolveFn = res;
        }),
    );
    const { handle } = hubHandle(CAP_HUB, versionInfo as never);
    const h = useVersionInfo({ hub: handle, doc: fakeDoc(), win: null });
    h.refresh();
    h.refresh();
    h.refresh();
    expect(versionInfo).toHaveBeenCalledTimes(1);
    expect(h.phase.value).toBe("loading");
    resolveFn(okOutcome());
    await flushPromises();
    expect(h.phase.value).toBe("ok");
    expect(h.snapshot.value).toEqual(WIRE_OK);
    h.dispose();
  });

  it("a snapshot whose hub generation does not match the CURRENT frame is dropped (§4)", async () => {
    const other = { ...WIRE_OK, hub: { pid: 999, startedAt: 42 } };
    const versionInfo = vi.fn(async () => okOutcome(other));
    const { handle } = hubHandle(CAP_HUB, versionInfo as never);
    const h = useVersionInfo({ hub: handle, doc: fakeDoc(), win: null });
    h.refresh();
    await flushPromises();
    expect(h.phase.value).toBe("error");
    expect(h.snapshot.value).toBeUndefined();
    h.dispose();
  });

  it("a generation CHANGE clears the stored snapshot", async () => {
    const versionInfo = vi.fn(async () => okOutcome());
    const { state, handle } = hubHandle(CAP_HUB, versionInfo as never);
    const h = useVersionInfo({ hub: handle, doc: fakeDoc(), win: null });
    h.refresh();
    await flushPromises();
    expect(h.snapshot.value).toBeDefined();
    state.value = { ...state.value, hub: { ...CAP_HUB, pid: 12, startedAt: 2000 } } as HubState;
    await flushPromises(); // the gen watch flushes as a pre job on the next microtask tick
    expect(h.snapshot.value).toBeUndefined();
    h.dispose();
  });

  it("garbage bodies fail parseVersionInfoWire ⇒ error, no snapshot", async () => {
    for (const bad of [{ v: 2 }, { v: 1, hub: { pid: "x", startedAt: 1 } }, null]) {
      const versionInfo = vi.fn(async () => okOutcome(bad));
      const { handle } = hubHandle(CAP_HUB, versionInfo as never);
      const h = useVersionInfo({ hub: handle, doc: fakeDoc(), win: null });
      h.refresh();
      await flushPromises();
      expect(h.phase.value).toBe("error");
      expect(h.snapshot.value).toBeUndefined();
      h.dispose();
    }
  });

  it("HTTP failures surface as error and a later refresh can recover", async () => {
    let fail = true;
    const versionInfo = vi.fn(async () => (fail ? { ok: false, error: "E_DEADLINE", status: 504 } : okOutcome()));
    const { handle } = hubHandle(CAP_HUB, versionInfo as never);
    const h = useVersionInfo({ hub: handle, doc: fakeDoc(), win: null });
    h.refresh();
    await flushPromises();
    expect(h.phase.value).toBe("error");
    fail = false;
    h.refresh();
    await flushPromises();
    expect(h.phase.value).toBe("ok");
    h.dispose();
  });
});

describe("useVersionInfo: visibilitychange (paired, floored at 10min)", () => {
  function rig(visible: boolean) {
    const doc = fakeDoc();
    doc.visibilityState = visible ? "visible" : "hidden";
    const versionInfo = vi.fn(async () => okOutcome());
    const { handle } = hubHandle(CAP_HUB, versionInfo as never);
    const now = vi.fn(() => NOW);
    const h = useVersionInfo({ hub: handle, doc, win: null, now });
    return { doc, versionInfo, h, now };
  }
  const NOW = 1_000_000;

  it("visible + ≥10min since the last fetch ⇒ refreshes; <10min ⇒ not; hidden ⇒ not", async () => {
    const { doc, versionInfo, h } = rig(true);
    doc.fire();
    await flushPromises();
    expect(versionInfo).toHaveBeenCalledTimes(1); // never fetched before ⇒ floor satisfied
    doc.fire();
    await flushPromises();
    expect(versionInfo).toHaveBeenCalledTimes(1); // <10min — suppressed
    h.dispose();
  });

  it("hidden never refreshes", async () => {
    const { doc, versionInfo, h } = rig(false);
    doc.fire();
    await flushPromises();
    expect(versionInfo).toHaveBeenCalledTimes(0);
    h.dispose();
  });

  it("dispose() removes the listener (paired registration)", () => {
    const { doc, h } = rig(true);
    expect(doc.listenerCount()).toBe(1);
    h.dispose();
    expect(doc.listenerCount()).toBe(0);
  });

  it("no cap ⇒ visible never refreshes", async () => {
    const doc = fakeDoc();
    doc.visibilityState = "visible";
    const versionInfo = vi.fn(async () => okOutcome());
    const { handle } = hubHandle({ ...CAP_HUB, caps: [] }, versionInfo as never);
    const h = useVersionInfo({ hub: handle, doc, win: null });
    doc.fire();
    await flushPromises();
    expect(versionInfo).toHaveBeenCalledTimes(0);
    h.dispose();
  });

  it("the floor constant is the plan's 10 minutes", () => {
    expect(VERSION_VISIBLE_REFRESH_MS).toBe(10 * 60 * 1000);
  });
});

describe("useVersionInfo: match wiring", () => {
  it("match reflects the live hub frame + selected card + snapshot; VERSION_CTX is injectable", () => {
    const versionInfo = vi.fn();
    const agents = new Map<string, unknown>([
      ["a1", { card: { pluginVersion: "0.5.5", buildId: "0.5.5@abcdef1234567" } }],
      ["a2", { card: { pluginVersion: "0.5.5", buildId: "0.5.5@1111111222222" } }],
    ]);
    const state = ref({ hub: CAP_HUB, conn: "open", selected: "a1", agents }) as unknown as { value: HubState };
    const handle = { state, transport: { versionInfo } } as unknown as HubHandle;
    const h = useVersionInfo({ hub: handle, doc: fakeDoc(), win: null });
    expect(h.match.value.sessionStatus).toBe("same");
    expect(h.match.value.summary).toEqual({ older: 0, newer: 0, drift: 1 });
    state.value = { ...state.value, selected: "a2" } as HubState;
    expect(h.match.value.sessionStatus).toBe("differ");
    expect(typeof VERSION_CTX).toBe("symbol");
    h.dispose();
  });
});
