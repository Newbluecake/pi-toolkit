// @vitest-environment happy-dom
/**
 * web-hub-privacy plan v2.1 (package P2) — the session privacy lock UI. Anchors from the
 * plan's 实施拆包 P2 row + 「客户端行为」节:
 *
 *  - 锁定态 `AgentDetail` 整棵子树不存在 (P0 — the gate is at DashboardView, not the transcript);
 *  - fail-closed: `privacy.v1` cap without the first `privacy` frame ⇒ NO session detail renders;
 *  - 回锁四路: route switch / idle timeout (fake timers) / manual 「立即锁定」 / visibilitychange;
 *  - 回锁关浮层: entering the locked state closes the App-level preview dialog;
 *  - loopback 变体: no password box, click-to-confirm, `verify` never called;
 *  - 手机 band 完全忽略 privacy (<768px: 照常渲染、无锁标、无锁屏);
 *  - 无 cap 零痕迹: no lock affordances anywhere;
 *  - 取消标记两变体: LAN password dialog vs loopback confirm (wire shapes pinned);
 *  - 标记 vs 立即锁定 naming separation (distinct i18n labels on the two header/card actions);
 *  - ask_user needsAnswer badge survives the lock on the card (内容解锁后才可见).
 */
import { flushPromises, mount } from "@vue/test-utils";
import { ref, type Ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, reduce } from "../../../src/web-hub/ui/src/logic/state.js";
import DashboardView from "../../../src/web-hub/ui/src/components/shell/DashboardView.vue";
import SettingsView from "../../../src/web-hub/ui/src/components/shell/SettingsView.vue";
import { CONTROL_ENV, HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import { PREVIEW_CTX, type PreviewContext } from "../../../src/web-hub/ui/src/components/preview/previewContext.js";
import type { HubHandle, HubState, Route } from "../../../src/web-hub/ui/src/types.js";
import type { PrivacyOutcome, PrivacyTransport } from "../../../src/web-hub/ui/src/transport/types.js";

type Msg = { event: string; data?: unknown; id?: number };
type LogicState = ReturnType<typeof initialState>;
const run = (msgs: Msg[], s = initialState()): LogicState => msgs.reduce((acc, m) => reduce(acc, m), s);

/** Query-aware matchMedia stub (dashboard-view.test.ts precedent): `narrow` = phone band. */
function stubMatchMedia(narrow: boolean): void {
  const map: Record<string, boolean> = {
    "(max-width: 767px)": narrow,
    "(max-width: 480px)": narrow,
    "(min-width: 1025px)": !narrow,
    "(min-width: 481px) and (max-width: 1024px)": false,
  };
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: map[query] ?? false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

const SID_A = "sid-secret-a";
const SID_B = "sid-public-b";

function card(agentKey: string, sessionId?: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentKey,
    kind: "tui",
    pid: 1,
    cwd: "/tmp/p",
    state: "live",
    pluginVersion: "1.0.0",
    outdated: false,
    prompts: [],
    ...(sessionId !== undefined
      ? { session: { sessionId, cwd: "/tmp/p", name: agentKey === "agent-a" ? "Secret session" : "Public session" } }
      : {}),
    ...extra,
  };
}

/** Reducer script: connect burst with (withCap) or without (withoutCap) the privacy cap/frame. */
function hubState(opts: { cap: boolean; frame: boolean; locked?: string[] }): LogicState {
  const msgs: Msg[] = [{ event: "hello", data: { clientId: "c1" } }];
  if (opts.cap) msgs.push({ event: "hub", data: { caps: ["privacy.v1"] } });
  if (opts.frame) msgs.push({ event: "privacy", data: { locked: opts.locked ?? [] } });
  msgs.push(
    { event: "agents", data: [card("agent-a", SID_A), card("agent-b", SID_B)] },
    { event: "subscribing", data: { agentKey: "agent-a", clientId: "c1" } },
    { event: "history", data: { agentKey: "agent-a", entries: [], tailMessages: [], fromSeq: 0, hasMore: false } },
    { event: "subscribing", data: { agentKey: "agent-b", clientId: "c1" } },
    { event: "history", data: { agentKey: "agent-b", entries: [], tailMessages: [], fromSeq: 0, hasMore: false } },
  );
  return run(msgs);
}

interface FakePrivacy extends PrivacyTransport {
  readonly verify: ReturnType<typeof vi.fn<(password: string) => Promise<PrivacyOutcome>>>;
  readonly lock: ReturnType<typeof vi.fn<(req: unknown) => Promise<PrivacyOutcome>>>;
}

function fakePrivacy(): FakePrivacy {
  return {
    verify: vi.fn(async () => ({ ok: true, data: { ok: true } }) as Promise<PrivacyOutcome>),
    lock: vi.fn(async () => ({ ok: true, data: { ok: true } }) as Promise<PrivacyOutcome>),
  };
}

interface Mounted {
  wrapper: ReturnType<typeof mount>;
  state: Ref<LogicState>;
  privacy: FakePrivacy;
  previewClose: ReturnType<typeof vi.fn<() => void>>;
  setRoute(route: Route): Promise<void>;
  pushFrame(locked: string[]): Promise<void>;
}

const mounted: Array<ReturnType<typeof mount>> = [];

function mountDashboard(opts: {
  route: Route;
  state: LogicState;
  mode?: "token" | "password";
  privacy?: FakePrivacy;
}): Mounted {
  const state = ref(opts.state) as Ref<LogicState>;
  const privacy = opts.privacy ?? fakePrivacy();
  const hub: HubHandle = {
    state: state as unknown as HubHandle["state"],
    dispatch: () => {},
    privacy,
  };
  const previewClose = vi.fn<() => void>();
  const previewCtx: PreviewContext = {
    plaintext: false,
    handle: {
      view: ref({ phase: "closed" }),
      scope: ref(null),
      open: () => {},
      close: previewClose,
      retry: () => {},
      dispose: () => {},
    } as unknown as PreviewContext["handle"],
  };
  const routeRef = ref(opts.route) as Ref<Route>;
  const wrapper = mount(DashboardView, {
    props: { hub, route: opts.route },
    global: {
      provide: {
        [HUB_CTX as symbol]: hub,
        [PREVIEW_CTX as symbol]: previewCtx,
        ...(opts.mode === "password"
          ? {
              [CONTROL_ENV as symbol]: {
                authMode: "password",
                plaintext: false,
                dialogDrafts: new Map(),
                noticeExpanded: ref(false),
              },
            }
          : {}),
      },
    },
  });
  mounted.push(wrapper);
  return {
    wrapper,
    state,
    privacy,
    previewClose,
    async setRoute(route: Route) {
      await wrapper.setProps({ route });
      await flushPromises();
    },
    async pushFrame(locked: string[]) {
      state.value = run([{ event: "privacy", data: { locked } }], state.value);
      await flushPromises();
    },
  };
}

async function unlockViaPassword(m: Mounted, password = "pw"): Promise<void> {
  const input = m.wrapper.find("#privacy-unlock-password");
  expect(input.exists()).toBe(true);
  await input.setValue(password);
  await m.wrapper.find(".privacy-lock-form").trigger("submit");
  await flushPromises();
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.style.overflow = "";
  document.body.style.overflow = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const w of mounted.splice(0)) w.unmount();
  document.documentElement.style.overflow = "";
  document.body.style.overflow = "";
  document.body.innerHTML = "";
  window.localStorage.clear();
});

