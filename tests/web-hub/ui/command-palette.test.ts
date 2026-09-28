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
