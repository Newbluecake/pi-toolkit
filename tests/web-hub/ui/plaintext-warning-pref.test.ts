// @vitest-environment happy-dom
/**
 * `pwh_hide_plaintext_warn` (`composables/usePlaintextWarning.ts`, 2026-10 user opt-out —
 * "http警告支持通过设置关闭"; AGENTS.md web-hub U1 rulings: the sole LAN user behind password
 * auth explicitly accepts the plaintext risk). One browser-local pref hides EVERY plaintext-HTTP
 * warning in the UI: ControlNotice's plainHttp body (masked to its control-risk remainder, never
 * removed wholesale), AttachmentTray's §4.2 line, WorktreeDiffDialog, PreviewHost, SpawnConfirm,
 * HistoryForkConfirm and LoginView's sign-in banner. Pinned here:
 *
 *  - pref absent/invalid ⇒ every warning still renders — byte-identical default, fail-open;
 *  - pref "1" ⇒ each warning hidden (ControlNotice keeps the non-plaintext remainder);
 *  - the SettingsView card (only rendered on a plaintext page — CONTROL_ENV.plaintext, the same
 *    predicate every warning uses) flips a MOUNTED warning live in the same tab;
 *  - a `storage` event from ANOTHER tab flips visibility too (cross-tab sync);
 *  - en/zh key parity for the new i18n leaves (the global i18n-parity suite enforces the whole
 *    dictionary; this pins the specific new keys so a partial edit fails with a pointed message).
 */
import { mount } from "@vue/test-utils";
import { nextTick, ref, type Ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AttachmentTray from "../../../src/web-hub/ui/src/components/control/AttachmentTray.vue";
import ControlNotice from "../../../src/web-hub/ui/src/components/control/ControlNotice.vue";
import { CONTROL_ENV, type ControlEnv } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import WorktreeDiffDialog from "../../../src/web-hub/ui/src/components/diff/WorktreeDiffDialog.vue";
import PreviewHost from "../../../src/web-hub/ui/src/components/preview/PreviewHost.vue";
import { PREVIEW_CTX, type PreviewContext } from "../../../src/web-hub/ui/src/components/preview/previewContext.js";
import HistoryForkConfirm from "../../../src/web-hub/ui/src/components/spawn/HistoryForkConfirm.vue";
import SpawnConfirm from "../../../src/web-hub/ui/src/components/spawn/SpawnConfirm.vue";
import SettingsView from "../../../src/web-hub/ui/src/components/shell/SettingsView.vue";
import LoginView from "../../../src/web-hub/ui/src/components/shell/LoginView.vue";
import { resetBodyScrollLock } from "../../../src/web-hub/ui/src/composables/useScrollLock.js";
import type { DialogState } from "../../../src/web-hub/ui/src/composables/useWorktreeDiff.js";
import {
  PLAINTEXT_WARN_STORAGE_KEY,
  loadPlaintextHidden,
  parsePlaintextHidden,
  resetPlaintextWarningForTests,
  setPlaintextHiddenPref,
  usePlaintextWarning,
  type PlaintextStorageEvent,
  type PlaintextWarnWindow,
} from "../../../src/web-hub/ui/src/composables/usePlaintextWarning.js";
import type { PreviewHandle, PreviewView, Attachment } from "../../../src/web-hub/ui/src/types.js";
import { MESSAGES } from "../../../src/web-hub/ui/src/i18n/index.js";

const mounted: Array<ReturnType<typeof mount>> = [];

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
  resetBodyScrollLock();
  document.body.style.overflow = "";
  document.body.innerHTML = "";
  resetPlaintextWarningForTests();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

// --- mount helpers (each mounts the component in its warning-bearing state) -------------------

function track<T extends ReturnType<typeof mount>>(w: T): T {
  mounted.push(w);
  return w;
}

function mountTray() {
  const item: Attachment = { id: "a1", name: "shot.png", size: 12, mime: "image/png", state: "ready" };
  return track(mount(AttachmentTray, { props: { items: [item], plaintext: true } }));
}

function mountSpawnConfirm() {
  return track(mount(SpawnConfirm, { props: { resolvedCwd: "/home/u/proj", plaintext: true } }));
}

function mountForkConfirm() {
  return track(mount(HistoryForkConfirm, { props: { reason: "manual", plaintext: true } }));
}

function mountNotice() {
  return track(mount(ControlNotice, { props: { mode: "password", plaintext: true } }));
}

function mountLogin() {
  return track(mount(LoginView, { props: { plaintext: true, busy: false, error: null, initialPasswordHint: false } }));
}

const OID = "b".repeat(40);

function mountDiffDialog() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const state: DialogState = {
    phase: "loading",
    wt: "/wt/main",
    entry: { path: "src/a.ts", status: "M", add: 1, del: 0 },
    base: OID,
    stale: false,
  };
  return track(
    mount(WorktreeDiffDialog, { attachTo: host, props: { state, mode: "split", mobile: false, plaintext: true } }),
  );
}

