import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMemCommand } from "../../../src/memory/command.js";
import type { JevCommandPort } from "../../../src/memory/jev/contracts.js";
import { parseMemorySettings } from "../../../src/memory/settings.js";
import * as memoryFs from "../../../src/memory/safe-fs.js";
import { wrapCommandApi } from "../../../src/commands/capture.js";
import { resolveCommandPolicy } from "../../../src/web-hub/agent/command-policy.js";
import { parseRevisionFlowCommand } from "../../../src/memory/command-flow.js";
import { executeMemoryRead } from "../../../src/memory/command-readonly.js";
import {
  createCommandComplete,
  type ArgCompleter,
  type AutocompleteProviderLike,
} from "../../../src/web-hub/agent/command-complete.js";
import type { CompleteReqFrame } from "../../../src/web-hub/protocol/command-args.js";
import { CMD_ARGS } from "../../../src/web-hub/protocol/command-args.js";

/** Manual timer queue — the production seam is unref'd setTimeout; tests fire on demand. */
function manualTimers() {
  const timers: Array<{ ms: number; fn: () => void; fired: boolean }> = [];
  return {
    setTimer: (ms: number, fn: () => void) => {
      const t = { ms, fn, fired: false };
      timers.push(t);
      return {
        cancel: () => {
          t.fired = true;
        },
      };
    },
    fire: (ms: number) => {
      for (const t of timers) if (t.ms === ms && !t.fired) ((t.fired = true), t.fn());
    },
    pending: () => timers.filter((t) => !t.fired).length,
  };
}

function req(name: string, prefix = "", rid = "r-1"): CompleteReqFrame {
  return { t: "complete_req", rid, name, prefix, deadlineMs: 2000, origin: { listener: "loopback" } };
}

const EXT_PORT = {
  getCommands: () => [
    { name: "webhub", description: "hub", source: "extension" },
    { name: "agent", description: "diag", source: "extension" },
    { name: "tpl", description: "template", source: "prompt" },
    { name: "skillcmd", description: "skill", source: "skill" },
  ],
};

function ownMap(entries: Record<string, ArgCompleter>): Map<string, ArgCompleter> {
  return new Map(Object.entries(entries));
}

describe("command-complete — validation & policy gates (§4.3 #1/#2)", () => {
  it("unknown command ⇒ E_UNKNOWN_COMMAND (not retryable)", async () => {
    const t = manualTimers();
    const cc = createCommandComplete({
      commands: EXT_PORT,
      own: () => undefined,
      tui: () => undefined,
      mode: "all",
      setTimer: t.setTimer,
    });
    const r = await cc.answer(req("nope"));
    expect(r).toEqual({ t: "complete_reply", rid: "r-1", ok: false, code: "E_UNKNOWN_COMMAND", retryable: false });
  });

  it("deny builtin (web-unreachable) ⇒ E_COMMAND_DENIED — never completes", async () => {
    const t = manualTimers();
    const cc = createCommandComplete({
      commands: EXT_PORT,
      own: () => undefined,
      tui: () => undefined,
      mode: "all",
      setTimer: t.setTimer,
    });
    // `settings` is in BUILTIN_DENY_NAMES ⇒ classified builtin + deny
    const r = await cc.answer(req("settings"));
    expect(r).toEqual({ t: "complete_reply", rid: "r-1", ok: false, code: "E_COMMAND_DENIED", retryable: false });
  });

  it("webCommandPolicy override deny ⇒ E_COMMAND_DENIED (same override precedence as execution)", async () => {
    const t = manualTimers();
    const cc = createCommandComplete({
      commands: EXT_PORT,
      own: () => undefined,
      tui: () => undefined,
      mode: "all",
      setTimer: t.setTimer,
      overrides: { webhub: "deny" },
    });
    const r = await cc.answer(req("webhub"));
    expect(r).toEqual({ t: "complete_reply", rid: "r-1", ok: false, code: "E_COMMAND_DENIED", retryable: false });
  });

  it("bad name / control-char prefix / oversized prefix ⇒ E_BAD_REQUEST (second-line defense)", async () => {
    const t = manualTimers();
    const cc = createCommandComplete({
      commands: EXT_PORT,
      own: () => undefined,
      tui: () => undefined,
      mode: "all",
      setTimer: t.setTimer,
    });
    expect(await cc.answer({ ...req("bad name!"), name: "bad name!" })).toMatchObject({
      ok: false,
      code: "E_BAD_REQUEST",
    });
    expect(await cc.answer(req("webhub", "a\rb"))).toMatchObject({ ok: false, code: "E_BAD_REQUEST" });
    expect(await cc.answer(req("webhub", "x".repeat(CMD_ARGS.prefixMaxBytes + 1)))).toMatchObject({
      ok: false,
      code: "E_BAD_REQUEST",
    });
  });
});

