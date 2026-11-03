// @vitest-environment happy-dom
/**
 * 2026-11-03 费用折算（形态 B）：QuotaCard 窗口行在重置文案旁渲染 `≈$X.XX`
 * （costUnpriced ⇒ `≈$X.XX+`）；costUsd 缺席 ⇒ 不渲染折算（legacy 路径字节由
 * quota-legacy-golden.test.ts 钉死）。
 */
process.env["TZ"] = "Asia/Shanghai";
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import QuotaCard from "../../../src/web-hub/ui/src/components/quota/QuotaCard.vue";
import { resetLangForTests, setLangOverride } from "../../../src/web-hub/ui/src/composables/useI18n.js";
import type { QuotaWire } from "../../../src/web-hub/protocol/messages.js";

const NOW = Date.UTC(2026, 10, 3, 4, 0, 0); // 12:00 Asia/Shanghai
const H = 3_600_000;

const wire = (costUsd?: number, costUnpriced?: true): QuotaWire => ({
  v: 1,
  at: NOW - 30_000,
  providers: [
    {
      id: "kimi-coding",
      level: 0,
      stale: false,
      fetchedAt: NOW - 60_000,
      windows: [
        {
          scope: "5h",
          usedPct: 10,
          level: 0,
          resetAt: NOW + 2 * H,
          ...(costUsd === undefined ? {} : { costUsd }),
          ...(costUnpriced === true ? { costUnpriced } : {}),
        },
      ],
    },
  ],
});

afterEach(() => resetLangForTests());

describe("QuotaCard 费用折算", () => {
  it("costUsd ⇒ 重置文案旁渲染 ≈$X.XX（zh/en 同形符号 token）", () => {
    for (const lang of ["zh", "en"] as const) {
      setLangOverride(lang, null);
      const w = mount(QuotaCard, { props: { quota: wire(12.3), now: NOW, anchorEl: null }, attachTo: document.body });
      const sub = w.get(".q-sub");
      expect(sub.text()).toContain("≈$12.30");
      expect(sub.text()).not.toContain("+");
      w.unmount();
    }
  });

  it("costUnpriced ⇒ ≈$X.XX+（下界标记）；零价 ⇒ ≈$0.00 不带 +", () => {
    setLangOverride("zh", null);
    const unpriced = mount(QuotaCard, {
      props: { quota: wire(3.5, true), now: NOW, anchorEl: null },
      attachTo: document.body,
    });
    expect(unpriced.get(".q-sub").text()).toContain("≈$3.50+");
    unpriced.unmount();
    const zero = mount(QuotaCard, { props: { quota: wire(0), now: NOW, anchorEl: null }, attachTo: document.body });
    expect(zero.get(".q-sub").text()).toContain("≈$0.00");
    expect(zero.get(".q-sub").text()).not.toContain("+");
    zero.unmount();
  });

  it("costUsd 缺席 ⇒ 只有重置文案，无折算", () => {
    setLangOverride("zh", null);
    const w = mount(QuotaCard, { props: { quota: wire(), now: NOW, anchorEl: null }, attachTo: document.body });
    expect(w.get(".q-sub").text()).not.toContain("≈");
    w.unmount();
  });
});
