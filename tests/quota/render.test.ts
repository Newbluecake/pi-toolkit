// quota-plan §9.2 render.test.ts — L1/L2/L3 copy templates (§5.5), time /
// scope formatting, demoted + stale markers, HUD line.
//
// All wall-clock fixtures are built from local-time Date constructors so the
// expected HH:MM strings hold on any timezone.

import { describe, expect, it } from "vitest";
import type { LadderLevel, WindowScope } from "../../src/quota/types.js";
import type { ProviderVerdict, QuotaRecoveryEvent, WindowVerdict } from "../../src/quota/ladder.js";
import {
  alternativesAdvice,
  buildQuotaAvailableTexts,
  buildQuotaBlockText,
  buildQuotaMessage,
  buildQuotaRecoveryText,
  buildQuotaRecoveryTexts,
  buildQuotaTickText,
  buildQuotaWarnText,
  dedupeVerdicts,
  formatCountdown,
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

  it("formatCountdown hits each duration tier boundary (English tokens, floor to minute)", () => {
    expect(formatCountdown(59_000)).toBe("<1m");
    expect(formatCountdown(60_000)).toBe("1m");
    expect(formatCountdown(59 * 60_000)).toBe("59m");
    expect(formatCountdown(60 * 60_000 - 1_000)).toBe("59m"); // 59m59s
    expect(formatCountdown(60 * 60_000)).toBe("1h");
    expect(formatCountdown(3 * 60_000 * 60)).toBe("3h");
    expect(formatCountdown((3 * 60 + 12) * 60_000)).toBe("3h12m");
    expect(formatCountdown((23 * 60 + 59) * 60_000)).toBe("23h59m");
    expect(formatCountdown(24 * 60_000 * 60)).toBe("1d");
    expect(formatCountdown(2 * 24 * 3_600_000)).toBe("2d"); // 2d0h
    expect(formatCountdown((2 * 24 + 11) * 3_600_000)).toBe("2d11h");
    expect(formatCountdown(Number.NaN)).toBe("<1m"); // 防御：非有限值
  });
});