describe("command-complete — source selection (§4.3 #3)", () => {
  it("S-own wins over S-tui; template/skill/builtin never use S-tui and answer empty", async () => {
    const t = manualTimers();
    const ownCalls: string[] = [];
    const tuiCalls: string[] = [];
    const tui: AutocompleteProviderLike = {
      getSuggestions: async (lines) => {
        tuiCalls.push(lines[0] ?? "");
        return { items: [{ value: "from-tui", label: "from-tui" }], prefix: "" };
      },
    };
    const cc = createCommandComplete({
      commands: EXT_PORT,
      own: () => ownMap({ webhub: (p) => (ownCalls.push(p), [{ value: "status", label: "status" }]) }),
      tui: () => tui,
      mode: "all",
      setTimer: t.setTimer,
    });
    const own = await cc.answer(req("webhub", ""));
    expect(own).toMatchObject({ ok: true, source: "own", items: [{ value: "status", label: "status" }] });
    expect(ownCalls).toEqual([""]);
    expect(tuiCalls).toEqual([]);
    // third-party extension (no S-own entry) ⇒ S-tui
    const third = await cc.answer(req("agent", ""));
    expect(third).toMatchObject({ ok: true, source: "tui", items: [{ value: "from-tui", label: "from-tui" }] });
    expect(tuiCalls).toEqual(["/agent "]);
    // template + skill ⇒ empty ok, no call at all
    expect(await cc.answer(req("tpl"))).toMatchObject({ ok: true, items: [], source: "own" });
    expect(await cc.answer(req("skillcmd"))).toMatchObject({ ok: true, items: [], source: "own" });
    expect(ownCalls).toEqual([""]);
  });

  it('mode "toolkit" never consults S-tui (third-party ⇒ empty)', async () => {
    const t = manualTimers();
    const tui: AutocompleteProviderLike = { getSuggestions: async () => ({ items: [], prefix: "" }) };
    const cc = createCommandComplete({
      commands: EXT_PORT,
      own: () => undefined,
      tui: () => tui,
      mode: "toolkit",
      setTimer: t.setTimer,
    });
    expect(await cc.answer(req("agent"))).toMatchObject({ ok: true, items: [], source: "own" });
  });

  it("S-tui unavailable (rpc mode, never captured) ⇒ empty ok, never an error", async () => {
    const t = manualTimers();
    const cc = createCommandComplete({
      commands: EXT_PORT,
      own: () => undefined,
      tui: () => undefined,
      mode: "all",
      setTimer: t.setTimer,
    });
    expect(await cc.answer(req("agent"))).toMatchObject({ ok: true, items: [], source: "own" });
  });
});