describe("P0 gate — locked session never mounts AgentDetail", () => {
  it("locked viewed session: PrivacyLockScreen replaces the whole AgentDetail subtree", async () => {
    stubMatchMedia(false);
    const m = mountDashboard({
      route: { name: "agent", key: "agent-a" },
      state: hubState({ cap: true, frame: true, locked: [SID_A] }),
    });
    await flushPromises();
    expect(m.wrapper.find(".privacy-lock").exists()).toBe(true);
    expect(m.wrapper.find(".privacy-lock-session").text()).toBe("Secret session");
    // The WHOLE AgentDetail subtree is absent — header, panels, dock, composer, dialogs:
    expect(m.wrapper.find(".detail-head").exists()).toBe(false);
    expect(m.wrapper.find(".detail-body").exists()).toBe(false);
    expect(m.wrapper.find(".dock").exists()).toBe(false);
    expect(m.wrapper.find(".composer").exists()).toBe(false);
    expect(m.wrapper.find(".fleet-summary-bar").exists()).toBe(false);
  });

  it("unlocked viewed session renders AgentDetail normally while another session is locked", async () => {
    stubMatchMedia(false);
    const m = mountDashboard({
      route: { name: "agent", key: "agent-b" },
      state: hubState({ cap: true, frame: true, locked: [SID_A] }),
    });
    await flushPromises();
    expect(m.wrapper.find(".privacy-lock").exists()).toBe(false);
    expect(m.wrapper.find(".detail-head").exists()).toBe(true);
  });

  it("fail-closed: cap advertised but no privacy frame yet ⇒ NO session detail at all", async () => {
    stubMatchMedia(false);
    const m = mountDashboard({
      route: { name: "agent", key: "agent-b" },
      state: hubState({ cap: true, frame: false }),
    });
    await flushPromises();
    expect(m.wrapper.find('[data-privacy="fail-closed"]').exists()).toBe(true);
    expect(m.wrapper.find(".detail-head").exists()).toBe(false);
    expect(m.wrapper.find(".privacy-lock").exists()).toBe(false);
  });

  it("no privacy.v1 cap ⇒ byte-level zero trace (no lock screen, no card/header affordance)", async () => {
    stubMatchMedia(false);
    const m = mountDashboard({
      route: { name: "agent", key: "agent-a" },
      state: hubState({ cap: false, frame: false }),
    });
    await flushPromises();
    expect(m.wrapper.find(".detail-head").exists()).toBe(true);
    expect(m.wrapper.find(".privacy-lock").exists()).toBe(false);
    expect(m.wrapper.find(".privacy-lock-btn").exists()).toBe(false);
    expect(m.wrapper.find(".privacy-head-btn").exists()).toBe(false);
  });

  it("phone band (<768px) ignores privacy entirely: locked session renders, no badge, no lock screen", async () => {
    stubMatchMedia(true); // narrow
    const m = mountDashboard({
      route: { name: "agent", key: "agent-a" },
      state: hubState({ cap: true, frame: true, locked: [SID_A] }),
    });
    await flushPromises();
    expect(m.wrapper.find(".detail-head").exists()).toBe(true);
    expect(m.wrapper.find(".privacy-lock").exists()).toBe(false);
    // switch to the list route: no lock affordance on the cards either
    await m.setRoute({ name: "list" });
    expect(m.wrapper.find(".privacy-lock-btn").exists()).toBe(false);
  });

  it("a locked session's card keeps the needsAnswer badge (内容解锁后才可见)", async () => {
    stubMatchMedia(false);
    const state = run([
      { event: "hello", data: { clientId: "c1" } },
      { event: "hub", data: { caps: ["privacy.v1"] } },
      { event: "privacy", data: { locked: [SID_A] } },
      {
        event: "agents",
        data: [
          card("agent-a", SID_A, { dialogs: { open: [{ dialogId: "ask:1" }], closed: [], epoch: "e1" } }),
          card("agent-b", SID_B),
        ],
      },
    ]);
    const m = mountDashboard({ route: { name: "list" }, state });
    await flushPromises();
    const cardEl = m.wrapper.find('a.agent-card[href="#/agent/agent-a"]');
    expect(cardEl.exists()).toBe(true);
    expect(cardEl.find(".badge-answer").exists()).toBe(true);
    expect(cardEl.find(".privacy-lock-btn").exists()).toBe(true); // 锁定态常显
  });
});

