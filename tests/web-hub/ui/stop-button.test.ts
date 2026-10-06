// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import StopButton from "../../../src/web-hub/ui/src/components/control/StopButton.vue";

/**
 * `control/StopButton.vue` (control-plan.md v2.1 §7.4 — C5): two-step confirm — first click
 * arms (data-armed, aria-live announcement, queue note), second click emits `stop`; 4s
 * auto-revert and Esc disarm; nothing renders while the agent is idle.
 */

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  vi.useRealTimers();
  for (const w of mounted.splice(0)) w.unmount();
});

function mountStop(props: { busy: boolean; queueCount?: number }) {
  const wrapper = mount(StopButton, { props });
  mounted.push(wrapper);
  return wrapper;
}

describe("StopButton.vue (§7.4 two-step)", () => {
  it("renders nothing while the agent is not busy", () => {
    const w = mountStop({ busy: false });
    expect(w.find(".stop-btn").exists()).toBe(false);
  });

  it("first click only arms (no emit, data-armed + live announcement); second click emits stop", async () => {
    const w = mountStop({ busy: true });
    await w.find(".stop-btn").trigger("click");
    expect(w.emitted("stop")).toBeUndefined();
    expect(w.find(".stop-btn").attributes("data-armed")).toBe("true");
    expect(w.find(".stop-live").exists()).toBe(true);
    await w.find(".stop-btn").trigger("click");
    expect(w.emitted("stop")).toHaveLength(1);
    expect(w.find(".stop-btn").attributes("data-armed")).toBeUndefined();
  });

  it("auto-reverts after 4s", async () => {
    vi.useFakeTimers();
    const w = mountStop({ busy: true });
    await w.find(".stop-btn").trigger("click");
    expect(w.find(".stop-btn").attributes("data-armed")).toBe("true");
    vi.advanceTimersByTime(4100);
    await w.vm.$nextTick();
    expect(w.find(".stop-btn").attributes("data-armed")).toBeUndefined();
    await w.find(".stop-btn").trigger("click"); // arms again — no stale emit
    expect(w.emitted("stop")).toBeUndefined();
  });

  it("Esc disarms without emitting", async () => {
    const w = mountStop({ busy: true });
    await w.find(".stop-btn").trigger("click");
    await w.find(".stop-btn").trigger("keydown", { key: "Escape" });
    expect(w.find(".stop-btn").attributes("data-armed")).toBeUndefined();
    expect(w.emitted("stop")).toBeUndefined();
  });

  it("armed copy carries the K12 queue note when queueCount > 0", async () => {
    const w = mountStop({ busy: true, queueCount: 3 });
    await w.find(".stop-btn").trigger("click");
    expect(w.find(".stop-queue-note").text()).toContain("3");
  });
});