describe("command-complete — timeouts, in-flight, exceptions (§4.3 #4)", () => {
  it("hard timeout at agentCallTimeoutMs ⇒ E_DEADLINE retryable; late result dropped, slot released", async () => {
    const t = manualTimers();
    let resolveLate: ((v: { value: string; label: string }[]) => void) | undefined;
    const cc = createCommandComplete({
      commands: EXT_PORT,
      own: () => ownMap({ webhub: () => new Promise((res) => (resolveLate = res)) }),
      tui: () => undefined,
      mode: "all",
      setTimer: t.setTimer,
    });
    const p = cc.answer(req("webhub"));
    const step = () => new Promise<void>((r) => setImmediate(r));
    await step();
    expect(cc.inflight()).toBe(1);
    t.fire(CMD_ARGS.agentCallTimeoutMs);
    const r = await p;
    expect(r).toEqual({ t: "complete_reply", rid: "r-1", ok: false, code: "E_DEADLINE", retryable: true });
    expect(cc.inflight()).toBe(0);
    // the late loser settling now must not resurrect anything
    resolveLate?.([{ value: "late", label: "late" }]);
    await step();
    expect(cc.inflight()).toBe(0);
  });

  it("S-tui timeout aborts the AbortSignal", async () => {
    const t = manualTimers();
    let aborted = false;
    const provider: AutocompleteProviderLike = {
      getSuggestions: (_l, _r, _c, options) =>
        new Promise(() => {
          options.signal.addEventListener("abort", () => (aborted = true));
        }),
    };
    const cc = createCommandComplete({
      commands: EXT_PORT,
      own: () => undefined,
      tui: () => provider,
      mode: "all",
      setTimer: t.setTimer,
    });
    const p = cc.answer(req("agent"));
    await new Promise<void>((r) => setImmediate(r));
    t.fire(CMD_ARGS.agentCallTimeoutMs);
    expect(await p).toMatchObject({ ok: false, code: "E_DEADLINE" });
    expect(aborted).toBe(true);
  });

  it("in-flight cap 2 ⇒ third concurrent call answers E_RATE retryable", async () => {
    const t = manualTimers();
    const gates: Array<(v: { value: string; label: string }[]) => void> = [];
    const completer: ArgCompleter = () => new Promise((res) => gates.push(res));
    const cc = createCommandComplete({
      commands: EXT_PORT,
      own: () => ownMap({ webhub: completer, agent: completer, tpl: completer as ArgCompleter }),
      tui: () => undefined,
      mode: "all",
      setTimer: t.setTimer,
    });
    const p1 = cc.answer(req("webhub", "", "r1"));
    const p2 = cc.answer(req("agent", "", "r2"));
    await new Promise<void>((r) => setImmediate(r));
    const p3 = cc.answer(req("webhub", "", "r3"));
    expect(await p3).toEqual({ t: "complete_reply", rid: "r3", ok: false, code: "E_RATE", retryable: true });
    for (const g of gates) g([{ value: "x", label: "x" }]);
    expect((await p1) as { ok: boolean }).toMatchObject({ ok: true });
    expect((await p2) as { ok: boolean }).toMatchObject({ ok: true });
    expect(cc.inflight()).toBe(0);
  });

  it("completer exception ⇒ ok:true items:[] (exception text never leaked)", async () => {
    const t = manualTimers();
    const cc = createCommandComplete({
      commands: EXT_PORT,
      own: () =>
        ownMap({
          webhub: () => {
            throw new Error("secret path /root/x");
          },
        }),
      tui: () => undefined,
      mode: "all",
      setTimer: t.setTimer,
    });
    const r = await cc.answer(req("webhub"));
    expect(r).toMatchObject({ ok: true, items: [], source: "own" });
    expect(JSON.stringify(r)).not.toContain("secret");
  });

  it("a completer legitimately returning null ⇒ ok:true items:[] (null ≠ timeout)", async () => {
    const t = manualTimers();
    const cc = createCommandComplete({
      commands: EXT_PORT,
      own: () => ownMap({ webhub: () => null }),
      tui: () => undefined,
      mode: "all",
      setTimer: t.setTimer,
    });
    expect(await cc.answer(req("webhub"))).toMatchObject({ ok: true, items: [] });
  });

  it("dispose() ⇒ E_UNSUPPORTED afterwards", async () => {
    const t = manualTimers();
    const cc = createCommandComplete({
      commands: EXT_PORT,
      own: () => undefined,
      tui: () => undefined,
      mode: "all",
      setTimer: t.setTimer,
    });
    cc.dispose();
    expect(await cc.answer(req("webhub"))).toMatchObject({ ok: false, code: "E_UNSUPPORTED", retryable: false });
  });
});

