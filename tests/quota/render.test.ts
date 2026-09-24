// quota-plan §9.2 render.test.ts — L1/L2/L3 copy templates (§5.5), time /
// scope formatting, demoted + stale markers, HUD line.
//
// All wall-clock fixtures are built from local-time Date constructors so the
// expected HH:MM strings hold on any timezone.

import { describe, expect, it } from "vitest";
import type { LadderLevel } from "../../src/quota/types.js";
import type { ProviderVerdict, WindowVerdict } from "../../src/quota/ladder.js";
import {
  buildQuotaBlockText,
  buildQuotaMessage,
  buildQuotaTickText,
  buildQuotaWarnText,
  dedupeVerdicts,
  formatEta,
  formatResetAt,
  formatScope,
  readQuotaStatusTheme,
  renderProviderLine,
  renderQuotaStatus,
} from "../../src/quota/render.js";

const NOW = new Date(2026, 0, 15, 1, 29, 0).getTime(); // local 01:29（+41min = 02:10，严格早于 02:11 重置）
const RESET = new Date(2026, 0, 15, 2, 11, 0).getTime(); // local 02:11

function w(
  scope: "5h" | "week",
  usedPct: number,
  level: LadderLevel,
  reason: WindowVerdict["reason"],
  extra?: Partial<WindowVerdict>,
): WindowVerdict {
  return { scope, usedPct, level, reason, ...extra };
}

function verdict(over: Partial<ProviderVerdict>): ProviderVerdict {
  return {
    provider: "zai-coding-cn",
    level: 1,
    windows: [],
    demoted: false,
    fetchedAt: NOW,
    stale: false,
    ...over,
  };
}

describe("formatScope / formatResetAt / formatEta", () => {
  it("formatScope maps to compact English tokens", () => {
    expect(formatScope("5h")).toBe("5h");
    expect(formatScope("week")).toBe("7d");
  });

  it("formatResetAt renders HH:MM same-day, M/D HH:MM across days, and says 未知 when unknown", () => {
    expect(formatResetAt(RESET, NOW)).toBe("02:11");
    expect(formatResetAt(undefined, NOW)).toBe("未知");
    expect(formatResetAt(Number.NaN, NOW)).toBe("未知");
    // A 7d window resetting days away must not read as "today".
    const nextDay = formatResetAt(NOW + 26 * 3_600_000, NOW);
    const d = new Date(NOW + 26 * 3_600_000);
    expect(nextDay).toBe(
      `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`,
    );
  });

  it("formatEta rounds minutes and composes hours", () => {
    expect(formatEta(90_000)).toBe("约 2 分钟");
    expect(formatEta(5_400_000)).toBe("约 1 小时 30 分钟");
    expect(formatEta(3_600_000)).toBe("约 1 小时");
    expect(formatEta(10_000)).toBe("约 不足 1 分钟");
    expect(formatEta(undefined)).toBe("未知");
  });
});

describe("L1 tick block", () => {
  it("renders one segment per provider and ⚠ on degraded windows", () => {
    const zai = verdict({
      level: 1,
      windows: [w("5h", 62, 1, "pct"), w("week", 21, 0, "none")],
    });
    const kimi = verdict({
      provider: "kimi-coding",
      level: 3,
      windows: [w("5h", 8, 0, "none"), w("week", 100, 3, "exhausted")],
    });
    expect(buildQuotaTickText([zai, kimi], NOW)).toBe(
      "[quota] zai-coding-cn 5h 62% · 7d 21% | kimi-coding 5h 8% · 7d 100% ⚠",
    );
  });

  it("appends ⤓demoted(→HH:MM) at the segment tail while the mark lives", () => {
    const v = verdict({
      level: 1,
      demoted: true,
      windows: [w("5h", 41, 1, "pct"), w("week", 19, 0, "none", { resetAt: RESET })],
    });
    expect(renderProviderLine(v, NOW)).toBe("zai-coding-cn 5h 41% · 7d 19% ⤓demoted(→02:11)");
  });

  it("renders bare ⤓demoted when no window reset time is known", () => {
    const v = verdict({ level: 1, demoted: true, windows: [w("5h", 41, 1, "pct")] });
    expect(renderProviderLine(v, NOW)).toBe("zai-coding-cn 5h 41% ⤓demoted");
  });
});

