// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CommandResult from "../../../src/web-hub/ui/src/components/control/CommandResult.vue";
import type { CommandOutputWire } from "../../../src/web-hub/protocol/messages.js";

/**
 * `control/CommandResult.vue` (control-plan.md v2.1 §4.9 第 10 条 — C5): CommandOutputWire
 * entry rendering (notify level badge / widget+status key blocks / text+error pre), the
 * needsTerminal steps line, the truncation footer, captured:false ⇒ terminal-only note, async
 * running state and the waiting-in-terminal banner.
 */

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
});

function mountResult(props: Record<string, unknown>) {
  const wrapper = mount(CommandResult, { props: { name: "session", state: "done", ...props } });
  mounted.push(wrapper);
  return wrapper;
}

const FULL_OUTPUT: CommandOutputWire = {
  entries: [
    { kind: "notify", level: "warning", text: "settings reloaded" },
    { kind: "widget", key: "fleet", text: "3 runs active" },
    { kind: "status", key: "cache", text: "1h ttl" },
    { kind: "text", title: "doctor", text: "D01 ok\nD02 ok" },
    { kind: "error", text: "one check failed" },
    { kind: "interactive", text: "confirm" },
  ],
  truncated: { droppedEntries: 3, droppedBytes: 4096 },
  needsTerminal: true,
};

describe("CommandResult.vue (§4.9)", () => {
  it("renders every entry kind as text nodes (no v-html — source-scan enforced)", () => {
    const w = mountResult({ output: FULL_OUTPUT, captured: true });
    expect(w.find(".output-notify .chip").text()).toBe("warning");
    expect(w.find(".output-notify").text()).toContain("settings reloaded");
    const blocks = w.findAll(".output-block");
    expect(blocks.map((b) => b.find(".output-key").text())).toEqual(["fleet", "cache"]);
    const pres = w.findAll(".command-output pre");
    expect(pres.some((p) => p.text().includes("D01 ok"))).toBe(true);
    expect(pres.some((p) => p.classes().includes("output-error"))).toBe(true);
  });

  it("interactive entries collapse into the needsTerminal line; truncation footer reports drops", () => {
    const w = mountResult({ output: FULL_OUTPUT, captured: true });
    expect(w.find(".command-needs-terminal").text()).toContain("confirm");
    expect(w.find(".command-truncated").text()).toContain("3");
    expect(w.find(".command-truncated").text()).toContain("4 KiB");
    // interactive entries never render as output blocks
    expect(w.findAll(".command-output pre").some((p) => p.text() === "confirm")).toBe(false);
  });

  it("captured:false with no entries ⇒ terminal-only note (third-party commands)", () => {
    const w = mountResult({ captured: false, output: null });
    expect(w.text()).toContain("only visible in the terminal");
  });

  it("running state shows the in-progress chip; dismiss emits", async () => {
    const w = mountResult({ state: "running", name: "compact" });
    expect(w.find(".command-result").attributes("data-state")).toBe("running");
    expect(w.text()).toContain("Running…");
    await w.find(".command-result-dismiss").trigger("click");
    expect(w.emitted("dismiss")).toHaveLength(1);
  });

  it("failed state shows the error; waitingTerminal shows the terminal-interaction banner", () => {
    const failed = mountResult({ state: "failed", error: "E_BUSY_COMPACTING", message: "compacting" });
    expect(failed.find(".command-error").text()).toContain("compacting");
    const waiting = mountResult({ waitingTerminal: true, captured: false });
    expect(waiting.find(".command-waiting-terminal").text()).toContain("waiting for interaction in the terminal");
  });
});

/** Auto-dismiss (2026-10 user request): ONLY informational, content-less results (terminal-only
 * note, bare "ran fine" success card) close on their own after 6 s; real output, actionable
 * banners and errors stay. Hover/focus pause the countdown (resume keeps the remaining time);
 * a prop swap (DetailDock replaces the cmdResult object per dispatch) restarts the full window;
 * unmount clears the timer. */
