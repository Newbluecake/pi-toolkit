// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import CommandPalette from "../../../src/web-hub/ui/src/components/control/CommandPalette.vue";

/**
 * `control/CommandPalette.vue` (control-plan.md v2.1 §4.6/§7.7 — C5): policy badges (policyBusy
 * overrides while busy), output badges, deny rows greyed and not pickable. The inline two-step
 * `CommandConfirm.vue` lives in `command-confirm.test.ts` (§12.3's file split).
 */

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  vi.useRealTimers();
  for (const w of mounted.splice(0)) w.unmount();
});

const COMMANDS = [
  { name: "session", kind: "builtin", description: "Show session info", policy: "allow", output: "captured" },
  { name: "compact", kind: "builtin", description: "Compact", policy: "allow", policyBusy: "confirm" },
  { name: "thirdparty-thing", kind: "extension", description: "3rd-party", policy: "confirm", output: "terminal" },
  { name: "quit", kind: "builtin", description: "Exit pi", policy: "deny" },
];

function mountPalette(props: { commands?: readonly unknown[]; query: string; busy?: boolean }) {
  const wrapper = mount(CommandPalette, { props: { commands: [], ...props } });
  mounted.push(wrapper);
  return wrapper;
}

describe("CommandPalette.vue (§4.6/§7.7)", () => {
  it("filters by the typed prefix and shows policy + output badges", () => {
    const w = mountPalette({ commands: COMMANDS, query: "s" });
    const rows = w.findAll(".command-item");
    expect(rows.map((r) => r.find(".command-name").text())).toEqual(["/session"]);
    expect(rows[0]!.text()).toContain("allow");
    expect(rows[0]!.text()).toContain("output here");
  });

  it("policyBusy overrides policy while the agent is busy", () => {
    const idle = mountPalette({ commands: COMMANDS, query: "compact" });
    expect(idle.find(".policy-chip").text()).toBe("allow");
    const busy = mountPalette({ commands: COMMANDS, query: "compact", busy: true });
    expect(busy.find(".policy-chip").text()).toBe("confirm");
  });

  it("deny rows are greyed (aria-disabled), show the reason, and never emit pick", async () => {
    const w = mountPalette({ commands: COMMANDS, query: "quit" });
    const row = w.find(".command-item");
    expect(row.classes()).toContain("denied");
    expect(row.attributes("aria-disabled")).toBe("true");
    expect(row.text()).toContain("Terminal only");
    await row.trigger("click");
    expect(w.emitted("pick")).toBeUndefined();
  });

  it("third-party confirm commands carry the output-in-terminal badge (§4.9)", () => {
    const w = mountPalette({ commands: COMMANDS, query: "third" });
    expect(w.find(".command-item").text()).toContain("output in terminal");
  });

  it("empty result ⇒ the never-falls-back-to-text message", () => {
    const w = mountPalette({ commands: COMMANDS, query: "nosuch" });
    expect(w.find(".command-empty").text()).toContain("never sent as plain text");
  });
});

/**
 * Tiered match (name prefix > name substring > description substring), the web-hub analogue of
 * what the TUI's own slash-command matcher already does — added because a skill-sourced command
 * (e.g. `/dev-flow`, description "...model routing...") was only findable via its description,
 * and the old filter was a bare `name.startsWith(query)`.
 */
const SKILL_COMMANDS = [
  { name: "dev-flow", kind: "skill", description: "Standard workflow with model routing lanes", policy: "allow" },
  { name: "foo", kind: "builtin", description: "unrelated", policy: "allow" },
  { name: "routing-table", kind: "builtin", description: "show the routing table", policy: "allow" },
  { name: "abc", kind: "builtin", description: "routing starts the description here", policy: "allow" },
];