describe("unlock — password (LAN) variant", () => {
  it("verify 200 {ok:true} unlocks the view; the password reaches the transport verbatim", async () => {
    stubMatchMedia(false);
    const m = mountDashboard({
      route: { name: "agent", key: "agent-a" },
      state: hubState({ cap: true, frame: true, locked: [SID_A] }),
      mode: "password",
    });
    await flushPromises();
    expect(m.wrapper.find(".privacy-lock-form").exists()).toBe(true);
    await unlockViaPassword(m, "s3cret");
    expect(m.privacy.verify).toHaveBeenCalledWith("s3cret");
    expect(m.wrapper.find(".detail-head").exists()).toBe(true);
    expect(m.wrapper.find(".privacy-lock").exists()).toBe(false);
  });

  it("verify 200 {ok:false} is a VERDICT (invalid-password line, stays locked) — never an error/401", async () => {
    stubMatchMedia(false);
    const privacy = fakePrivacy();
    privacy.verify.mockResolvedValue({ ok: true, data: { ok: false } });
    const m = mountDashboard({
      route: { name: "agent", key: "agent-a" },
      state: hubState({ cap: true, frame: true, locked: [SID_A] }),
      mode: "password",
      privacy,
    });
    await flushPromises();
    await unlockViaPassword(m);
    expect(m.wrapper.find(".privacy-lock").exists()).toBe(true);
    expect(m.wrapper.find(".form-error").text()).toBe("Invalid username or password.");
    expect(m.wrapper.find(".detail-head").exists()).toBe(false);
  });

  it("verify 429 rides the login-style countdown (retryAfterS ticks down, then re-enables)", async () => {
    vi.useFakeTimers();
    stubMatchMedia(false);
    const privacy = fakePrivacy();
    privacy.verify.mockResolvedValue({ ok: false, status: 429, error: "E_RATE", retryAfterS: 3 });
    const m = mountDashboard({
      route: { name: "agent", key: "agent-a" },
      state: hubState({ cap: true, frame: true, locked: [SID_A] }),
      mode: "password",
      privacy,
    });
    await flushPromises();
    await unlockViaPassword(m);
    expect(m.wrapper.find(".form-error").text()).toContain("3s");
    expect(m.wrapper.find('.privacy-lock-form button[type="submit"]').attributes("disabled")).toBeDefined();
    await vi.advanceTimersByTimeAsync(3_100);
    await flushPromises();
    expect(m.wrapper.find(".form-error").text()).toBe("");
    expect(m.wrapper.find('.privacy-lock-form button[type="submit"]').attributes("disabled")).toBeUndefined();
  });
});

