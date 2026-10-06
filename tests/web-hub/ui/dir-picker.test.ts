// @vitest-environment happy-dom
/**
 * `DirPicker.vue` + `SpawnConfirm.vue` (web-hub-spawn plan SP12 / arch §9.1, plan §3.2). The
 * picker is driven by a REAL `createNewSession` (SP11) orchestrator over a fake `start`, so
 * these tests pin the component wiring AND the flow phases: recent dirs, the 409 ⇒
 * SpawnConfirm view (resolvedCwd via textContent, LAN plaintext warning), failures preserving
 * the input, and the 48 KiB client-side precheck.
 */
import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { ref } from "vue";
import DirPicker from "../../../src/web-hub/ui/src/components/spawn/DirPicker.vue";
import { HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import { createNewSession } from "../../../src/web-hub/ui/src/composables/useNewSession.js";
import type { HubHandle, HubState } from "../../../src/web-hub/ui/src/types.js";
import type { SpawnOutcome } from "../../../src/web-hub/ui/src/transport/types.js";
import type { DirEntryWire, SpawnRequestBody } from "../../../src/web-hub/protocol/spawn.js";

function fakeClock() {
  let now = 1_700_000_000_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number): number => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id: number): void => void timers.delete(id),
  };
}

interface Harness {
  readonly hub: HubHandle;
  readonly starts: SpawnRequestBody[];
}

/** HUB_CTX with a real §3.2 orchestrator over a scripted `start`; dirs() returns `recent`. */
function harness(opts: { start: (req: SpawnRequestBody) => Promise<SpawnOutcome>; recent?: DirEntryWire[] }): Harness {
  const starts: SpawnRequestBody[] = [];
  const clock = fakeClock();
  const newSession = createNewSession({
    start: (req) => {
      starts.push(req);
      return opts.start(req);
    },
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    newId: () => `req-${starts.length}-aaaaaaaaaaaa`,
  });
  const hub: HubHandle = {
    state: ref({ agents: new Map(), spawns: null } as unknown as HubState),
    dispatch: () => {},
    spawn: {
      list: async () => ({ ok: false, error: "E_NOT_FOUND", status: 404 }),
      dirs: async () => ({ ok: true, recent: opts.recent ?? [] }),
      start: async () => ({ ok: false, error: "E_UNSUPPORTED", retryable: false }),
      stop: async () => ({ ok: true, state: "stopping" }),
      newSession,
    },
  };
  return { hub, starts };
}

function mountPicker(h: Harness, props: { prefillCwd?: string; focusSubmit?: boolean; plaintext?: boolean } = {}) {
  return mount(DirPicker, {
    props,
    attachTo: document.body,
    global: { provide: { [HUB_CTX as symbol]: h.hub } },
  });
}

