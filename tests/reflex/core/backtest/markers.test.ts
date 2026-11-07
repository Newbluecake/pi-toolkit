/**
 * B1 · markers survival governance (plan B1 step 1): every literal `markers.ts` relies on must
 * still exist in `src/**` OUTSIDE `src/reflex/**` — an upstream rename must fail here loudly
 * instead of silently misclassifying the corpus. Also pins the value-imported constants to
 * their sources and the HUD tui-gate code/comment presence (plan §8 residual-risk clause).
 */
import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENTRY_TYPE } from "../../../../src/topic-switch/records.js";
import { WAKE_LEVEL_CUSTOM_TYPE } from "../../../../src/fabric/wake-level.js";
import { LLM_TIME_ENTRY_TYPE } from "../../../../src/hud/timing.js";
import {
  HUD_TUI_GATE_SINCE,
  HUD_TIME_ENTRY_TYPE,
  INJECTED_PREFIXES,
  MARKERS_VERSION,
  ORIGIN_MARKERS,
  SUBAGENT_CHILD_MARKER,
  SUBAGENT_RUN_MARKER,
  isInjectedText,
} from "../../../../src/reflex/core/backtest/markers.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url)); // tests/reflex
const SRC = resolve(ROOT, "../src");

/** All non-reflex source files, concatenated per-file for targeted literal greps. */
function srcFiles(): { file: string; text: string }[] {
  return globSync("src/**/*.ts", { cwd: resolve(SRC, "..") })
    .filter((f) => !f.startsWith("src/reflex/"))
    .map((f) => ({ file: f, text: readFileSync(resolve(SRC, "..", f), "utf8") }));
}

function somewhere(substr: string): boolean {
  return srcFiles().some((f) => f.text.includes(substr));
}

describe("marker survival (literals still exist outside src/reflex)", () => {
  it("mirrored customType markers", () => {
    expect(somewhere(ORIGIN_MARKERS.web)).toBe(true); // src/web-hub/agent/origin-entry.ts
    expect(somewhere(SUBAGENT_CHILD_MARKER)).toBe(true); // src/session-nav/session-head.ts
    expect(somewhere(SUBAGENT_RUN_MARKER)).toBe(true); // src/adapters/pi-run-log.ts + session-nav
  });

  it("value-imported markers stay equal to their sources", () => {
    expect(ORIGIN_MARKERS.topicSwitch).toBe(ENTRY_TYPE);
    expect(ORIGIN_MARKERS.wake).toBe(WAKE_LEVEL_CUSTOM_TYPE);
    expect(HUD_TIME_ENTRY_TYPE).toBe(LLM_TIME_ENTRY_TYPE);
    expect(somewhere(ENTRY_TYPE)).toBe(true);
    expect(somewhere(WAKE_LEVEL_CUSTOM_TYPE)).toBe(true);
    expect(somewhere(LLM_TIME_ENTRY_TYPE)).toBe(true);
  });

  it("each injected prefix anchors to its producing module", () => {
    // prefix → [file that must contain a stable head of it]
    const anchors: readonly (readonly [string, string])[] = [
      ["[主会话 steer · ", "src/tools/steer-tool.ts"],
      ["[switch_context] ", "src/context-switch/tool.ts"],
      ["[web-hub attachments] ", "src/web-hub/protocol/upload.ts"],
      ["[飞书 · ", "src/web-hub/protocol/feishu.ts"],
      ["[用户 @mention] ", "src/mention/mention.ts"],
      ["[/goal 续跑 · ", "src/goal/texts.ts"],
      ["[thread 事件 · ", "src/stack.ts"],
      ["[fabric ", "src/fabric/format-fence.ts"],
    ];
    for (const [prefix, anchorFile] of anchors) {
      expect(INJECTED_PREFIXES, prefix).toContain(prefix);
      expect(
        readFileSync(resolve(SRC, anchorFile.replace(/^src\//, "")), "utf8").includes(prefix),
        `${prefix} missing from ${anchorFile}`,
      ).toBe(true);
    }
    expect(INJECTED_PREFIXES.length).toBe(anchors.length);
  });

  it("the HUD tui gate (sourceMode premise) is still in place", () => {
    const hud = readFileSync(resolve(SRC, "hud/index.ts"), "utf8");
    expect(hud.includes("非 tui 会话不再产生 HUD 计时条目")).toBe(true);
    expect(hud.includes('live = ctx.mode === "tui"')).toBe(true);
  });
});

describe("marker values", () => {
  it("HUD_TUI_GATE_SINCE is the HUD tui-gate commit instant (78d71adc, 2026-09-18)", () => {
    // 1789715067 s — derivation in B1-report §2; asserted exactly so an accidental edit is caught.
    expect(HUD_TUI_GATE_SINCE).toBe(1_789_715_067_000);
  });

  it("MARKERS_VERSION is a plain string (cache invalidation key component)", () => {
    expect(typeof MARKERS_VERSION).toBe("string");
    expect(MARKERS_VERSION.length).toBeGreaterThan(0);
  });

  it("isInjectedText matches prefixes at position 0 only", () => {
    expect(isInjectedText("[switch_context] 交接")).toBe(true);
    expect(isInjectedText("这句话里提到 [switch_context] 不算")).toBe(false);
    expect(isInjectedText("普通提问")).toBe(false);
  });
});