describe("unlock — loopback (token) variant", () => {
  it("click-to-confirm only: no password box, no verify request, unlocks the view", async () => {
    stubMatchMedia(false);
    const m = mountDashboard({
      route: { name: "agent", key: "agent-a" },
      state: hubState({ cap: true, frame: true, locked: [SID_A] }),
      // no CONTROL_ENV ⇒ token mode
    });
    await flushPromises();
    expect(m.wrapper.find("#privacy-unlock-password").exists()).toBe(false);
    const confirm = m.wrapper.find(".privacy-lock-confirm");
    expect(confirm.exists()).toBe(true);
    expect(confirm.text()).toBe("Click to view");
    await confirm.trigger("click");
    await flushPromises();
    expect(m.privacy.verify).not.toHaveBeenCalled();
    expect(m.wrapper.find(".detail-head").exists()).toBe(true);
  });
});

describe("回锁四路 (four relock paths)", () => {
  async function unlockedView(): Promise<Mounted> {
    stubMatchMedia(false);
    const m = mountDashboard({
      route: { name: "agent", key: "agent-a" },
      state: hubState({ cap: true, frame: true, locked: [SID_A] }),
      mode: "password",
    });
    await flushPromises();
    await unlockViaPassword(m);
    expect(m.wrapper.find(".detail-head").exists()).toBe(true);
    return m;
  }

  it("① route switch relocks (view state is pure memory)", async () => {
    const m = await unlockedView();
    await m.setRoute({ name: "list" });
    await m.setRoute({ name: "agent", key: "agent-a" });
    expect(m.wrapper.find(".privacy-lock").exists()).toBe(true);
    expect(m.wrapper.find(".detail-head").exists()).toBe(false);
    expect(m.privacy.verify).toHaveBeenCalledTimes(1); // relocking never re-verifies
  });

  it("② idle timeout relocks (default 10min; interaction resets the clock; viewing-only)", async () => {
    vi.useFakeTimers();
    const m = await unlockedView();
    // 9 minutes idle, then a keydown (interaction) resets the countdown…
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    window.dispatchEvent(new KeyboardEvent("keydown"));
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    await flushPromises();
    expect(m.wrapper.find(".detail-head").exists()).toBe(true); // …still unlocked
    await vi.advanceTimersByTimeAsync(61_000);
    await flushPromises();
    expect(m.wrapper.find(".privacy-lock").exists()).toBe(true); // 10min after the last interaction
  });

  it("② the idle clock honors the pwh_privacy_timeout browser pref", async () => {
    window.localStorage.setItem("pwh_privacy_timeout", "1");
    vi.useFakeTimers();
    const m = await unlockedView();
    await vi.advanceTimersByTimeAsync(61_000);
    await flushPromises();
    expect(m.wrapper.find(".privacy-lock").exists()).toBe(true);
  });

  it("③ the header's 「立即锁定」 relocks the view (no request)", async () => {
    const m = await unlockedView();
    const btn = m.wrapper.find(".privacy-head-btn");
    expect(btn.exists()).toBe(true);
    expect(btn.attributes("aria-label")).toBe("Relock this session's view immediately");
    expect(btn.attributes("title")).toBe("Lock now");
    expect(btn.get(".head-btn-label").text()).toBe("Lock"); // marked ⇒ 「锁定」 label
    expect(btn.get(".head-btn-label").attributes("aria-hidden")).toBe("true");
    await btn.trigger("click");
    await flushPromises();
    expect(m.wrapper.find(".privacy-lock").exists()).toBe(true);
    expect(m.privacy.lock).not.toHaveBeenCalled(); // pure client-side
  });

  it("④ visibilitychange: hidden relocks immediately", async () => {
    const m = await unlockedView();
    const original = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    try {
      document.dispatchEvent(new Event("visibilitychange"));
      await flushPromises();
      expect(m.wrapper.find(".privacy-lock").exists()).toBe(true);
    } finally {
      if (original !== undefined) Object.defineProperty(document, "visibilityState", original);
      else delete (document as unknown as Record<string, unknown>)["visibilityState"];
    }
  });

  it("entering the locked state closes the session's preview dialog (回锁关浮层)", async () => {
    const m = await unlockedView();
    expect(m.previewClose).not.toHaveBeenCalled();
    const btn = m.wrapper.find(".privacy-head-btn");
    await btn.trigger("click");
    await flushPromises();
    expect(m.previewClose).toHaveBeenCalledTimes(1);
  });

  it("another tab marking the VIEWED session locks it instantly and closes the preview (标记瞬间)", async () => {
    stubMatchMedia(false);
    // viewing the UNMARKED public session; then a privacy frame marks it
    const m = mountDashboard({
      route: { name: "agent", key: "agent-b" },
      state: hubState({ cap: true, frame: true, locked: [] }),
      mode: "password",
    });
    await flushPromises();
    expect(m.wrapper.find(".detail-head").exists()).toBe(true);
    await m.pushFrame([SID_B]);
    expect(m.wrapper.find(".privacy-lock").exists()).toBe(true);
    expect(m.wrapper.find(".detail-head").exists()).toBe(false);
    expect(m.previewClose).toHaveBeenCalled();
  });
});