function mountPreviewHost() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = ref<PreviewView>({ phase: "closed" }) as Ref<PreviewView>;
  const handle: PreviewHandle = {
    view,
    scope: ref(null),
    open: vi.fn(),
    close: vi.fn(() => {
      view.value = { phase: "closed" };
    }),
    retry: vi.fn(),
    dispose: vi.fn(),
  };
  const ctx: PreviewContext = { handle, plaintext: true };
  const w = track(mount(PreviewHost, { attachTo: host, global: { provide: { [PREVIEW_CTX as symbol]: ctx } } }));
  return { w, view };
}

function fakeEnv(over: Partial<ControlEnv> = {}): ControlEnv {
  return { authMode: "token", plaintext: false, dialogDrafts: new Map(), noticeExpanded: ref(false), ...over };
}

function mountSettings(env: ControlEnv | null) {
  return track(mount(SettingsView, { global: { provide: env ? { [CONTROL_ENV as symbol]: env } : {} } }));
}

const tick = async (): Promise<void> => {
  await nextTick();
  await nextTick();
};

// --- the pref itself --------------------------------------------------------------------------

describe("usePlaintextWarning — pure pref read/write", () => {
  it('only the exact token "1" parses as hidden; everything else fails open to shown', () => {
    expect(parsePlaintextHidden("1")).toBe(true);
    for (const raw of ["0", "true", "yes", "", " 1", "2", "on"]) expect(parsePlaintextHidden(raw)).toBe(false);
    expect(parsePlaintextHidden(null)).toBe(false);
  });

  it("loadPlaintextHidden: absent ⇒ false; '1' ⇒ true; a throwing storage fails open to false", () => {
    const storage = new Map<string, string>();
    const shim = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
    };
    expect(loadPlaintextHidden(shim)).toBe(false);
    storage.set(PLAINTEXT_WARN_STORAGE_KEY, "1");
    expect(loadPlaintextHidden(shim)).toBe(true);
    const throwing = {
      getItem: () => {
        throw new Error("locked");
      },
      setItem: () => {
        throw new Error("locked");
      },
    };
    expect(loadPlaintextHidden(throwing)).toBe(false);
  });

  it("setPlaintextHiddenPref persists '1'/'0' and ignores write failures", () => {
    const storage = new Map<string, string>();
    const shim = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
    };
    setPlaintextHiddenPref(shim, true);
    expect(storage.get(PLAINTEXT_WARN_STORAGE_KEY)).toBe("1");
    setPlaintextHiddenPref(shim, false);
    expect(storage.get(PLAINTEXT_WARN_STORAGE_KEY)).toBe("0");
    const throwing = {
      getItem: (): string | null => null,
      setItem: () => {
        throw new Error("locked");
      },
    };
    expect(() => setPlaintextHiddenPref(throwing, true)).not.toThrow();
  });
});

// --- the seven warning sites ------------------------------------------------------------------

