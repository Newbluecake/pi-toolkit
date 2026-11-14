// @vitest-environment happy-dom
import { mount, flushPromises } from "@vue/test-utils";
import { defineComponent, h, provide, ref, shallowRef } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatDateTime, localeFor } from "../../../src/web-hub/ui/src/format.js";
import { setLangOverride, resetLangForTests } from "../../../src/web-hub/ui/src/composables/useI18n.js";
import SpawnRow from "../../../src/web-hub/ui/src/components/spawn/SpawnRow.vue";
import SessionHistoryDialog from "../../../src/web-hub/ui/src/components/spawn/SessionHistoryDialog.vue";
import { HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import {
  RETAINED_RELAUNCH,
  useRetainedRelaunch,
  type RetainedRelaunch,
} from "../../../src/web-hub/ui/src/composables/useRetainedRelaunch.js";
import type { HubHandle, HubState, NewSessionFlow } from "../../../src/web-hub/ui/src/types.js";
import type { SpawnRecordPublic } from "../../../src/web-hub/protocol/spawn.js";
import type { SpawnHistoryOutcome, SpawnRelaunchOutcome } from "../../../src/web-hub/ui/src/transport/types.js";

const CAP = "spawn.exited.v1";
function rec(over: Partial<SpawnRecordPublic> = {}): SpawnRecordPublic {
  return {
    spawnId: "sp-one",
    cwdLabel: "project",
    state: "exited",
    createdAt: 1,
    updatedAt: 2,
    origin: { listener: "loopback", reqId: "old-request" },
    ...over,
  };
}
function harness(items = [rec()], caps = ["spawn.v1", CAP]) {
  const state = shallowRef({
    hub: { caps, pid: 101, startedAt: 1000 },
    conn: "connected",
    clientId: "tab-1",
    agents: new Map(),
    spawns: { items, active: 0, max: 10 },
  } as unknown as HubState);
  const flow = ref<NewSessionFlow>({ phase: "idle" });
  const relaunch = vi.fn<(id: string) => Promise<SpawnRelaunchOutcome>>(async (id) => ({
    ok: true,
    spawnId: id,
    state: "starting",
  }));
  const submit = vi.fn(async () => true);
  const list = vi.fn(async () => ({
    ok: true,
    items: items.map((r) => ({ ...r, cwd: "/owner" })),
    policy: { allowed: true },
  }));
  const history = vi.fn<() => Promise<SpawnHistoryOutcome>>(async () => ({
    ok: true,
    page: { items: [], stats: { files: 0, indexed: 0, enum: { complete: true, dirsDone: 0, dirsTotal: 0 } } },
  }));
  const hub = {
    state,
    spawn: { relaunch, list, history, newSession: { flow, submit, cancel: vi.fn() } },
  } as unknown as HubHandle;
  function records(next: SpawnRecordPublic[]) {
    state.value = { ...state.value, spawns: { items: next, active: 0, max: 10 } };
  }
  return { hub, state, flow, relaunch, submit, list, history, records };
}
const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
  document.body.innerHTML = "";
  window.location.hash = "";
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetLangForTests();
});
function setup(f: ReturnType<typeof harness>, row?: SpawnRecordPublic) {
  let controller!: RetainedRelaunch;
  const open = ref(true);
  const visibleRow = ref(row);
  const Host = defineComponent({
    setup() {
      provide(HUB_CTX, f.hub);
      controller = useRetainedRelaunch(f.hub);
      provide(RETAINED_RELAUNCH, controller);
      return () =>
        h("div", [
          visibleRow.value
            ? h(SpawnRow, {
                rec: visibleRow.value,
                onDismiss: () => {
                  visibleRow.value = undefined;
                },
              })
            : null,
          open.value
            ? h(SessionHistoryDialog, {
                onClose: () => {
                  open.value = false;
                },
              })
            : null,
        ]);
    },
  });
  const w = mount(Host, { attachTo: document.body });
  mounted.push(w);
  return { w, open, controller, visibleRow };
}
const retainedButton = () => document.body.querySelector<HTMLButtonElement>(".history-retained-row button")!;
async function click(el: HTMLElement) {
  el.click();
  await flushPromises();
}