describe("标记 / 取消标记", () => {
  it("card affordance on an UNMARKED session marks it directly (locked:true, no password)", async () => {
    stubMatchMedia(false);
    const m = mountDashboard({
      route: { name: "list" },
      state: hubState({ cap: true, frame: true, locked: [] }),
      mode: "password",
    });
    await flushPromises();
    const btn = m.wrapper.find('a.agent-card[href="#/agent/agent-b"] .privacy-lock-btn');
    expect(btn.exists()).toBe(true);
    expect(btn.attributes("aria-label")).toBe("Mark this session as private");
    await btn.trigger("click");
    await flushPromises();
    expect(m.privacy.lock).toHaveBeenCalledWith({ agentKey: "agent-b", sessionId: SID_B, locked: true });
    // the hub's answering broadcast flips the badge/screen (simulate it)
    await m.pushFrame([SID_B]);
    const lockedBtn = m.wrapper.find('a.agent-card[href="#/agent/agent-b"] .privacy-lock-btn');
    expect(lockedBtn.attributes("aria-label")).toBe("Remove privacy mark");
  });

  it("取消标记 (LAN): password dialog, password rides the request only", async () => {
    stubMatchMedia(false);
    const m = mountDashboard({
      route: { name: "list" },
      state: hubState({ cap: true, frame: true, locked: [SID_A] }),
      mode: "password",
    });
    await flushPromises();
    await m.wrapper.find('a.agent-card[href="#/agent/agent-a"] .privacy-lock-btn').trigger("click");
    await flushPromises();
    const dialog = document.body.querySelector(".privacy-unmark");
    expect(dialog).not.toBeNull();
    const input = document.body.querySelector<HTMLInputElement>("#privacy-unmark-password");
    expect(input).not.toBeNull();
    input!.value = "pw-unmark";
    input!.dispatchEvent(new Event("input"));
    const form = document.body.querySelector(".privacy-unmark-form")!;
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flushPromises();
    expect(m.privacy.lock).toHaveBeenCalledWith({
      agentKey: "agent-a",
      sessionId: SID_A,
      locked: false,
      password: "pw-unmark",
    });
    expect(document.body.querySelector(".privacy-unmark")).toBeNull(); // closed on success
  });

  it("取消标记 (loopback): confirm dialog without a password field", async () => {
    stubMatchMedia(false);
    const m = mountDashboard({
      route: { name: "list" },
      state: hubState({ cap: true, frame: true, locked: [SID_A] }),
      // token mode
    });
    await flushPromises();
    await m.wrapper.find('a.agent-card[href="#/agent/agent-a"] .privacy-lock-btn').trigger("click");
    await flushPromises();
    expect(document.body.querySelector("#privacy-unmark-password")).toBeNull();
    const buttons = [...document.body.querySelectorAll<HTMLButtonElement>(".privacy-unmark-actions button")];
    const confirm = buttons.find((b) => b.textContent === "Remove mark");
    expect(confirm).toBeDefined();
    confirm!.click();
    await flushPromises();
    expect(m.privacy.lock).toHaveBeenCalledWith({ agentKey: "agent-a", sessionId: SID_A, locked: false });
    expect(document.body.querySelector(".privacy-unmark")).toBeNull();
  });

  it("取消标记 (LAN) wrong-password verdict keeps the dialog open with the invalid line", async () => {
    stubMatchMedia(false);
    const privacy = fakePrivacy();
    privacy.lock.mockResolvedValue({ ok: true, data: { ok: false } });
    const m = mountDashboard({
      route: { name: "list" },
      state: hubState({ cap: true, frame: true, locked: [SID_A] }),
      mode: "password",
      privacy,
    });
    await flushPromises();
    await m.wrapper.find('a.agent-card[href="#/agent/agent-a"] .privacy-lock-btn').trigger("click");
    await flushPromises();
    const form = document.body.querySelector(".privacy-unmark-form")!;
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flushPromises();
    expect(document.body.querySelector(".privacy-unmark")).not.toBeNull();
    expect(document.body.querySelector(".privacy-unmark .form-error")?.textContent).toBe(
      "Invalid username or password.",
    );
  });
});

