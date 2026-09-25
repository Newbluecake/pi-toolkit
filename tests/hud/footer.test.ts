import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  computeLiveSubagentCost,
  layoutTopLine,
  renderExtensionStatusLines,
  renderTimeLineStatusParts,
} from "../../src/hud/footer.js";

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</>`,
};

describe("renderExtensionStatusLines", () => {
  it("quota 条目独占一行且放在最后", () => {
    const lines = renderExtensionStatusLines(
      [
        ["quota", "kimi 62%"],
        ["cache-ttl", "5h"],
      ],
      theme,
    );
    expect(lines).toEqual(["5h", "kimi 62%"]);
  });

  it("web-hub 状态独占一行（无宽度或无 quota 时），位于共享行之后、quota 之前", () => {
    const lines = renderExtensionStatusLines(
      [
        ["quota", "kimi 62%"],
        ["pi-subagent:web-hub", "web ●"],
        ["cache-ttl", "cache adaptive · 5m"],
      ],
      theme,
    );
    expect(lines).toEqual(["cache adaptive · 5m", "web ●", "kimi 62%"]);
    expect(renderExtensionStatusLines([["pi-subagent:web-hub", "web ●"]], theme, 80)).toEqual(["web ●"]);
  });

  it("放得下时 web-hub 并入 quota 行末尾，放不下则各占一行", () => {
    const entries: [string, string][] = [
      ["quota", "kimi 62%"],
      ["pi-subagent:web-hub", "web ●"],
      ["cache-ttl", "5m"],
    ];
    const plain = { fg: (_color: string, text: string) => text };
    // "kimi 62%" (8) + " │ " (3) + "web ●" (5) = 16
    expect(renderExtensionStatusLines(entries, plain, 16)).toEqual(["5m", "kimi 62% │ web ●"]);
    expect(renderExtensionStatusLines(entries, plain, 15)).toEqual(["5m", "web ●", "kimi 62%"]);
  });

  it("其余条目按 key 排序后合并为一行", () => {
    const lines = renderExtensionStatusLines(
      [
        ["goal", "running"],
        ["cache-ttl", "5h"],
        ["watch", "w1"],
      ],
      theme,
    );
    expect(lines).toEqual(["5h running w1"]);
  });

  it("feishu-notify 与 pi-hud 移到 start 行，不再出现在 status 行", () => {
    const lines = renderExtensionStatusLines(
      [
        ["feishu-notify", "✨ watching"],
        ["pi-hud", "input 17 · rounds 304"],
        ["cache-ttl", "5h"],
      ],
      theme,
    );
    expect(lines).toEqual(["5h"]);
  });

  it("无 quota 条目时不产生额外行", () => {
    expect(renderExtensionStatusLines([], theme)).toEqual([]);
    expect(renderExtensionStatusLines([["cache-ttl", "5h"]], theme)).toEqual(["5h"]);
  });

  it("quota 空文本（含仅空白）不占行", () => {
    expect(renderExtensionStatusLines([["quota", ""]], theme)).toEqual([]);
    expect(renderExtensionStatusLines([["quota", "  \n\t "]], theme)).toEqual([]);
  });

  it("空文本条目被跳过，不产生多余空格", () => {
    const lines = renderExtensionStatusLines(
      [
        ["cache-ttl", "5h"],
        ["goal", ""],
        ["watch", "  "],
      ],
      theme,
    );
    expect(lines).toEqual(["5h"]);
  });

  it("quota 与其余条目并存：status 行在前、quota 行在后", () => {
    const lines = renderExtensionStatusLines(
      [
        ["quota", "kimi 62% · zai 41%"],
        ["feishu-notify", "watching"],
        ["cache-ttl", "5h"],
      ],
      theme,
    );
    expect(lines).toEqual(["5h", "kimi 62% · zai 41%"]);
  });

  it("对条目数组做净化（sanitize），换行/重复空白折叠为单空格", () => {
    const lines = renderExtensionStatusLines([["cache-ttl", "5h\n ·  ttl 2m"]], theme);
    expect(lines).toEqual(["5h · ttl 2m"]);
  });
});

describe("renderTimeLineStatusParts", () => {
  it("按 watching → input·rounds 的顺序取出，feishu-notify 用 muted 包裹", () => {
    const parts = renderTimeLineStatusParts(
      [
        ["pi-hud", "input 17 · rounds 304"],
        ["cache-ttl", "5h"],
        ["feishu-notify", "✨ watching"],
      ],
      theme,
    );
    expect(parts).toEqual(["<muted>✨ watching</>", "input 17 · rounds 304"]);
  });

  it("缺失或空文本的条目被跳过", () => {
    expect(renderTimeLineStatusParts([["cache-ttl", "5h"]], theme)).toEqual([]);
    expect(
      renderTimeLineStatusParts(
        [
          ["feishu-notify", ""],
          ["pi-hud", "input 1 · rounds 2"],
        ],
        theme,
      ),
    ).toEqual(["input 1 · rounds 2"]);
  });

  it("对文本做净化（换行/重复空白折叠）", () => {
    expect(renderTimeLineStatusParts([["pi-hud", "input 1\n  · rounds 2"]], theme)).toEqual(["input 1 · rounds 2"]);
  });
});

describe("layoutTopLine", () => {
  const plain = { fg: (_c: string, t: string) => t };
  const parts = {
    left: "~/repo │ git master@abc1234",
    plugin: "toolkit v0.2.1@abc1234",
    model: "claude-opus-5-5 • high",
    modelWithProvider: "(cloudrouter-anthropic) claude-opus-5-5 • high",
  };
  const full = `${parts.left} │ ${parts.plugin}`;

  it("宽度充足：左侧含插件信息，右对齐带 provider 的模型", () => {
    const line = layoutTopLine(parts, 120, plain);
    expect(line.length).toBe(120);
    expect(line.startsWith(full)).toBe(true);
    expect(line.endsWith(parts.modelWithProvider)).toBe(true);
  });

  it("稍窄：先去掉 provider 前缀", () => {
    const width = full.length + 2 + parts.model.length;
    const line = layoutTopLine(parts, width, plain);
    expect(line).toBe(`${full}  ${parts.model}`);
  });

  it("再窄：去掉插件信息，保住模型", () => {
    const width = parts.left.length + 2 + parts.model.length + 1;
    const line = layoutTopLine(parts, width, plain);
    expect(line).toBe(`${parts.left}   ${parts.model}`);
  });

  it("极窄：左侧优先，模型截断到剩余宽度", () => {
    const width = parts.left.length + 8;
    const line = layoutTopLine(parts, width, plain);
    expect(line.startsWith(parts.left)).toBe(true);
    expect(visibleWidth(line)).toBe(width);
    expect(line).not.toContain("toolkit");
  });

  it("无插件信息 / 单 provider", () => {
    const line = layoutTopLine({ left: parts.left, model: parts.model }, 80, plain);
    expect(line.startsWith(parts.left)).toBe(true);
    expect(line.endsWith(parts.model)).toBe(true);
    expect(line.length).toBe(80);
  });
});

describe("computeLiveSubagentCost (+agents component)", () => {
  // 语义：Σ（主会话 assistant + 带 usage 的 toolResult）来自 session entries；
  // +agents 来自 subagent:usage 广播减去 subAccounted。总数 = Σ + +agents。
  const entry = (costUsd: number, terminal: boolean, absorbed?: boolean) =>
    absorbed === undefined ? { costUsd, terminal } : { costUsd, terminal, absorbed: true };

  it("复现：嵌套 run 花费已随父 run 的 toolResult 入账，但广播仍单列它 ⇒ 总额虚增", () => {
    // 场景：主会话派出 R（$1.0），R 内部 consult 产生 C（$0.2，父 R）。
    // 主会话 get_subagent_result(R) 的 toolResult usage 已含 C 的 $0.2（X9 链，
    // 见 tests/runtime/nested-run-usage.test.ts），subAccounted 只记下 R。
    const subUsage = new Map([
      ["run_r", entry(1.0, true)],
      ["run_c", entry(0.2, true)], // consult run：花费已在 R 的 $1.0 里
    ]);
    const live = computeLiveSubagentCost(subUsage, new Set(["run_r"]));
    // 当前实现：C 未被 subAccounted ⇒ +agents 仍计 $0.2。
    expect(live.costUsd).toBe(0.2);
    // ⇒ footer 总额 = Σ($1.0，已含 C) + +agents($0.2) = $1.2，实际 $1.0。
    expect(1.0 + live.costUsd).toBe(1.2);
    expect(live.anyActive).toBe(false); // 全终态：显示为永久灰色残留
  });

  it("被吸收（absorbed）的 run 不再计入 +agents：总额回到真实值", () => {
    const subUsage = new Map([
      ["run_r", entry(1.0, true)],
      ["run_c", entry(0.2, true, true)], // 广播标记：花费已在父 run 累计器内
    ]);
    const live = computeLiveSubagentCost(subUsage, new Set(["run_r"]));
    expect(live.costUsd).toBe(0);
    expect(1.0 + live.costUsd).toBe(1.0); // 实际花费
    expect(live.anyActive).toBe(false);
  });

  it("父 run 尚未被主会话取回时，被吸收的子 run 也不重复：+agents 只剩父", () => {
    // R 运行中（$0.8 已花，其中含已取回的 C $0.2）；广播：R 未吸收标记、C absorbed。
    const subUsage = new Map([
      ["run_r", entry(0.8, false)],
      ["run_c", entry(0.2, true, true)],
    ]);
    const live = computeLiveSubagentCost(subUsage, new Set());
    expect(live.costUsd).toBeCloseTo(0.8, 10);
    expect(live.anyActive).toBe(true); // R 还在烧钱 ⇒ 黄色
  });

  it("未被吸收（父 run 从未取结果）的终态嵌套 run 仍计入（真实花费，不留少算）", () => {
    const subUsage = new Map([
      ["run_r", entry(0.8, true)],
      ["run_g", entry(0.3, true)], // 后台嵌套 run，R 终态也没取它的结果
    ]);
    const live = computeLiveSubagentCost(subUsage, new Set(["run_r"]));
    expect(live.costUsd).toBeCloseTo(0.3, 10);
    expect(live.anyActive).toBe(false);
  });

  it("运行中的普通子 run 照常计入且标 active", () => {
    const subUsage = new Map([
      ["run_x", entry(0.4, false)],
      ["run_y", entry(0.1, true)],
    ]);
    const live = computeLiveSubagentCost(subUsage, new Set());
    expect(live.costUsd).toBeCloseTo(0.5, 10);
    expect(live.anyActive).toBe(true);
  });
});