describe("L2 warn block", () => {
  it("matches the plan §5.5 template (pct + eta before reset)", () => {
    const v = verdict({
      level: 2,
      windows: [w("5h", 78, 2, "pct", { resetAt: RESET, etaMs: 41 * 60_000 }), w("week", 21, 0, "none")],
    });
    expect(buildQuotaWarnText(v, NOW)).toBe(
      [
        "[quota 预警] zai-coding-cn 5h 已用 78%（阈值 75%），按当前速率约 41 分钟后耗尽，早于窗口重置（02:11）。",
        "订阅额度照常优先使用，派单不变；到 L3（≥90% 或即将耗尽）才会切换。",
      ].join("\n"),
    );
  });

  it("features the highest-level window and drops clauses it has no data for", () => {
    const v = verdict({
      level: 2,
      windows: [w("5h", 10, 0, "none"), w("week", 62, 2, "forecast-before-reset", { etaMs: 3 * 3_600_000 })],
    });
    const text = buildQuotaWarnText(v, NOW);
    expect(text).toContain("zai-coding-cn 7d 已用 62%");
    expect(text).not.toContain("阈值"); // forecast-raised: no pct tier crossed
    expect(text).toContain("按当前速率约 3 小时后耗尽");
    expect(text).not.toContain("早于窗口重置"); // resetAt unknown
  });

  it("is advisory only: never redirects to other models nor announces a demotion", () => {
    const v = verdict({ level: 2, windows: [w("5h", 78, 2, "pct")] });
    const text = buildQuotaWarnText(v, NOW);
    expect(text).not.toContain("优先交给");
    expect(text).not.toContain("降一位");
    expect(text).toContain("订阅额度照常优先使用");
  });
});

describe("L3 block", () => {
  const alternatives = ["kimi-coding/kimi-k3", "cloudrouter-anthropic/claude-opus-5"];

  it("matches the template (forbid + candidates to weigh against the task + gate promise)", () => {
    const v = verdict({
      level: 3,
      windows: [w("5h", 93, 3, "pct", { resetAt: RESET, etaMs: 18 * 60_000 })],
    });
    expect(buildQuotaBlockText(v, alternatives, NOW)).toBe(
      [
        "[quota 严重] zai-coding-cn 5h 已用 93%，预计 18 分钟内耗尽（窗口 02:11 重置）。",
        "本轮不要把新任务派给 zai-coding-cn。替代候选（订阅优先）：kimi-coding/kimi-k3、cloudrouter-anthropic/claude-opus-5。",
        "按任务需求选：候选能胜任就优先用（订阅额度不用会作废）；不胜任就按路由表另选合适模型，不必硬凑。",
        "继续派给该 provider 会在 spawn 阶段被快速失败拦下（不会消耗 run）。",
      ].join("\n"),
    );
  });

  it("handles exhausted windows without eta/reset", () => {
    const v = verdict({ level: 3, windows: [w("week", 100, 3, "exhausted")] });
    const text = buildQuotaBlockText(v, [], NOW);
    expect(text).toContain("[quota 严重] zai-coding-cn 7d 已用 100%。");
    expect(text).toContain(
      "本轮不要把新任务派给 zai-coding-cn。暂无替代候选，按路由表另选合适模型（可检查 pi /model）。",
    );
  });
});

describe("buildQuotaMessage", () => {
  it("assembles one merged message: L1 tick first, then L2/L3 blocks", () => {
    const l1 = verdict({ provider: "kimi-coding", level: 1, windows: [w("5h", 55, 1, "pct")] });
    const l2 = verdict({ level: 2, windows: [w("5h", 78, 2, "pct")] });
    const l3 = verdict({ level: 3, windows: [w("5h", 93, 3, "exhausted")] });
    const text = buildQuotaMessage(
      [
        { verdict: l2, alternatives: ["kimi-coding/kimi-k3"] },
        { verdict: l1, alternatives: [] },
        { verdict: l3, alternatives: ["kimi-coding/kimi-k3"] },
      ],
      NOW,
    );
    const parts = text.split("\n\n");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("[quota] kimi-coding 5h 55%");
    expect(parts[1]).toContain("[quota 预警]");
    expect(parts[2]).toContain("[quota 严重]");
  });

  it("merges same-pool providers (zai-coding-cn / zai) into one L2/L3 block", () => {
    const pool = [w("5h", 20, 0, "none"), w("week", 28, 2, "forecast-before-reset", { resetAt: RESET })];
    const cn = verdict({ provider: "zai-coding-cn", level: 2, windows: pool });
    const intl = verdict({ provider: "zai", level: 2, windows: pool });
    const warn = buildQuotaMessage(
      [
        { verdict: cn, alternatives: [] },
        { verdict: intl, alternatives: [] },
      ],
      NOW,
    );
    expect(warn.split("\n\n")).toHaveLength(1);
    expect(warn).toContain("[quota 预警] zai-coding-cn / zai 7d 已用 28%");

    // L3：合并后替代链剔除同池成员（同池的另一个名字不是替代）。
    const hot = [w("5h", 93, 3, "pct", { resetAt: RESET })];
    const block = buildQuotaMessage(
      [
        {
          verdict: verdict({ provider: "zai-coding-cn", level: 3, windows: hot }),
          alternatives: ["zai/glm-5.3", "deepseek/x"],
        },
        {
          verdict: verdict({ provider: "zai", level: 3, windows: hot }),
          alternatives: ["zai-coding-cn/glm-5.3", "deepseek/x"],
        },
      ],
      NOW,
    );
    expect(block.split("\n\n")).toHaveLength(1);
    expect(block).toContain("本轮不要把新任务派给 zai-coding-cn / zai。替代候选（订阅优先）：deepseek/x。");
  });

  it("keeps different pools (or same data at different levels) as separate blocks", () => {
    const a = verdict({ provider: "zai-coding-cn", level: 2, windows: [w("5h", 78, 2, "pct")] });
    const b = verdict({ provider: "zai", level: 2, windows: [w("5h", 80, 2, "pct")] });
    const text = buildQuotaMessage(
      [
        { verdict: a, alternatives: [] },
        { verdict: b, alternatives: [] },
      ],
      NOW,
    );
    expect(text.split("\n\n")).toHaveLength(2);
    expect(text).toContain("[quota 预警] zai-coding-cn 5h");
    expect(text).toContain("[quota 预警] zai 5h");
  });

  it("returns empty string for no sections", () => {
    expect(buildQuotaMessage([], NOW)).toBe("");
  });
});

