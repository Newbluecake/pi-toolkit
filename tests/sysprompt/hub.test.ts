// sysprompt-stable plan v3.1 §4.5 / §7.3 (M2, fake-pi hub tests). The hub is
// the single `before_agent_start` handler that folds registered sections
// (stable snapshot / live-refresh / legacy raw) and, when wakeReplay is on,
// owns S1's wake-run replay + first-wake seeding through the SAME capture
// cell (`src/sysprompt/wake-replay.ts`, unchanged since S1). `context_with_system`
// runs against pi-ai's REAL `getCurrentSystemMessage` (resolved by
// `getTranscriptHelpers` at hub-creation time), matching the production path.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, test } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createPromptSectionHub,
  type PromptSectionHub,
  type PromptSectionHubOpts,
  type SectionRegistration,
} from "../../src/sysprompt/hub.js";
import { SKIP, type Live } from "../../src/prompt-sections/stable-section.js";
import { PROMPT_SECTIONS_ENTRY_TYPE } from "../../src/prompt-sections/store.js";

// ---------------------------------------------------------------------------
// fake pi: hub registers each event AT MOST ONCE (single owner), so a
// duplicate pi.on() call for the same event is itself a bug the fake surfaces
// immediately -- this doubles as the "each hook registered exactly once" test.
// ---------------------------------------------------------------------------

interface FakePi {
  pi: ExtensionAPI;
  handlers: Map<string, (event: any, ctx: any) => any>;
  appended: Array<{ type: string; data: unknown }>;
  logs: string[];
  throwOnAppend: { value: boolean };
}

function fakePi(): FakePi {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const appended: Array<{ type: string; data: unknown }> = [];
  const logs: string[] = [];
  const throwOnAppend = { value: false };
  const pi = {
    on(event: string, handler: any) {
      if (handlers.has(event)) throw new Error(`duplicate pi.on(${event}) -- hub must register each hook once`);
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    appendEntry(type: string, data?: unknown) {
      if (throwOnAppend.value) throw new Error("appendEntry failed");
      appended.push({ type, data });
    },
  } as unknown as ExtensionAPI;
  return { pi, handlers, appended, logs, throwOnAppend };
}

function makeHub(host: FakePi, opts: Partial<PromptSectionHubOpts> = {}): PromptSectionHub {
  return createPromptSectionHub(host.pi, {
    mode: opts.mode ?? (() => "stable"),
    wakeReplay: opts.wakeReplay ?? true,
    adoptForeignForcedPrompt: opts.adoptForeignForcedPrompt ?? false,
    log: opts.log ?? ((message) => host.logs.push(message)),
  });
}

/** A section whose live value the test drives directly; ignores `input.ctx`. */
function testSection(initial: Live = ""): {
  reg: SectionRegistration;
  setLive: (v: Live) => void;
  calls: () => number;
} {
  let live: Live = initial;
  let calls = 0;
  const reg: SectionRegistration = {
    provider: () => {
      calls += 1;
      return live;
    },
    title: "## Test Section",
    pointerHint: "Refresh via the test tool.",
  };
  return { reg, setLive: (v) => (live = v), calls: () => calls };
}

function beforeAgentStart(host: FakePi, systemPrompt: string, ctx: Partial<ExtensionContext> = {}): any {
  const handler = host.handlers.get("before_agent_start")!;
  return handler({ type: "before_agent_start", prompt: "go", systemPrompt, systemPromptOptions: {} }, ctx);
}

function beforeAgentStartForced(
  host: FakePi,
  systemPrompt: string,
  forceSystemPrompt: string | undefined,
  ctx: Partial<ExtensionContext> = {},
): any {
  const handler = host.handlers.get("before_agent_start")!;
  return handler(
    { type: "before_agent_start", prompt: "go", systemPrompt, systemPromptOptions: { forceSystemPrompt } },
    ctx,
  );
}

async function contextWithSystem(host: FakePi, messages: unknown[], ctx: Partial<ExtensionContext>): Promise<any> {
  const handler = host.handlers.get("context_with_system");
  if (!handler) return undefined;
  return handler({ type: "context_with_system", messages }, ctx);
}

function sessionStart(host: FakePi, reason: string, ctx: Partial<ExtensionContext> = {}): void {
  host.handlers.get("session_start")?.({ type: "session_start", reason }, ctx);
}
function sessionCompact(host: FakePi): void {
  host.handlers.get("session_compact")?.({ type: "session_compact" }, {});
}
function modelSelect(host: FakePi): void {
  host.handlers.get("model_select")?.({ type: "model_select" }, {});
}
function sessionTree(host: FakePi, ctx: Partial<ExtensionContext> = {}): void {
  host.handlers.get("session_tree")?.({ type: "session_tree" }, ctx);
}
function turnStart(host: FakePi): void {
  host.handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 0, timestamp: 0 }, {});
}
function agentSettled(host: FakePi): void {
  host.handlers.get("agent_settled")?.({ type: "agent_settled" }, {});
}