describe("DirPicker.vue (SP12)", () => {
  it("focusSubmit (NewSessionMenu main-button open) focuses 「Start」 on mount; default does not", async () => {
    const h = harness({ start: async () => ({ ok: false, error: "E_UNSUPPORTED", retryable: false }) });
    const focused = mountPicker(h, { prefillCwd: "/home/u/proj", focusSubmit: true });
    await flushPromises();
    expect(document.activeElement).toBe(focused.get(".spawn-picker-actions .btn-primary").element);
    focused.unmount();

    const plain = mountPicker(h, { prefillCwd: "/home/u/proj" });
    await flushPromises();
    expect(document.activeElement).not.toBe(plain.get(".spawn-picker-actions .btn-primary").element);
    plain.unmount();
  });

  it("prefills the cwd input and lists recent directories; clicking one fills the input", async () => {
    const h = harness({
      start: async () => ({ ok: false, error: "E_UNSUPPORTED", retryable: false }),
      recent: [
        { cwd: "/home/u/alpha", label: "alpha", at: 2000 },
        { cwd: "/home/u/beta", label: "beta", at: 1000 },
      ],
    });
    const wrapper = mountPicker(h, { prefillCwd: "/home/u/selected" });
    await flushPromises();
    expect((wrapper.get("#spawn-cwd").element as HTMLInputElement).value).toBe("/home/u/selected");
    const recent = wrapper.findAll(".spawn-recent-btn");
    expect(recent).toHaveLength(2);
    expect(recent[0]!.text()).toContain("alpha");

    await recent[1]!.trigger("click");
    expect((wrapper.get("#spawn-cwd").element as HTMLInputElement).value).toBe("/home/u/beta");
  });

  it("submits {cwd, firstPrompt} through the orchestrator exactly once per click", async () => {
    let call = 0;
    const h = harness({
      start: async () => {
        call += 1;
        return { ok: false, error: "E_NETWORK", retryable: true }; // one same-id resend, then failed
      },
    });
    const wrapper = mountPicker(h, { prefillCwd: "~/work" });
    await flushPromises();
    await wrapper.get("#spawn-cwd").setValue("/home/u/proj");
    await wrapper.get("#spawn-first-prompt").setValue("hello session");
    await wrapper.get(".spawn-picker-actions .btn-primary").trigger("click");
    await flushPromises();
    expect(call).toBe(2); // §3.2: network error ⇒ the SAME id resent once
    expect(h.starts[0]).toEqual({
      id: "req-0-aaaaaaaaaaaa",
      cwd: "/home/u/proj",
      firstPrompt: { text: "hello session" },
    });
    expect(h.starts[1]).toEqual(h.starts[0]);
  });

  it("409 E_CONFIRM_REQUIRED ⇒ the SpawnConfirm view shows resolvedCwd and the LAN warning; confirm resends with confirm+expectCwd", async () => {
    let confirmed = false;
    const h = harness({
      start: async (req) => {
        if (req.confirm === true) {
          confirmed = true;
          return { ok: true, data: { spawnId: "sp9", state: "starting", cwd: "/real/path" } };
        }
        return {
          ok: false,
          error: "E_CONFIRM_REQUIRED",
          resolvedCwd: "/real/path",
          reason: "unknown-dir",
          retryable: false,
        };
      },
    });
    const wrapper = mountPicker(h, { prefillCwd: "/home/u/proj", plaintext: true });
    await flushPromises();
    await wrapper.get(".spawn-picker-actions .btn-primary").trigger("click");
    await flushPromises();

    const confirm = wrapper.get(".spawn-confirm");
    expect(confirm.get(".spawn-confirm-cwd").text()).toBe("/real/path");
    expect(confirm.text()).toContain("not in the known list");
    expect(confirm.get(".spawn-plain-warning").text()).toContain("Plain HTTP");

    await confirm.get(".btn-primary").trigger("click");
    await flushPromises();
    expect(confirmed).toBe(true);
    expect(h.starts[1]).toMatchObject({ id: "req-0-aaaaaaaaaaaa", confirm: true, expectCwd: "/real/path" });
    expect(wrapper.find(".spawn-picker-status").text()).toContain("Waiting for the session");
  });

  it("no LAN plaintext warning when plaintext is false", async () => {
    const h = harness({
      start: async () => ({
        ok: false,
        error: "E_CONFIRM_REQUIRED",
        resolvedCwd: "/real/path",
        reason: "unknown-dir",
        retryable: false,
      }),
    });
    const wrapper = mountPicker(h, { plaintext: false });
    await flushPromises();
    await wrapper.get(".spawn-picker-actions .btn-primary").trigger("click");
    await flushPromises();
    expect(wrapper.find(".spawn-confirm").exists()).toBe(true);
    expect(wrapper.find(".spawn-plain-warning").exists()).toBe(false);
  });

  it("E_LIMIT failure keeps the typed input and shows the taxonomy line; retry resubmits", async () => {
    let calls = 0;
    const h = harness({
      start: async () => {
        calls += 1;
        return { ok: false, error: "E_LIMIT", message: "4/4 processes", retryable: false };
      },
    });
    const wrapper = mountPicker(h);
    await flushPromises();
    await wrapper.get("#spawn-cwd").setValue("/home/u/keepme");
    await wrapper.get("#spawn-first-prompt").setValue("draft body");
    await wrapper.get(".spawn-picker-actions .btn-primary").trigger("click");
    await flushPromises();

    expect(wrapper.get(".spawn-picker-error").text()).toContain("Process limit reached");
    expect(wrapper.get(".spawn-picker-error").text()).toContain("4/4 processes");
    expect((wrapper.get("#spawn-cwd").element as HTMLInputElement).value).toBe("/home/u/keepme");
    expect((wrapper.get("#spawn-first-prompt").element as HTMLTextAreaElement).value).toBe("draft body");

    await wrapper.get(".spawn-picker-actions .btn:not(.btn-primary):not(.btn-ghost)").trigger("click");
    await flushPromises();
    expect(calls).toBe(2); // retry ⇒ a NEW id (§3.2)
    expect(h.starts[1]!.id).not.toBe(h.starts[0]!.id);
    expect(h.starts[1]!.cwd).toBe("/home/u/keepme");
  });

  it("first prompt over 48 KiB ⇒ submit disabled with the byte precheck line (never hits the wire)", async () => {
    const h = harness({ start: async () => ({ ok: false, error: "E_NETWORK", retryable: true }) });
    const wrapper = mountPicker(h);
    await flushPromises();
    await wrapper.get("#spawn-first-prompt").setValue("x".repeat(48 * 1024 + 1));
    const submit = wrapper.get(".spawn-picker-actions .btn-primary");
    expect(submit.attributes("disabled")).toBeDefined();
    expect(wrapper.get(".spawn-picker-error").text()).toContain("48 KiB");
    await submit.trigger("click");
    await flushPromises();
    expect(h.starts).toHaveLength(0);
  });
});
