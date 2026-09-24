import { describe, expect, it } from "vitest";
import { renderExtensionStatusLines, renderTimeLineStatusParts } from "../../src/hud/footer.js";

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