const systemMessage = (content: string) => ({
  role: "system",
  content,
  timestamp: 1_700_000_000_000,
  toolsAdded: [{ name: "bash" }],
});
const userMessage = { role: "user", content: "hi" };

// ---------------------------------------------------------------------------

describe("wiring: each hook registered exactly once", () => {
  test("stable + wakeReplay:true registers all seven pi.on() hooks plus context_with_system", () => {
    const host = fakePi();
    const hub = makeHub(host, { wakeReplay: true });
    hub.register("pi_subagent_types", testSection("").reg);
    expect(host.handlers.has("before_agent_start")).toBe(true);
    expect(host.handlers.has("context_with_system")).toBe(true);
    expect(host.handlers.has("session_start")).toBe(true);
    expect(host.handlers.has("session_compact")).toBe(true);
    expect(host.handlers.has("model_select")).toBe(true);
    expect(host.handlers.has("session_tree")).toBe(true);
    expect(host.handlers.has("turn_start")).toBe(true);
    expect(host.handlers.has("agent_settled")).toBe(true);
  });

  test("wakeReplay:false does NOT register context_with_system (U5: not registered-but-inert)", () => {
    const host = fakePi();
    makeHub(host, { wakeReplay: false });
    expect(host.handlers.has("context_with_system")).toBe(false);
    expect(host.handlers.has("before_agent_start")).toBe(true); // everything else stays
  });

  test("registering the same section name twice throws (programming error)", () => {
    const host = fakePi();
    const hub = makeHub(host);
    hub.register("pi_subagent_types", testSection("").reg);
    expect(() => hub.register("pi_subagent_types", testSection("").reg)).toThrow(/duplicate/);
  });

  test("a second hub (simulating a child session) gets the identical hook set (D6)", () => {
    const main = fakePi();
    const child = fakePi();
    makeHub(main, { wakeReplay: true });
    makeHub(child, { wakeReplay: true }); // child registers no sections, same hook set regardless
    expect([...main.handlers.keys()].sort()).toEqual([...child.handlers.keys()].sort());
  });
});