describe("command-complete — S-tui prefix guard (§4.3 #5)", () => {
  it("a result whose prefix ≠ requested prefix is discarded wholesale (file-path branch leak)", async () => {
    const t = manualTimers();
    const provider: AutocompleteProviderLike = {
      getSuggestions: async () => ({ items: [{ value: "/etc/passwd", label: "passwd" }], prefix: "/et" }),
    };
    const cc = createCommandComplete({
      commands: EXT_PORT,
      own: () => undefined,
      tui: () => provider,
      mode: "all",
      setTimer: t.setTimer,
    });
    const r = await cc.answer(req("agent", "x"));
    expect(r).toMatchObject({ ok: true, items: [], source: "tui" });
  });
});

describe("command-complete — normalization & caps (§4.3 #6)", () => {
  it("drops leading-whitespace / newline / empty values, non-item garbage; dedupes by value", async () => {
    const t = manualTimers();
    const cc = createCommandComplete({
      commands: EXT_PORT,
      own: () =>
        ownMap({
          webhub: () => [
            { value: " status", label: "leading ws" },
            { value: "a\nb", label: "newline" },
            { value: "", label: "empty" },
            "garbage",
            { value: "status", label: "one" },
            { value: "status", label: "dup" },
            { value: 42, label: "num" } as unknown as { value: string; label: string },
          ],
        }),
      tui: () => undefined,
      mode: "all",
      setTimer: t.setTimer,
    });
    const r = await cc.answer(req("webhub"));
    expect(r).toMatchObject({ ok: true, source: "own" });
    if (r.ok !== true) throw new Error("unreachable");
    expect(r.items.map((i) => i.value)).toEqual(["status"]);
    expect(r.items[0]!.label).toBe("one");
  });

  it("strips ANSI escapes from value/label/description", async () => {
    const t = manualTimers();
    const cc = createCommandComplete({
      commands: EXT_PORT,
      own: () =>
        ownMap({
          webhub: () => [{ value: "\x1b[31mstatus\x1b[0m", label: "\x1b[1mS\x1b[0m", description: "\x07bell" }],
        }),
      tui: () => undefined,
      mode: "all",
      setTimer: t.setTimer,
    });
    const r = await cc.answer(req("webhub"));
    expect(r).toMatchObject({
      ok: true,
      items: [{ value: "status", label: "S", description: "bell" }],
    });
  });

  it("caps at itemMax=50 with truncated:true", async () => {
    const t = manualTimers();
    const many = Array.from({ length: 80 }, (_, i) => ({ value: `v${i}`, label: `v${i}` }));
    const cc = createCommandComplete({
      commands: EXT_PORT,
      own: () => ownMap({ agent: () => many }),
      tui: () => undefined,
      mode: "all",
      setTimer: t.setTimer,
    });
    const r = await cc.answer(req("agent"));
    if (r.ok !== true) throw new Error("unreachable");
    expect(r.items.length).toBe(CMD_ARGS.itemMax);
    expect(r.truncated).toBe(true);
  });

  it("truncates over-long label/description to their caps", async () => {
    const t = manualTimers();
    const cc = createCommandComplete({
      commands: EXT_PORT,
      own: () =>
        ownMap({
          webhub: () => [{ value: "status", label: "L".repeat(500), description: "D".repeat(500) }],
        }),
      tui: () => undefined,
      mode: "all",
      setTimer: t.setTimer,
    });
    const r = await cc.answer(req("webhub"));
    if (r.ok !== true) throw new Error("unreachable");
    expect(r.items[0]!.label.length).toBeLessThanOrEqual(CMD_ARGS.itemLabelMaxChars);
    expect(r.items[0]!.description!.length).toBeLessThanOrEqual(CMD_ARGS.itemDescMaxChars);
  });
});

