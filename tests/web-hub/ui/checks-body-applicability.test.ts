// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import type { CheckContext } from "../../../scripts/web-hub/visual.js";
import {
  applicabilityOutcome,
  bodyApplicability,
  check,
  PLACEHOLDER_APP_MARKER,
} from "../../../scripts/web-hub/visual/checks-body.js";

/**
 * P4/W3-integration fix (todo #26, "上一轮报告"点 1/2): `checks-body.ts`'s DOM-dependent checks
 * used to hard-fail (in `PWH_VISUAL_STRICT_BODY=1` mode) on any scenario/route that legitimately
 * never mounts `.detail-body` at all — `dashboard`/`states`/`login` all route to `#/`, which
 * never selects an agent, so `#fleet-drawer`/`.transcript` genuinely don't exist there. These
 * tests pin the shared `bodyApplicability()`/`applicabilityOutcome()` gate (placeholder App vs.
 * no agent selected vs. a real P3+ page ready for the per-check assertion) and the fleet
 * drawer's own "zero rows → no `.fleet-summary-bar`/`#fleet-drawer` at all" not-applicable case
 * (ui-design.md §9's "无子 agent → 不渲染", fleet-drawer §6.1's `v-if`).
 *
 * fleet-drawer F6: the old `<details class="fleet">` fixtures were migrated to the new DOM shape
 * (`.detail[data-drawer][data-drawer-open]` + `.fleet-summary-bar` + `#fleet-drawer .tree .run`),
 * matching `checkFleetDrawerOpen`'s post-F6 semantics (§6.2: docked 默认开 / overlay·fullscreen
 * 挂载关闭).
 */

function fakeCtx(overrides: Partial<CheckContext> & { bodyHtml?: string }): CheckContext {
  document.body.innerHTML = overrides.bodyHtml ?? "";
  const page = {
    evaluate: async (fn: unknown, arg?: unknown) => (fn as (a?: unknown) => unknown)(arg),
  };
  return {
    page: page as CheckContext["page"],
    baseUrl: "http://127.0.0.1:0",
    scenario: overrides.scenario ?? "dashboard",
    width: overrides.width ?? 1024,
    theme: "light",
    isMobile: false,
    hasTouch: false,
    consoleErrors: [],
    pageErrors: [],
    requests: [],
    failedRequests: [],
    cspViolations: [],
    refreshCspViolations: async () => {},
    expectFleetRows: false,
    ...overrides,
  };
}

afterEach(() => {
  delete process.env["PWH_VISUAL_STRICT_BODY"];
  document.body.innerHTML = "";
});

describe("bodyApplicability", () => {
  it("reports 'placeholder' when the P0 placeholder marker is still in the body text", async () => {
    const ctx = fakeCtx({ bodyHtml: `<p>${PLACEHOLDER_APP_MARKER}</p>` });
    expect(await bodyApplicability(ctx)).toBe("placeholder");
  });

  it("reports 'no-agent' for a real (non-placeholder) page with no .detail-body mounted", async () => {
    const ctx = fakeCtx({ bodyHtml: `<div class="app"><div class="layout"></div></div>` });
    expect(await bodyApplicability(ctx)).toBe("no-agent");
  });

  it("reports 'ready' once .detail-body is mounted", async () => {
    const ctx = fakeCtx({ bodyHtml: `<div class="detail-body"></div>` });
    expect(await bodyApplicability(ctx)).toBe("ready");
  });
});