describe("mode: stable / live / legacy (three-state, task item 6)", () => {
  test("stable: first turn is a free refresh (no message); a later change freezes the head and sends an update", () => {
    const host = fakePi();
    const hub = makeHub(host, { mode: () => "stable" });
    const s = testSection();
    hub.register("pi_subagent_types", s.reg);

    s.setLive("A");
    const r1 = beforeAgentStart(host, "BASE");
    expect(r1).toEqual({ systemPrompt: "BASE\n\nA" });

    s.setLive("B");
    const r2 = beforeAgentStart(host, "BASE");
    expect(r2.systemPrompt).toBe("BASE\n\nA"); // frozen: head unchanged
    expect(r2.message).toBeDefined();
    expect(r2.message.content).toContain("REPLACES");
    expect(r2.message.content).toContain("B");

    // same live again ⇒ no repeat message (I3); head stays byte-identical
    const r3 = beforeAgentStart(host, "BASE");
    expect(r3).toEqual({ systemPrompt: "BASE\n\nA" });
  });

  test("legacy: raw live every turn, byte-identical to the fold oracle, never a message, never appendEntry", () => {
    const host = fakePi();
    const hub = makeHub(host, { mode: () => "legacy" });
    const s = testSection();
    hub.register("pi_subagent_types", s.reg);

    s.setLive("A");
    expect(beforeAgentStart(host, "BASE")).toEqual({ systemPrompt: "BASE\n\nA" });
    s.setLive("B");
    expect(beforeAgentStart(host, "BASE")).toEqual({ systemPrompt: "BASE\n\nB" }); // no freeze at all
    s.setLive(""); // SKIP-equivalent for legacy: today's "nothing to inject"
    expect(beforeAgentStart(host, "BASE")).toBeUndefined();
    expect(host.appended).toEqual([]); // legacy never persists (D7)
  });

  test("live: refreshes every turn through the SAME fold, but never emits an update message or persists", () => {
    const host = fakePi();
    const hub = makeHub(host, { mode: () => "live" });
    const s = testSection();
    hub.register("pi_subagent_types", s.reg);

    s.setLive("A");
    expect(beforeAgentStart(host, "BASE")).toEqual({ systemPrompt: "BASE\n\nA" });
    s.setLive("B");
    const r2 = beforeAgentStart(host, "BASE");
    expect(r2).toEqual({ systemPrompt: "BASE\n\nB" }); // head tracks live, no message
    expect(host.appended).toEqual([]); // live never persists either
  });

  test("live keeps last-known content on a transient SKIP (state-machine fallback), unlike legacy", () => {
    const host = fakePi();
    const liveHub = makeHub(host, { mode: () => "live" });
    const s = testSection();
    liveHub.register("pi_subagent_types", s.reg);
    s.setLive("A");
    expect(beforeAgentStart(host, "BASE").systemPrompt).toBe("BASE\n\nA");
    s.setLive(SKIP);
    expect(beforeAgentStart(host, "BASE").systemPrompt).toBe("BASE\n\nA"); // kept, not blanked

    const host2 = fakePi();
    const legacyHub = makeHub(host2, { mode: () => "legacy" });
    const s2 = testSection();
    legacyHub.register("pi_subagent_types", s2.reg);
    s2.setLive("A");
    expect(beforeAgentStart(host2, "BASE").systemPrompt).toBe("BASE\n\nA");
    s2.setLive(SKIP);
    expect(beforeAgentStart(host2, "BASE")).toBeUndefined(); // legacy: SKIP ⇒ blank, matches today
  });

  test("all sections empty ⇒ undefined (no forced-prompt path taken)", () => {
    const host = fakePi();
    const hub = makeHub(host);
    hub.register("pi_subagent_types", testSection("").reg);
    hub.register("pi_subagent_models", testSection("").reg);
    expect(beforeAgentStart(host, "BASE")).toBeUndefined();
  });
});

describe("error handling / I5 / I7", () => {
  test("provider throws after a successful snapshot ⇒ folds the OLD snapshot, never crashes (I5)", () => {
    const host = fakePi();
    const hub = makeHub(host);
    let shouldThrow = false;
    const reg: SectionRegistration = {
      provider: () => {
        if (shouldThrow) throw new Error("boom");
        return "GOOD";
      },
      title: "## T",
    };
    hub.register("pi_subagent_types", reg);
    expect(beforeAgentStart(host, "BASE").systemPrompt).toBe("BASE\n\nGOOD");
    shouldThrow = true;
    expect(beforeAgentStart(host, "BASE").systemPrompt).toBe("BASE\n\nGOOD"); // kept, no crash
  });

  test("provider returns a thenable ⇒ treated as SKIP and logs once per occurrence (I7)", () => {
    const host = fakePi();
    const hub = makeHub(host);
    const reg: SectionRegistration = { provider: () => Promise.resolve("nope") as unknown as Live, title: "## T" };
    hub.register("pi_subagent_types", reg);
    const result = beforeAgentStart(host, "BASE");
    expect(result).toBeUndefined(); // SKIP on a fresh (never-had-a-snapshot) section ⇒ folds ""
    expect(host.logs.some((line) => line.includes("thenable"))).toBe(true);
  });

  test("skipIf: true ⇒ the section is fully inert (provider never called, no state, no update)", () => {
    const host = fakePi();
    const hub = makeHub(host);
    const s = testSection("A");
    const reg: SectionRegistration = { ...s.reg, skipIf: () => true };
    hub.register("pi_subagent_types", reg);
    const result = beforeAgentStart(host, "BASE");
    expect(result).toBeUndefined();
    expect(s.calls()).toBe(0);
    expect(hub._state("pi_subagent_types")).toEqual({
      snapshot: undefined,
      announced: undefined,
      stale: true,
      sentCount: 0,
      sentBytes: 0,
    });
  });
});