describe("retained recovery UI: one shared intent, no fresh fallback", () => {
  it.each([true, false])(
    "failed restore evidence with failure=%s uses same spawnId without owner cwd/old key",
    async (failure) => {
      const r = rec({
        state: "failed",
        restore: { attempt: 1, ...(failure ? { failure: "session-invalid" as const } : {}) },
      });
      const f = harness([r]);
      f.relaunch.mockResolvedValue({ ok: false, error: "E_AGENT_ONLINE", status: 409 });
      const { w } = setup(f, r);
      await flushPromises();
      const retry = w.findAll("button").find((b) => b.text() === "Retry recovery")!;
      expect(retry.exists()).toBe(true);
      await retry.trigger("click");
      expect(f.relaunch).toHaveBeenCalledTimes(1);
      expect(f.relaunch).toHaveBeenCalledWith("sp-one");
      expect(f.submit).not.toHaveBeenCalled();
      expect(f.list).not.toHaveBeenCalled();
      expect(w.find('[role="alert"]').text()).toContain("exit cannot be confirmed");
      expect(r.from).toBeUndefined();
    },
  );

  it("SpawnRow and retained section simultaneous clicks share HTTP lock even across close/reopen", async () => {
    const r = rec({ state: "failed", restore: { attempt: 2 } });
    const f = harness([r]);
    let resolve!: (r: SpawnRelaunchOutcome) => void;
    f.relaunch.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { w, controller, open } = setup(f, r);
    await flushPromises();
    const retry = w.findAll("button").find((b) => b.text() === "Retry recovery")!;
    await retry.trigger("click");
    retainedButton().click();
    expect(f.relaunch).toHaveBeenCalledTimes(1);
    open.value = false;
    await flushPromises();
    open.value = true;
    await flushPromises();
    expect(retainedButton().disabled).toBe(true);
    await controller.request(r.spawnId);
    expect(f.relaunch).toHaveBeenCalledTimes(1);
    resolve({ ok: true, spawnId: r.spawnId, state: "starting" });
    await flushPromises();
    f.records([rec({ state: "live", agentKey: "late-live" })]);
    await flushPromises();
    expect(window.location.hash).toBe(""); // dismissed intent cannot navigate later
    expect(f.submit).not.toHaveBeenCalled();
  });

  it("exit → 202 → async failure → dismiss/close → fresh snapshot → same-id recovery → live navigation", async () => {
    const f = harness();
    const host = setup(f);
    await flushPromises();
    expect(f.relaunch).not.toHaveBeenCalled();
    await click(retainedButton());
    expect(host.controller.pending.value.has("sp-one")).toBe(true);
    f.records([{ ...Object.fromEntries(Object.entries(rec()).reverse()) } as SpawnRecordPublic]); // repeated terminal snapshot is NOT evidence of asynchronous failure
    await flushPromises();
    expect(host.controller.pending.value.has("sp-one")).toBe(true);
    f.records([rec({ state: "starting", restore: { phase: "registering", attempt: 1 } })]);
    await flushPromises();
    expect(retainedButton().disabled).toBe(true);
    const failed = rec({ state: "failed", updatedAt: 5, restore: { attempt: 1, failure: "session-invalid" } });
    f.records([failed]);
    host.visibleRow.value = failed;
    await flushPromises();
    await host.w
      .findAll("button")
      .find((b) => b.text() === "Dismiss")!
      .trigger("click");
    expect(document.body.querySelector(".history-retained-row")).not.toBeNull();
    host.open.value = false;
    await flushPromises();
    host.w.unmount();
    const fresh = harness([failed]); // no old card, key or origin request required
    const again = setup(fresh);
    await flushPromises();
    expect(retainedButton().textContent).toContain("Try to restore");
    expect(fresh.relaunch).not.toHaveBeenCalled();
    await click(retainedButton());
    fresh.records([rec({ state: "live", agentKey: "new-key", updatedAt: 8 })]);
    await flushPromises();
    expect(window.location.hash).toBe("#/agent/new-key");
    expect(fresh.relaunch).toHaveBeenCalledTimes(1);
    expect(fresh.relaunch).toHaveBeenCalledWith("sp-one");
    expect(f.submit).not.toHaveBeenCalled();
    expect(fresh.submit).not.toHaveBeenCalled();
    expect(again.controller.pending.value.size).toBe(0);
    expect(again.open.value).toBe(false);
    expect(f.history).not.toHaveBeenCalled();
  });

  it.each([
    ["E_NOT_FOUND", 404, undefined, "record is gone"],
    ["E_AGENT_ONLINE", 409, undefined, "previous process"],
    ["E_SPAWN_GONE", 410, undefined, "session file"],
    ["E_BAD_REQUEST", 409, "no-session", "no usable recovery"],
    ["E_NETWORK", 0, undefined, "Network"],
  ] as const)("honest %s rejection never submits/forks", async (error, status, reason, copy) => {
    const f = harness();
    f.relaunch.mockResolvedValue({ ok: false, error, status, ...(reason ? { reason } : {}) });
    setup(f);
    await flushPromises();
    await click(retainedButton());
    expect(document.body.textContent?.toLowerCase()).toContain(copy.toLowerCase());
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.relaunch).toHaveBeenCalledTimes(1);
  });

  it("evicted/removing records never revive and rejected promises do not fall through", async () => {
    const f = harness();
    const { controller } = setup(f);
    await controller.request("sp-one");
    f.records([]);
    await flushPromises();
    expect(document.body.textContent).toContain("no longer in the retention window");
    await controller.request("sp-one");
    expect(f.relaunch).toHaveBeenCalledTimes(1);
    f.records([rec({ removing: true })]);
    await flushPromises();
    expect(retainedButton().disabled).toBe(true);
    f.records([rec()]);
    f.relaunch.mockRejectedValue(new Error("network"));
    await controller.request("sp-one");
    expect(controller.errors.value.get("sp-one")).toBe("spawn.relaunchErrNetwork");
    expect(f.submit).not.toHaveBeenCalled();
  });

  it.each(["conn", "pid", "startedAt", "clientId", "cap"])(
    "%s change cancels pending intent and ignores late HTTP/SSE",
    async (field) => {
      const f = harness();
      let resolve!: (r: SpawnRelaunchOutcome) => void;
      f.relaunch.mockImplementation(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      const { controller } = setup(f);
      void controller.request("sp-one");
      f.state.value = {
        ...f.state.value,
        ...(field === "conn" ? { conn: "reconnecting" as const } : {}),
        ...(field === "clientId" ? { clientId: "tab-2" } : {}),
        ...(field === "pid" ? { hub: { ...f.state.value.hub, pid: 102 } } : {}),
        ...(field === "startedAt" ? { hub: { ...f.state.value.hub, startedAt: 2000 } } : {}),
        ...(field === "cap" ? { hub: { caps: ["spawn.v1"] } } : {}),
      };
      expect(controller.pending.value.size).toBe(0);
      expect(controller.isPending("sp-one")).toBe(true); // generation/connection cancellation does not release HTTP lock
      await controller.request("sp-one");
      expect(f.relaunch).toHaveBeenCalledTimes(1);
      resolve({ ok: true, spawnId: "sp-one", state: "starting" });
      await flushPromises();
      f.records([rec({ state: "live", agentKey: "new" })]);
      await flushPromises();
      expect(window.location.hash).toBe("");
      expect(controller.pending.value.size).toBe(0);
      expect(f.relaunch).toHaveBeenCalledTimes(1);
    },
  );

  it("ordinary history submit and recovery are mutually exclusive", async () => {
    const f = harness();
    const { controller } = setup(f);
    for (const phase of ["submitting", "confirming", "awaiting"] as const) {
      f.flow.value = { phase } as NewSessionFlow;
      await controller.request("sp-one");
    }
    expect(f.relaunch).not.toHaveBeenCalled();
  });
  it("a pending relaunch disables ordinary history resume/fork and guards its handler", async () => {
    const f = harness([rec()], ["spawn.v1", CAP, "spawn.history.v1"]);
    f.history.mockResolvedValue({
      ok: true,
      page: {
        items: [
          {
            key: "old/file.jsonl",
            id: "history-id",
            cwd: "/project",
            cwdLabel: "project",
            startedAt: "2026-10-01T00:00:00.000Z",
            mtimeMs: 1,
            size: 10,
            title: "History title",
            titleSource: "first",
            kind: "main",
            cwdState: "ok",
            startable: true,
            indexed: true,
          },
        ],
        stats: { files: 1, indexed: 1, enum: { complete: true, dirsDone: 1, dirsTotal: 1 } },
      },
    } as unknown as SpawnHistoryOutcome);
    const { controller, w } = setup(f);
    await flushPromises();
    const primary = document.body.querySelector<HTMLButtonElement>(".history-row-actions button")!;
    expect(primary).not.toBeNull();
    expect(primary.disabled).toBe(false);
    await controller.request("sp-one");
    await flushPromises();
    expect(primary.disabled).toBe(true);
    primary.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const engine = (
      w.findComponent(SessionHistoryDialog).vm.$ as unknown as {
        setupState: { rows: unknown[]; onPrimary(row: unknown): void };
      }
    ).setupState;
    engine.onPrimary(engine.rows[0]);
    expect(f.submit).not.toHaveBeenCalled();
  });
  it("an SSE change to restore-failed while fresh retry awaits owner detail cannot submit", async () => {
    const fresh = rec({ state: "failed" });
    const f = harness([fresh]);
    let done!: (r: Awaited<ReturnType<typeof f.list>>) => void;
    f.list.mockImplementation(
      () =>
        new Promise((resolve) => {
          done = resolve;
        }),
    );
    const host = setup(f, fresh);
    await flushPromises();
    await host.w
      .findAll("button")
      .find((b) => b.text() === "Retry")!
      .trigger("click");
    const restored = rec({ state: "failed", restore: { attempt: 1 } });
    host.visibleRow.value = restored;
    f.records([restored]);
    await flushPromises();
    done({ ok: true, items: [{ ...restored, cwd: "/owner" }], policy: { allowed: true } });
    await flushPromises();
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.relaunch).not.toHaveBeenCalled();
  });
});

it.each(["en-US", "zh-CN"])(
  "retained dates follow UI language, not browser %s, including runtime switch",
  async (browserLang) => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue([browserLang]);
    const ui = browserLang === "en-US" ? "zh" : "en";
    setLangOverride(ui, null);
    const at = 1794651000000;
    const f = harness([rec({ updatedAt: at })]);
    setup(f);
    await flushPromises();
    const date = () => document.body.querySelector(".history-retained time")!.textContent;
    expect(date()).toBe(formatDateTime(at, localeFor(ui)));
    const next = ui === "en" ? "zh" : "en";
    setLangOverride(next, null);
    await flushPromises();
    expect(date()).toBe(formatDateTime(at, localeFor(next)));
  },
);