describe("CommandResult.vue auto-dismiss", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("terminal-only note disappears after 6 s — not before", async () => {
    const w = mountResult({ captured: false, output: null });
    expect(w.find(".command-terminal-only").exists()).toBe(true);
    await vi.advanceTimersByTimeAsync(5_999);
    expect(w.emitted("dismiss")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(w.emitted("dismiss")).toHaveLength(1);
  });

  it("content-less captured success (ran fine, nothing to show) auto-dismisses too", async () => {
    const w = mountResult({ captured: true, output: { entries: [] } });
    expect(w.find(".command-terminal-only").exists()).toBe(false); // bare header card, no note
    await vi.advanceTimersByTimeAsync(6_000);
    expect(w.emitted("dismiss")).toHaveLength(1);
  });

  it("captured output with real text never auto-dismisses", async () => {
    const w = mountResult({ output: FULL_OUTPUT, captured: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(w.emitted("dismiss")).toBeUndefined();
    expect(w.findAll(".command-output pre").length).toBeGreaterThan(0);
  });

  it("error results never auto-dismiss", async () => {
    const w = mountResult({ state: "failed", error: "E_BUSY_COMPACTING", message: "compacting" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(w.emitted("dismiss")).toBeUndefined();
  });

  it("terminal-only with an interactive-steps line stays (content to read)", async () => {
    const w = mountResult({ captured: false, output: { entries: [{ kind: "interactive", text: "confirm" }] } });
    expect(w.find(".command-needs-terminal").exists()).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(w.emitted("dismiss")).toBeUndefined();
  });

  it("waiting-in-terminal banner never auto-dismisses (actionable)", async () => {
    const w = mountResult({ captured: false, output: null, waitingTerminal: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(w.emitted("dismiss")).toBeUndefined();
  });

  it("hover pauses and resumes with the remaining window", async () => {
    const w = mountResult({ captured: false, output: null });
    await vi.advanceTimersByTimeAsync(3_000); // 3 s left
    await w.find(".command-result").trigger("mouseenter");
    await vi.advanceTimersByTimeAsync(30_000); // paused — nothing fires
    expect(w.emitted("dismiss")).toBeUndefined();
    await w.find(".command-result").trigger("mouseleave");
    await vi.advanceTimersByTimeAsync(2_999); // resumes with the 3 s that were left
    expect(w.emitted("dismiss")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(w.emitted("dismiss")).toHaveLength(1);
  });

  it("keyboard focus pauses; focus hopping inside the card keeps it paused", async () => {
    const w = mountResult({ captured: false, output: null });
    const card = w.find(".command-result");
    await card.trigger("focusin");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(w.emitted("dismiss")).toBeUndefined();
    // focusout whose relatedTarget is still inside the card must NOT resume the countdown
    card.element.dispatchEvent(
      new FocusEvent("focusout", { bubbles: true, relatedTarget: w.find(".command-result-dismiss").element }),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(w.emitted("dismiss")).toBeUndefined();
    // focus actually leaving the card resumes with the full window still to go
    await card.trigger("focusout");
    await vi.advanceTimersByTimeAsync(5_999);
    expect(w.emitted("dismiss")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(w.emitted("dismiss")).toHaveLength(1);
  });

  it("close button still dismisses manually and cancels the countdown", async () => {
    const w = mountResult({ captured: false, output: null });
    await vi.advanceTimersByTimeAsync(1_000);
    await w.find(".command-result-dismiss").trigger("click");
    expect(w.emitted("dismiss")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(w.emitted("dismiss")).toHaveLength(1); // no second (timer) emit after the manual close
  });

  it("a new result (prop swap) restarts the full window", async () => {
    const w = mountResult({ captured: false, output: null });
    await vi.advanceTimersByTimeAsync(4_000); // 2 s left on the first window
    await w.setProps({ name: "other" }); // DetailDock replaces the cmdResult object per dispatch
    await vi.advanceTimersByTimeAsync(4_000); // the old window would have fired 2 s in
    expect(w.emitted("dismiss")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2_000); // exactly 6 s since the restart
    expect(w.emitted("dismiss")).toHaveLength(1);
  });

  it("running → done arms the countdown on completion, not before", async () => {
    const w = mountResult({ state: "running" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(w.emitted("dismiss")).toBeUndefined();
    await w.setProps({ state: "done", captured: false });
    await vi.advanceTimersByTimeAsync(5_999);
    expect(w.emitted("dismiss")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(w.emitted("dismiss")).toHaveLength(1);
  });

  it("unmount clears the timer — nothing fires afterwards", async () => {
    const w = mount(CommandResult, { props: { name: "session", state: "done", captured: false, output: null } });
    await vi.advanceTimersByTimeAsync(1_000);
    w.unmount();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(w.emitted("dismiss")).toBeUndefined();
  });
});
