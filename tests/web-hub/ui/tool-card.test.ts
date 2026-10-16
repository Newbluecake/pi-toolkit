// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { ref, type Ref } from "vue";
import { describe, expect, it, vi } from "vitest";
import ToolCard from "../../../src/web-hub/ui/src/components/transcript/ToolCard.vue";
import { PREVIEW_CTX, type PreviewContext } from "../../../src/web-hub/ui/src/components/preview/previewContext.js";
import type { PreviewHandle, PreviewPathScope, PreviewView } from "../../../src/web-hub/ui/src/types.js";
import type { ToolView } from "../../../src/web-hub/ui/src/types.js";

/**
 * `ToolCard.vue` (vue-plan.md v2.1 §3.1/§5.2/§5.3/§6.6 — P4): state → icon/data-st mapping,
 * args/result rendering (via `@logic/render/tools.js`'s tested `summarizeArgs`/`safeJson`), the
 * truncated-payload badge, and the running-tool partial output's tail truncation (200 lines /
 * 16 KiB, `tail-lines.ts`) with its "Show full output" toggle.
 *
 * The edit-diff view (2026-10): a parseable `edit` args replaces the Input section's raw JSON
 * with `@logic/diff.js`'s rows (hunk headers `Edit i/m`, `-`/`+` rows, inline marks, the file
 * path still through `PathText`) and the fold guard collapses oversized hunks behind an
 * Expand button; any gate miss keeps the raw-JSON `<pre>` exactly as before.
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

describe("ToolCard.vue — tool-duration chip", () => {
  it("done/error with durationMs renders the muted chip; unknown duration renders NO element", () => {
    const done = mount(ToolCard, {
      props: { view: view({ toolCallId: "c1", toolName: "read", state: "done", durationMs: 2_400, result: "x" }) },
    });
    const chip = done.get(".tool-dur");
    expect(chip.text()).toBe("2.4s");
    expect(chip.attributes("translate")).toBe("no");

    const err = mount(ToolCard, {
      props: {
        view: view({ toolCallId: "c2", toolName: "bash", state: "error", durationMs: 185_000, result: "boom" }),
      },
    });
    expect(err.get(".tool-dur").text()).toBe("3m 05s");

    const unknown = mount(ToolCard, {
      props: { view: view({ toolCallId: "c3", toolName: "read", state: "done", result: "x" }) },
    });
    expect(unknown.find(".tool-dur").exists()).toBe(false);
  });

  it("running with runningSince ticks the elapsed at 1 Hz (browser clock only)", async () => {
    vi.useFakeTimers();
    try {
      const started = Date.now() - 3_400;
      const wrapper = mount(ToolCard, {
        props: { view: view({ toolCallId: "c4", toolName: "bash", state: "running", runningSince: started }) },
      });
      expect(wrapper.get(".tool-dur").text()).toBe("3.4s");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(wrapper.get(".tool-dur").text()).toBe("4.4s");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(wrapper.get(".tool-dur").text()).toBe("6.4s");
      // finishing swaps the ticking chip for the final agent-measured duration
      await wrapper.setProps({
        view: view({ toolCallId: "c4", toolName: "bash", state: "done", durationMs: 6_900, result: "x" }),
      });
      expect(wrapper.get(".tool-dur").text()).toBe("6.9s");
    } finally {
      vi.useRealTimers();
    }
  });

  it("running without runningSince (fresh attach / snapshot inflight) renders NO chip", () => {
    const wrapper = mount(ToolCard, {
      props: { view: view({ toolCallId: "c5", toolName: "bash", state: "running" }) },
    });
    expect(wrapper.find(".tool-dur").exists()).toBe(false);
  });
});

describe("ToolCard.vue — edit diff view", () => {
  it("parseable edit args: diff rows replace the raw-JSON Input section, inline marks included", () => {
    const wrapper = mount(ToolCard, {
      props: {
        view: view({
          toolCallId: "d1",
          toolName: "edit",
          state: "done",
          args: { path: "/p/src/a.ts", edits: [{ oldText: "foo(bar);", newText: "foo(baz);" }] },
          result: "ok",
        }),
      },
    });
    expect(wrapper.find(".diff").exists()).toBe(true);
    const input = wrapper.findAll(".tool-section")[0]!;
    expect(input.find(".pre").exists()).toBe(false);
    expect(input.text()).not.toContain("oldText");
    expect(input.get(".diff-del .diff-text").text()).toBe("foo(bar);");
    expect(input.get(".diff-del .diff-mark").text()).toBe("r");
    expect(input.get(".diff-add .diff-mark").text()).toBe("z");
    // the Output section is untouched
    expect(wrapper.findAll(".tool-section")[1]!.get(".pre").text()).toBe("ok");
  });

  it("multiple edits render ordered hunk headers (Edit i/m) and context rows", () => {
    const wrapper = mount(ToolCard, {
      props: {
        view: view({
          toolCallId: "d2",
          toolName: "edit",
          state: "done",
          args: {
            edits: [
              { oldText: "a\nb\nc", newText: "a\nB\nc" },
              { oldText: "", newText: "new" },
            ],
          },
        }),
      },
    });
    const heads = wrapper.findAll(".diff-hunk-head").map((h) => h.text());
    expect(heads).toEqual(["Edit 1/2", "Edit 2/2"]);
    const first = wrapper.findAll(".diff-hunk")[0]!;
    expect(first.findAll(".diff-ctx").map((r) => r.get(".diff-text").text())).toEqual(["a", "c"]);
    expect(
      wrapper
        .findAll(".diff-hunk")[1]!
        .findAll(".diff-row")
        .map((r) => r.get(".diff-text").text()),
    ).toEqual(["new"]);
  });

  it("gate misses keep the raw-JSON Input section (malformed edit args / other tools)", () => {
    const malformed = view({ toolCallId: "d3", toolName: "edit", state: "done", args: { edits: [] } });
    const w1 = mount(ToolCard, { props: { view: malformed } });
    expect(w1.find(".diff").exists()).toBe(false);
    expect(w1.get(".tool-section .pre").text()).toContain("edits");

    const w2 = mount(ToolCard, {
      props: { view: view({ toolCallId: "d4", toolName: "bash", state: "done", args: { command: "ls" } }) },
    });
    expect(w2.find(".diff").exists()).toBe(false);
    expect(w2.get(".tool-section .pre").text()).toContain("command");
  });

  it("the file path renders through PathText (plain without ctx, .path-ref with one)", () => {
    const args = { path: "/p/src/a.ts", edits: [{ oldText: "a", newText: "b" }] };
    const plain = mount(ToolCard, {
      props: { view: view({ toolCallId: "d5", toolName: "edit", state: "done", args }) },
    });
    expect(plain.get(".diff-path").text()).toBe("/p/src/a.ts");
    expect(plain.find(".diff-path .path-ref").exists()).toBe(false);

    const scope: PreviewPathScope = { agentKey: "A", sessionId: "s1", cwd: "/p", uploads: true };
    const viewRef = ref({ phase: "closed" }) as Ref<PreviewView>;
    const handle: PreviewHandle = {
      view: viewRef,
      scope: ref(scope),
      open: vi.fn(),
      close: vi.fn(),
      retry: vi.fn(),
      dispose: vi.fn(),
    };
    const ctx: PreviewContext = { handle, plaintext: false };
    const linked = mount(ToolCard, {
      props: { view: view({ toolCallId: "d6", toolName: "edit", state: "done", args }) },
      global: { provide: { [PREVIEW_CTX as symbol]: ctx } },
    });
    expect(linked.get(".diff-path .path-ref").attributes("role")).toBe("button");
  });

  it("a hunk over the fold threshold collapses; Expand restores every row", async () => {
    const lines = Array.from({ length: 250 }, (_, i) => `line-${i}`);
    const wrapper = mount(ToolCard, {
      props: {
        view: view({
          toolCallId: "d7",
          toolName: "edit",
          state: "done",
          args: { edits: [{ oldText: "", newText: lines.join("\n") }] },
        }),
      },
    });
    const hunk = () => wrapper.findAll(".diff-hunk")[0]!;
    // 250 rows > threshold 200 ⇒ head 20 + marker + tail 20
    expect(hunk().findAll(".diff-row").length).toBe(41);
    const fold = hunk().get(".diff-fold-row");
    expect(fold.text()).toContain("210");
    expect(fold.text()).toContain("omitted");

    await fold.get("button").trigger("click");
    expect(hunk().findAll(".diff-row").length).toBe(250);
    expect(hunk().find(".diff-fold-row").exists()).toBe(false);
    expect(hunk().get(".diff-row").get(".diff-text").text()).toBe("line-0");
  });
});

/**
 * Markdown-rendered tool results (2026-10「get_subagent_result 渲染 markdown」): only tools in
 * `ToolCard.vue`'s `MD_RESULT_TOOLS` allow-list get their DONE string result rendered through
 * the assistant pipeline (`MarkdownView.vue` — heading downgrade, GFM tables, CodeBlock with
 * its raw-copy button); everything else (other tools, error results, running partials, the
 * Input section) keeps the plain `<pre>` byte-identically. The rendered/source toggle is
 * per-card local state, default rendered, and the source mode always shows the raw text.
 */
