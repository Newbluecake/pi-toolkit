// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { setLangOverride } from "../../../src/web-hub/ui/src/composables/useI18n.js";
import TxCommand from "../../../src/web-hub/ui/src/components/transcript/TxCommand.vue";
import type { CmdCardView } from "../../../src/web-hub/ui/src/logic/cmdRecord.js";
import { cmdPlainText } from "../../../src/web-hub/ui/src/logic/cmdRecord.js";

/**
 * U1 · transcript/TxCommand.vue (plan §4.7 + the approved preview baseline): header
 * `/name args` + state chip + copy; source/「不进上下文」chips; notify level rows; widget/status
 * groups; interactive collapse line; notices; ≈6-line fold with 「展开全部」; running/unrecorded
 * bodies; TEXT NODES ONLY (no v-html — also pinned repo-wide by source-scan). No PREVIEW_CTX is
 * provided here ⇒ PathText degrades to bare text (DOM-equivalence rule), paths stay visible.
 */

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  setLangOverride(null);
  for (const w of mounted.splice(0)) w.unmount();
});

function view(over: Partial<CmdCardView> = {}): CmdCardView {
  return {
    cmdId: "c0123456789abcdef012",
    name: "record",
    args: "status",
    source: "web",
    startedAt: 1_700_000_000_000,
    state: "done",
    ...over,
  };
}

function mountCard(v: CmdCardView) {
  const w = mount(TxCommand, { props: { view: v } });
  mounted.push(w);
  return w;
}