describe("prefixFresh: turn_start clears it, session_compact/model_select/agent_settled interplay", () => {
  test("compact ⇒ immediate user turn is a FREE refresh (no message)", () => {
    const host = fakePi();
    const hub = makeHub(host);
    const s = testSection();
    hub.register("pi_subagent_types", s.reg);
    s.setLive("A");
    beforeAgentStart(host, "BASE"); // seed snapshot=A

    sessionCompact(host);
    s.setLive("C");
    const r = beforeAgentStart(host, "BASE"); // no turn_start in between ⇒ free
    expect(r).toEqual({ systemPrompt: "BASE\n\nC" }); // silently rewritten, no message
  });

  test("compact ⇒ turn_start ⇒ user turn is NOT free: head stays put, an update is sent (review-3 #9)", () => {
    const host = fakePi();
    const hub = makeHub(host);
    const s = testSection();
    hub.register("pi_subagent_types", s.reg);
    s.setLive("A");
    beforeAgentStart(host, "BASE");

    sessionCompact(host);
    turnStart(host); // a request happened before the next user turn ⇒ refresh is no longer free
    s.setLive("C");
    const r = beforeAgentStart(host, "BASE");
    expect(r.systemPrompt).toBe("BASE\n\nA"); // head unchanged
    expect(r.message).toBeDefined();
    expect(r.message.content).toContain("C");
  });

  test("compact ⇒ agent_settled ⇒ user turn is STILL free (settled must not clear the free window, F9)", () => {
    const host = fakePi();
    const hub = makeHub(host);
    const s = testSection();
    hub.register("pi_subagent_types", s.reg);
    s.setLive("A");
    beforeAgentStart(host, "BASE");

    sessionCompact(host);
    agentSettled(host); // does not clear prefixFresh
    s.setLive("C");
    const r = beforeAgentStart(host, "BASE");
    expect(r).toEqual({ systemPrompt: "BASE\n\nC" }); // free refresh, no message
  });

  test("model_select ⇒ turn_start ⇒ user turn does NOT resend an already-announced update (review-3 #12)", () => {
    const host = fakePi();
    const hub = makeHub(host);
    const s = testSection();
    hub.register("pi_subagent_types", s.reg);
    s.setLive("A");
    beforeAgentStart(host, "BASE"); // snapshot=A, announced=A
    s.setLive("B");
    const withUpdate = beforeAgentStart(host, "BASE");
    expect(withUpdate.message).toBeDefined(); // announced=B now, snapshot stays A

    modelSelect(host); // prefixFresh=true, but NOT forgetAnnounced
    turnStart(host); // clears prefixFresh before the next user turn
    // live unchanged (still "B", already announced) ⇒ nothing to resend, head stays put
    const r = beforeAgentStart(host, "BASE");
    expect(r).toEqual({ systemPrompt: "BASE\n\nA" });
  });

  test("session_tree with no matching branch entry keeps in-memory state and forgetAnnounced ⇒ next turn resends (§4.9)", () => {
    const host = fakePi();
    const hub = makeHub(host);
    const s = testSection();
    hub.register("pi_subagent_types", s.reg);
    s.setLive("A");
    beforeAgentStart(host, "BASE"); // snapshot=A, announced=A
    s.setLive("B");
    beforeAgentStart(host, "BASE"); // announced=B (update already sent), snapshot stays A

    sessionTree(host, {}); // no sessionManager ⇒ "not found" ⇒ keep in-memory + forgetAnnounced (announced -> A)
    // live is still "B" (unchanged) but announced was reset to snapshot "A" ⇒ resend
    const r = beforeAgentStart(host, "BASE");
    expect(r.systemPrompt).toBe("BASE\n\nA"); // still frozen
    expect(r.message).toBeDefined();
    expect(r.message.content).toContain("B");
  });
});

