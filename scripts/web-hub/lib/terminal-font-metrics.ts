import assert from "node:assert/strict";
import type { PwPage } from "./playwright.js";

/** Read public renderer option facts + actual GPU canvas geometry; never xterm private fields. */
export async function terminalFontMetrics(page: PwPage) {
  const value = await page.evaluate(() => {
    const stage = document.querySelector<HTMLElement>(".terminal-spike-viewport:not(.is-initializing)")!;
    const fontFamily = stage?.dataset["terminalFontFamily"] ?? "";
    const fontSize = Number(stage?.dataset["terminalFontSize"]);
    const cols = Number(stage?.dataset["terminalCols"]);
    const canvas = stage?.querySelector<HTMLCanvasElement>("canvas[data-terminal-webgl-canvas]");
    const context = document.createElement("canvas").getContext("2d")!;
    context.font = `${fontSize}px ${fontFamily}`;
    const advances = Object.fromEntries(["W", "i", "m", "中"].map((s) => [s, context.measureText(s).width]));
    const dpr = window.devicePixelRatio;
    return { fontFamily, fontSize, cols, advances, dpr, cell: (canvas?.width ?? 0) / cols / dpr };
  });
  const ascii = [value.advances["W"]!, value.advances["i"]!, value.advances["m"]!];
  assert(value.fontFamily && value.fontSize >= 10 && value.cols > 0, "terminal font facts missing");
  assert(Math.max(...ascii) - Math.min(...ascii) < 0.5, `proportional terminal font: ${JSON.stringify(value)}`);
  const expectedCell = Math.floor(ascii[0]! * value.dpr) / value.dpr;
  assert(Math.abs(value.cell - expectedCell) < 0.1, `terminal cell/advance floor mismatch: ${JSON.stringify(value)}`);
  assert(value.advances["中"]! >= ascii[0]! * 1.5, `CJK wide fallback missing: ${JSON.stringify(value)}`);
  return value;
}
