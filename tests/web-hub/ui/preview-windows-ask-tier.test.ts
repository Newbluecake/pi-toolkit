// @vitest-environment happy-dom
/**
 * 2026-10-24 验收裁定 (ask-paths fix #1): preview windows opened FROM the ask_user
 * dialog/float (`open({…, origin:"ask"})`, or from inside an ask-tier window) render in a
 * SECOND overlay root `.preview-overlay.is-windows.is-modeless.is-ask-tier` at z 46 — above
 * the ask-float's z 45, which otherwise covers the window's right edge. Placement also
 * avoids the float's on-screen rectangle (`avoidObstacle`; overlap allowed only when no
 * side fits). Non-ask windows keep the legacy tier-25 root and byte-identical DOM.
 *
 * Driven over the REAL `usePreviewWindows` manager + PreviewHost (the preview-windows.test.ts
 * rig pattern), plus a static read of the two stylesheets pinning the tier relationship.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mount } from "@vue/test-utils";
import { nextTick, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import PreviewHost from "../../../src/web-hub/ui/src/components/preview/PreviewHost.vue";
import { PREVIEW_CTX, type PreviewContext } from "../../../src/web-hub/ui/src/components/preview/previewContext.js";
import { HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import { resetBodyScrollLock } from "../../../src/web-hub/ui/src/composables/useScrollLock.js";
import { usePreviewWindows } from "../../../src/web-hub/ui/src/composables/usePreviewWindows.js";
import type { HubState } from "../../../src/web-hub/ui/src/types.js";
import type { PreviewDirOutcome, PreviewTransport } from "../../../src/web-hub/ui/src/transport/types.js";

const tick = async (): Promise<void> => {
  await nextTick();
  await nextTick();
  await new Promise((r) => setTimeout(r, 0));
};

function rig() {
  const agents = new Map<string, unknown>([
    [
      "A",
      {
        key: "A",
        card: { session: { sessionId: "s1", sessionFile: "/p/s.jsonl", cwd: "/p" } },
        session: { sessionId: "s1", sessionFile: "/p/s.jsonl", cwd: "/p" },
      },
    ],
  ]);
  const state = ref({
    clientId: "c1",
    hub: { caps: ["preview.v1", "preview.dir.v1", "preview.html.v1"] },
    conn: "open",
    selected: "A",
    agents,
    order: ["A"],
  } as unknown as HubState);
  const waits: Array<{ resolve: (o: PreviewDirOutcome) => void }> = [];
  const transport: PreviewTransport = {
    fetch: () => new Promise<PreviewDirOutcome>((resolve) => waits.push({ resolve })),
  };
  const hubFake = {
    state,
    preview: {
      fetch: transport.fetch,
      // static cap answer (the preview-windows.test.ts rig pattern) so .html windows can mint
      htmlCap: () =>
        Promise.resolve({
          ok: true,
          url: "/pv/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/index.html",
          openUrl: "/pvw/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          idleMs: 900_000,
          hardRemainingMs: 3_600_000,
        }),
    },
    dispatch: () => {},
  };
  const previewHandle = usePreviewWindows({ preview: transport, mode: "token", state, coarse: ref(false) });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const wrapper = mount(PreviewHost, {
    attachTo: host,
    global: {
      provide: {
        [PREVIEW_CTX as symbol]: { handle: previewHandle, plaintext: false } satisfies PreviewContext,
        [HUB_CTX as symbol]: hubFake,
      },
    },
  });
  const text = (body: string): void => {
    const w = waits.shift();
    w?.resolve({ ok: true, kind: "text", size: body.length, truncated: false, text: body });
  };
  return { handle: previewHandle, wrapper, text };
}

const roots = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(".preview-overlay.is-windows")];
const cssVar = (el: HTMLElement, name: string): number => Number.parseFloat(el.style.getPropertyValue(name));

/** A fake ask-float whose getBoundingClientRect is fully controlled (happy-dom returns 0s). */
function fakeAskFloat(rect: { left: number; top: number; width: number; height: number }): HTMLElement {
  const el = document.createElement("section");
  el.className = "ask-float";
  el.getBoundingClientRect = () =>
    ({ ...rect, x: rect.left, y: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  resetBodyScrollLock();
  document.body.style.overflow = "";
  document.body.innerHTML = "";
  document.body.classList.remove("pwh-pw-dragging");
  vi.restoreAllMocks();
});

describe("ask-tier preview windows (fix #1)", () => {
  it("ask-origin windows render in a dedicated .is-ask-tier root; non-ask windows stay in the base root", async () => {
    const { handle, text } = rig();
    handle.open({ path: "/p/plain.txt" });
    text("plain");
    await tick();
    expect(roots()).toHaveLength(1);
    expect(roots()[0]!.classList.contains("is-ask-tier")).toBe(false);

    handle.open({ path: "/p/from-ask.txt", origin: "ask" });
    text("ask");
    await tick();
    const rs = roots();
    expect(rs).toHaveLength(2);
    const base = rs.find((r) => !r.classList.contains("is-ask-tier"))!;
    const ask = rs.find((r) => r.classList.contains("is-ask-tier"))!;
    // both roots keep the modeless shell semantics
    expect(base.classList.contains("is-modeless")).toBe(true);
    expect(ask.classList.contains("is-modeless")).toBe(true);
    // each window sits in its own tier's root
    expect(base.querySelector(".preview-window")).not.toBeNull();
    expect(ask.querySelector(".preview-window")).not.toBeNull();
    expect(base.querySelectorAll(".preview-window")).toHaveLength(1);
    expect(ask.querySelectorAll(".preview-window")).toHaveLength(1);
  });

  it("a window opened FROM INSIDE an ask-tier window inherits the tier", async () => {
    const { handle, text } = rig();
    handle.open({ path: "/p/from-ask.txt", origin: "ask" });
    text("ask");
    await tick();
    const askWin = handle.windows.value[0]!;
    const result = handle.openWindow({ path: "/p/child.txt" }, askWin.id);
    expect(result).toBe("opened");
    text("child");
    await tick();
    expect(handle.windows.value[1]!.askTier).toBe(true);
    const ask = roots().find((r) => r.classList.contains("is-ask-tier"))!;
    expect(ask.querySelectorAll(".preview-window")).toHaveLength(2);
  });

  it("a conversation-opened window stays tier-25 even while an ask window is open", async () => {
    const { handle, text } = rig();
    handle.open({ path: "/p/from-ask.txt", origin: "ask" });
    text("ask");
    await tick();
    handle.open({ path: "/p/plain.txt" });
    text("plain");
    await tick();
    expect(handle.windows.value[1]!.askTier).toBeUndefined();
    const base = roots().find((r) => !r.classList.contains("is-ask-tier"))!;
    expect(base.querySelectorAll(".preview-window")).toHaveLength(1);
  });

  it("closing the last ask window removes the tier root entirely", async () => {
    const { handle, text } = rig();
    handle.open({ path: "/p/from-ask.txt", origin: "ask" });
    text("ask");
    await tick();
    expect(roots().some((r) => r.classList.contains("is-ask-tier"))).toBe(true);
    handle.closeAll();
    await tick();
    expect(roots()).toHaveLength(0);
  });

  it("placement avoids the ask float's on-screen rectangle when a side fits", async () => {
    // 复验 B1: the default-band viewport (1024×768) makes the cascaded window so large that
    // a bottom-right float never intersects it — the old assertion was vacuous. Pin a
    // 1920×1080 viewport instead: the cascaded rect is then (512,126,960,900) and a
    // bottom-right float genuinely overlaps its right edge. Deleting the `askFloatRect()`
    // argument in PreviewHost turns this test RED (the window stays at x=512, intersecting).
    const descW = Object.getOwnPropertyDescriptor(window, "innerWidth");
    const descH = Object.getOwnPropertyDescriptor(window, "innerHeight");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1920 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 1080 });
    try {
      fakeAskFloat({ left: 1200, top: 700, width: 400, height: 300 });
      const { handle, text } = rig();
      handle.open({ path: "/p/from-ask.txt", origin: "ask" });
      text("ask");
      await tick();
      const ask = roots().find((r) => r.classList.contains("is-ask-tier"))!;
      const sec = ask.querySelector<HTMLElement>(".preview-window")!;
      const rect = {
        x: cssVar(sec, "--pw-x"),
        y: cssVar(sec, "--pw-y"),
        w: cssVar(sec, "--pw-w"),
        h: cssVar(sec, "--pw-h"),
      };
      expect([rect.x, rect.y, rect.w, rect.h].every(Number.isFinite)).toBe(true);
      // displaced into the LEFT gap: x = 1200 − w − EDGE(8); the cascaded x would be 512
      expect(rect.w).toBe(960);
      expect(rect.x).toBe(1200 - 960 - 8);
      expect(rect.x).not.toBe(512);
      const obstacle = { x: 1200, y: 700, w: 400, h: 300 };
      const intersects =
        rect.x < obstacle.x + obstacle.w &&
        obstacle.x < rect.x + rect.w &&
        rect.y < obstacle.y + obstacle.h &&
        obstacle.y < rect.y + rect.h;
      expect(intersects).toBe(false);
    } finally {
      if (descW !== undefined) Object.defineProperty(window, "innerWidth", descW);
      if (descH !== undefined) Object.defineProperty(window, "innerHeight", descH);
    }
  });

  it("non-ask windows do NOT avoid the float rect (legacy placement)", async () => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    fakeAskFloat({ left: vw - 420, top: vh - 60, width: 400, height: 50 });
    const { handle, text } = rig();
    handle.open({ path: "/p/plain.txt" });
    text("plain");
    await tick();
    const sec = roots()[0]!.querySelector<HTMLElement>(".preview-window")!;
    // the legacy placement — identical to a run WITHOUT any ask float in the DOM:
    // `cascadeRect(defaultRect(vp), vp, [])` (no header.topbar in this rig ⇒ top offset 0).
    const { cascadeRect, defaultRect } = await import("../../../src/web-hub/ui/src/logic/previewWindowGeom.js");
    const vp = { vw, vh, top: 0 };
    const d = cascadeRect(defaultRect(vp), vp, []);
    expect(cssVar(sec, "--pw-x")).toBe(d.x);
    expect(cssVar(sec, "--pw-y")).toBe(d.y);
    expect(cssVar(sec, "--pw-w")).toBe(d.w);
    expect(cssVar(sec, "--pw-h")).toBe(d.h);
  });
});