describe("applicabilityOutcome", () => {
  it("placeholder + non-strict mode degrades to an informational pass", async () => {
    const ctx = fakeCtx({ bodyHtml: "" });
    const outcome = await applicabilityOutcome("some-check", ctx, "placeholder");
    expect(outcome).toEqual({ name: "some-check", ok: true, detail: "skipped (placeholder App)" });
  });

  it("placeholder + PWH_VISUAL_STRICT_BODY=1 fails hard instead of skipping", async () => {
    process.env["PWH_VISUAL_STRICT_BODY"] = "1";
    const ctx = fakeCtx({ bodyHtml: "" });
    const outcome = await applicabilityOutcome("some-check", ctx, "placeholder");
    expect(outcome?.ok).toBe(false);
  });

  it("no-agent is always a pass (not applicable), strict mode or not", async () => {
    const ctx = fakeCtx({ bodyHtml: "" });
    expect((await applicabilityOutcome("some-check", ctx, "no-agent"))?.ok).toBe(true);
    process.env["PWH_VISUAL_STRICT_BODY"] = "1";
    expect((await applicabilityOutcome("some-check", ctx, "no-agent"))?.ok).toBe(true);
  });

  it("ready defers to the caller (returns null, no outcome of its own)", async () => {
    const ctx = fakeCtx({ bodyHtml: "" });
    expect(await applicabilityOutcome("some-check", ctx, "ready")).toBeNull();
  });
});