describe("命名分离 (「隐私标记」 vs 「立即锁定」)", () => {
  it("the mark action and the view-relock action carry distinct i18n labels", async () => {
    stubMatchMedia(false);
    const m = mountDashboard({
      route: { name: "agent", key: "agent-b" },
      state: hubState({ cap: true, frame: true, locked: [SID_A] }),
      mode: "password",
    });
    await flushPromises();
    // unmarked session (agent-b being viewed): header button = 「隐私标记」
    const headBtn = m.wrapper.find(".privacy-head-btn");
    expect(headBtn.exists()).toBe(true);
    expect(headBtn.attributes("aria-label")).toBe("Mark this session as private");
    expect(headBtn.attributes("title")).toBe("Mark private");
    expect(headBtn.get(".head-btn-label").text()).toBe("Private"); // unmarked ⇒ 「隐私」 label
    // mark it → broadcast → now viewing a marked session ⇒ the SAME button becomes 「立即锁定」
    await headBtn.trigger("click");
    await flushPromises();
    expect(m.privacy.lock).toHaveBeenCalledWith({ agentKey: "agent-b", sessionId: SID_B, locked: true });
    await m.pushFrame([SID_B]); // marked while viewing ⇒ lock screen (标记瞬间)
    expect(m.wrapper.find(".privacy-lock").exists()).toBe(true);
    await unlockViaPassword(m);
    const headBtn2 = m.wrapper.find(".privacy-head-btn");
    expect(headBtn2.attributes("aria-label")).toBe("Relock this session's view immediately");
    expect(headBtn2.attributes("title")).toBe("Lock now");
  });
});

describe("settings — idle timeout card", () => {
  function mountSettings(caps: string[]) {
    const hub = {
      state: ref({ hub: { caps }, agents: new Map(), order: [] } as unknown as HubState),
      dispatch: () => {},
    } as unknown as HubHandle;
    const w = mount(SettingsView, { attachTo: document.body, global: { provide: { [HUB_CTX as symbol]: hub } } });
    mounted.push(w);
    return w;
  }

  it("renders only with the privacy.v1 cap (无 cap 零痕迹)", () => {
    const without = mountSettings([]);
    expect(without.find(".settings-privacy-timeout").exists()).toBe(false);
    without.unmount();
    const withCap = mountSettings(["privacy.v1"]);
    expect(withCap.find(".settings-privacy-timeout").exists()).toBe(true);
  });

  it("persists a valid value and falls back to the default for junk", async () => {
    const w = mountSettings(["privacy.v1"]);
    const input = w.find(".settings-privacy-timeout");
    await input.setValue("15");
    await input.trigger("change");
    expect(window.localStorage.getItem("pwh_privacy_timeout")).toBe("15");
    await input.setValue("999");
    await input.trigger("change");
    expect(window.localStorage.getItem("pwh_privacy_timeout")).toBe("10"); // out of range ⇒ default
  });
});
