// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { toRaw } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMemCommand } from "../../../src/memory/command.js";
import { createStatusCommand, type StatusCommandDeps } from "../../../src/commands/status.js";
import { createThreadCommand } from "../../../src/commands/thread.js";
import { createReflexCommand, type ReflexCommandDeps } from "../../../src/reflex/command.js";
import { BUILTIN_SCRIPTS } from "../../../src/reflex/core/catalog.js";
import { createWebHubCommand } from "../../../src/commands/webhub.js";
import type { RegisteredCommand } from "@earendil-works/pi-coding-agent";
import type { JevCommandPort } from "../../../src/memory/jev/contracts.js";
import { wrapCommandApi } from "../../../src/commands/capture.js";
import { createCommandComplete, type ArgCompleter } from "../../../src/web-hub/agent/command-complete.js";
import CommandArgPalette from "../../../src/web-hub/ui/src/components/control/CommandArgPalette.vue";

/**
 * `control/CommandArgPalette.vue` (web-hub-slash-args §6.2, P3): render states — static
 * header (usage with ellipsis + full-text title, r1 #3), rows with confirm chip and value
 * title, the delayed loading hint, the empty hint, the error silent degrade (header only),
 * the footer hint, aria wiring (listbox / option ids / aria-busy) and the no-v-html rule.
 */

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const w of mounted.splice(0)) w.unmount();
});

const ITEMS = [
  { value: "keepalive", label: "keepalive", description: "cache keepalive" },
  { value: "status", label: "status", policy: "confirm" as const },
];

function mountPanel(props: Record<string, unknown> = {}) {
  const w = mount(CommandArgPalette, {
    props: { name: "cache-ttl", usage: "<subcommand> [args]", items: ITEMS, ...props },
  });
  mounted.push(w);
  return w;
}