describe("CommandPalette.vue — tiered match + sort (name prefix > name substring > description)", () => {
  it("matches a query that only appears in the description, case-insensitively", () => {
    const w = mountPalette({ commands: SKILL_COMMANDS, query: "ROUTING" });
    const names = w.findAll(".command-name").map((n) => n.text());
    expect(names).toContain("/dev-flow");
    expect(names).not.toContain("/foo");
  });

  it("ranks name-prefix hits before name-substring hits before description-only hits", () => {
    const w = mountPalette({ commands: SKILL_COMMANDS, query: "routing" });
    const names = w.findAll(".command-name").map((n) => n.text());
    // "routing-table": name prefix · "abc": description prefix-of-word but name has no "routing" ·
    // "dev-flow": description substring only — prefix tier must sort before the description tier.
    expect(names.indexOf("/routing-table")).toBeLessThan(names.indexOf("/dev-flow"));
    expect(names).not.toContain("/foo");
  });

  it("a name-substring (non-prefix) hit ranks before a description-only hit", () => {
    const commands = [
      { name: "zz-routing", kind: "builtin", description: "nothing special", policy: "allow" },
      { name: "dev-flow", kind: "skill", description: "mentions routing in prose", policy: "allow" },
    ];
    const w = mountPalette({ commands, query: "routing" });
    const names = w.findAll(".command-name").map((n) => n.text());
    expect(names).toEqual(["/zz-routing", "/dev-flow"]);
  });
});

/**
 * Keyboard-model half (2026-10 user request 「Tab 选择」): the palette is the LISTBOX of a
 * combobox — focus never enters it; the composer drives the highlight through the `active`
 * prop (aria-selected / .active) and mirrors the option ids (`<listboxId>-opt-<i>`) for the
 * textarea's aria-activedescendant. `hover` reports pointer hovers so the keyboard highlight
 * and the mouse highlight are one state.
 */
describe("CommandPalette.vue — combobox listbox half (active/listboxId/hover)", () => {
  const MANY = [
    { name: "session", kind: "builtin", policy: "allow" },
    { name: "status", kind: "builtin", policy: "allow" },
    { name: "stop", kind: "builtin", policy: "allow" },
  ];

  it("active highlights exactly that row (aria-selected + .active); default is the best match (0)", () => {
    const w = mountPalette({ commands: MANY, query: "s" });
    const sel = w.findAll(".command-item").map((r) => r.attributes("aria-selected"));
    expect(sel).toEqual(["true", "false", "false"]);
    expect(w.findAll(".command-item")[0]!.classes()).toContain("active");

    const moved = mountPalette({ commands: MANY, query: "s", active: 1 });
    expect(moved.findAll(".command-item")[1]!.classes()).toContain("active");
    expect(moved.findAll(".command-item")[1]!.attributes("aria-selected")).toBe("true");
    expect(moved.findAll(".command-item")[0]!.attributes("aria-selected")).toBe("false");
  });

  it("listboxId names the listbox root and every option (`<id>-opt-<index>`, Composer-mirrored)", () => {
    const w = mountPalette({ commands: MANY, query: "s", listboxId: "cmd-lb" });
    expect(w.find(".command-palette").attributes("id")).toBe("cmd-lb");
    expect(w.findAll(".command-item").map((r) => r.attributes("id"))).toEqual([
      "cmd-lb-opt-0",
      "cmd-lb-opt-1",
      "cmd-lb-opt-2",
    ]);
  });

  it("without listboxId no ids render (standalone mounts stay id-less)", () => {
    const w = mountPalette({ commands: MANY, query: "s" });
    expect(w.find(".command-palette").attributes("id")).toBeUndefined();
    expect(w.findAll(".command-item")[0]!.attributes("id")).toBeUndefined();
  });

  it("mousemove emits hover with the row index (mouse and keyboard share one highlight)", async () => {
    const w = mountPalette({ commands: MANY, query: "s" });
    await w.findAll(".command-item")[2]!.trigger("mousemove");
    expect(w.emitted("hover")).toEqual([[2]]);
  });

  it("shows the keyboard-hint footer only when rows exist (empty state keeps its own message)", () => {
    const w = mountPalette({ commands: MANY, query: "s" });
    expect(w.find(".command-hint").exists()).toBe(true);
    expect(w.find(".command-hint").text()).toBe("Tab completes · ↑↓ select · Esc close");
    const empty = mountPalette({ commands: MANY, query: "zzz" });
    expect(empty.find(".command-hint").exists()).toBe(false);
    expect(empty.find(".command-empty").exists()).toBe(true);
  });
});