describe("renderQuotaStatus (HUD line)", () => {
  const zai = verdict({
    windows: [w("5h", 62, 1, "pct"), w("week", 21, 0, "none")],
  });
  const kimi = verdict({
    provider: "kimi-coding",
    level: 3,
    windows: [w("5h", 8, 0, "none"), w("week", 100, 3, "exhausted")],
  });

  it("returns undefined when no provider has a snapshot", () => {
    expect(renderQuotaStatus([], NOW, 600_000)).toBeUndefined();
  });

  it("renders the condensed line with short names", () => {
    expect(renderQuotaStatus([zai, kimi], NOW, 600_000)).toBe("quota zai 62%/21% · kimi 8%/100%");
  });

  it("appends ·stale Nm once when any snapshot is older than refreshMs", () => {
    const line = renderQuotaStatus([zai, kimi], NOW + 12 * 60_000, 600_000);
    expect(line).toBe("quota zai 62%/21% · kimi 8%/100% ·stale 12m");
  });

  it("stays clean while every snapshot is within refreshMs", () => {
    expect(renderQuotaStatus([zai], NOW + 600_000, 600_000)).not.toContain("stale");
  });

  it("dedupes same-pool providers (zai & zai-coding-cn share one key, review Minor 9)", () => {
    const zaiOverseas = verdict({
      provider: "zai",
      windows: [w("5h", 62, 1, "pct"), w("week", 21, 0, "none")],
    });
    expect(renderQuotaStatus([zai, zaiOverseas, kimi], NOW, 600_000)).toBe("quota zai 62%/21% · kimi 8%/100%");
    // usedPct 取整容差：62.4 vs 61.6 同池仍折叠
    const drifted = verdict({
      provider: "zai",
      windows: [w("5h", 61.6, 1, "pct"), w("week", 21.2, 0, "none")],
    });
    expect(renderQuotaStatus([zai, drifted], NOW, 600_000)).toBe("quota zai 62%/21%");
    // 数据实质不同（不同账号）时保留两行
    const separate = verdict({
      provider: "zai",
      windows: [w("5h", 30, 0, "none"), w("week", 5, 0, "none")],
    });
    expect(renderQuotaStatus([zai, separate], NOW, 600_000)).toBe("quota zai 62%/21% · zai 30%/5%");
    // dedupeVerdicts 本体：顺序保留首个
    expect(dedupeVerdicts([zai, zaiOverseas, kimi]).map((v) => v.provider)).toEqual(["zai-coding-cn", "kimi-coding"]);
  });

  it("colorizes via theme in HUD convention (dim label/name + tone value) and stays plain without it", () => {
    const calls: Array<[string, string]> = [];
    const theme = {
      fg: (color: string, text: string) => {
        calls.push([color, text]);
        return `<${color}>${text}</>`;
      },
    };
    const line = renderQuotaStatus([zai, kimi], NOW, 600_000, theme);
    expect(line).toBe("<dim>quota</> <dim>zai</> <text>62%/21%</><dim> · </><dim>kimi</> <error>8%/100%</>");
    // joiner 也是 dim
    expect(calls.some(([color, text]) => color === "dim" && text === " · ")).toBe(true);
    // stale 后缀 dim；无 theme 时纯文本不变（其余用例已锁）
    const staleLine = renderQuotaStatus([zai], NOW + 12 * 60_000, 600_000, theme);
    expect(staleLine).toBe("<dim>quota</> <dim>zai</> <text>62%/21%</><dim> ·stale 12m</>");
  });

  it("readQuotaStatusTheme reads ctx.ui.theme structurally and tolerates its absence", () => {
    const fg = (color: string, text: string): string => text;
    expect(readQuotaStatusTheme({ ui: { theme: { fg } } })?.fg("dim", "x")).toBe("x");
    expect(readQuotaStatusTheme({ ui: {} })).toBeUndefined();
    expect(readQuotaStatusTheme(undefined)).toBeUndefined();
    expect(readQuotaStatusTheme({ ui: { theme: { fg: "not-a-fn" } } })).toBeUndefined();
  });
});

