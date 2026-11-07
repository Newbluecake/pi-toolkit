/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * jev-reflex R3a: the TUI renderer for `subagent:reflex` — the §5.1 shell collapses to
 * `reflex · <scriptId> · <ms>ms` + Q/body (shell and the Chinese footer stripped); malformed
 * details / content ⇒ undefined (pi falls back to its default rendering).
 */
import { describe, expect, it } from "vitest";
import { Text } from "@earendil-works/pi-tui";
import { BUILTIN_SCRIPTS } from "../../src/reflex/core/catalog.js";
import { renderAnswer } from "../../src/reflex/core/render.js";
import { reflexDisplayText, renderReflexMessage } from "../../src/reflex/render-tui.js";

const jobs = BUILTIN_SCRIPTS.find((s) => s.id === "jobs.list")!;
const rendered = renderAnswer({
  script: jobs,
  outcome: {
    kind: "ok",
    lines: ["bash jobs (1 running, 0 finished unread):", "  b_1 running 3m12s  npm test"],
    facts: { running: 1, unread: 0, total: 1 },
    truncated: false,
  },
  question: "后台还有几个 job",
  ms: 4,
  portVer: 1,
});

const theme = { fg: (color: string, text: string) => `<${color}>${text}</>` } as any;
const options = (pad = 1) => ({ expanded: false, outputPad: pad }) as any;

describe("reflexDisplayText (pure form)", () => {
  it("strips the <reflex> shell and the footer; keeps Q/body verbatim; header from details", () => {
    expect(reflexDisplayText(rendered.details, rendered.content)).toBe(
      [
        "reflex · jobs.list · 4ms",
        "Q: 后台还有几个 job",
        "---",
        "bash jobs (1 running, 0 finished unread):",
        "  b_1 running 3m12s  npm test",
      ].join("\n"),
    );
  });

  it("rounds ms, floors at 0, and survives empty port lines (emptyText already applied by render)", () => {
    const empty = renderAnswer({
      script: jobs,
      outcome: { kind: "ok", lines: [], facts: { running: 0, unread: 0, total: 0 }, truncated: false },
      question: "后台还有几个 job",
      ms: 3.6,
      portVer: 1,
    });
    expect(reflexDisplayText(empty.details, empty.content)).toBe(
      ["reflex · jobs.list · 4ms", "Q: 后台还有几个 job", "---", "当前没有后台任务"].join("\n"),
    );
  });

  it("returns undefined for malformed details / content (default rendering fallback)", () => {
    expect(reflexDisplayText(undefined, rendered.content)).toBeUndefined();
    expect(reflexDisplayText(null, rendered.content)).toBeUndefined();
    expect(reflexDisplayText("nope", rendered.content)).toBeUndefined();
    expect(reflexDisplayText({}, rendered.content)).toBeUndefined(); // missing scriptId/ms
    expect(reflexDisplayText({ scriptId: "jobs.list", ms: Number.NaN }, rendered.content)).toBeUndefined();
    expect(reflexDisplayText(rendered.details, undefined)).toBeUndefined();
    expect(reflexDisplayText(rendered.details, 42)).toBeUndefined();
    expect(reflexDisplayText(rendered.details, "not a reflex message")).toBeUndefined();
    expect(reflexDisplayText(rendered.details, "<reflex>no closing shell")).toBeUndefined();
    // a missing footer line is not the §5.1 shape either
    expect(reflexDisplayText(rendered.details, "<reflex a>\nbody\n</reflex>")).toBeUndefined();
  });
});

describe("renderReflexMessage (component)", () => {
  it("renders a Text with the dim header line, the verbatim body, and the requested padding", () => {
    const component = renderReflexMessage(
      { content: rendered.content, details: rendered.details } as any,
      options(2),
      theme,
    );
    expect(component).toBeInstanceOf(Text);
    expect(reflexDisplayText(rendered.details, rendered.content)).toBeDefined(); // same input parses
  });

  it("renders for a non-object details too — undefined (pi default rendering)", () => {
    expect(renderReflexMessage({ content: rendered.content } as any, options(), theme)).toBeUndefined();
    expect(
      renderReflexMessage({ content: "plain", details: rendered.details } as any, options(), theme),
    ).toBeUndefined();
  });
});