describe("ask-tier promotion (复验 B2)", () => {
  it("dedup focus: an ask-tagged ref for an already-open path promotes that window to the ask tier", async () => {
    const { handle, text } = rig();
    handle.open({ path: "/p/shared.txt" }); // conversation origin ⇒ legacy tier-25 window
    text("body");
    await tick();
    expect(handle.windows.value[0]!.askTier).toBeUndefined();
    expect(roots().some((r) => r.classList.contains("is-ask-tier"))).toBe(false);

    const result = handle.open({ path: "/p/shared.txt", origin: "ask" }); // same path from the ask float
    expect(result).toBe("focused"); // dedup hits the existing window…
    await tick();
    expect(handle.windows.value).toHaveLength(1); // deduped, no second window
    expect(handle.windows.value[0]!.askTier).toBe(true); // …but promoted
    const ask = roots().find((r) => r.classList.contains("is-ask-tier"))!;
    expect(ask.querySelectorAll(".preview-window")).toHaveLength(1);
  });

  it("cap navigation: an ask-tagged ref over the 6-window cap promotes the navigation target", async () => {
    const { handle, text } = rig();
    for (let i = 0; i < 6; i++) {
      handle.open({ path: `/p/w${i}.txt` });
      text(`body ${i}`);
    }
    await tick();
    expect(handle.windows.value).toHaveLength(6);
    expect(handle.windows.value.every((w) => w.askTier === undefined)).toBe(true);

    handle.open({ path: "/p/overflow.txt", origin: "ask" }); // 7th: navigates in the ACTIVE window
    text("overflow");
    await tick();
    expect(handle.windows.value).toHaveLength(6); // still capped
    const active = handle.activeId.value!;
    const target = handle.windows.value.find((w) => w.id === active)!;
    expect(target.askTier).toBe(true); // promoted so the float can't cover the navigation result
    const ask = roots().find((r) => r.classList.contains("is-ask-tier"))!;
    expect(ask.querySelectorAll(".preview-window")).toHaveLength(1);
    expect(ask.querySelector(".preview-window")!.getAttribute("data-pw-id")).toBe(String(active));
  });

  it("复验 #3: promotion SKIPS an html window — same element instance, iframe intact, stays tier 25", async () => {
    const { handle, text } = rig();
    handle.open({ path: "/p/a.html" }); // conversation origin ⇒ legacy tier-25 window
    await tick();
    text("<p>x</p>");
    // the html entry renders the sandboxed iframe (lazy chunk) — the migration hazard
    await vi.waitFor(() => expect(document.querySelector("iframe.preview-html-frame")).not.toBeNull(), {
      timeout: 4000,
    });
    const sec = document.querySelector(".preview-window")!;
    const frame = document.querySelector("iframe.preview-html-frame")!;

    const result = handle.open({ path: "/p/a.html", origin: "ask" }); // same path from the ask float
    expect(result).toBe("focused"); // dedup hit…
    await tick();
    expect(handle.windows.value[0]!.askTier).toBeUndefined(); // …but NOT promoted (iframe reload guard)
    expect(roots().some((r) => r.classList.contains("is-ask-tier"))).toBe(false);
    expect(document.querySelector(".preview-window")).toBe(sec); // same element instance, no migration
    expect(document.querySelector("iframe.preview-html-frame")).toBe(frame); // iframe NOT remounted
  });
});