describe("command-complete — per-item policy (§4.3 #7)", () => {
  it("deny items dropped (/webhub: only `status` is web-allow), confirm items carry policy chip (/agent reload)", async () => {
    const t = manualTimers();
    const cc = createCommandComplete({
      commands: EXT_PORT,
      own: () =>
        ownMap({
          webhub: () => [
            { value: "status", label: "status" },
            { value: "passwd", label: "passwd" },
            { value: "restart", label: "restart" },
          ],
          agent: () => [
            { value: "costs", label: "costs" },
            { value: "reload", label: "reload" },
            { value: "settings set budget.extendStepS 60", label: "set" },
          ],
        }),
      tui: () => undefined,
      mode: "all",
      setTimer: t.setTimer,
    });
    const webhub = await cc.answer(req("webhub"));
    if (webhub.ok !== true) throw new Error("unreachable");
    expect(webhub.items.map((i) => i.value)).toEqual(["status"]); // passwd/restart deny ⇒ gone
    const agent = await cc.answer(req("agent"));
    if (agent.ok !== true) throw new Error("unreachable");
    const byValue = new Map(agent.items.map((i) => [i.value, i]));
    expect(byValue.get("costs")).toEqual({ value: "costs", label: "costs" }); // allow ⇒ no chip
    expect(byValue.get("reload")!.policy).toBe("confirm");
    expect(byValue.get("settings set budget.extendStepS 60")!.policy).toBe("confirm");
  });

  it("deny items are filtered even on the S-tui source", async () => {
    const t = manualTimers();
    const provider: AutocompleteProviderLike = {
      getSuggestions: async () => ({
        items: [
          { value: "status", label: "status" },
          { value: "passwd", label: "passwd" },
        ],
        prefix: "",
      }),
    };
    const cc = createCommandComplete({
      commands: EXT_PORT,
      own: () => undefined,
      tui: () => provider,
      mode: "all",
      setTimer: t.setTimer,
    });
    const r = await cc.answer(req("webhub", ""));
    if (r.ok !== true) throw new Error("unreachable");
    expect(r.items.map((i) => i.value)).toEqual(["status"]);
    expect(r.source).toBe("tui");
  });
});

describe("#39 completion reuses scoped execution policy", () => {
  it("filters writes even with allow override while keeping readonly items", async () => {
    const cc = createCommandComplete({
      commands: { getCommands: () => [{ name: "mem", description: "memory", source: "extension" }] },
      own: () =>
        ownMap({
          mem: () =>
            ["session list", "session add raw", "hub trash", "hub adopt", "hub rm rule.123"].map((value) => ({
              value,
              label: value,
            })),
        }),
      tui: () => undefined,
      mode: "toolkit",
      memoryScopes: true,
      overrides: { mem: "allow" },
    });
    const answer = await cc.answer(req("mem"));
    expect(answer.ok).toBe(true);
    if (!answer.ok) throw Error("expected readonly completion");
    expect(answer.items.map((item) => item.value)).toEqual(["session list", "hub trash"]);
    cc.dispose();
  });
});

describe("#65 completion write-port projection", () => {
  it("projects only session add and still respects explicit deny", async () => {
    const make = (overrides: Record<string, "allow" | "deny" | "confirm">) =>
      createCommandComplete({
        commands: { getCommands: () => [{ name: "mem", description: "memory", source: "extension" }] },
        own: () =>
          ownMap({
            mem: () => ["session list", "session add text", "hub add text"].map((value) => ({ value, label: value })),
          }),
        tui: () => undefined,
        mode: "toolkit",
        memoryScopes: true,
        memoryCapabilities: () => ({ sessionAdd: true, revisionReview: false }),
        overrides,
      });
    const allowed = make({ mem: "allow" });
    const answer = await allowed.answer(req("mem"));
    expect(answer.ok).toBe(true);
    if (!answer.ok) throw Error("expected completion");
    expect(answer.items.map((item) => item.value)).toEqual(["session list", "session add text"]);
    allowed.dispose();
    const denied = make({ mem: "deny" });
    const blocked = await denied.answer(req("mem"));
    expect(blocked.ok).toBe(false);
    denied.dispose();
  });
});