describe("TxCommand.vue", () => {
  it("done card: header, chips, notify rows with level badges, copy button", () => {
    const w = mountCard(
      view({
        output: {
          entries: [
            { kind: "notify", level: "info", text: "录制中\n数据库: /home/u/.pi/agent/records/traffic.db" },
            { kind: "notify", level: "warning", text: "careful" },
          ],
        },
      }),
    );
    expect(w.find(".cmd-invocation").text()).toBe("/record status");
    expect(w.find(".cmd-state").text()).toContain("done");
    expect(w.find(".cmd-chip-src").text()).toBe("web");
    const rows = w.findAll(".cmd-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.find(".cmd-lv").text()).toBe("info");
    // PathText without PREVIEW_CTX ⇒ bare text, no clickable refs, path still visible
    expect(rows[0]?.text()).toContain("/home/u/.pi/agent/records/traffic.db");
    expect(w.find(".path-ref").exists()).toBe(false);
    expect(rows[1]?.find(".cmd-lv").text()).toBe("warning");
    expect(w.find("button.btn-icon").exists()).toBe(true); // CopyButton
  });

  it("zh locale: 「命令」/「不进上下文」/ feishu source chip「飞书」", () => {
    setLangOverride("zh");
    const w = mountCard(view({ source: "feishu", output: { entries: [] }, notice: "no-output" }));
    expect(w.find(".who").text()).toBe("命令");
    expect(w.find(".chip-noctx").text()).toBe("不进上下文");
    expect(w.find(".cmd-chip-src").text()).toBe("飞书");
    expect(w.text()).toContain("无输出");
  });

  it("running: spinner chip + muted body, NO copy button", () => {
    const w = mountCard(view({ state: "running", output: undefined }));
    expect(w.find(".cmd-state").text()).toContain("running");
    expect(w.find(".cmd-muted").exists()).toBe(true);
    expect(w.find("button.btn-icon").exists()).toBe(false);
  });

  it("unrecorded: 「结果未记录」 chip + body", () => {
    setLangOverride("zh");
    const w = mountCard(view({ state: "unrecorded", output: undefined }));
    expect(w.find(".cmd-state").text()).toContain("结果未记录");
    expect(w.text()).toContain("会话中断或已切换");
  });

  it("failed: failed chip + error row renders the reason as text", () => {
    const w = mountCard(view({ state: "failed", error: "E_POLICY: deny", output: undefined }));
    expect(w.find(".cmd-state").text()).toContain("failed");
    expect(w.find(".cmd-lv[data-level='error']").exists()).toBe(true);
    expect(w.text()).toContain("E_POLICY: deny");
  });

  it("timeout chip is localized (已截止) and collected output still renders", () => {
    setLangOverride("zh");
    const w = mountCard(
      view({ state: "timeout", output: { entries: [{ kind: "notify", level: "info", text: "partial" }] } }),
    );
    expect(w.find(".cmd-state").text()).toContain("已截止");
    expect(w.text()).toContain("partial");
  });

  it("notices: terminal-only / sensitive banners; left-session adds NO banner", () => {
    const term = mountCard(view({ notice: "terminal-only", output: undefined }));
    expect(term.text()).toContain("terminal"); // en: "Sent — output is only visible in the terminal"
    term.unmount();
    setLangOverride("zh");
    const sens = mountCard(view({ notice: "sensitive", output: undefined }));
    expect(sens.text()).toContain("敏感命令，输出未记录");
    sens.unmount();
    const left = mountCard(
      view({
        notice: "left-session",
        output: { entries: [{ kind: "notify", level: "info", text: "→ 已离开本会话" }] },
      }),
    );
    expect(left.text()).toContain("→ 已离开本会话");
    expect(left.findAll(".cmd-note-line")).toHaveLength(0);
  });

  it("widget/status group under their key; interactive steps collapse into one line", () => {
    const w = mountCard(
      view({
        output: {
          entries: [
            { kind: "widget", key: "agent:fleet", text: "line1" },
            { kind: "widget", key: "agent:fleet", text: "line2" },
            { kind: "interactive", title: "确认删除", text: "confirm" },
          ],
        },
      }),
    );
    const keys = w.findAll(".cmd-key");
    expect(keys).toHaveLength(1);
    expect(keys[0]?.text()).toBe("agent:fleet");
    expect(w.find(".cmd-row-group").text()).toContain("line1");
    expect(w.find(".cmd-row-group").text()).toContain("line2");
    expect(w.find(".cmd-note-line").text()).toContain("确认删除");
  });

  it(">6 lines ⇒ clamped body + 「展开全部」 toggle; click expands", async () => {
    setLangOverride("zh");
    const w = mountCard(
      view({ output: { entries: [{ kind: "notify", level: "info", text: "1\n2\n3\n4\n5\n6\n7\n8" }] } }),
    );
    expect(w.find(".cmd-card-body").classes()).toContain("is-clamped");
    const fold = w.find(".cmd-fold");
    expect(fold.text()).toBe("展开全部");
    await fold.trigger("click");
    expect(w.find(".cmd-card-body").classes()).not.toContain("is-clamped");
    expect(w.find(".cmd-fold").text()).toBe("收起");
  });

  it("short output ⇒ no fold button, no clamp", () => {
    const w = mountCard(view({ output: { entries: [{ kind: "notify", level: "info", text: "one" }] } }));
    expect(w.find(".cmd-fold").exists()).toBe(false);
    expect(w.find(".cmd-card-body").classes()).not.toContain("is-clamped");
  });

  it("truncated footer renders when the output was window-dropped", () => {
    const w = mountCard(
      view({
        output: {
          entries: [{ kind: "notify", level: "info", text: "x" }],
          truncated: { droppedEntries: 3, droppedBytes: 3000 },
        },
      }),
    );
    expect(w.find(".cmd-truncated").exists()).toBe(true);
  });

  it("copy text = cmdPlainText (header + verbatim blocks + error)", () => {
    const v = view({
      state: "failed",
      error: "boom",
      output: { entries: [{ kind: "notify", level: "info", text: "out" }] },
    });
    const w = mountCard(v);
    const btn = w.find("button.btn-icon");
    expect(btn.exists()).toBe(true);
    expect(cmdPlainText(v)).toBe("/record status\nout\nboom");
  });
});