describe("control.css 的 stop 图标/ring 在 --fs-scale 放大时不得压住 composer 输入文字, 且不得在手机尺寸下挤掉文字可见宽度(2026-10 现场: package1 图标铉死在超大字号下显得过小, 被驳回; package2 图标/预留无封顶引起 390×844 fs=3 时文字可见宽度 0px, 被 verifier r2 驳回; package3 封顶 + 窄屏布局降级 为最终方案)", () => {
  const css = readFileSync(
    resolve(fileURLToPath(import.meta.url), "../../../../src/web-hub/ui/src/styles/control.css"),
    "utf8",
  );
  const rule = (selector: string): string => {
    const m = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{[^}]*\\}`).exec(css);
    return m?.[0] ?? "";
  };
  /** Extracts the full `@media (max-width: 480px) { ... }` block, brace-matched (the block
   * contains nested rule braces, so a naive `[^}]*` regex can't span it). */
  const mediaBlock480 = (): string => {
    const start = css.indexOf("@media (max-width: 480px)");
    if (start < 0) return "";
    const open = css.indexOf("{", start);
    if (open < 0) return "";
    let depth = 0;
    for (let i = open; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") {
        depth--;
        if (depth === 0) return css.slice(start, i + 1);
      }
    }
    return "";
  };
  /** All `@media (max-width: 480px) { ... }` blocks in source order (there are two: the layout-
   * wrap block near the top, and a later one that narrows-overrides `.stop-btn .icon`'s cap). */
  const allMediaBlocks480 = (): string[] => {
    const blocks: string[] = [];
    let from = 0;
    for (;;) {
      const start = css.indexOf("@media (max-width: 480px)", from);
      if (start < 0) break;
      const open = css.indexOf("{", start);
      if (open < 0) break;
      let depth = 0;
      let end = -1;
      for (let i = open; i < css.length; i++) {
        if (css[i] === "{") depth++;
        else if (css[i] === "}") {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      if (end < 0) break;
      blocks.push(css.slice(start, end + 1));
      from = end + 1;
    }
    return blocks;
  };

  it("stop 图标宽屏(>480px, 无条件的基准规则)仍在 1.5x(36px)封顶, 不再无界增长", () => {
    // 基准规则在文件中文本位置在两个 @media(max-width:480px) 块之间(布局换行块之后, 图标封顶覆盖块之前), 因此 `rule()` 的首个匹配就是它
    expect(rule(".stop-btn .icon")).toMatch(/width:\s*min\(calc\(24px \* var\(--fs-scale,\s*1\)\),\s*36px\)/);
    expect(rule(".stop-btn .icon")).toMatch(/height:\s*min\(calc\(24px \* var\(--fs-scale,\s*1\)\),\s*36px\)/);
    // 不得回退成 package1 的钉死值, 也不得回退成 package2 的无封顶 calc
    expect(rule(".composer-input .stop-btn .icon")).toBe("");
    expect(rule(".stop-btn .icon")).not.toMatch(/width:\s*calc\(24px \* var\(--fs-scale,\s*1\)\);/);
  });

  it("stop 图标窄屏(<=480px)封顶放宽到 48px(可见方块 = 盒×10/24, fs>=2 时为 20px): stop/ring 已换行不再占 textarea 宽度, 无需再抑制图标大小", () => {
    const blocks = allMediaBlocks480();
    const iconBlock = blocks.find((b) => /\.stop-btn \.icon\s*\{/.test(b)) ?? "";
    expect(iconBlock).not.toBe("");
    const narrowIcon = /\.stop-btn \.icon\s*\{[^}]*\}/.exec(iconBlock)?.[0] ?? "";
    expect(narrowIcon).toMatch(/width:\s*min\(calc\(24px \* var\(--fs-scale,\s*1\)\),\s*48px\)/);
    expect(narrowIcon).toMatch(/height:\s*min\(calc\(24px \* var\(--fs-scale,\s*1\)\),\s*48px\)/);
    // 不得跟宽屏同样封顶在 36px(必须比宽屏封顶大, 否则没意义有窄屏专门规则)
    expect(narrowIcon).not.toMatch(/36px/);
    // 该规则必须打 **在** 无条件的 36px 基准规则之后(同优先级按源顺序局部, 否则窄屏时不生效)
    const baseIdx = css.indexOf(".stop-btn .icon {");
    const iconBlockIdx = css.indexOf(iconBlock);
    expect(baseIdx).toBeGreaterThanOrEqual(0);
    expect(iconBlockIdx).toBeGreaterThan(baseIdx);
  });

  it("ring-only 档(58px)仍维持固定 px 不缩放(ctx-ring 本身不跟 --fs-scale)", () => {
    expect(rule(".composer-input:has(.ctx-ring) textarea")).toMatch(/padding-right:\s*58px/);
  });

  it("stop-only 档(宽屏, 未命中窄屏 media)按 --fs-scale 缩放, 在 70px 封顶", () => {
    expect(rule(".composer-input:has(.stop-btn):not(:has(.ctx-ring)) textarea")).toMatch(
      /padding-right:\s*min\(calc\(52px \* var\(--fs-scale,\s*1\)\),\s*70px\)/,
    );
  });

  it("ring+stop 档(宽屏)拆开为 ring 固定段(56px) + stop 段按 --fs-scale 缩放并在 70px 封顶", () => {
    expect(rule(".composer-input:has(.ctx-ring):has(.stop-btn) textarea")).toMatch(
      /padding-right:\s*calc\(56px \+ min\(calc\(52px \* var\(--fs-scale,\s*1\)\),\s*70px\)\)/,
    );
  });

  it("stop-wrap 的 right 偏移按 ring 是否在场分两式: 有 ring 时贴着 ring 的固定 60px 段(不缩放); 单独出现时贴边(--sp-1, 同 ctx-ring 自己的边缘间距约定)", () => {
    expect(rule(".composer-input:has(.ctx-ring) .stop-wrap")).toMatch(/right:\s*60px/);
    expect(rule(".composer-input:not(:has(.ctx-ring)) .stop-wrap")).toMatch(/right:\s*var\(--sp-1\)/);
  });

  it("ctx-ring 自己的几何(位置/按钮宽/svg 尺寸)不得被改成跟 --fs-scale 走(与 stop 图标不同, ring 是图形控件)", () => {
    // 专门行首锗定 .ctx-ring 本体规则, 避免命中窄屏 media 里的 `.composer-input .ctx-ring { position: static; }`
    const baseCtxRing = /^\.ctx-ring\s*\{[^}]*\}/m.exec(css)?.[0] ?? "";
    expect(baseCtxRing).toMatch(/right:\s*var\(--sp-1\)/);
    expect(baseCtxRing).not.toMatch(/var\(--fs-scale/);
    expect(rule(".ctx-ring-btn")).toMatch(/width:\s*56px/);
    expect(rule(".ctx-ring-btn")).not.toMatch(/var\(--fs-scale/);
  });

  it("窄屏(<=480px)降级: ring/stop 移到 textarea 下方的独立一行, padding-right 重置为普通 --sp-3(不再需要为它们预留宽度), 两者改为 position:static(脱离绝对定位覆盖文字)", () => {
    const block = mediaBlock480();
    expect(block).not.toBe("");
    expect(block).toMatch(/\.composer-input\s*\{\s*flex-wrap:\s*wrap;/);
    expect(block).toMatch(/padding-right:\s*var\(--sp-3\);/);
    expect(block).toMatch(/\.stop-wrap[\s\S]*?position:\s*static;/);
    expect(block).toMatch(/\.ctx-ring\s*\{\s*position:\s*static;/);
    // 不得在窄屏档里残留 package3 切被捦正的旧封顶 padding 公式(56px cap)
    expect(block).not.toMatch(/56px\)\)/);
  });
});