// 2026-09-24 kimi 现场：等级只来自降位地板时，旧文案挑用量最高的窗口说「5h 已用 0% …
// 派单不变」；已耗尽窗口还报「预计不足 1 分钟内耗尽」。
describe("demotion-floor copy and exhausted windows", () => {
  const UNTIL = new Date(2026, 0, 18, 9, 6, 0).getTime(); // 1/18 09:06（跨天带日期）
  const floorOnly = verdict({
    provider: "kimi-coding",
    level: 2,
    demoted: true,
    demotedUntil: UNTIL,
    windows: [w("5h", 0, 0, "none"), w("week", 0, 0, "none")],
  });

  it("L2 block says the provider is still demoted instead of '已用 0% … 派单不变'", () => {
    const text = buildQuotaWarnText(floorOnly, NOW, "kimi-coding", ["zai-coding-cn/glm-5.3"]);
    expect(text).toBe(
      [
        "[quota 预警] kimi-coding 仍在降位期（此前额度告急触发降位，预计 1/18 09:06 解除），最新读数（5h 0% · 7d 0%）与降位矛盾，可能是上游返回的残缺数据，已按降位处理。",
        "新任务优先考虑其它订阅模型；若仍派给它，可能因额度耗尽失败。替代候选（订阅优先）：zai-coding-cn/glm-5.3。",
        "按任务需求选：候选能胜任就优先用（订阅额度不用会作废）；不胜任就按路由表另选合适模型，不必硬凑。",
      ].join("\n"),
    );
    expect(text).not.toContain("派单不变");
    expect(text).not.toContain("已用 0%");
  });

  it("says 预计解除时间未知 when the demotion record carries no expiry", () => {
    const { demotedUntil: _drop, ...rest } = floorOnly;
    const text = buildQuotaWarnText(rest, NOW);
    expect(text).toContain("仍在降位期（此前额度告急触发降位，预计解除时间未知）");
  });

  it("buildQuotaMessage routes the floor-only verdict's alternatives into the L2 block", () => {
    const text = buildQuotaMessage([{ verdict: floorOnly, alternatives: ["zai-coding-cn/glm-5.3"] }], NOW);
    expect(text).toContain("仍在降位期");
    expect(text).toContain("替代候选（订阅优先）：zai-coding-cn/glm-5.3");
  });

  it("a window genuinely at L2 keeps the ordinary advisory copy even while demoted", () => {
    const v = verdict({ level: 2, demoted: true, demotedUntil: UNTIL, windows: [w("5h", 78, 2, "pct")] });
    const text = buildQuotaWarnText(v, NOW);
    expect(text).toContain("5h 已用 78%");
    expect(text).not.toContain("仍在降位期");
  });

  it("⤓demoted(→…) prefers the demotion record's expiry over the earliest window reset", () => {
    const v = verdict({
      provider: "kimi-coding",
      level: 3,
      demoted: true,
      demotedUntil: UNTIL,
      windows: [w("5h", 0, 0, "none", { resetAt: RESET }), w("week", 100, 3, "exhausted", { resetAt: UNTIL })],
    });
    expect(renderProviderLine(v, NOW)).toBe("kimi-coding 5h 0% · 7d 100% ⚠ ⤓demoted(→1/18 09:06)");
  });

  it("L3 block never attaches an ETA to an exhausted window", () => {
    const v = verdict({
      provider: "kimi-coding",
      level: 3,
      windows: [w("5h", 0, 0, "none"), w("week", 100, 3, "exhausted", { resetAt: UNTIL, etaMs: 20_000 })],
    });
    const text = buildQuotaBlockText(v, [], NOW);
    expect(text.split("\n")[0]).toBe("[quota 严重] kimi-coding 7d 已用 100%（窗口 1/18 09:06 重置）。");
    expect(text).not.toContain("预计");
  });

  it("L2 block never attaches an ETA to an exhausted window either (defensive)", () => {
    const v = verdict({ level: 2, windows: [w("week", 100, 2, "exhausted", { etaMs: 20_000 })] });
    const text = buildQuotaWarnText(v, NOW);
    expect(text).toContain("7d 已用 100%");
    expect(text).not.toContain("按当前速率");
  });
});
