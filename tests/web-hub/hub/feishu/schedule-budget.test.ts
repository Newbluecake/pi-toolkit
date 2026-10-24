/** F1 §7.3: NoticeBudget lanes (critical / normal / schedule) + `remaining()`. */
import { describe, expect, it } from "vitest";
import { createFeishuSecurity, createNoticeBudget } from "../../../../src/web-hub/hub/feishu/security.js";
import { createSecurityEventBus } from "../../../../src/web-hub/hub/security-events.js";
import { FEISHU_NOTIFY_LIMITS } from "../../../../src/web-hub/protocol/feishu.js";
import { createFakeClock } from "../../../fixtures/feishu/fake-http.js";

const G = FEISHU_NOTIFY_LIMITS.globalPerMin;

describe("NoticeBudget lanes", () => {
  it("no opts ≡ normal lane: uses the full global cap, exactly like the legacy interface", () => {
    const clock = createFakeClock(0);
    const b = createNoticeBudget(clock);
    let ok = 0;
    for (let i = 0; i < G + 5; i++) if (b.reserve(`k${i}`, 0)) ok++;
    expect(ok).toBe(G);
    expect(b.remaining()).toBe(0);
    const b2 = createNoticeBudget(clock);
    let okN = 0;
    for (let i = 0; i < G + 5; i++) if (b2.reserve(`k${i}`, 0, { lane: "normal" })) okN++;
    expect(okN).toBe(G);
  });

  it("critical may use the whole cap", () => {
    const b = createNoticeBudget(createFakeClock(0));
    let ok = 0;
    for (let i = 0; i < G + 5; i++) if (b.reserve(`k${i}`, 0, { lane: "critical" })) ok++;
    expect(ok).toBe(G);
  });

  it("schedule leaves ≥5 for critical and is capped at max(1, G-7) per minute", () => {
    const b = createNoticeBudget(createFakeClock(0));
    let ok = 0;
    for (let i = 0; i < G + 5; i++) if (b.reserve(`s${i}`, 0, { lane: "schedule" })) ok++;
    expect(ok).toBe(Math.max(1, G - 5 - 2));
    expect(b.remaining()).toBeGreaterThanOrEqual(5);
    // critical still gets its reserve after a schedule flood
    let crit = 0;
    for (let i = 0; i < 10; i++) if (b.reserve(`c${i}`, 0, { lane: "critical" })) crit++;
    expect(crit).toBe(G - ok);
    expect(crit).toBeGreaterThanOrEqual(5);
  });

  it("schedule is refused once normal traffic leaves fewer than 5 spare", () => {
    const b = createNoticeBudget(createFakeClock(0));
    for (let i = 0; i < G - 5; i++) expect(b.reserve(`n${i}`, 0)).toBe(true);
    expect(b.remaining()).toBe(5);
    expect(b.reserve("s", 0, { lane: "schedule" })).toBe(false);
    expect(b.reserve("c", 0, { lane: "critical" })).toBe(true);
  });

  it("window rolls over after a minute and honours gap keys per lane", () => {
    const clock = createFakeClock(0);
    const b = createNoticeBudget(clock);
    expect(b.reserve("g", 60_000, { lane: "schedule" })).toBe(true);
    expect(b.reserve("g", 60_000, { lane: "schedule" })).toBe(false);
    clock.advance(60_000);
    expect(b.remaining()).toBe(G);
    expect(b.reserve("g", 60_000, { lane: "schedule" })).toBe(true);
  });

  it("security alerts ride the critical lane: a schedule flood cannot starve them", async () => {
    const clock = createFakeClock(0);
    const bus = createSecurityEventBus({ error: () => {} });
    const budget = createNoticeBudget(clock);
    const lanes: Array<string | undefined> = [];
    const orig = budget.reserve.bind(budget);
    budget.reserve = (key, gap, opts) => {
      lanes.push(opts?.lane);
      return orig(key, gap, opts);
    };
    const sent: string[] = [];
    const sec = createFeishuSecurity({
      security: bus,
      clock,
      owner: () => "ou_owner",
      budget,
      send: async (i) => {
        sent.push(i.key);
      },
    });
    for (let i = 0; i < 40; i++) budget.reserve(`s${i}`, 0, { lane: "schedule" });
    lanes.length = 0;
    for (let i = 0; i < 5; i++) sec.onEvent({ type: "passwd" });
    clock.advance(5_000);
    expect(lanes.length).toBeGreaterThan(0);
    expect(lanes.every((l) => l === "critical")).toBe(true);
    expect(sent.length).toBeGreaterThanOrEqual(1);
    sec.dispose();
  });
});
