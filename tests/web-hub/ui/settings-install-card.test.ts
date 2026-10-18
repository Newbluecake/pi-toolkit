// @vitest-environment happy-dom
/**
 * `shell/SettingsView.vue`'s 「安装为应用」 card (2026-10-18 PWA install guidance) + the
 * browser half `composables/useInstallPrompt.ts`: the boot-wired `beforeinstallprompt`
 * capture (preventDefault + hold), the install click reflecting `userChoice`, `appinstalled`
 * latching the installed state, and the standalone / insecure-origin guidance rows.
 *
 * Determinism notes (probed against this happy-dom version): `window.isSecureContext` is
 * ABSENT (reads undefined ⇒ the insecure branch is the default secure-side fallback),
 * `matchMedia(...).matches` is false, and the UA classifies as "other" — so every state below
 * is driven explicitly (defineProperty / matchMedia stub / synthetic events), never by env
 * accidents.
 */
import { mount, flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsView from "../../../src/web-hub/ui/src/components/shell/SettingsView.vue";
import {
  resetInstallPromptForTests,
  wireInstallPromptCapture,
  type BeforeInstallPromptEvent,
} from "../../../src/web-hub/ui/src/composables/useInstallPrompt.js";

const mounted: Array<ReturnType<typeof mount>> = [];

/** Synthetic spec-shaped event: a plain Event carrying `prompt()` + `userChoice`. */
function installEvent(outcome: "accepted" | "dismissed"): BeforeInstallPromptEvent {
  const ev = new Event("beforeinstallprompt") as BeforeInstallPromptEvent;
  Object.defineProperty(ev, "prompt", { value: vi.fn(async () => {}) });
  Object.defineProperty(ev, "userChoice", {
    value: Promise.resolve({ outcome, platform: "web" }),
  });
  return ev;
}

function mountCard() {
  const w = mount(SettingsView, { attachTo: document.body });
  mounted.push(w);
  return w;
}

function textOf(w: ReturnType<typeof mount>): string {
  return w.text();
}

function defineSecure(v: boolean | undefined): void {
  // happy-dom ships no isSecureContext descriptor at all — define/redefine freely.
  Object.defineProperty(window, "isSecureContext", { value: v, configurable: true });
}

beforeEach(() => {
  window.localStorage.clear();
  resetInstallPromptForTests();
  vi.unstubAllGlobals();
});

afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
  window.localStorage.clear();
  resetInstallPromptForTests();
  vi.unstubAllGlobals();
  delete (window as { isSecureContext?: boolean }).isSecureContext;
});

describe("useInstallPrompt capture (boot wiring)", () => {
  it("wireInstallPromptCapture holds a spec-shaped beforeinstallprompt (preventDefault'd) and drops impostors", () => {
    wireInstallPromptCapture(window);
    const ev = installEvent("dismissed");
    const pd = vi.spyOn(ev, "preventDefault");
    window.dispatchEvent(ev);
    expect(pd).toHaveBeenCalledOnce();
    const impostor = new Event("beforeinstallprompt"); // no prompt()/userChoice surface
    expect(() => window.dispatchEvent(impostor)).not.toThrow(); // ignored, never captured
  });

  it("prompt() is one-shot: after the click resolves, the state falls back to guidance until the browser re-fires", async () => {
    defineSecure(true);
    wireInstallPromptCapture(window);
    window.dispatchEvent(installEvent("dismissed"));
    const w = mountCard();
    const btn = w.find("button.btn-primary");
    expect(btn.exists()).toBe(true);
    await btn.trigger("click");
    await flushPromises();
    // dismissed outcome note is reflected…
    expect(textOf(w)).toContain("Dismissed");
    // …and the button is gone (no held event any more → guidance row for the "other" UA)
    expect(w.find("button.btn-primary").exists()).toBe(false);
  });

  it("userChoice accepted reflects the installing note; appinstalled latches the installed state", async () => {
    defineSecure(true);
    wireInstallPromptCapture(window);
    window.dispatchEvent(installEvent("accepted"));
    const w = mountCard();
    await w.find("button.btn-primary").trigger("click");
    await flushPromises();
    expect(textOf(w)).toContain("Installing");
    window.dispatchEvent(new Event("appinstalled"));
    await flushPromises();
    expect(textOf(w)).toContain("Installed");
    expect(w.find("button.btn-primary").exists()).toBe(false);
  });
});

describe("SettingsView 「安装为应用」 card states", () => {
  it("standalone display mode → installed status row, no button, no steps", () => {
    // useMedia (settings' narrow probe) also calls add/removeEventListener on the same MQL —
    // the stub carries no-op listeners so only `matches` differs by query.
    vi.stubGlobal(
      "matchMedia",
      (query: string) =>
        ({
          matches: query === "(display-mode: standalone)",
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as MediaQueryList,
    );
    defineSecure(false);
    const w = mountCard();
    expect(textOf(w)).toContain("Installed");
    expect(w.find("button.btn-primary").exists()).toBe(false);
    expect(textOf(w)).not.toContain("chrome://flags");
  });

  it("insecure context → chrome://flags whitelist guidance with the live origin chip + copy button", () => {
    defineSecure(false); // happy-dom default is undefined; make the branch explicit
    const w = mountCard();
    const text = textOf(w);
    expect(text).toContain("Install as app");
    expect(text).toContain("chrome://flags/#unsafely-treat-insecure-origin-as-secure");
    expect(text).toContain("Enabled");
    const chip = w.find(".settings-install-origin-chip");
    expect(chip.exists()).toBe(true);
    expect(chip.text()).toBe(window.location.origin); // the CURRENT origin, rendered
    expect(w.findComponent({ name: "CopyButton" }).exists()).toBe(true);
  });

  it("captured prompt → install button beats the insecure guidance", () => {
    defineSecure(false);
    wireInstallPromptCapture(window);
    window.dispatchEvent(installEvent("accepted"));
    const w = mountCard();
    expect(w.find("button.btn-primary").exists()).toBe(true);
    expect(textOf(w)).not.toContain("chrome://flags");
  });
});