describe("CommandArgPalette render states", () => {
  it("renders the static header (`/name` + usage, title carries the full text) and rows", () => {
    const w = mountPanel({ listboxId: "lb" });
    const head = w.find(".arg-head");
    expect(head.exists()).toBe(true);
    expect(head.find(".command-name").text()).toBe("/cache-ttl");
    const usage = head.find(".arg-usage");
    expect(usage.text()).toBe("<subcommand> [args]");
    expect(usage.attributes("title")).toBe("<subcommand> [args]"); // r1 #3: ellipsis + title full
    const rows = w.findAll(".arg-item");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.find(".command-name").text()).toBe("keepalive");
    expect(rows[0]!.find(".command-desc").text()).toBe("cache keepalive");
    expect(rows[0]!.attributes("title")).toBe("keepalive"); // title = raw value (whole-prefix replace)
    expect(rows[1]!.attributes("title")).toBe("status");
  });

  it("confirm items carry the shared confirm chip; allow items carry none", () => {
    const w = mountPanel();
    const chips = w.findAll(".policy-chip");
    expect(chips).toHaveLength(1);
    expect(chips[0]!.attributes("data-policy")).toBe("confirm");
    expect(chips[0]!.text()).not.toBe("");
  });

  it("usage falls back to nothing when absent — header keeps the bare `/name` with rows", () => {
    const w = mountPanel({ usage: undefined });
    expect(w.find(".arg-head").exists()).toBe(true);
    expect(w.find(".arg-usage").exists()).toBe(false);
  });

  it("empty: header + the weak no-completions hint (no rows, no footer)", () => {
    const w = mountPanel({ items: [] });
    expect(w.find(".command-empty").exists()).toBe(true);
    expect(w.find(".command-empty").text()).not.toBe("");
    expect(w.findAll(".arg-item")).toHaveLength(0);
    expect(w.find(".command-hint").exists()).toBe(false);
  });

  it("error: silent degrade — header only, the empty hint is suppressed", () => {
    const w = mountPanel({ items: [], error: true });
    expect(w.find(".arg-head").exists()).toBe(true);
    expect(w.find(".command-empty").exists()).toBe(false);
    expect(w.find(".command-hint").exists()).toBe(false);
  });

  it("loading with no rows shows the delayed hint (250ms) — not before", async () => {
    vi.useFakeTimers();
    try {
      const w = mountPanel({ items: [], loading: true });
      expect(w.find(".command-empty").exists()).toBe(false); // before the delay: nothing flashes
      vi.advanceTimersByTime(249);
      await vi.advanceTimersByTimeAsync(1);
      expect(w.find(".command-empty").exists()).toBe(true); // the "…" hint
      vi.advanceTimersByTime(5_000);
      expect(w.findAll(".command-empty")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("loading keeps stale rows visible and clears the delayed hint when rows exist", async () => {
    vi.useFakeTimers();
    try {
      const w = mountPanel({ loading: true }); // items present
      vi.advanceTimersByTime(400);
      expect(w.findAll(".arg-item")).toHaveLength(2); // stale rows kept
      expect(w.find(".command-empty").exists()).toBe(false); // hint never shows with rows
      expect(w.find(".command-palette").attributes("aria-busy")).toBe("true");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a fast response never flashes the loading hint (timer cleared on settle)", async () => {
    vi.useFakeTimers();
    try {
      const w = mountPanel({ items: [], loading: true });
      await w.setProps({ loading: false, items: ITEMS });
      vi.advanceTimersByTime(1_000);
      expect(w.find(".command-empty").exists()).toBe(false);
      expect(w.findAll(".arg-item")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aria: listbox role/label, option ids `<id>-opt-<i>`, aria-selected follows active", () => {
    const w = mountPanel({ listboxId: "lb", active: 1 });
    const root = w.find(".command-palette");
    expect(root.attributes("role")).toBe("listbox");
    expect(root.attributes("aria-label")).not.toBe("");
    const rows = w.findAll(".arg-item");
    expect(rows[0]!.attributes("id")).toBe("lb-opt-0");
    expect(rows[1]!.attributes("id")).toBe("lb-opt-1");
    expect(rows[0]!.attributes("aria-selected")).toBe("false");
    expect(rows[1]!.attributes("aria-selected")).toBe("true");
  });

  it("pointer: click emits the item; hover emits the index; mousedown is prevented (no textarea blur)", async () => {
    const w = mountPanel();
    await w.findAll(".arg-item")[1]!.trigger("click");
    expect(w.emitted("pick")).toEqual([[ITEMS[1]]]);
    await w.findAll(".arg-item")[0]!.trigger("mousemove");
    expect(w.emitted("hover")).toEqual([[0]]);
    const el = w.findAll(".arg-item")[0]!.element;
    const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true); // @mousedown.prevent keeps the textarea focused
  });

  it("never uses v-html: item text with markup renders as TEXT, not nodes", () => {
    const w = mountPanel({
      items: [{ value: "<b>v</b>", label: "<script>x</script>", description: "<i>d</i>" }],
    });
    expect(w.html()).toContain("&lt;script&gt;"); // escaped ⇒ interpolation, never v-html
    expect(w.find(".arg-item script").exists()).toBe(false);
    expect(w.find(".arg-item i").exists()).toBe(false);
  });
});

describe("V-2 real factory/capture/service candidates → real Palette policy and payload", () => {
  it.each([
    ["agent", "settings s", "settings set", "set", "confirm"],
    ["thread", "sub r_v2-complete-run o", "sub r_v2-complete-run origin", "origin", "confirm"],
    ["reflex", "reset jobs", "reset jobs.list", "jobs.list", "confirm"],
    ["webhub", "token ", "token rotate", "rotate", "default"],
    ["webhub", "token ", "token rotate", "rotate", "allow"],
  ] as const)(
    "%s %s (%s/%s) %s renders only actual policy, picks the exact item",
    async (name, prefix, value, label, policy) => {
      const business = vi.fn((key: PropertyKey): never => {
        throw Error(`palette cannot inspect ${String(key)}`);
      });
      const commands = {
        agent: createStatusCommand(new Proxy({} as StatusCommandDeps, { get: (_t, key) => business(key) })),
        thread: createThreadCommand({ current: () => business("thread.current") }),
        reflex: createReflexCommand(
          new Proxy({ catalog: BUILTIN_SCRIPTS } as ReflexCommandDeps, {
            get: (target, key) => (key === "catalog" ? target.catalog : business(key)),
          }),
        ),
        webhub: createWebHubCommand({ control: () => business("webhub.control"), open: () => business("open") }),
      };
      type Command = Omit<RegisteredCommand, "name" | "sourceInfo">;
      const records = new Map<string, Command>();
      const pi = {
        registerCommand: (key: string, command: Command) => records.set(key, command),
        getCommands: () =>
          [...records].map(([key, command]) => ({
            name: key,
            source: "extension",
            ...(command.description !== undefined ? { description: command.description } : {}),
          })),
      };
      const raw = new Map<string, ArgCompleter>();
      const owned = new Set<string>();
      const wrapped = wrapCommandApi(pi as unknown as ExtensionAPI, () => undefined, owned, raw);
      const natives = Object.values(commands).map((command) => vi.spyOn(command, "handler"));
      for (const [key, command] of Object.entries(commands)) {
        wrapped.registerCommand(key, command);
        expect(raw.get(key)).toBe(command.getArgumentCompletions);
        expect(records.get(key)?.getArgumentCompletions).toBe(command.getArgumentCompletions);
      }
      expect(owned).toEqual(new Set(Object.keys(commands)));
      const service = createCommandComplete({
        commands: pi,
        own: () => raw,
        tui: () => undefined,
        mode: "toolkit",
        ...(policy === "allow" ? { overrides: { webhub: "allow" as const } } : {}),
      });
      try {
        const reply = await service.answer({
          t: "complete_req",
          rid: "v2-palette",
          name,
          prefix,
          deadlineMs: 2000,
          origin: { listener: "loopback" },
        });
        if (!reply.ok) throw Error("expected real own service reply");
        expect(reply.source).toBe("own");
        const w = mountPanel({ name, items: reply.items, listboxId: "v2-policy" });
        const rows = w.findAll(".arg-item");
        if (policy === "default") {
          expect(reply.items).toEqual([]);
          expect(rows).toHaveLength(0);
          expect(w.emitted("pick")).toBeUndefined();
        } else {
          expect(reply.items).toHaveLength(1);
          expect(reply.items[0]).toMatchObject({ value, label });
          expect(reply.items[0]?.policy).toBe(policy === "confirm" ? "confirm" : undefined);
          expect(rows).toHaveLength(1);
          expect(rows[0]!.attributes("title")).toBe(value);
          expect(rows[0]!.find(".command-name").text()).toBe(label);
          expect(rows[0]!.find(".policy-chip").exists()).toBe(policy === "confirm");
          if (policy === "confirm") expect(rows[0]!.find(".policy-chip").attributes("data-policy")).toBe("confirm");
          await rows[0]!.trigger("click");
          const picked = w.emitted("pick");
          expect(picked).toEqual([[reply.items[0]]]);
          // Vue wraps prop items reactively; its raw target remains the service item.
          expect(toRaw(picked?.[0]?.[0])).toBe(reply.items[0]);
        }
        expect(business).not.toHaveBeenCalled();
        for (const native of natives) expect(native).not.toHaveBeenCalled();
      } finally {
        service.dispose();
      }
    },
  );
});

describe("V-M real memory candidates keep policy chips and pick payloads in the real palette", () => {
  it.each(["allow", "confirm", "deny"] as const)(
    "%s policy is rendered without inventing --run or execution permission",
    async (policy) => {
      const reads: string[] = [];
      const jev = new Proxy({} as JevCommandPort, {
        get(_target, key) {
          if (key === "isChildSession") return false;
          reads.push(String(key));
          throw Error("palette cannot query backend");
        },
      });
      const command = createMemCommand({ jev });
      const native = vi.spyOn(command, "handler");
      const records = new Map<string, typeof command>();
      const pi = {
        registerCommand(name: string, c: typeof command) {
          records.set(name, c);
        },
        getCommands: () => [...records].map(([name, c]) => ({ name, source: "extension", description: c.description })),
      };
      const raw = new Map<string, ArgCompleter>();
      const owned = new Set<string>();
      wrapCommandApi(pi as unknown as ExtensionAPI, () => undefined, owned, raw).registerCommand("mem", command);
      expect(raw.get("mem")).toBe(command.getArgumentCompletions);
      const service = createCommandComplete({
        commands: pi,
        own: () => raw,
        tui: () => undefined,
        mode: "toolkit",
        overrides: { mem: policy },
        memoryCapabilities: () => ({ sessionAdd: false, revisionReview: true }),
      });
      try {
        const reply = await service.answer({
          t: "complete_req",
          rid: "vm-chip",
          name: "mem",
          prefix: "review ",
          deadlineMs: 2000,
          origin: { listener: "loopback" },
        });
        const w = mountPanel({
          name: "mem",
          usage: "review [--list]",
          items: reply.ok ? reply.items : [],
          listboxId: "vm-list",
        });
        expect(w.text()).not.toContain("--run");
        if (policy === "deny") {
          expect(reply).toMatchObject({ ok: false, code: "E_COMMAND_DENIED" });
          expect(w.findAll(".arg-item")).toHaveLength(0);
          expect(w.emitted("pick")).toBeUndefined();
        } else {
          expect(reply).toMatchObject({
            ok: true,
            source: "own",
            items: [{ value: "review --list", label: "--list" }],
          });
          if (!reply.ok) throw Error("real service refused");
          const rows = w.findAll(".arg-item");
          expect(rows).toHaveLength(1);
          expect(rows[0]!.attributes("title")).toBe("review --list");
          expect(rows[0]!.attributes("id")).toBe("vm-list-opt-0");
          expect(rows[0]!.find(".command-name").text()).toBe("--list");
          expect(rows[0]!.find(".policy-chip").exists()).toBe(policy === "confirm");
          if (policy === "confirm") expect(rows[0]!.find(".policy-chip").attributes("data-policy")).toBe("confirm");
          await rows[0]!.trigger("click");
          expect(w.emitted("pick")).toEqual([[reply.items[0]]]);
        }
        expect(native).not.toHaveBeenCalled();
        expect(reads).toEqual([]);
      } finally {
        service.dispose();
      }
    },
  );
});