describe("check.run — scenario/route guards (the actual regression from the previous report)", () => {
  it("dashboard/states/login-shaped pages (no agent selected) report every DOM-dependent check as not applicable, never a failure", async () => {
    process.env["PWH_VISUAL_STRICT_BODY"] = "1";
    const ctx = fakeCtx({ bodyHtml: `<div class="app"><div class="layout"></div></div>`, scenario: "states" });
    const outcomes = await check.run(ctx);
    const byName = new Map(outcomes.map((o) => [o.name, o]));
    for (const name of [
      "fleet-drawer-open",
      "transcript-window-cap",
      "content-visibility-auto",
      "long-content-scrolls-within-block",
    ]) {
      expect(byName.get(name)?.ok, `${name} should be a not-applicable pass`).toBe(true);
    }
  });

  it("a mounted .detail-body whose agent has zero fleet rows reports fleet-drawer-open as not applicable, not a failure", async () => {
    process.env["PWH_VISUAL_STRICT_BODY"] = "1";
    const ctx = fakeCtx({
      bodyHtml: `<div class="detail-body"><div class="transcript"><div class="tx-item"></div></div></div>`,
      scenario: "detail",
      width: 1024,
    });
    const outcomes = await check.run(ctx);
    const fleet = outcomes.find((o) => o.name === "fleet-drawer-open");
    expect(fleet?.ok).toBe(true);
    expect(fleet?.detail).toMatch(/no fleet rows/);
  });

  it("strict mode still fails a genuinely missing selector once .detail-body is mounted (no silent pass)", async () => {
    process.env["PWH_VISUAL_STRICT_BODY"] = "1";
    const ctx = fakeCtx({ bodyHtml: `<div class="detail-body"></div>`, scenario: "detail", width: 1024 });
    const outcomes = await check.run(ctx);
    const transcript = outcomes.find((o) => o.name === "transcript-window-cap");
    expect(transcript?.ok).toBe(false);
  });

  // fleet-drawer F6 的 DOM 形状:`.detail[data-drawer][data-drawer-open]` + 摘要行按钮 +
  // `#fleet-drawer`(`.tree .run` 行在其中;drawer 有 fleet 行即挂载,关闭只是 display:none)。
  const drawerHtml = (mode: "docked" | "overlay" | "fullscreen", open: boolean) =>
    `<div class="detail" data-drawer="${mode}"${open ? " data-drawer-open" : ""}>` +
    `<div class="detail-main"><div class="detail-body"></div>` +
    `<button class="fleet-summary-bar" aria-expanded="${open}"></button></div>` +
    `<aside id="fleet-drawer"><div class="tree-scroll"><ul class="tree"><li><div class="run"></div></li></ul></div></aside>` +
    `</div>`;

  it("the fleet drawer's data-drawer mode/open state is checked against the F6 breakpoints (1280 docked-default-open / 767 fullscreen)", async () => {
    process.env["PWH_VISUAL_STRICT_BODY"] = "1";
    const dockedOpen = await check.run(
      fakeCtx({ bodyHtml: drawerHtml("docked", true), scenario: "detail", width: 1280 }),
    );
    expect(dockedOpen.find((o) => o.name === "fleet-drawer-open")?.ok).toBe(true);

    const dockedClosed = await check.run(
      fakeCtx({ bodyHtml: drawerHtml("docked", false), scenario: "detail", width: 1280 }),
    );
    expect(dockedClosed.find((o) => o.name === "fleet-drawer-open")?.ok).toBe(false);

    const overlayClosed = await check.run(
      fakeCtx({ bodyHtml: drawerHtml("overlay", false), scenario: "detail", width: 1024 }),
    );
    expect(overlayClosed.find((o) => o.name === "fleet-drawer-open")?.ok).toBe(true);

    const overlayOpen = await check.run(
      fakeCtx({ bodyHtml: drawerHtml("overlay", true), scenario: "detail", width: 1024 }),
    );
    expect(overlayOpen.find((o) => o.name === "fleet-drawer-open")?.ok).toBe(false);

    const fullClosed = await check.run(
      fakeCtx({ bodyHtml: drawerHtml("fullscreen", false), scenario: "detail", width: 375 }),
    );
    expect(fullClosed.find((o) => o.name === "fleet-drawer-open")?.ok).toBe(true);
  });

  it("fleet-drawer-open fails when the summary bar's aria-expanded disagrees with data-drawer-open", async () => {
    process.env["PWH_VISUAL_STRICT_BODY"] = "1";
    const ctx = fakeCtx({
      bodyHtml:
        `<div class="detail" data-drawer="overlay"><div class="detail-main"><div class="detail-body"></div>` +
        `<button class="fleet-summary-bar" aria-expanded="true"></button></div>` +
        `<aside id="fleet-drawer"><ul class="tree"><li><div class="run"></div></li></ul></aside></div>`,
      scenario: "detail",
      width: 1024,
    });
    const outcomes = await check.run(ctx);
    const fleet = outcomes.find((o) => o.name === "fleet-drawer-open");
    expect(fleet?.ok).toBe(false);
    expect(fleet?.detail).toMatch(/aria-expanded/);
  });

  it("P1 fix: expectFleetRows=true with no #fleet-drawer mounted is a real failure, not the zero-rows not-applicable pass", async () => {
    process.env["PWH_VISUAL_STRICT_BODY"] = "1";
    const ctx = fakeCtx({
      bodyHtml: `<div class="detail-body"><div class="transcript"></div></div>`,
      scenario: "detail",
      width: 1024,
      expectFleetRows: true,
    });
    const outcomes = await check.run(ctx);
    const fleet = outcomes.find((o) => o.name === "fleet-drawer-open");
    expect(fleet?.ok).toBe(false);
    expect(fleet?.detail).toMatch(/fixture promises fleet rows/);
  });

  it("expectFleetRows=true with the drawer mounted still evaluates the F6 mode/open semantics normally", async () => {
    process.env["PWH_VISUAL_STRICT_BODY"] = "1";
    const ctx = fakeCtx({
      bodyHtml: drawerHtml("docked", true),
      scenario: "detail",
      width: 1280,
      expectFleetRows: true,
    });
    const outcomes = await check.run(ctx);
    expect(outcomes.find((o) => o.name === "fleet-drawer-open")?.ok).toBe(true);
  });

  it("expectFleetRows=true with the drawer mounted but zero .tree .run rows is a real failure", async () => {
    process.env["PWH_VISUAL_STRICT_BODY"] = "1";
    const ctx = fakeCtx({
      bodyHtml:
        `<div class="detail" data-drawer="docked" data-drawer-open><div class="detail-main"><div class="detail-body"></div>` +
        `<button class="fleet-summary-bar" aria-expanded="true"></button></div>` +
        `<aside id="fleet-drawer"><ul class="tree"></ul></aside></div>`,
      scenario: "detail",
      width: 1280,
      expectFleetRows: true,
    });
    const outcomes = await check.run(ctx);
    const fleet = outcomes.find((o) => o.name === "fleet-drawer-open");
    expect(fleet?.ok).toBe(false);
    expect(fleet?.detail).toMatch(/tree \.run is empty/);
  });
});
