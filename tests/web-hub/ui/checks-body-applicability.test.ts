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
 * never selects an agent, so `.fleet`/`.transcript` genuinely don't exist there. These tests
 * pin the shared `bodyApplicability()`/`applicabilityOutcome()` gate (placeholder App vs. no
 * agent selected vs. a real P3+ page ready for the per-check assertion) and the fleet-panel's
 * own "zero rows → no `.fleet` at all" not-applicable case (ui-design.md §6.4's "无子 agent →
 * 不渲染子 agent 面板（不占位）", already documented on `FleetPanel.vue`).
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
      "fleet-default-open",
      "transcript-window-cap",
      "content-visibility-auto",
      "long-content-scrolls-within-block",
    ]) {
      expect(byName.get(name)?.ok, `${name} should be a not-applicable pass`).toBe(true);
    }
  });

  it("a mounted .detail-body whose agent has zero fleet rows reports fleet-default-open as not applicable, not a failure", async () => {
    process.env["PWH_VISUAL_STRICT_BODY"] = "1";
    const ctx = fakeCtx({
      bodyHtml: `<div class="detail-body"><div class="transcript"><div class="tx-item"></div></div></div>`,
      scenario: "detail",
      width: 1024,
    });
    const outcomes = await check.run(ctx);
    const fleet = outcomes.find((o) => o.name === "fleet-default-open");
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

  it("a real <details class='fleet'> reflects its open/closed state against the 768px breakpoint", async () => {
    process.env["PWH_VISUAL_STRICT_BODY"] = "1";
    const openCtx = fakeCtx({
      bodyHtml: `<div class="detail-body"><details class="fleet" open></details></div>`,
      scenario: "detail",
      width: 1024,
    });
    const openOutcomes = await check.run(openCtx);
    expect(openOutcomes.find((o) => o.name === "fleet-default-open")?.ok).toBe(true);

    const closedAtDesktopCtx = fakeCtx({
      bodyHtml: `<div class="detail-body"><details class="fleet"></details></div>`,
      scenario: "detail",
      width: 1024,
    });
    const closedOutcomes = await check.run(closedAtDesktopCtx);
    expect(closedOutcomes.find((o) => o.name === "fleet-default-open")?.ok).toBe(false);
  });
});
