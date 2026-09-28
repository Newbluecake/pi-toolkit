// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
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