/** V-M: only registration through the production capture proxy populates RAW. */
function capturedMemory(layout: "blocks" | "tiered" = "blocks", jevOn = true) {
  const businessReads: string[] = [];
  const jev = new Proxy({} as JevCommandPort, {
    get(_target, key) {
      if (key === "isChildSession") return false;
      businessReads.push(String(key));
      throw new Error("completion must not inspect Jev business ports");
    },
  });
  const command = createMemCommand({
    settings: parseMemorySettings({ layout }),
    ...(jevOn ? { jev } : {}),
  });
  const native = vi.spyOn(command, "handler");
  const registered = new Map<string, typeof command>();
  const pi = {
    registerCommand(name: string, value: typeof command) {
      registered.set(name, value);
    },
    getCommands: () => [...registered].map(([name, c]) => ({ name, description: c.description, source: "extension" })),
  };
  const raw = new Map<string, ArgCompleter>();
  const owned = new Set<string>();
  wrapCommandApi(pi as unknown as ExtensionAPI, () => undefined, owned, raw).registerCommand("mem", command);
  expect(owned).toEqual(new Set(["mem"]));
  expect(raw.size).toBe(1);
  expect(raw.get("mem")).toBe(command.getArgumentCompletions);
  expect(registered.get("mem")?.getArgumentCompletions).toBe(command.getArgumentCompletions);
  return { pi, command, raw, owned, businessReads, native };
}

