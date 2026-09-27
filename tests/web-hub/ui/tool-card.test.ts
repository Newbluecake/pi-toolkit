// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import ToolCard from "../../../src/web-hub/ui/src/components/transcript/ToolCard.vue";
import type { ToolView } from "../../../src/web-hub/ui/src/types.js";

/**
 * `ToolCard.vue` (vue-plan.md v2.1 §3.1/§5.2/§5.3/§6.6 — P4): state → icon/data-st mapping,
 * args/result rendering (via `@logic/render/tools.js`'s tested `summarizeArgs`/`safeJson`), the
 * truncated-payload badge, and the running-tool partial output's tail truncation (200 lines /
 * 16 KiB, `tail-lines.ts`) with its "Show full output" toggle.
 */
function view(v: Partial<ToolView> & Pick<ToolView, "toolCallId" | "toolName" | "state">): ToolView {
  return { args: undefined, ...v };
}

describe("ToolCard.vue", () => {
  it("done: shows check icon, data-st=done, args summary and output", () => {
    const wrapper = mount(ToolCard, {
      props: {
        view: view({
          toolCallId: "1",
          toolName: "read",
          state: "done",
          args: { path: "src/state.js" },
          result: "line1\nline2",
        }),
      },
    });
    expect(wrapper.get("details.tool").attributes("data-st")).toBe("done");
    expect(wrapper.get(".tool-name").text()).toBe("read");
    expect(wrapper.get(".tool-args").text()).toBe("src/state.js");
    const labels = wrapper.findAll(".tool-label").map((l) => l.text());
    expect(labels.some((l) => l.includes("Output"))).toBe(true);
    const pres = wrapper.findAll(".tool-section .pre").map((p) => p.text());
    expect(pres).toContain("line1\nline2");
    expect(wrapper.get(".tool-end").text()).toContain("2 lines");
  });

  it("running: data-st=running, shows a progress bar and a spinning icon", () => {
    const wrapper = mount(ToolCard, {
      props: { view: view({ toolCallId: "2", toolName: "bash", state: "running", args: "npm test" }) },
    });
    expect(wrapper.get("details.tool").attributes("data-st")).toBe("running");
    expect(wrapper.find(".tool-progress").exists()).toBe(true);
    expect(wrapper.find(".spin").exists()).toBe(true);
  });

  it("error: data-st=failed, result section carries is-error and a 'Result' label", () => {
    const wrapper = mount(ToolCard, {
      props: { view: view({ toolCallId: "3", toolName: "edit", state: "error", result: "boom" }) },
    });
    expect(wrapper.get("details.tool").attributes("data-st")).toBe("failed");
    expect(wrapper.get(".tool-label").text()).toContain("Result");
    expect(wrapper.get(".tool-section").classes()).toContain("is-error");
    expect(wrapper.get(".tool-end").text()).toContain("error");
  });

  it("truncated payload shows the truncated badge", () => {
    const wrapper = mount(ToolCard, {
      props: { view: view({ toolCallId: "4", toolName: "bash", state: "done", result: "x", truncated: true }) },
    });
    expect(wrapper.find(".badge-trunc").exists()).toBe(true);
  });

  it("running partial output tail-truncates to 200 lines with a Show full output toggle", async () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line-${i}`);
    const wrapper = mount(ToolCard, {
      props: { view: view({ toolCallId: "5", toolName: "bash", state: "running", partial: lines.join("\n") }) },
    });
    const pre = wrapper.get(".tool-section .pre");
    expect(pre.text().split("\n").length).toBe(200);
    expect(pre.text().split("\n")[0]).toBe("line-300");
    expect(wrapper.get("button.btn-xs").text()).toContain("Show full output");

    await wrapper.get("button.btn-xs").trigger("click");
    const fullPre = wrapper.get(".tool-section .pre");
    expect(fullPre.text().split("\n").length).toBe(500);
    expect(wrapper.find("button.btn-xs").exists()).toBe(false);
  });

  it("short partial output (under the cap) renders in full with no toggle", () => {
    const wrapper = mount(ToolCard, {
      props: { view: view({ toolCallId: "6", toolName: "bash", state: "running", partial: "hi\nthere" }) },
    });
    expect(wrapper.get(".tool-section .pre").text()).toBe("hi\nthere");
    expect(wrapper.find("button.btn-xs").exists()).toBe(false);
  });

  it("pending state: clock icon, no body when there is nothing to show", () => {
    const wrapper = mount(ToolCard, { props: { view: view({ toolCallId: "7", toolName: "bash", state: "pending" }) } });
    expect(wrapper.get("details.tool").attributes("data-st")).toBe("pending");
    expect(wrapper.find(".tool-body").exists()).toBe(false);
  });
});