describe("context_with_system: replay + first-wake seeding (wakeReplay:true)", () => {
  test("no capture yet (wake before any user turn, and base already matches) ⇒ untouched", async () => {
    const host = fakePi();
    const hub = makeHub(host);
    hub.register("pi_subagent_types", testSection("").reg);
    const out = await contextWithSystem(host, [systemMessage("BASE"), userMessage], { getSystemPrompt: () => "BASE" });
    expect(out).toBeUndefined();
    void hub;
  });

  test("capture present ⇒ replay is applied to a wake request", async () => {
    const host = fakePi();
    const hub = makeHub(host);
    const s = testSection();
    hub.register("pi_subagent_types", s.reg);
    s.setLive("A");
    beforeAgentStart(host, "BASE"); // captures "BASE\n\nA"
    expect(hub._captured()).toBe("BASE\n\nA");

    const out = await contextWithSystem(host, [systemMessage("BASE"), userMessage], {
      getSystemPrompt: () => "BASE\n\nA", // pretend this is a forced run so R5a is a no-op
    });
    expect(out).toBeDefined();
    expect((out.messages[0] as any).content).toBe("BASE\n\nA");
  });

  test("first wake request before any user turn seeds a capture that matches the following user turn byte-for-byte (review-3 #5)", async () => {
    const host = fakePi();
    const hub = makeHub(host);
    const s = testSection();
    hub.register("pi_subagent_types", s.reg);
    s.setLive("A");

    const out = await contextWithSystem(host, [systemMessage("BASE"), userMessage], { getSystemPrompt: () => "BASE" });
    expect(out).toBeDefined();
    expect((out.messages[0] as any).content).toBe("BASE\n\nA");

    const turn = beforeAgentStart(host, "BASE");
    // stale already cleared by the seed; live unchanged ⇒ same frozen head, no update
    expect(turn).toEqual({ systemPrompt: "BASE\n\nA" });
    expect(hub._state("pi_subagent_types")?.snapshot).toBe("A");
  });

  test('getSystemPrompt: () => "" ⇒ no seed, no replay (review-3 #4: unbound default must never drop the base)', async () => {
    const host = fakePi();
    const hub = makeHub(host);
    hub.register("pi_subagent_types", testSection("A").reg);
    const out = await contextWithSystem(host, [systemMessage(""), userMessage], { getSystemPrompt: () => "" });
    expect(out).toBeUndefined();
    expect(hub._captured()).toBeUndefined();
  });

  test("wake run: 1st request all-empty (no seed) ⇒ 2nd request in the SAME run does not seed even once content appears (review-3 #5)", async () => {
    const host = fakePi();
    const hub = makeHub(host);
    const s = testSection("");
    hub.register("pi_subagent_types", s.reg);

    const first = await contextWithSystem(host, [systemMessage("BASE"), userMessage], {
      getSystemPrompt: () => "BASE",
    });
    expect(first).toBeUndefined(); // sections empty ⇒ seeded === cur ⇒ no capture
    s.setLive("NOW NON EMPTY");
    const second = await contextWithSystem(host, [systemMessage("BASE"), userMessage], {
      getSystemPrompt: () => "BASE",
    });
    expect(second).toBeUndefined(); // firstRequestPending already consumed ⇒ no seeding attempt at all
  });

  test("ctx.getSystemPrompt is called at most once per run (review-3 #14)", async () => {
    const host = fakePi();
    const hub = makeHub(host);
    const s = testSection();
    hub.register("pi_subagent_types", s.reg);
    s.setLive("A");
    beforeAgentStart(host, "BASE"); // captures "BASE\n\nA"

    let calls = 0;
    const getSystemPrompt = () => {
      calls += 1;
      return "BASE\n\nA";
    };
    await contextWithSystem(host, [systemMessage("BASE"), userMessage], { getSystemPrompt }); // first ⇒ R5a check runs once
    await contextWithSystem(host, [systemMessage("BASE"), userMessage], { getSystemPrompt }); // not first ⇒ no more calls
    expect(calls).toBe(1);
  });

  test("ctx.getSystemPrompt() throws ⇒ still replays the captured bytes", async () => {
    const host = fakePi();
    const hub = makeHub(host);
    const s = testSection();
    hub.register("pi_subagent_types", s.reg);
    s.setLive("A");
    beforeAgentStart(host, "BASE");
    const out = await contextWithSystem(host, [systemMessage("BASE"), userMessage], {
      getSystemPrompt: () => {
        throw new Error("assertActive");
      },
    });
    expect(out).toBeDefined();
    expect((out.messages[0] as any).content).toBe("BASE\n\nA");
  });

  describe("R5a: a later extension appends to the forced prompt (U7)", () => {
    test("adoptForeignForcedPrompt:false ⇒ still replays OUR captured bytes and WARNs once per run", async () => {
      const host = fakePi();
      const hub = makeHub(host, { adoptForeignForcedPrompt: false });
      const s = testSection();
      hub.register("pi_subagent_types", s.reg);
      s.setLive("A");
      beforeAgentStart(host, "BASE"); // captures "BASE\n\nA"

      const cur = "BASE\n\nA\n\nEXTRA-FROM-LATER-EXTENSION";
      const out1 = await contextWithSystem(host, [systemMessage("BASE"), userMessage], { getSystemPrompt: () => cur });
      expect((out1.messages[0] as any).content).toBe("BASE\n\nA"); // kept OUR bytes
      const out2 = await contextWithSystem(host, [systemMessage("BASE"), userMessage], { getSystemPrompt: () => cur });
      expect((out2.messages[0] as any).content).toBe("BASE\n\nA"); // still ours on request 2

      expect(host.logs.filter((l) => l.includes("R5a")).length).toBe(1); // once per RUN, not per request
    });

    test("adoptForeignForcedPrompt:true ⇒ replays the extended text instead", async () => {
      const host = fakePi();
      const hub = makeHub(host, { adoptForeignForcedPrompt: true });
      const s = testSection();
      hub.register("pi_subagent_types", s.reg);
      s.setLive("A");
      beforeAgentStart(host, "BASE");

      const cur = "BASE\n\nA\n\nEXTRA-FROM-LATER-EXTENSION";
      const out = await contextWithSystem(host, [systemMessage("BASE"), userMessage], { getSystemPrompt: () => cur });
      expect((out.messages[0] as any).content).toBe(cur);
    });

    test("two separate runs each WARN exactly once (agent_settled resets firstRequestPending)", async () => {
      const host = fakePi();
      const hub = makeHub(host, { adoptForeignForcedPrompt: false });
      const s = testSection();
      hub.register("pi_subagent_types", s.reg);
      s.setLive("A");
      beforeAgentStart(host, "BASE");
      const cur = "BASE\n\nA\n\nEXTRA";
      await contextWithSystem(host, [systemMessage("BASE"), userMessage], { getSystemPrompt: () => cur });
      agentSettled(host); // ends the run
      await contextWithSystem(host, [systemMessage("BASE"), userMessage], { getSystemPrompt: () => cur }); // next run's 1st request
      expect(host.logs.filter((l) => l.includes("R5a")).length).toBe(2);
    });
  });

  describe("earlier extension forces the prompt while our sections are empty (review-3 #3)", () => {
    test("adoptForeignForcedPrompt:false ⇒ does not capture the foreign text", async () => {
      const host = fakePi();
      const hub = makeHub(host, { adoptForeignForcedPrompt: false });
      hub.register("pi_subagent_types", testSection("").reg); // our sections stay empty
      beforeAgentStartForced(host, "BASE", "BASE_FORCED_BY_OTHER");
      expect(hub._captured()).toBeUndefined();
    });

    test("adoptForeignForcedPrompt:true ⇒ captures the foreign forced text", async () => {
      const host = fakePi();
      const hub = makeHub(host, { adoptForeignForcedPrompt: true });
      hub.register("pi_subagent_types", testSection("").reg);
      beforeAgentStartForced(host, "BASE", "BASE_FORCED_BY_OTHER");
      expect(hub._captured()).toBe("BASE_FORCED_BY_OTHER");
    });
  });
});

