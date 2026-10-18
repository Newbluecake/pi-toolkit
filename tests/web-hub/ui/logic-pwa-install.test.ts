/**
 * `logic/pwaInstall.ts` (2026-10-18 PWA 「安装为应用」) — the pure decision half: `classifyUa`
 * (UA sniffing that picks PROSE ONLY, never gates function) and `deriveInstallState`'s
 * ordering contract (standalone > prompt > iOS > insecure > desktop-chromium > android-menu >
 * generic). The browser-event half (`beforeinstallprompt` capture) is covered by
 * `settings-install-card.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { classifyUa, deriveInstallState, type InstallEnv } from "../../../src/web-hub/ui/src/logic/pwaInstall.js";

const env = (overrides: Partial<InstallEnv> = {}): InstallEnv => ({
  ua: "",
  standalone: false,
  hasPrompt: false,
  isSecureContext: true,
  origin: "http://192.168.1.10:7879",
  ...overrides,
});

// Real-world UA strings (trimmed to the tokens classifyUa reads).
const UA_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const UA_IPAD =
  "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
/** iPadOS 13+ desktop-mode: "Macintosh" UA that still carries "Touch" (desktop Safari never does). */
const UA_IPAD_DESKTOP =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15 (Touch)";
const UA_ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const UA_WIN_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const UA_WIN_EDGE =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";
const UA_WIN_FIREFOX = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0";
const UA_MAC_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

describe("classifyUa (prose selection only — never a functional gate)", () => {
  it.each([
    [UA_IPHONE, "ios"],
    [UA_IPAD, "ios"],
    [UA_IPAD_DESKTOP, "ios"],
    ["Mozilla/5.0 (iPod touch; CPU iPhone OS 15_8 like Mac OS X)", "ios"],
    [UA_ANDROID_CHROME, "android"],
    [UA_WIN_CHROME, "desktop-chromium"],
    [UA_WIN_EDGE, "desktop-chromium"],
    [
      "Mozilla/5.0 (X11; CrOS x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      "desktop-chromium",
    ],
    [UA_WIN_FIREFOX, "other"],
    [UA_MAC_SAFARI, "other"],
    ["", "other"],
    ["some-unknown-agent", "other"],
  ] as const)("classifies %s → %s", (ua, expected) => {
    expect(classifyUa(ua)).toBe(expected);
  });

  it("an Android-Chrome UA never lands on desktop-chromium (mobile token outranks chrome/)", () => {
    expect(classifyUa(UA_ANDROID_CHROME)).toBe("android");
  });
});

describe("deriveInstallState ordering", () => {
  it("1. standalone outranks everything, even a captured prompt or an iOS UA", () => {
    expect(deriveInstallState(env({ standalone: true }))).toEqual({ kind: "standalone" });
    expect(deriveInstallState(env({ standalone: true, hasPrompt: true, ua: UA_IPHONE }))).toEqual({
      kind: "standalone",
    });
  });

  it("2. a captured beforeinstallprompt yields the button state", () => {
    expect(deriveInstallState(env({ hasPrompt: true, ua: UA_ANDROID_CHROME }))).toEqual({ kind: "prompt" });
    expect(deriveInstallState(env({ hasPrompt: true, ua: UA_WIN_FIREFOX }))).toEqual({ kind: "prompt" });
  });

  it("3. iOS outranks the insecure branch — Safari's Add to Home Screen works on plain HTTP", () => {
    expect(deriveInstallState(env({ ua: UA_IPHONE, isSecureContext: false }))).toEqual({
      kind: "steps",
      guidance: "ios-safari",
      origin: "http://192.168.1.10:7879",
    });
  });

  it("4. non-secure context (any non-iOS UA) yields the chrome://flags whitelist guidance", () => {
    for (const ua of [UA_ANDROID_CHROME, UA_WIN_CHROME, UA_WIN_FIREFOX, ""]) {
      expect(deriveInstallState(env({ ua, isSecureContext: false }))).toEqual({
        kind: "steps",
        guidance: "insecure-origin",
        origin: "http://192.168.1.10:7879",
      });
    }
  });

  it("5. secure desktop Chromium → address-bar/menu hint; 6. secure Android without a prompt → menu hint; 7. rest → generic", () => {
    expect(deriveInstallState(env({ ua: UA_WIN_CHROME }))).toEqual({
      kind: "steps",
      guidance: "desktop-chromium",
      origin: "http://192.168.1.10:7879",
    });
    expect(deriveInstallState(env({ ua: UA_ANDROID_CHROME }))).toEqual({
      kind: "steps",
      guidance: "android-menu",
      origin: "http://192.168.1.10:7879",
    });
    expect(deriveInstallState(env({ ua: UA_WIN_FIREFOX }))).toEqual({
      kind: "steps",
      guidance: "generic",
      origin: "http://192.168.1.10:7879",
    });
  });
});