describe("pwh_hide_plaintext_warn gates every plaintext warning", () => {
  it("pref absent ⇒ every warning still renders (pins the pre-feature default)", async () => {
    const tray = mountTray();
    expect(tray.find(".tray-plain-warning").exists()).toBe(true);
    expect(tray.find(".tray-plain-warning").text()).toContain("Plain HTTP");

    expect(mountSpawnConfirm().find(".spawn-plain-warning").exists()).toBe(true);
    expect(mountForkConfirm().find(".spawn-plain-warning").exists()).toBe(true);

    const notice = mountNotice();
    expect(notice.find(".notice-body").text()).toContain("plain HTTP"); // the full plainHttp body

    expect(mountLogin().text()).toContain("Plain HTTP");

    mountDiffDialog();
    expect(document.querySelector(".wtd-plaintext")).not.toBeNull();

    const { view } = mountPreviewHost();
    view.value = { phase: "loading", path: "/p/a.ts" };
    await tick();
    expect(document.querySelector(".preview-plaintext")).not.toBeNull();
  });

  it('pref "1" ⇒ each warning hidden; ControlNotice keeps its non-plaintext remainder', async () => {
    window.localStorage.setItem(PLAINTEXT_WARN_STORAGE_KEY, "1");

    expect(mountTray().find(".tray-plain-warning").exists()).toBe(false);
    expect(mountSpawnConfirm().find(".spawn-plain-warning").exists()).toBe(false);
    expect(mountForkConfirm().find(".spawn-plain-warning").exists()).toBe(false);

    // The banner itself stays (control risk ≠ plaintext risk): only the plaintext sentence drops.
    const notice = mountNotice();
    expect(notice.find(".control-notice").exists()).toBe(true);
    expect(notice.find(".notice-body").text()).not.toContain("plain HTTP");
    expect(notice.find(".notice-body").text()).toContain("send messages to your agents");

    const login = mountLogin();
    expect(login.text()).not.toContain("Plain HTTP");
    expect(login.find(".login-notices").exists()).toBe(false); // no other notice to keep alive

    mountDiffDialog();
    expect(document.querySelector(".wtd-plaintext")).toBeNull();

    const { view } = mountPreviewHost();
    view.value = { phase: "loading", path: "/p/a.ts" };
    await tick();
    expect(document.querySelector(".preview-plaintext")).toBeNull();
  });

  it("invalid stored values are treated as off (fail open to showing)", () => {
    for (const raw of ["true", "yes", "0"]) {
      window.localStorage.setItem(PLAINTEXT_WARN_STORAGE_KEY, raw);
      expect(mountSpawnConfirm().find(".spawn-plain-warning").exists()).toBe(true);
    }
  });

  it("non-plaintext transport never shows a warning, regardless of the pref", () => {
    window.localStorage.setItem(PLAINTEXT_WARN_STORAGE_KEY, "1"); // even hidden ⇒ no change visible
    const tray = track(mount(AttachmentTray, { props: { items: [], plaintext: false } }));
    expect(tray.find(".tray-plain-warning").exists()).toBe(false);
    const notice = track(mount(ControlNotice, { props: { mode: "token" } }));
    expect(notice.find(".notice-body").text()).toContain("this computer's"); // local variant untouched
  });
});

// --- the settings card ------------------------------------------------------------------------

describe("SettingsView — the 「明文 HTTP 警告」 card", () => {
  it("renders ONLY on a plaintext page (CONTROL_ENV.plaintext — https/loopback pages omit it)", () => {
    expect(mountSettings(fakeEnv({ authMode: "password", plaintext: true })).text()).toContain(
      "Plaintext HTTP warnings",
    );
    expect(mountSettings(fakeEnv({ authMode: "password", plaintext: false })).text()).not.toContain(
      "Plaintext HTTP warnings",
    );
    expect(mountSettings(null).text()).not.toContain("Plaintext HTTP warnings");
  });

  it("toggling in settings flips a MOUNTED warning live (same tab) and persists", async () => {
    const settings = mountSettings(fakeEnv({ authMode: "password", plaintext: true }));
    const spawn = mountSpawnConfirm();
    expect(spawn.find(".spawn-plain-warning").exists()).toBe(true);

    const section = settings.find('section[aria-label="Plaintext HTTP warnings"]');
    expect(section.exists()).toBe(true);
    const options = section.findAll(".settings-option");
    expect(options).toHaveLength(2);
    expect(options[0]!.attributes("aria-checked")).toBe("true"); // default: show

    await options[1]!.trigger("click"); // hide
    expect(window.localStorage.getItem(PLAINTEXT_WARN_STORAGE_KEY)).toBe("1");
    await tick();
    expect(spawn.find(".spawn-plain-warning").exists()).toBe(false);
    expect(section.findAll(".settings-option")[1]!.attributes("aria-checked")).toBe("true");

    await section.findAll(".settings-option")[0]!.trigger("click"); // back to show
    expect(window.localStorage.getItem(PLAINTEXT_WARN_STORAGE_KEY)).toBe("0");
    await tick();
    expect(spawn.find(".spawn-plain-warning").exists()).toBe(true);
  });

  it("a stored pref '1' is reflected by the card on mount", () => {
    window.localStorage.setItem(PLAINTEXT_WARN_STORAGE_KEY, "1");
    const settings = mountSettings(fakeEnv({ authMode: "password", plaintext: true }));
    const options = settings.find('section[aria-label="Plaintext HTTP warnings"]').findAll(".settings-option");
    expect(options[0]!.attributes("aria-checked")).toBe("false");
    expect(options[1]!.attributes("aria-checked")).toBe("true");
  });
});