describe("T-G5 (review-3 #8): sections still show up in { systemPrompt } even with wakeReplay off", () => {
  for (const mode of ["stable", "legacy"] as const) {
    test(`mode=${mode}, wakeReplay:false ⇒ context_with_system never registered; sections still fold`, () => {
      const host = fakePi();
      const hub = makeHub(host, { wakeReplay: false, mode: () => mode });
      hub.register("pi_subagent_types", testSection("A").reg);
      expect(host.handlers.has("context_with_system")).toBe(false);
      expect(beforeAgentStart(host, "BASE")).toEqual({ systemPrompt: "BASE\n\nA" });
      expect(hub._captured()).toBeUndefined(); // replay layer inert by construction
    });
  }
});

describe("persistence (U6, §4.9)", () => {
  test("a user turn whose state does not change never re-appends the entry", () => {
    const host = fakePi();
    const hub = makeHub(host);
    const s = testSection();
    hub.register("pi_subagent_types", s.reg);
    s.setLive("A");
    beforeAgentStart(host, "BASE"); // state changes: initial -> snapshot A
    beforeAgentStart(host, "BASE"); // unchanged (live still A, already announced)
    beforeAgentStart(host, "BASE");
    expect(host.appended.filter((e) => e.type === PROMPT_SECTIONS_ENTRY_TYPE)).toHaveLength(1);
  });

  test("session_start(reload) with an exact (no-compaction-after) entry restores byte-for-byte and sends no update (review-3 #2)", () => {
    const host = fakePi();
    const hub = makeHub(host);
    const s = testSection();
    hub.register("pi_subagent_types", s.reg);
    s.setLive("A");
    beforeAgentStart(host, "BASE");
    s.setLive("B");
    beforeAgentStart(host, "BASE"); // announced=B, snapshot stays A, one entry written so far
    const persistedEntry = host.appended.at(-1)!;

    // Simulate /reload: fresh hub, fresh closure, branch has our persisted entry and nothing after it.
    const host2 = fakePi();
    const hub2 = makeHub(host2);
    const s2 = testSection();
    hub2.register("pi_subagent_types", s2.reg);
    sessionStart(host2, "reload", {
      sessionManager: {
        getBranch: () => [{ type: "custom", customType: PROMPT_SECTIONS_ENTRY_TYPE, data: persistedEntry.data }],
      } as any,
    });
    s2.setLive("B"); // matches the persisted `announced` exactly ⇒ nothing new
    const r = beforeAgentStart(host2, "BASE");
    expect(r).toEqual({ systemPrompt: "BASE\n\nA" }); // identical to pre-reload, no update
    expect(hub2._state("pi_subagent_types")?.snapshot).toBe("A");
  });

  test("session_start(resume) forgets announced ⇒ a still-different live resends once", () => {
    const host = fakePi();
    const hub = makeHub(host);
    const s = testSection();
    hub.register("pi_subagent_types", s.reg);
    s.setLive("A");
    beforeAgentStart(host, "BASE");
    s.setLive("B");
    beforeAgentStart(host, "BASE"); // announced=B, snapshot=A
    const persistedEntry = host.appended.at(-1)!;

    const host2 = fakePi();
    const hub2 = makeHub(host2);
    const s2 = testSection();
    hub2.register("pi_subagent_types", s2.reg);
    sessionStart(host2, "resume", {
      sessionManager: {
        getBranch: () => [{ type: "custom", customType: PROMPT_SECTIONS_ENTRY_TYPE, data: persistedEntry.data }],
      } as any,
    });
    // resume ⇒ forgetAnnounced (announced reset to snapshot "A"); live is still "B" ⇒ resend
    s2.setLive("B");
    const r = beforeAgentStart(host2, "BASE");
    expect(r.systemPrompt).toBe("BASE\n\nA");
    expect(r.message).toBeDefined();
    expect(r.message.content).toContain("B");
  });

  test("appendEntry throws ⇒ WARNs once, in-memory state and the return value are unaffected", () => {
    const host = fakePi();
    const hub = makeHub(host);
    const s = testSection();
    hub.register("pi_subagent_types", s.reg);
    host.throwOnAppend.value = true;
    s.setLive("A");
    const r1 = beforeAgentStart(host, "BASE");
    expect(r1).toEqual({ systemPrompt: "BASE\n\nA" }); // unaffected by the persist failure
    s.setLive("B");
    beforeAgentStart(host, "BASE"); // a second failing persist must not double-warn
    expect(host.logs.filter((l) => l.includes("persist failed")).length).toBe(1);
    expect(host.appended).toEqual([]); // nothing ever actually landed
  });

  test("getBranch missing entirely ⇒ fresh state, no crash", () => {
    const host = fakePi();
    const hub = makeHub(host);
    const s = testSection();
    hub.register("pi_subagent_types", s.reg);
    sessionStart(host, "startup", {}); // no sessionManager at all
    s.setLive("A");
    expect(beforeAgentStart(host, "BASE")).toEqual({ systemPrompt: "BASE\n\nA" });
  });
});