describe("V-M real memory factory → capture RAW → completion/policy", () => {
  it.each(["toolkit", "all"] as const)(
    "%s uses the identical RAW function, never S-tui or memory I/O",
    async (mode) => {
      const f = capturedMemory();
      const own = vi.fn(() => f.raw);
      const tui = vi.fn(async () => ({ items: [], prefix: "review " }));
      const fsReadsAndWrites: Array<{ mockRestore(): void }> = Object.entries(memoryFs)
        .filter(([, value]) => typeof value === "function")
        .map(([name]) => vi.spyOn(memoryFs, name as keyof typeof memoryFs));
      const cc = createCommandComplete({
        commands: f.pi,
        own,
        tui: () => ({ getSuggestions: tui }),
        mode,
        memoryCapabilities: () => ({ sessionAdd: false, revisionReview: true }),
      });
      try {
        for (const prefix of ["review ", "review --l", "review\t--l"]) {
          expect(await cc.answer(req("mem", prefix))).toEqual({
            t: "complete_reply",
            rid: "r-1",
            ok: true,
            source: "own",
            items: [{ value: "review --list", label: "--list", description: "只读列出当前建议" }],
          });
        }
        for (const prefix of ["review --r", "review --run", "review --list extra"])
          expect(await cc.answer(req("mem", prefix))).toMatchObject({ ok: true, items: [] });
        expect(f.command.getArgumentCompletions(`review ${"x".repeat(1025)}`)).toEqual([]);
        expect(await cc.answer(req("mem", `review ${"x".repeat(1025)}`))).toMatchObject({
          ok: false,
          code: "E_BAD_REQUEST",
        });
        expect(await cc.answer(req("mem", "review\n"))).toMatchObject({ ok: false, code: "E_BAD_REQUEST" });
        expect(own.mock.results.every((r) => r.value === f.raw)).toBe(true);
        expect(own).toHaveBeenCalled();
        expect(tui).not.toHaveBeenCalled();
        expect(f.native).not.toHaveBeenCalled();
        expect(f.businessReads).toEqual([]);
        for (const spy of fsReadsAndWrites) expect(spy).not.toHaveBeenCalled();
      } finally {
        cc.dispose();
        for (const spy of fsReadsAndWrites) spy.mockRestore();
      }
    },
  );

  it.each(["blocks", "tiered"] as const)(
    "%s Jev on/off preserves discovery gate through real capture",
    async (layout) => {
      for (const jevOn of [false, true]) {
        const f = capturedMemory(layout, jevOn);
        const cc = createCommandComplete({
          commands: f.pi,
          own: () => f.raw,
          tui: () => undefined,
          mode: "toolkit",
          memoryCapabilities: () => ({ sessionAdd: false, revisionReview: true }),
        });
        try {
          const root = await cc.answer(req("mem", "r"));
          expect(root.ok).toBe(true);
          if (!root.ok) throw Error("completion refused");
          expect(root.items.map((r) => r.value)).toEqual(jevOn ? ["restore", "review"] : ["restore"]);
          expect(await cc.answer(req("mem", "review "))).toMatchObject({
            ok: true,
            items: jevOn ? [{ value: "review --list", label: "--list" }] : [],
          });
          expect(f.businessReads).toEqual([]);
          expect(f.native).not.toHaveBeenCalled();
        } finally {
          cc.dispose();
        }
      }
    },
  );

  it.each(["missing", "false", "throw"] as const)(
    "review %s capability is fail-closed even with allow override",
    async (state) => {
      const f = capturedMemory();
      const capabilities = vi.fn(() => {
        if (state === "throw") throw Error("private backend unavailable");
        return { sessionAdd: false, revisionReview: false };
      });
      const cc = createCommandComplete({
        commands: f.pi,
        own: () => f.raw,
        tui: () => undefined,
        mode: "toolkit",
        overrides: { mem: "allow" },
        ...(state === "missing" ? {} : { memoryCapabilities: capabilities }),
      });
      try {
        expect(await cc.answer(req("mem", "review "))).toMatchObject({ ok: true, items: [] });
        for (const args of ["review", "review --list"])
          expect(
            resolveCommandPolicy({ name: "mem", args, kind: "extension", overrides: { mem: "allow" } }).policy,
          ).toBe("deny");
        expect(f.businessReads).toEqual([]);
        expect(f.native).not.toHaveBeenCalled();
        if (state === "missing") expect(capabilities).not.toHaveBeenCalled();
        else expect(capabilities).toHaveBeenCalledTimes(2);
      } finally {
        cc.dispose();
      }
    },
  );

  it("rechecks actual capability after awaiting the unchanged synchronous factory completer", async () => {
    const f = capturedMemory();
    let enabled = true;
    const capabilities = vi.fn(() => ({ sessionAdd: false, revisionReview: enabled }));
    const cc = createCommandComplete({
      commands: f.pi,
      own: () => f.raw,
      tui: () => undefined,
      mode: "toolkit",
      memoryCapabilities: capabilities,
    });
    try {
      const pending = cc.answer(req("mem", "review "));
      expect(capabilities).toHaveBeenCalledTimes(1);
      // raceCall has an await boundary even for the real, synchronous RAW factory function.
      await Promise.resolve();
      enabled = false;
      expect(await pending).toMatchObject({ ok: true, items: [] });
      expect(capabilities.mock.results.map((r) => r.value.revisionReview)).toEqual([true, false]);
      expect(f.native).not.toHaveBeenCalled();
    } finally {
      cc.dispose();
    }
  });

  it("deny override blocks real RAW lookup; native --run compatibility is not a Web grammar expansion", async () => {
    const f = capturedMemory();
    const own = vi.fn(() => f.raw);
    const cc = createCommandComplete({
      commands: f.pi,
      own,
      tui: () => undefined,
      mode: "toolkit",
      overrides: { mem: "deny" },
      memoryCapabilities: () => ({ sessionAdd: false, revisionReview: true }),
    });
    try {
      expect(await cc.answer(req("mem", "review "))).toMatchObject({ ok: false, code: "E_COMMAND_DENIED" });
      expect(own).not.toHaveBeenCalled();
      expect(parseRevisionFlowCommand("review")).toEqual({ kind: "review", listOnly: false });
      expect(parseRevisionFlowCommand("review --list")).toEqual({ kind: "review", listOnly: true });
      expect(parseRevisionFlowCommand("review --run")).toBeUndefined();
      expect(
        resolveCommandPolicy({ name: "mem", args: "review --run", kind: "extension", memoryRevisionReview: true })
          .policy,
      ).toBe("confirm");
      expect(executeMemoryRead("review --run", "/nonexistent-v-m-project")).toMatchObject({
        ok: false,
        code: "E_MEM_WEB_UNSUPPORTED",
      });
      expect(f.native).not.toHaveBeenCalled();
      expect(f.businessReads).toEqual([]);
    } finally {
      cc.dispose();
    }
  });
});