describe("ask-tier z relationship (stylesheets)", () => {
  // happy-dom shadows the global URL class — join with resolve(fileURLToPath(import.meta.url))
  // (the ask-user-form.test.ts pattern), never `new URL(rel, import.meta.url)`.
  const read = (rel: string): string =>
    readFileSync(resolve(fileURLToPath(import.meta.url), `../../../../src/web-hub/ui/src/styles/${rel}`), "utf8");

  it("tier 46 (ask-origin preview root) is above tier 45 (.ask-float); base windows stay 25", () => {
    const preview = read("preview.css");
    const askFloat = read("ask-float.css");
    const tierOf = (css: string, selector: string): number => {
      const re = new RegExp(selector.replace(/[.*]/g, (c) => `\\${c}`) + "\\s*\\{[^}]*?z-index:\\s*(\\d+)", "s");
      const m = re.exec(css);
      expect(m, `${selector} z-index rule`).not.toBeNull();
      return Number(m![1]);
    };
    const base = tierOf(preview, ".preview-overlay.is-windows.is-modeless");
    const ask = tierOf(preview, ".preview-overlay.is-windows.is-modeless.is-ask-tier");
    const float = tierOf(askFloat, ".ask-float");
    expect(base).toBe(25); // non-ask windows unchanged
    expect(float).toBe(45);
    expect(ask).toBeGreaterThan(float); // the fix: ask-origin windows above the float
    expect(ask).toBeLessThan(50); // but still below every modal
  });
});