describe("alternative provider copy", () => {
  it("uses provider-oriented subscription advice", () => {
    const text = alternativesAdvice({ providers: ["kimi-coding"], subscription: true });
    expect(text).toContain("替代候选（订阅优先）：kimi-coding。");
    expect(text).toContain("在这些 provider 下按任务需求选择合适模型");
  });

  it("labels tier 2 fallback as pay-per-use rather than subscription-first", () => {
    const text = alternativesAdvice({ providers: ["cloudrouter-response"], subscription: false });
    expect(text).toContain("无可用订阅；按量计费 provider：cloudrouter-response。");
    expect(text).not.toContain("订阅优先");
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

  it("marks a window whose reset has elapsed with the compact English ·reset token (no ⚠)", () => {
    const kimi = verdict({
      provider: "kimi-coding",
      level: 0,
      windows: [w("5h", 8, 0, "none"), w("week", 100, 0, "reset-elapsed")],
    });
    expect(renderProviderLine(kimi, NOW)).toBe("kimi-coding 5h 8% · 7d 100%·reset");
    expect(buildQuotaTickText([kimi], NOW)).toBe("[quota] kimi-coding 5h 8% · 7d 100%·reset");
    // 与仍在有效的 L2 窗口共存：·reset 只落在已过重置的窗口上，⚠ 照常给有效窗口。
    const mixed = verdict({
      provider: "kimi-coding",
      level: 2,
      windows: [w("5h", 80, 2, "pct"), w("week", 100, 0, "reset-elapsed")],
    });
    expect(renderProviderLine(mixed, NOW)).toBe("kimi-coding 5h 80% ⚠ · 7d 100%·reset");
  });

  it("HUD line carries ·reset per elapsed window, plain and themed", () => {
    const kimi = verdict({
      provider: "kimi-coding",
      level: 0,
      windows: [w("5h", 8, 0, "none"), w("week", 100, 0, "reset-elapsed")],
    });
    expect(renderQuotaStatus([kimi], NOW, 600_000)).toBe("quota kimi 8%/100%·reset");
    const theme = { fg: (_color: string, text: string) => `<${text}>` };
    expect(renderQuotaStatus([kimi], NOW, 600_000, theme)).toBe("<quota> <kimi> <8%/100%·reset>");
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

  it("uses the week window's own threshold (95%), not the 5h default (75%) — quota-plan 「阶梯阈值按窗口区分」", () => {
    const v = verdict({ level: 2, windows: [w("week", 95, 2, "pct")] });
    const text = buildQuotaWarnText(v, NOW);
    expect(text).toContain("7d 已用 95%（阈值 95%）");
    expect(text).toContain("到 L3（\u226598% 或即将耗尽）");
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
        "本轮不要把新任务派给 zai-coding-cn（继续派给它会在 spawn 阶段被快速失败拦下，不会消耗 run）。",
        "替代候选（订阅优先）：kimi-coding/kimi-k3、cloudrouter-anthropic/claude-opus-5。",
        "按任务需求选：在这些 provider 下按任务需求选择合适模型；订阅额度不用会作废；不胜任就按路由表另选合适模型，不必硬凑。",
      ].join("\n"),
    );
  });

  it("handles exhausted windows without eta/reset", () => {
    const v = verdict({ level: 3, windows: [w("week", 100, 3, "exhausted")] });
    const text = buildQuotaBlockText(v, [], NOW);
    expect(text).toContain("[quota 严重] zai-coding-cn 7d 已用 100%。");
    expect(text).toContain(
      "本轮不要把新任务派给 zai-coding-cn（继续派给它会在 spawn 阶段被快速失败拦下，不会消耗 run）。\n暂无替代候选，按路由表另选合适模型（可检查 pi /model）。",
    );
  });
});

/** 注入消息按 `[quota` 段首切分（段间单换行，段内也有换行，不能按空行切）。 */
function blocks(text: string): string[] {
  return text.split(/\n(?=\[quota)/);
}

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
    // 段间单换行（不留空行）：按 `[quota` 段首切分。
    expect(text).not.toContain("\n\n");
    const parts = blocks(text);
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
    expect(blocks(warn)).toHaveLength(1);
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
    expect(blocks(block)).toHaveLength(1);
    expect(block).toContain(
      "本轮不要把新任务派给 zai-coding-cn / zai（继续派给它会在 spawn 阶段被快速失败拦下，不会消耗 run）。\n替代候选（订阅优先）：deepseek/x。",
    );
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
    expect(blocks(text)).toHaveLength(2);
    expect(text).toContain("[quota 预警] zai-coding-cn 5h");
    expect(text).toContain("[quota 预警] zai 5h");
  });

  it("merges several L3 providers: one reading line each, ban + alternatives said once", () => {
    const pool = [w("week", 98, 3, "pct", { resetAt: RESET, etaMs: 37 * 60_000 })];
    const kimiWin = [w("week", 100, 3, "exhausted", { resetAt: RESET })];
    const alts = { providers: ["cr-response", "cr-anthropic", "zhipu-pool"], subscription: false };
    const text = buildQuotaMessage(
      [
        { verdict: verdict({ provider: "zai-coding-cn", level: 3, windows: pool }), alternatives: alts },
        { verdict: verdict({ provider: "zai", level: 3, windows: pool }), alternatives: alts },
        { verdict: verdict({ provider: "kimi-coding", level: 3, windows: kimiWin }), alternatives: alts },
      ],
      NOW,
    );
    const lines = text.split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(/^\[quota 严重\] zai-coding-cn \/ zai 7d 已用 98%，预计 37 分钟内耗尽（窗口 .+ 重置）。$/);
    expect(lines[1]).toMatch(/^\[quota 严重\] kimi-coding 7d 已用 100%（窗口 .+ 重置）。$/);
    expect(lines[2]).toBe(
      "本轮不要把新任务派给 zai-coding-cn / zai、kimi-coding（继续派给它们会在 spawn 阶段被快速失败拦下，不会消耗 run）。",
    );
    expect(lines[3]).toBe("无可用订阅；按量计费 provider：cr-response、cr-anthropic、zhipu-pool。");
    expect(text.match(/本轮不要/g)).toHaveLength(1);
    expect(text.match(/^按任务需求选：/gm)).toHaveLength(1);
  });

  it("merged L3 alternatives are the intersection minus every banned provider", () => {
    const hot = [w("5h", 93, 3, "pct", { resetAt: RESET })];
    const text = buildQuotaMessage(
      [
        {
          verdict: verdict({ provider: "zai", level: 3, windows: hot }),
          alternatives: ["kimi-coding/k3", "deepseek/x", "a/y"],
        },
        {
          verdict: verdict({ provider: "kimi-coding", level: 3, windows: [w("5h", 95, 3, "pct")] }),
          alternatives: ["zai/glm", "deepseek/x"],
        },
      ],
      NOW,
    );
    expect(text).toContain("替代候选（订阅优先）：deepseek/x。");
    expect(text).not.toContain("kimi-coding/k3");
    expect(text.match(/本轮不要/g)).toHaveLength(1);
  });

  it("falls back to separate L3 blocks when the alternatives cannot be merged losslessly", () => {
    const hot = [w("5h", 93, 3, "pct", { resetAt: RESET })];
    // 订阅口径不一致
    const mixed = buildQuotaMessage(
      [
        {
          verdict: verdict({ provider: "zai", level: 3, windows: hot }),
          alternatives: { providers: ["a"], subscription: true },
        },
        {
          verdict: verdict({ provider: "kimi-coding", level: 3, windows: [w("5h", 95, 3, "pct")] }),
          alternatives: { providers: ["a"], subscription: false },
        },
      ],
      NOW,
    );
    expect(mixed.match(/本轮不要/g)).toHaveLength(2);
    // 交集为空而各自原本有候选
    const disjoint = buildQuotaMessage(
      [
        { verdict: verdict({ provider: "zai", level: 3, windows: hot }), alternatives: ["b/x"] },
        {
          verdict: verdict({ provider: "kimi-coding", level: 3, windows: [w("5h", 95, 3, "pct")] }),
          alternatives: ["c/y"],
        },
      ],
      NOW,
    );
    expect(disjoint.match(/本轮不要/g)).toHaveLength(2);
    expect(disjoint).toContain("派给它会");
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

// 恢复倒计时（2026-09 用户确认效果）：用完窗口的 provider 段末尾追加
// ` resets <时长>`（英文 token），倒计时到全部用完窗口 resetAt 的最大值。
describe("HUD recovery countdown (resets …)", () => {
  const H = 3_600_000;
  const D = 24 * H;
  const TWO_D_11H = 2 * D + 11 * H;

  /** week 用完（resetAt 可控）、5h 未用的 kimi verdict。 */
  function exhaustedKimi(resetAt: number | undefined, now = NOW): ProviderVerdict {
    return verdict({
      provider: "kimi-coding",
      level: 3,
      fetchedAt: now,
      windows: [w("5h", 8, 0, "none"), w("week", 100, 3, "exhausted", ...(resetAt === undefined ? [] : [{ resetAt }]))],
    });
  }

  it("appends ` resets <duration>` to the exhausted provider segment only", () => {
    const zai = verdict({ windows: [w("5h", 62, 1, "pct"), w("week", 21, 0, "none")] });
    const kimi = exhaustedKimi(NOW + TWO_D_11H);
    expect(renderQuotaStatus([zai, kimi], NOW, 600_000)).toBe("quota zai 62%/21% · kimi 8%/100% resets 2d11h");
  });

  it("takes the LATEST resetAt when both windows are exhausted (wait for 7d)", () => {
    const both = verdict({
      provider: "kimi-coding",
      level: 3,
      windows: [
        w("5h", 100, 3, "exhausted", { resetAt: NOW + 3 * H }),
        w("week", 100, 3, "exhausted", { resetAt: NOW + TWO_D_11H }),
      ],
    });
    expect(renderQuotaStatus([both], NOW, 600_000)).toBe("quota kimi 100%/100% resets 2d11h");
    // 窗口顺序不影响取最大值
    const flipped = verdict({
      provider: "kimi-coding",
      level: 3,
      windows: [
        w("week", 100, 3, "exhausted", { resetAt: NOW + TWO_D_11H }),
        w("5h", 100, 3, "exhausted", { resetAt: NOW + 3 * H }),
      ],
    });
    expect(renderQuotaStatus([flipped], NOW, 600_000)).toBe("quota kimi 100%/100% resets 2d11h");
  });

  it("shows the countdown once a window is above 95% (not only when exhausted)", () => {
    const near = verdict({
      provider: "zai-coding-cn",
      level: 3,
      windows: [w("5h", 12, 0, "none"), w("week", 96, 3, "pct", { resetAt: NOW + TWO_D_11H })],
    });
    expect(renderQuotaStatus([near], NOW, 600_000)).toBe("quota zai 12%/96% resets 2d11h");
    // 正好 95% 不算「超过」
    const at95 = verdict({
      provider: "zai-coding-cn",
      level: 2,
      windows: [w("5h", 12, 0, "none"), w("week", 95, 2, "pct", { resetAt: NOW + TWO_D_11H })],
    });
    expect(renderQuotaStatus([at95], NOW, 600_000)).toBe("quota zai 12%/95%");
    // 95.4% 显示为 95% ⇒ 与段内数字口径一致，不显示倒计时；95.6% 显示 96% ⇒ 显示
    const at954 = verdict({
      provider: "zai-coding-cn",
      level: 2,
      windows: [w("5h", 12, 0, "none"), w("week", 95.4, 2, "pct", { resetAt: NOW + TWO_D_11H })],
    });
    expect(renderQuotaStatus([at954], NOW, 600_000)).toBe("quota zai 12%/95%");
    const at956 = verdict({
      provider: "zai-coding-cn",
      level: 3,
      windows: [w("5h", 12, 0, "none"), w("week", 95.6, 3, "pct", { resetAt: NOW + TWO_D_11H })],
    });
    expect(renderQuotaStatus([at956], NOW, 600_000)).toBe("quota zai 12%/96% resets 2d11h");
    // 5h 97% 在前、7d 100% 在后 ⇒ 取较晚的重置
    const both = verdict({
      provider: "kimi-coding",
      level: 3,
      windows: [
        w("5h", 97, 3, "pct", { resetAt: NOW + 3 * H }),
        w("week", 100, 3, "exhausted", { resetAt: NOW + TWO_D_11H }),
      ],
    });
    expect(renderQuotaStatus([both], NOW, 600_000)).toBe("quota kimi 97%/100% resets 2d11h");
    // 只有 5h 过线 ⇒ 5h 的重置
    const only5h = verdict({
      provider: "kimi-coding",
      level: 3,
      windows: [w("5h", 97, 3, "pct", { resetAt: NOW + 3 * H }), w("week", 40, 0, "none")],
    });
    expect(renderQuotaStatus([only5h], NOW, 600_000)).toBe("quota kimi 97%/40% resets 3h");
  });

  it("hides the countdown when any exhausted window has no resetAt (never guess)", () => {
    // 唯一用完窗口无 resetAt
    expect(renderQuotaStatus([exhaustedKimi(undefined)], NOW, 600_000)).toBe("quota kimi 8%/100%");
    // 5h 用完（有 resetAt）+ week 用完（无）⇒ 恢复时刻未知，同样不显示
    const partial = verdict({
      provider: "kimi-coding",
      level: 3,
      windows: [w("5h", 100, 3, "exhausted", { resetAt: NOW + 3 * H }), w("week", 100, 3, "exhausted")],
    });
    expect(renderQuotaStatus([partial], NOW, 600_000)).toBe("quota kimi 100%/100%");
  });

  it("never shows a countdown for merely-high usage (L3 95% not exhausted)", () => {
    const hot = verdict({
      level: 3,
      windows: [w("5h", 95, 3, "pct", { resetAt: NOW + TWO_D_11H })],
    });
    expect(renderQuotaStatus([hot], NOW, 600_000)).toBe("quota zai 95%");
  });

  it("reset-elapsed windows never count as exhausted (·reset keeps its place)", () => {
    const elapsed = verdict({
      provider: "kimi-coding",
      level: 0,
      windows: [w("5h", 8, 0, "none"), w("week", 100, 0, "reset-elapsed", { resetAt: NOW - 60_000 })],
    });
    expect(renderQuotaStatus([elapsed], NOW, 600_000)).toBe("quota kimi 8%/100%·reset");
  });

  it("defensively hides the countdown when an exhausted window's resetAt is already past", () => {
    // ladder 规则 0 已把这类窗口判成 reset-elapsed，这里锁住渲染层的防御分支
    const past = exhaustedKimi(NOW - 1_000);
    expect(renderQuotaStatus([past], NOW, 600_000)).toBe("quota kimi 8%/100%");
  });

  it("themes the countdown dim while percentages keep levelColor", () => {
    const theme = { fg: (color: string, text: string) => `<${color}>${text}</>` };
    expect(renderQuotaStatus([exhaustedKimi(NOW + TWO_D_11H)], NOW, 600_000, theme)).toBe(
      "<dim>quota</> <dim>kimi</> <error>8%/100%</> <dim>resets 2d11h</>",
    );
  });

  it("coexists with the ·stale marker (stale stays at line end)", () => {
    const later = NOW + 12 * 60_000;
    const kimi = exhaustedKimi(later + TWO_D_11H, NOW); // fetchedAt=NOW ⇒ age 12m；倒计时按 later 现算
    expect(renderQuotaStatus([kimi], later, 600_000)).toBe("quota kimi 8%/100% resets 2d11h ·stale 12m");
  });

  it("coexists with same-pool dedupe (one segment, one countdown)", () => {
    const cn = verdict({
      level: 3,
      windows: [w("5h", 12, 0, "none"), w("week", 100, 3, "exhausted", { resetAt: NOW + TWO_D_11H })],
    });
    const intl = verdict({
      provider: "zai",
      level: 3,
      windows: [w("5h", 12, 0, "none"), w("week", 100, 3, "exhausted", { resetAt: NOW + TWO_D_11H })],
    });
    expect(renderQuotaStatus([cn, intl], NOW, 600_000)).toBe("quota zai 12%/100% resets 2d11h");
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
        "按任务需求选：在这些 provider 下按任务需求选择合适模型；订阅额度不用会作废；不胜任就按路由表另选合适模型，不必硬凑。",
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

// 额度恢复播报文案（buildQuotaRecoveryText）：英文 token（5h/7d 读数）+ 中文散文；
// 闸门状态必须与 event.gateBlocked 一致——另一窗口仍耗时绝不写「已放行」。
describe("recovery block (额度恢复播报)", () => {
  const R5H = new Date(2026, 0, 15, 6, 11, 0).getTime(); // local 06:11
  const RWEEK = new Date(2026, 0, 18, 9, 6, 0).getTime(); // local 1/18 09:06

  function recovery(over: Partial<QuotaRecoveryEvent> = {}): QuotaRecoveryEvent {
    return {
      provider: "kimi-coding",
      resetScopes: new Set<WindowScope>(["5h", "week"]),
      verdict: verdict({
        provider: "kimi-coding",
        level: 0,
        windows: [w("5h", 0, 0, "none"), w("week", 2, 0, "none")],
      }),
      gateBlocked: false,
      at: NOW,
      ...over,
    };
  }

  it("full reset with the gate open: current readings + 放行 + 可恢复派单", () => {
    expect(buildQuotaRecoveryText(recovery(), NOW)).toBe(
      "[quota 恢复] kimi-coding 窗口已重置，当前 5h 0% · 7d 2%，spawn 闸门已放行，可恢复派单。",
    );
  });

  it("single-window reset with the other still exhausted names both honestly (never 已放行)", () => {
    const v = verdict({
      provider: "kimi-coding",
      level: 3,
      demoted: true,
      demotedUntil: RWEEK,
      windows: [w("5h", 1, 0, "none", { resetAt: R5H }), w("week", 100, 3, "exhausted", { resetAt: RWEEK })],
    });
    const text = buildQuotaRecoveryText(
      recovery({ resetScopes: new Set<WindowScope>(["5h"]), verdict: v, gateBlocked: true }),
      NOW,
    );
    expect(text).toBe(
      "[quota 恢复] kimi-coding 5h 窗口已重置，当前 5h 1% · 7d 100%，" +
        "7d 仍耗尽（1/18 09:06 重置），spawn 闸门仍拦截，请继续避开 kimi-coding 的新任务。",
    );
    expect(text).not.toContain("已放行");
  });

  it("a still-warm (L2) unreset window is named with the ⚠ token", () => {
    const v = verdict({
      provider: "zai-coding-cn",
      level: 2,
      windows: [w("5h", 10, 0, "none"), w("week", 80, 2, "pct", { resetAt: RWEEK })],
    });
    const text = buildQuotaRecoveryText(
      recovery({ provider: "zai-coding-cn", resetScopes: new Set<WindowScope>(["5h"]), verdict: v, gateBlocked: true }),
      NOW,
    );
    expect(text).toContain("5h 窗口已重置，当前 5h 10% · 7d 80%");
    expect(text).toContain("7d 仍 80% ⚠，spawn 闸门仍拦截");
    expect(text).not.toContain("已放行");
  });

  it("all windows reset yet still gated (low gateLevel): honest fallback clause", () => {
    const v = verdict({ provider: "zai-coding-cn", level: 2, windows: [w("5h", 55, 2, "pct")] });
    const text = buildQuotaRecoveryText(
      recovery({ provider: "zai-coding-cn", resetScopes: new Set<WindowScope>(["5h"]), verdict: v, gateBlocked: true }),
      NOW,
    );
    expect(text).toContain("窗口已重置，当前 5h 55%");
    expect(text).toContain("重置后读数仍触发闸门（等级 L2），spawn 闸门仍拦截");
    expect(text).not.toContain("已放行");
  });

  it("merges same-pool recoveries (zai-coding-cn / zai) into one line", () => {
    const pool = [w("5h", 0, 0, "none"), w("week", 98, 3, "pct", { resetAt: RWEEK })];
    const ev = (provider: string) =>
      recovery({
        provider,
        resetScopes: new Set<WindowScope>(["5h"]),
        verdict: verdict({ provider, level: 3, windows: pool }),
        gateBlocked: true,
      });
    const texts = buildQuotaRecoveryTexts([ev("zai-coding-cn"), ev("zai")], NOW);
    expect(texts).toEqual([
      "[quota 恢复] zai-coding-cn / zai 5h 窗口已重置，当前 5h 0% · 7d 98%，7d 仍 98% ⚠，" +
        "spawn 闸门仍拦截，请继续避开 zai-coding-cn / zai 的新任务。",
    ]);
    // 不同池 / 闸门状态不同 ⇒ 分开
    const other = recovery();
    expect(buildQuotaRecoveryTexts([ev("zai"), other], NOW)).toHaveLength(2);
    expect(buildQuotaRecoveryTexts([ev("zai-coding-cn"), { ...ev("zai"), gateBlocked: false }], NOW)).toHaveLength(2);
    // 同池但已重置窗口集合不同 ⇒ 分开
    expect(
      buildQuotaRecoveryTexts(
        [ev("zai-coding-cn"), { ...ev("zai"), resetScopes: new Set<WindowScope>(["5h", "week"]) }],
        NOW,
      ),
    ).toHaveLength(2);
  });

  it("window-less verdict (defensive) keeps the reset scopes without readings", () => {
    const text = buildQuotaRecoveryText(
      recovery({ verdict: verdict({ provider: "kimi-coding", level: 0, windows: [] }) }),
      NOW,
    );
    expect(text).toBe("[quota 恢复] kimi-coding 5h、7d 窗口已重置，spawn 闸门已放行，可恢复派单。");
  });
});

// 可用播报（B 方案）：同池合并与恢复播报同源；文本形态钉死（hook 测试断言逐字）。
describe("buildQuotaAvailableTexts (plan B)", () => {
  const pool = () => [w("5h", 0, 0, "none"), w("week", 2, 0, "none")];

  it("renders one line per pool with current readings", () => {
    expect(buildQuotaAvailableTexts([verdict({ level: 0, windows: pool() })])).toEqual([
      "[quota] zai-coding-cn 订阅可用，当前 5h 0% · 7d 2%，可正常派单。",
    ]);
  });

  it("merges same-pool providers and splits different pools", () => {
    const merged = buildQuotaAvailableTexts([
      verdict({ level: 0, windows: pool() }),
      verdict({ provider: "zai", level: 0, windows: pool() }),
    ]);
    expect(merged).toEqual(["[quota] zai-coding-cn / zai 订阅可用，当前 5h 0% · 7d 2%，可正常派单。"]);
    const split = buildQuotaAvailableTexts([
      verdict({ level: 0, windows: pool() }),
      verdict({ provider: "kimi-coding", level: 0, windows: [w("5h", 10, 0, "none")] }),
    ]);
    expect(split).toHaveLength(2);
  });

  it("empty input renders nothing", () => {
    expect(buildQuotaAvailableTexts([])).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// quota-plan r2 §11 render.test.ts（P7）：droid 池的 HUD / 标签 / 替代建议 / billing 子句。
// ─────────────────────────────────────────────────────────────────────────────

import { quotaLabel } from "../../src/quota/render.js";
import type { AlternativeSelection } from "../../src/quota/render.js";
import type { QuotaBillingInfo, QuotaProblem } from "../../src/quota/types.js";

function dw(
  scope: WindowScope,
  usedPct: number,
  level: LadderLevel,
  reason: WindowVerdict["reason"] = level > 0 ? "pct" : "none",
  extra?: Partial<WindowVerdict>,
): WindowVerdict {
  return { scope, usedPct, level, reason, ...extra };
}

function pool(
  id: "droid-standard" | "droid-core",
  windows: readonly WindowVerdict[],
  level: LadderLevel,
  billing?: Partial<QuotaBillingInfo>,
): ProviderVerdict {
  return {
    provider: id,
    level,
    windows,
    demoted: false,
    fetchedAt: NOW,
    stale: false,
    billing: {
      kind: "factory",
      pool: id === "droid-standard" ? "standard" : "core",
      overage: "droidCore",
      extraUsageAllowed: false,
      extraUsageBalanceCents: 0,
      ...billing,
    },
  };
}

const MARK_THEME = { fg: (color: string, text: string) => `<${color}:${text}>` };

describe("quotaLabel / formatScope(month)", () => {
  it("translates droid virtual ids, leaves every other provider untouched", () => {
    expect(quotaLabel("droid-standard")).toBe("Droid Standard 池");
    expect(quotaLabel("droid-core")).toBe("Droid Core 池");
    expect(quotaLabel("zai-coding-cn")).toBe("zai-coding-cn");
    expect(quotaLabel("droid")).toBe("droid");
    expect(formatScope("month")).toBe("mo");
  });
});

describe("renderQuotaStatus — droid merged segment (D14)", () => {
  const std = pool("droid-standard", [dw("5h", 12, 0), dw("week", 40, 0), dw("month", 5, 0)], 0);
  const core = pool("droid-core", [dw("5h", 0, 0), dw("week", 2, 0), dw("month", 1, 0)], 0);

  it("both pools merge into ONE segment: `droid <std cells> core <core cells>`; month cells read `mo N%`", () => {
    expect(renderQuotaStatus([std, core], NOW, 600_000)).toBe("quota droid 12%/40%/mo 5% core 0%/2%/mo 1%");
  });

  it("a single pool shows `droid …` (standard) or `droid core …` (core only)", () => {
    expect(renderQuotaStatus([std], NOW, 600_000)).toBe("quota droid 12%/40%/mo 5%");
    expect(renderQuotaStatus([core], NOW, 600_000)).toBe("quota droid core 0%/2%/mo 1%");
  });

  it("each pool carries its own reset countdown only when >95% (and the extra-usage tag only on standard)", () => {
    const hot = pool(
      "droid-standard",
      [dw("5h", 100, 3, "exhausted", { resetAt: NOW + 3_600_000 }), dw("month", 5, 0)],
      3,
      { overage: "extraUsage", extraUsageAllowed: true, extraUsageBalanceCents: 1234 },
    );
    const coreHot = pool("droid-core", [dw("5h", 97, 2, "pct", { resetAt: NOW + 2 * 3_600_000 })], 2, {
      overage: "extraUsage",
      extraUsageBalanceCents: 999,
    });
    const line = renderQuotaStatus([hot, coreHot], NOW, 600_000) ?? "";
    expect(line).toBe("quota droid 100%/mo 5% resets 1h extra $12.34 core 97% resets 2h");
    expect(line.match(/extra/g)).toHaveLength(1); // core never prints `extra`
  });

  it("`extra $Y` needs overage=extraUsage AND an exhausted, non-reset-elapsed window", () => {
    const extraBilling = { overage: "extraUsage" as const, extraUsageAllowed: true, extraUsageBalanceCents: 50 };
    const notExhausted = pool("droid-standard", [dw("5h", 60, 1)], 1, extraBilling);
    expect(renderQuotaStatus([notExhausted], NOW, 600_000)).not.toContain("extra");
    const elapsed = pool("droid-standard", [dw("5h", 100, 0, "reset-elapsed", { resetAt: NOW - 1 })], 0, extraBilling);
    expect(renderQuotaStatus([elapsed], NOW, 600_000)).not.toContain("extra");
    const droidCoreOverage = pool("droid-standard", [dw("5h", 100, 3, "exhausted")], 3);
    expect(renderQuotaStatus([droidCoreOverage], NOW, 600_000)).not.toContain("extra");
    const exhausted = pool(
      "droid-standard",
      [dw("5h", 100, 3, "exhausted", { resetAt: NOW + 60_000 })],
      3,
      extraBilling,
    );
    expect(renderQuotaStatus([exhausted], NOW, 600_000)).toContain("extra $0.50");
  });

  it("themed: dim name/`core`/countdown, level-colored values, warning-colored auth", () => {
    const hot = pool("droid-standard", [dw("5h", 100, 3, "exhausted", { resetAt: NOW + 3_600_000 })], 3);
    const problems: QuotaProblem[] = [{ family: "droid", status: 402 }];
    expect(renderQuotaStatus([hot, core], NOW, 600_000, MARK_THEME, problems)).toBe(
      "<dim:quota> <dim:droid> <error:100%> <dim:resets 1h> <dim:core> <text:0%/2%/mo 1%><dim: · ><warning:droid auth 402>",
    );
  });

  it("auth problems: appended after verdict segments (plain + themed); problems-only ⇒ `quota droid auth 402`", () => {
    const p: QuotaProblem[] = [{ family: "droid", status: 402 }];
    expect(renderQuotaStatus([std], NOW, 600_000, undefined, p)).toBe("quota droid 12%/40%/mo 5% · droid auth 402");
    expect(renderQuotaStatus([], NOW, 600_000, undefined, p)).toBe("quota droid auth 402");
    expect(renderQuotaStatus([], NOW, 600_000, MARK_THEME, p)).toBe("<dim:quota> <warning:droid auth 402>");
    expect(renderQuotaStatus([], NOW, 600_000, undefined, [])).toBeUndefined();
  });

  it("legacy providers keep their segments next to the droid one; the stale suffix still applies", () => {
    const zai = verdict({ provider: "zai-coding-cn", windows: [w("5h", 62, 1, "pct")] });
    const old = { ...std, fetchedAt: NOW - 20 * 60_000 };
    expect(renderQuotaStatus([zai, old], NOW, 600_000)).toBe("quota zai 62% · droid 12%/40%/mo 5% ·stale 20m");
  });

  it("identical readings in the two pools are NOT collapsed into one (provider#-prefixed signature)", () => {
    const a = pool("droid-standard", [dw("5h", 10, 0)], 0);
    const b = pool("droid-core", [dw("5h", 10, 0)], 0);
    expect(dedupeVerdicts([a, b])).toHaveLength(2);
    expect(renderQuotaStatus([a, b], NOW, 600_000)).toBe("quota droid 10% core 10%");
  });
});

describe("alternativesAdvice — external × models (D8)", () => {
  const MODELS_LINE = "同一 Factory 账户的 Core 池仍有额度，优先改用 Droid Core 池模型：droid/glm-5.3、droid/kimi-k3。";
  const sel = (over: Partial<AlternativeSelection>): AlternativeSelection => ({
    providers: [],
    subscription: true,
    external: true,
    ...over,
  });

  it("models + providers: core line first, then 『或改用 pi 原生子 agent（订阅优先）』, then the closing line", () => {
    const text = alternativesAdvice(
      sel({ models: ["droid/glm-5.3", "droid/kimi-k3"], providers: ["kimi-coding", "zai-coding-cn"] }),
    );
    const lines = text.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain(MODELS_LINE);
    expect(lines[1]).toBe(
      "或改用 pi 原生子 agent（订阅优先）：kimi-coding、zai-coding-cn。注意这会换成 pi 子 agent 运行（不是外部 Droid，权限与工具按 pi 的 agent 类型）。",
    );
    expect(lines[2]).toBe("按任务需求选；不胜任就按路由表另选合适模型，不必硬凑。");
  });

  it("models only: no pi line", () => {
    const text = alternativesAdvice(sel({ models: ["droid/glm-5.3", "droid/kimi-k3"] }));
    expect(text).toContain(MODELS_LINE);
    expect(text).not.toContain("pi 原生子 agent");
    expect(text.endsWith("不必硬凑。")).toBe(true);
  });

  it("providers only: the pi line opens with 『改用』 (no 『或』), and swaps the tier phrase when not subscription", () => {
    const sub = alternativesAdvice(sel({ providers: ["kimi-coding"] }));
    expect(sub.startsWith("改用 pi 原生子 agent（订阅优先）：kimi-coding。")).toBe(true);
    expect(sub).not.toContain("Core 池仍有额度");
    const paid = alternativesAdvice(sel({ providers: ["cloudrouter-anthropic"], subscription: false }));
    expect(paid).toContain("改用 pi 原生子 agent（无可用订阅，按量计费）：cloudrouter-anthropic。");
  });

  it("neither: the dedicated 『暂无替代候选…窗口重置后自动恢复』 line", () => {
    expect(alternativesAdvice(sel({}))).toBe(
      "暂无替代候选，按路由表另选合适模型（可检查 pi /model；窗口重置后自动恢复）。",
    );
  });

  it("without external, models alone are ignored and the legacy branch is byte-identical", () => {
    expect(alternativesAdvice({ providers: ["kimi-coding"], subscription: true })).toBe(
      "替代候选（订阅优先）：kimi-coding。\n按任务需求选：在这些 provider 下按任务需求选择合适模型；订阅额度不用会作废；不胜任就按路由表另选合适模型，不必硬凑。",
    );
    expect(alternativesAdvice(["kimi-coding"])).toContain("替代候选（订阅优先）");
  });
});

describe("alternativesAdvice — external × 逐池清单 + 对称推荐（2026-10-15 拍板）", () => {
  const sel = (over: Partial<AlternativeSelection>): AlternativeSelection => ({
    providers: [],
    subscription: true,
    external: true,
    ...over,
  });
  const STD_BLOCKED = {
    pool: "standard" as const,
    state: "blocked" as const,
    total: 9,
    models: [
      "droid/claude-sonnet-5-5",
      "droid/claude-opus-5-5",
      "droid/gpt-6.1-sol",
      "droid/grok-4.2",
      "droid/gemini-3-pro",
    ],
  };
  const CORE_OK = {
    pool: "core" as const,
    state: "ok" as const,
    total: 3,
    models: ["droid/glm-5.3", "droid/kimi-k3", "droid/inkling"],
  };
  const CORE_BLOCKED = {
    pool: "core" as const,
    state: "blocked" as const,
    total: 3,
    models: ["droid/glm-5.3", "droid/kimi-k3", "droid/inkling"],
  };
  const STD_OK = {
    pool: "standard" as const,
    state: "ok" as const,
    total: 2,
    models: ["droid/claude-opus-5-5", "droid/gpt-6"],
  };

  it("standard 被拦 + core 有余量：core 推荐行在前，清单独立成行并取代通用括号；截断写「等 N 个」", () => {
    const text = alternativesAdvice(
      sel({
        models: ["droid/glm-5.3", "droid/kimi-k3", "droid/inkling"],
        modelsPool: "core",
        poolListing: [STD_BLOCKED, CORE_OK],
      }),
    );
    const lines = text.split("\n");
    expect(lines[0]).toBe(
      "同一 Factory 账户的 Core 池仍有额度，优先改用 Droid Core 池模型：droid/glm-5.3、droid/kimi-k3、droid/inkling。",
    );
    expect(lines[1]).toBe(
      "Droid 模型按池：Standard 池（已拦，勿派）：droid/claude-sonnet-5-5、droid/claude-opus-5-5、droid/gpt-6.1-sol、droid/grok-4.2、droid/gemini-3-pro 等 9 个；Core 池（有余量）：droid/glm-5.3、droid/kimi-k3、droid/inkling。",
    );
    expect(text).not.toContain("Factory 托管开源模型"); // 旧括号被清单取代
  });

  it("core 被拦 + standard 有余量（对称）：推荐 Standard 模型并注明计费入 Standard 池", () => {
    const text = alternativesAdvice(
      sel({
        models: ["droid/claude-opus-5-5", "droid/gpt-6"],
        modelsPool: "standard",
        poolListing: [STD_OK, CORE_BLOCKED],
      }),
    );
    const lines = text.split("\n");
    expect(lines[0]).toBe(
      "同一 Factory 账户的 Standard 池仍有额度，可改用 Droid Standard 池模型：droid/claude-opus-5-5、droid/gpt-6（Standard 池模型计入 Standard 池额度，不占 Core 池）。",
    );
    expect(lines[1]).toBe(
      "Droid 模型按池：Standard 池（有余量）：droid/claude-opus-5-5、droid/gpt-6；Core 池（已拦，勿派）：droid/glm-5.3、droid/kimi-k3、droid/inkling。",
    );
  });

  it("两池都拦：无 droid 推荐行，清单仍在（先于 pi 行）", () => {
    const text = alternativesAdvice(sel({ poolListing: [STD_BLOCKED, CORE_BLOCKED], providers: ["kimi-coding"] }));
    const lines = text.split("\n");
    expect(lines[0]).toContain("Droid 模型按池：Standard 池（已拦，勿派）：");
    expect(lines[0]).toContain("Core 池（已拦，勿派）：");
    expect(text).not.toContain("仍有额度");
    expect(lines[1]).toContain("改用 pi 原生子 agent（订阅优先）：kimi-coding。");
    expect(lines[2]).toBe("按任务需求选；不胜任就按路由表另选合适模型，不必硬凑。");
  });

  it("清单缺席（目录未探测）⇒ 通用括号保留，输出与旧版逐字一致", () => {
    const text = alternativesAdvice(sel({ models: ["droid/glm-5.3"], modelsPool: "core", providers: [] }));
    expect(text).toBe(
      "同一 Factory 账户的 Core 池仍有额度，优先改用 Droid Core 池模型：droid/glm-5.3。" +
        "（Standard 池 = Droid 的 Anthropic/OpenAI/Google/xAI 模型；Core 池 = Factory 托管开源模型）\n" +
        "按任务需求选；不胜任就按路由表另选合适模型，不必硬凑。",
    );
  });

  it("清单为空数组 ⇒ 同样回退到旧括号；modelsPool 缺席按 core（旧输出兼容）", () => {
    expect(alternativesAdvice(sel({ models: ["droid/glm-5.3"], poolListing: [] }))).toContain("Factory 托管开源模型");
    expect(alternativesAdvice(sel({ models: ["droid/glm-5.3"] })).split("\n")[0]).toContain(
      "Core 池仍有额度，优先改用 Droid Core 池模型",
    );
  });

  it("告急状态（低于闸门线但 ≥L1）标「告急」；零候选池条目被省略", () => {
    const text = alternativesAdvice(
      sel({ poolListing: [{ pool: "core", state: "warn", total: 1, models: ["droid/glm-5.3"] }] }),
    );
    expect(text.split("\n")[0]).toBe("Droid 模型按池：Core 池（告急）：droid/glm-5.3。");
  });
});

describe("alternativesAdvice — droid pool supplement for blocked pi providers (2026-10-15 拍板)", () => {
  const DROID_LINE =
    "有余量的外部 Droid 池也可用：droid/glm-5.3、droid/kimi-k3（Core 池）；droid/claude-opus-5-5（Standard 池）。注意：外部 Droid 以完整权限运行（不是 pi 子 agent），不能当 consult/验收。";
  const POOLS = [
    { pool: "core" as const, models: ["droid/glm-5.3", "droid/kimi-k3"] },
    { pool: "standard" as const, models: ["droid/claude-opus-5-5"] },
  ];

  it("appends the droid line after the pi candidates; core pool groups before standard", () => {
    const text = alternativesAdvice({ providers: ["kimi-coding"], subscription: true, droidPools: POOLS });
    const lines = text.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("替代候选（订阅优先）：kimi-coding。");
    expect(lines[2]).toBe(DROID_LINE);
    expect(text).toContain("订阅额度不用会作废"); // pi 行正文原样保留在前
  });

  it("no pi providers: replaces the 暂无替代候选 line instead of contradicting it", () => {
    const text = alternativesAdvice({
      providers: [],
      subscription: true,
      droidPools: [{ pool: "core", models: ["droid/glm-5.3"] }],
    });
    expect(text).not.toContain("暂无替代候选");
    expect(text).toBe(
      [
        "暂无 pi provider 替代候选（可检查 pi /model）。",
        "有余量的外部 Droid 池也可用：droid/glm-5.3（Core 池）。注意：外部 Droid 以完整权限运行（不是 pi 子 agent），不能当 consult/验收。",
        "按任务需求选；不胜任就按路由表另选合适模型，不必硬凑。",
      ].join("\n"),
    );
  });

  it("droid absent / empty / all-empty pools ⇒ byte-identical legacy copy", () => {
    const legacy =
      "替代候选（订阅优先）：kimi-coding。\n按任务需求选：在这些 provider 下按任务需求选择合适模型；订阅额度不用会作废；不胜任就按路由表另选合适模型，不必硬凑。";
    expect(alternativesAdvice({ providers: ["kimi-coding"], subscription: true })).toBe(legacy);
    expect(alternativesAdvice({ providers: ["kimi-coding"], subscription: true, droidPools: [] })).toBe(legacy);
    expect(
      alternativesAdvice({
        providers: ["kimi-coding"],
        subscription: true,
        droidPools: [
          { pool: "core", models: [] },
          { pool: "standard", models: [] },
        ],
      }),
    ).toBe(legacy);
    expect(alternativesAdvice({ providers: [], subscription: true, droidPools: [] })).toBe(
      "暂无替代候选，按路由表另选合适模型（可检查 pi /model）。",
    );
  });

  it("external branch ignores droidPools (D7/D8 copy unchanged)", () => {
    const text = alternativesAdvice({
      providers: [],
      subscription: true,
      external: true,
      droidPools: [{ pool: "core", models: ["droid/glm-5.3"] }],
    });
    expect(text).not.toContain("有余量的外部 Droid 池也可用");
  });

  it("merged multi-provider L3 block carries the droid line once when all sections agree; disagreement falls back to per-section", () => {
    const hot5h = [w("5h", 93, 3, "pct", { resetAt: RESET })];
    const hotWeek = [w("week", 100, 3, "exhausted", { resetAt: RESET })];
    const agree = buildQuotaMessage(
      [
        {
          verdict: verdict({ provider: "zai-coding-cn", level: 3, windows: hot5h }),
          alternatives: { providers: ["deepseek/x"], subscription: true, droidPools: POOLS },
        },
        {
          verdict: verdict({ provider: "kimi-coding", level: 3, windows: hotWeek }),
          alternatives: { providers: ["deepseek/x"], subscription: true, droidPools: POOLS },
        },
      ],
      NOW,
    );
    expect(agree.split("本轮不要把新任务派给").length - 1).toBe(1); // 仍是合并块：禁用句只说一次
    expect(agree.split("有余量的外部 Droid 池也可用").length - 1).toBe(1); // droid 行只说一次
    const disagree = buildQuotaMessage(
      [
        {
          verdict: verdict({ provider: "zai-coding-cn", level: 3, windows: hot5h }),
          alternatives: { providers: ["deepseek/x"], subscription: true, droidPools: POOLS },
        },
        {
          verdict: verdict({ provider: "kimi-coding", level: 3, windows: hotWeek }),
          alternatives: {
            providers: ["deepseek/x"],
            subscription: true,
            droidPools: [{ pool: "core", models: ["droid/kimi-k3"] }],
          },
        },
      ],
      NOW,
    );
    expect(disagree.split("本轮不要把新任务派给").length - 1).toBe(2); // 回落逐段，宁重复不矛盾
    expect(disagree).toContain("有余量的外部 Droid 池也可用");
  });
});

describe("billing clauses (§7) + merged block fallback", () => {
  const std3 = (billing: Partial<QuotaBillingInfo>) =>
    pool("droid-standard", [dw("5h", 100, 3, "exhausted", { resetAt: RESET })], 3, billing);
  const std2 = (billing: Partial<QuotaBillingInfo>) =>
    pool("droid-standard", [dw("5h", 80, 2, "pct", { resetAt: RESET })], 2, billing);
  const ALT: AlternativeSelection = { providers: ["kimi-coding"], subscription: true, external: true };
  const NOT_OPENED =
    "Factory 超额策略为 extraUsage（额外余额 $12.34）：Standard 池耗尽后 Droid 会按量扣额外余额；pi-toolkit 闸门仍按额度拦截（放行需设 quota.droidAllowExtraUsage=true）。";
  const OPENED =
    "Factory 超额策略为 extraUsage：继续派会消耗额外余额 $12.34（真钱），闸门不拦截；优先改用 Core 池或订阅模型。";
  const DROID_CORE_CLAUSE = "Factory 超额策略为 droidCore：Standard 池耗尽后请改用 Core 池模型。";
  const CORE_FALLBACK_CLAUSE =
    "Factory 计费规则：Core 池额度耗尽后，Core 池模型回落计入 Standard 池额度继续跑（Standard 池模型不能反向使用 Core 池额度）。";
  const extra = { overage: "extraUsage" as const, extraUsageAllowed: true, extraUsageBalanceCents: 1234 };

  it("extraUsage, not opened: clause sits right after the head line; L3 block still promises the gate", () => {
    const text = buildQuotaBlockText(std3(extra), ALT, NOW, quotaLabel("droid-standard"));
    const lines = text.split("\n");
    expect(lines[0]).toContain("[quota 严重] Droid Standard 池 5h 已用 100%");
    expect(lines[1]).toBe(NOT_OPENED);
    expect(text).toContain("继续派给它会在 spawn 阶段被快速失败拦下");
  });

  it("extraUsage, opened (gateOpen): real-money clause, and L3 no longer promises 『会被拦下』", () => {
    const text = buildQuotaBlockText(std3({ ...extra, gateOpen: true }), ALT, NOW, quotaLabel("droid-standard"));
    expect(text.split("\n")[1]).toBe(OPENED);
    expect(text).toContain("建议本轮不要把新任务派给 Droid Standard 池（继续派会花额外余额）。");
    expect(text).not.toContain("被快速失败拦下");
    expect(text).not.toContain("会被拦下");
  });

  it("droidCore overage: pool-switch clause (L2 warn and L3 block)", () => {
    const warn = buildQuotaWarnText(std2({}), NOW, quotaLabel("droid-standard"));
    expect(warn.split("\n")[1]).toBe(DROID_CORE_CLAUSE);
    const block = buildQuotaBlockText(std3({}), ALT, NOW, quotaLabel("droid-standard"));
    expect(block.split("\n")[1]).toBe(DROID_CORE_CLAUSE);
  });

  it("overage `off` ⇒ no billing clause; a core-pool verdict carries the FALLBACK rule clause (2026-10-16 回落)", () => {
    expect(buildQuotaBlockText(std3({ overage: "off" }), ALT, NOW)).not.toContain("Factory 超额策略");
    const coreV = pool("droid-core", [dw("5h", 100, 3, "exhausted")], 3, extra);
    const block = buildQuotaBlockText(coreV, ALT, NOW);
    expect(block).not.toContain("Factory 超额策略");
    expect(block.split("\n")[1]).toBe(CORE_FALLBACK_CLAUSE);
    const warn = buildQuotaWarnText(pool("droid-core", [dw("5h", 80, 2)], 2, extra), NOW);
    expect(warn.split("\n")[1]).toBe(CORE_FALLBACK_CLAUSE);
  });

  it("L2 warn: extraUsage clause, and the L3 threshold quoted for a month window is the month default (98)", () => {
    const warn = buildQuotaWarnText(std2(extra), NOW, quotaLabel("droid-standard"));
    expect(warn.split("\n")[1]).toBe(NOT_OPENED);
    const monthWarn = buildQuotaWarnText(
      pool("droid-standard", [dw("month", 96, 2, "pct", { resetAt: RESET })], 2),
      NOW,
      "Droid Standard 池",
    );
    expect(monthWarn).toContain("mo 已用 96%（阈值 95%）");
    expect(monthWarn).toContain("到 L3（≥98% 或即将耗尽）");
  });

  it("two L3 sections where one is a droid pool never merge into one block (fall back to per-section output)", () => {
    const zai = verdict({
      provider: "zai-coding-cn",
      level: 3,
      windows: [w("5h", 100, 3, "exhausted", { resetAt: RESET })],
    });
    const kimi = verdict({
      provider: "kimi-coding",
      level: 3,
      windows: [w("5h", 100, 3, "exhausted", { resetAt: RESET })],
    });
    const std = std3({});
    const merged = buildQuotaMessage(
      [
        { verdict: zai, alternatives: { providers: ["x"], subscription: true } },
        { verdict: kimi, alternatives: { providers: ["x"], subscription: true } },
      ],
      NOW,
    );
    // sanity: legacy pair does merge into one 禁用句.
    expect(merged.match(/本轮不要把新任务派给/g)).toHaveLength(1);
    const mixed = buildQuotaMessage(
      [
        { verdict: zai, alternatives: { providers: ["x"], subscription: true } },
        {
          verdict: std,
          alternatives: { providers: ["x"], subscription: true, external: true, models: ["droid/glm-5.3"] },
        },
      ],
      NOW,
    );
    expect(mixed).toContain("[quota 严重] zai-coding-cn 5h");
    expect(mixed).toContain("[quota 严重] Droid Standard 池 5h");
    expect(mixed).toContain("优先改用 Droid Core 池模型：droid/glm-5.3");
    expect(mixed.match(/本轮不要把新任务派给/g)).toHaveLength(2);
  });

  it("dedupe/grouping labels use quotaLabel for droid L3 sections", () => {
    const text = buildQuotaMessage([{ verdict: std3({}), alternatives: ALT }], NOW);
    expect(text).toContain("本轮不要把新任务派给 Droid Standard 池");
  });
});

// 2026-10-16 回落实测定界：Core 池额度耗尽后 Core 模型按 Factory 规则回落计入
// Standard 池额度继续跑（Standard 模型不能反向使用 Core 池额度）——文案不再把
// 「Core 池触线」当成「Core 模型不可用」。
describe("core fallback notices (2026-10-16 回落)", () => {
  const ALT_FALLBACK: AlternativeSelection = {
    providers: ["kimi-coding"],
    subscription: true,
    external: true,
    models: ["droid/claude-opus-5-5", "droid/gpt-6"],
    modelsPool: "standard",
    poolListing: [
      { pool: "standard", state: "ok", total: 2, models: ["droid/claude-opus-5-5", "droid/gpt-6"] },
      { pool: "core", state: "fallback", total: 2, models: ["droid/glm-5.3", "droid/kimi-k3"] },
    ],
    coreFallback: true,
  };
  const coreL3 = pool("droid-core", [dw("week", 100, 3, "exhausted", { resetAt: RESET })], 3);

  it("L3 block with coreFallback: no disable line — explains fallback billing, core readings stay in the head", () => {
    const text = buildQuotaBlockText(coreL3, ALT_FALLBACK, NOW, quotaLabel("droid-core"));
    const lines = text.split("\n");
    expect(lines[0]).toBe("[quota 严重] Droid Core 池 7d 已用 100%（窗口 02:11 重置）。");
    expect(lines[1]).toBe(
      "Core 池额度已用尽：Core 池模型仍可照常派发，按 Factory 计费规则回落计入 Standard 池额度（Standard 池模型不能反向使用 Core 池额度），会额外消耗 Standard 池余量。",
    );
    expect(lines[2]).toBe(
      "Droid 模型按池：Standard 池（有余量）：droid/claude-opus-5-5、droid/gpt-6；Core 池（额度尽，回落 Standard 计费）：droid/glm-5.3、droid/kimi-k3。",
    );
    expect(text).not.toContain("本轮不要把新任务派给");
    expect(text).not.toContain("改用 pi 原生子 agent"); // 不诱导换执行语义
  });

  it("L3 block WITHOUT coreFallback (standard also over the line): disable line + gate promise stay", () => {
    const { coreFallback: _drop, ...rest } = ALT_FALLBACK;
    const text = buildQuotaBlockText(coreL3, rest, NOW, quotaLabel("droid-core"));
    expect(text).toContain("本轮不要把新任务派给 Droid Core 池");
    expect(text).toContain("继续派给它会在 spawn 阶段被快速失败拦下");
  });

  it("floor-only core demotion with coreFallback: no 『新任务优先考虑其它订阅模型』", () => {
    const UNTIL = new Date(2026, 0, 18, 9, 6, 0).getTime();
    const floorCore: ProviderVerdict = {
      ...pool("droid-core", [dw("5h", 0, 0, "none"), dw("week", 0, 0, "none")], 2),
      demoted: true,
      demotedUntil: UNTIL,
    };
    const text = buildQuotaWarnText(floorCore, NOW, quotaLabel("droid-core"), ALT_FALLBACK);
    expect(text.split("\n")[0]).toBe(
      "[quota 预警] Droid Core 池 仍在降位期（此前额度告急触发降位，预计 1/18 09:06 解除），最新读数（5h 0% · 7d 0%）与降位矛盾，可能是上游返回的残缺数据，已按降位处理。",
    );
    expect(text.split("\n")[1]).toBe(
      "Core 池模型不受此降位影响：Core 池额度耗尽后按 Factory 计费规则回落计入 Standard 池额度，照常派发即可（会额外消耗 Standard 池余量）。",
    );
    expect(text).not.toContain("新任务优先考虑其它订阅模型");
  });

  it("pool listing renders the fallback state as 『额度尽，回落 Standard 计费』", () => {
    const text = alternativesAdvice({
      providers: [],
      subscription: true,
      external: true,
      poolListing: [
        { pool: "standard", state: "ok", total: 1, models: ["droid/gpt-6"] },
        { pool: "core", state: "fallback", total: 1, models: ["droid/glm-5.3"] },
      ],
    });
    expect(text.split("\n")[0]).toBe(
      "Droid 模型按池：Standard 池（有余量）：droid/gpt-6；Core 池（额度尽，回落 Standard 计费）：droid/glm-5.3。",
    );
  });

  it("pi-blocked supplement line marks fallback core pools", () => {
    const text = alternativesAdvice({
      providers: ["kimi-coding"],
      subscription: true,
      droidPools: [
        { pool: "core", models: ["droid/glm-5.3", "droid/kimi-k3"], fallback: true },
        { pool: "standard", models: ["droid/claude-opus-5-5"] },
      ],
    });
    expect(text).toContain(
      "有余量的外部 Droid 池也可用：droid/glm-5.3、droid/kimi-k3（Core 池，回落 Standard 计费）；droid/claude-opus-5-5（Standard 池）。",
    );
  });
});