describe("ToolCard.vue — markdown-rendered results (MD_RESULT_TOOLS)", () => {
  const mdResult = [
    "# Run report",
    "",
    "| model | runs | cost |",
    "| --- | --: | --- |",
    "| kimi | 3 | $0.42 |",
    "",
    "- fixed `foo.ts`",
    "",
    "```ts",
    "const answer = 42;",
    "```",
  ].join("\n");

  function mdCard(v: Partial<ToolView> & Pick<ToolView, "toolCallId" | "toolName" | "state">) {
    return mount(ToolCard, { props: { view: view(v) } });
  }

  it("done get_subagent_result renders heading/table/code as elements, not raw text", () => {
    const wrapper = mdCard({ toolCallId: "m1", toolName: "get_subagent_result", state: "done", result: mdResult });
    const md = wrapper.get(".tool-md");
    // markdown `#` downgrades to h3..h6 inside the transcript (ui-design.md §12)
    expect(md.find("h3").text()).toBe("Run report");
    const table = md.get("table.md-table");
    expect(table.findAll("th").map((c) => c.text())).toEqual(["model", "runs", "cost"]);
    expect(table.findAll("td").map((c) => c.text())).toEqual(["kimi", "3", "$0.42"]);
    expect(table.get("td:nth-child(2)").classes()).toContain("md-tr"); // `--:` right-align
    // the result section carries no plain pre; the raw pipes/headings are NOT visible as text
    expect(wrapper.find(".tool-section .pre").exists()).toBe(false);
    expect(md.find(".md-list li").text()).toContain("fixed");
  });

  it("a fenced code block inside the rendered result keeps CodeBlock's raw copy source", () => {
    const wrapper = mdCard({ toolCallId: "m2", toolName: "get_subagent_result", state: "done", result: mdResult });
    const pre = wrapper.get(".tool-md .codeblock pre");
    expect(pre.text()).toBe("const answer = 42;"); // CodeBlock's copy button copies exactly this raw text
    expect(wrapper.find(".tool-md .codeblock button").exists()).toBe(true);
  });

  it("other done tools stay plain text with no toggle, even for markdown-looking results", () => {
    for (const toolName of ["bash", "read", "Agent"]) {
      const wrapper = mdCard({ toolCallId: "m3", toolName, state: "done", result: mdResult });
      expect(wrapper.find(".tool-md").exists(), toolName).toBe(false);
      expect(wrapper.find(".tool-md-toggle").exists(), toolName).toBe(false);
      const pres = wrapper.findAll(".tool-section .pre");
      expect(
        pres.some((p) => p.text().includes("| model | runs | cost |")),
        toolName,
      ).toBe(true);
    }
  });

  it("toggle switches rendered → source (raw text) and back; default is rendered", async () => {
    const wrapper = mdCard({ toolCallId: "m4", toolName: "get_subagent_result", state: "done", result: mdResult });
    const toggle = wrapper.get(".tool-md-toggle");
    expect(toggle.attributes("role")).toBe("group");
    const [renderedBtn, sourceBtn] = toggle.findAll("button");
    expect(renderedBtn.text()).toBe("Rendered");
    expect(sourceBtn.text()).toBe("Source");
    expect(renderedBtn.attributes("aria-pressed")).toBe("true");
    expect(sourceBtn.attributes("aria-pressed")).toBe("false");

    await sourceBtn.trigger("click");
    expect(wrapper.find(".tool-md").exists()).toBe(false);
    const pre = wrapper.get(".tool-section .pre");
    expect(pre.text()).toBe(mdResult); // the RAW markdown, byte-for-byte
    expect(pre.attributes("translate")).toBe("no");
    expect(wrapper.findAll(".tool-md-toggle button")[0]!.attributes("aria-pressed")).toBe("false");
    expect(wrapper.findAll(".tool-md-toggle button")[1]!.attributes("aria-pressed")).toBe("true");

    await wrapper.findAll(".tool-md-toggle button")[0]!.trigger("click");
    expect(wrapper.find(".tool-md").exists()).toBe(true);
  });

  it("toggle state is per-card local (two cards do not share it)", async () => {
    const a = mdCard({ toolCallId: "m5a", toolName: "get_subagent_result", state: "done", result: mdResult });
    const b = mdCard({ toolCallId: "m5b", toolName: "get_subagent_result", state: "done", result: mdResult });
    await a.findAll(".tool-md-toggle button")[1]!.trigger("click");
    expect(a.find(".tool-md").exists()).toBe(false);
    expect(b.find(".tool-md").exists()).toBe(true);
  });

  it("error result and running partial of get_subagent_result stay plain, no toggle", () => {
    const err = mdCard({ toolCallId: "m6", toolName: "get_subagent_result", state: "error", result: "# boom" });
    expect(err.get(".tool-section").classes()).toContain("is-error");
    expect(err.get(".tool-section .pre").text()).toBe("# boom");
    expect(err.find(".tool-md").exists()).toBe(false);
    expect(err.find(".tool-md-toggle").exists()).toBe(false);

    const run = mdCard({
      toolCallId: "m7",
      toolName: "get_subagent_result",
      state: "running",
      partial: "| a | b |\n| - | - |",
    });
    expect(run.get(".tool-section .pre").text()).toContain("| a | b |");
    expect(run.find(".tool-md").exists()).toBe(false);
    expect(run.find(".tool-md-toggle").exists()).toBe(false);
  });

  it("Input/args section of a markdown tool stays the plain PathText pre", () => {
    const wrapper = mdCard({
      toolCallId: "m8",
      toolName: "get_subagent_result",
      state: "done",
      args: { run_id: "run-42" },
      result: mdResult,
    });
    const pres = wrapper.findAll("pre");
    // two pres total: the args pre (Input section) + CodeBlock's pre INSIDE the md container —
    // the result section itself is never a pre
    expect(pres.length).toBe(2);
    expect(pres[0]!.text()).toContain("run-42");
    expect(pres[0]!.classes()).toContain("pre");
    expect(pres[1]!.text()).toBe("const answer = 42;");
    expect(pres[1]!.element.closest(".tool-md")).not.toBeNull();
  });
});