// --- cross-tab sync ---------------------------------------------------------------------------

describe("cross-tab sync via the storage event", () => {
  function fakeWin() {
    const listeners: Array<(ev: PlaintextStorageEvent) => void> = [];
    const win: PlaintextWarnWindow = {
      addEventListener: (_t, l) => void listeners.push(l),
      removeEventListener: () => {},
    };
    return {
      win,
      fire: (ev: PlaintextStorageEvent) => {
        for (const l of listeners) l(ev);
      },
    };
  }

  it("another tab writing the pref flips a mounted warning here", async () => {
    const { win, fire } = fakeWin();
    usePlaintextWarning({ storage: window.localStorage, win }); // register the fake listener first
    const spawn = mountSpawnConfirm();
    expect(spawn.find(".spawn-plain-warning").exists()).toBe(true);

    fire({ key: PLAINTEXT_WARN_STORAGE_KEY, newValue: "1" });
    await tick();
    expect(spawn.find(".spawn-plain-warning").exists()).toBe(false);

    fire({ key: PLAINTEXT_WARN_STORAGE_KEY, newValue: "0" });
    await tick();
    expect(spawn.find(".spawn-plain-warning").exists()).toBe(true);
  });

  it("an unrelated key is ignored; a storage.clear() (key null) re-reads the pref", async () => {
    window.localStorage.setItem(PLAINTEXT_WARN_STORAGE_KEY, "1");
    const { win, fire } = fakeWin();
    usePlaintextWarning({ storage: window.localStorage, win });
    const spawn = mountSpawnConfirm();
    expect(spawn.find(".spawn-plain-warning").exists()).toBe(false); // pref "1" from storage

    fire({ key: "pwh_something_else", newValue: "1" });
    await tick();
    expect(spawn.find(".spawn-plain-warning").exists()).toBe(false); // untouched

    window.localStorage.removeItem(PLAINTEXT_WARN_STORAGE_KEY); // the other tab cleared storage
    fire({ key: null, newValue: null });
    await tick();
    expect(spawn.find(".spawn-plain-warning").exists()).toBe(true);
  });
});

// --- i18n parity pin --------------------------------------------------------------------------

describe("i18n leaves exist in BOTH languages (global parity suite enforces the rest)", () => {
  it("settings.plainWarn* and control.noticePlainHttpMasked", () => {
    for (const lang of ["en", "zh"] as const) {
      const settings = MESSAGES[lang]?.["settings"];
      expect(settings?.plainWarnSection, `${lang}.settings.plainWarnSection`).toBeTruthy();
      expect(settings?.plainWarnHint, `${lang}.settings.plainWarnHint`).toBeTruthy();
      expect(settings?.plainWarnShow, `${lang}.settings.plainWarnShow`).toBeTruthy();
      expect(settings?.plainWarnHide, `${lang}.settings.plainWarnHide`).toBeTruthy();
      const control = MESSAGES[lang]?.["control"];
      expect(control?.noticePlainHttpMasked, `${lang}.control.noticePlainHttpMasked`).toBeTruthy();
    }
  });
});
