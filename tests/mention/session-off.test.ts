import { describe, expect, it, vi } from "vitest";
import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import { createMentionRegistry } from "../../src/mention/registry.js";
import { routeMention } from "../../src/mention/mention.js";
import { createMentionAutocompleteProvider } from "../../src/mention/autocomplete.js";
import { createMentionSessionPort, type MentionSessionSendOutcome } from "../../src/mention/session.js";
import type { XsDirectoryRow } from "../../src/fabric/xs/directory.js";
import type { RunSnapshot } from "../../src/core/types.js";
import { createCommandHandler, type CommandHandlerDeps } from "../../src/web-hub/agent/commands.js";
import { createCommandLedger } from "../../src/web-hub/agent/ledger.js";
import { createQueueMirror } from "../../src/web-hub/agent/queue-mirror.js";
import { fakeCtx, fakePi, fakeTimerQueue } from "../web-hub/agent/helpers.js";

/**
 * fabric reply-plan §9.7 (package M): the THREE off states — ① xs off (port not injected),
 * ② xs on but not joined, ③ after `leave` — every @ input (including `@session:`) passes
 * through to pi untouched, and completion output is byte-identical. Byte comparisons run
 * against the xs-off baseline (JSON.stringify equality) for the TUI parse/route/provider
 * outputs AND the web prompt path's sync determination.
 */

const row: XsDirectoryRow = {
  ref: "ab12cd34",
  name: "builder",
  cwdLabel: "~/repo",
  kind: "main",
  receive: "wake",
  busy: false,
  lastActiveAgoS: 5,
};

/** All @ shapes that must NEVER be intercepted in an off state. */
const TEXTS = [
  "@session:builder hi",
  "@session:ab12cd34 hi",
  "@builder hi", // would be a bare-form hit were we joined
  "@nobody hi",
  "@src/file.ts read this",
  "plain text, no mention at all",
];

function snapshot(status: RunSnapshot["status"]): RunSnapshot {
  return {
    runId: "run-1",
    generation: 1,
    status,
    phase: status === "running" ? "prompt_dispatch" : "settled",
    deadlines: { enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined },
    updatedAt: 1,
    diag: {
      createdAt: 0,
      phase: status === "running" ? "prompt_dispatch" : "settled",
      phaseEnteredAt: 0,
      pendingTools: 0,
      turns: 0,
      escalation: [],
      orphaned: false,
      generation: 1,
      degraded: [],
      staleInputs: 0,
      unkillable: [],
    },
  };
}

function portWith(joined: () => boolean, sends: unknown[]) {
  return createMentionSessionPort({
    joined,
    isLabel: () => false,
    cwd: () => "/tmp",
    lookupExact: (name) => (name === "builder" || name === "ab12cd34" ? row : undefined),
    send: async (target, message) => {
      sends.push({ target, message });
      const outcome: MentionSessionSendOutcome = { status: "sent", effect: "applied" };
      return outcome;
    },
  });
}

function tuiDeps(sessions: ReturnType<typeof portWith> | undefined) {
  return {
    registry: createMentionRegistry(), // no subagent labels — the session branch is the only candidate
    query: {
      get: () => snapshot("running"),
      steer: vi.fn(async () => ({ ok: true as const })),
    },
    spawn: { spawn: vi.fn() as never },
    ...(sessions !== undefined ? { sessions } : {}),
  };
}

describe("§9.7 off states — TUI parse/route byte-comparison vs the xs-off baseline", () => {
  it("state ① xs off (port absent): identical bytes for every @ shape", async () => {
    const sends: unknown[] = [];
    for (const text of TEXTS) {
      const baseline = JSON.stringify(await routeMention(text, tuiDeps(undefined)));
      const actual = JSON.stringify(await routeMention(text, tuiDeps(undefined)));
      expect(actual, text).toEqual(baseline);
      expect(JSON.parse(actual).handled, text).toBe(false);
    }
    expect(sends).toEqual([]);
  });

  it("state ② xs on but not joined: parse returns undefined ⇒ identical bytes to state ①", async () => {
    const sends: unknown[] = [];
    const port = portWith(() => false, sends);
    for (const text of TEXTS) {
      const baseline = JSON.stringify(await routeMention(text, tuiDeps(undefined)));
      const actual = JSON.stringify(await routeMention(text, tuiDeps(port)));
      expect(actual, text).toEqual(baseline);
      expect(JSON.parse(actual).handled, text).toBe(false);
    }
    expect(sends).toEqual([]);
  });

  it("state ③ after leave: the SAME port flips joined→false and outputs return to baseline", async () => {
    const sends: unknown[] = [];
    let joined = true;
    const port = portWith(() => joined, sends);
    // sanity while joined: the bare and explicit forms DO intercept (not an off state yet)
    expect((await routeMention("@builder hi", tuiDeps(port))).handled).toBe(true);
    expect((await routeMention("@session:builder hi", tuiDeps(port))).handled).toBe(true);
    expect(sends).toHaveLength(2);
    joined = false; // /fabric leave
    for (const text of TEXTS) {
      const baseline = JSON.stringify(await routeMention(text, tuiDeps(undefined)));
      const actual = JSON.stringify(await routeMention(text, tuiDeps(port)));
      expect(actual, text).toEqual(baseline);
      expect(JSON.parse(actual).handled, text).toBe(false);
    }
    expect(sends).toHaveLength(2); // nothing new was sent after the leave
  });
});

describe("§9.7 off states — completion output byte-comparison", () => {
  const options = () => ({ signal: new AbortController().signal, force: true });
  const BASE_ITEMS: AutocompleteItem[] = [{ value: "@src/index.ts", label: "@src/index.ts", description: "file" }];
  const AGENT = { entries: () => [{ label: "worker", type: "general", runId: "r1", status: "running" as const }] };

  function fakeBase(): AutocompleteProvider {
    return {
      async getSuggestions() {
        return { prefix: "", items: BASE_ITEMS };
      },
      applyCompletion: (lines) => ({ lines, cursorLine: 0, cursorCol: (lines[0] ?? "").length }),
    };
  }

  it("states ①②③ produce byte-identical completion output to the sessions-absent baseline", async () => {
    const baselineProvider = createMentionAutocompleteProvider(fakeBase(), AGENT);
    const expected = JSON.stringify(await baselineProvider.getSuggestions(["@"], 0, 1, options()));
    // ②/③: the port exists and the directory HAS a row, but join is off ⇒ entries [] …
    const notJoined = createMentionAutocompleteProvider(fakeBase(), {
      ...AGENT,
      sessions: () => [], // MW's wiring projects the not-joined directory as no entries
      sessionBareName: () => true,
    });
    expect(JSON.stringify(await notJoined.getSuggestions(["@"], 0, 1, options()))).toEqual(expected);
    // …and an explicitly throwing sessions() degrades to the same bytes
    const throwing = createMentionAutocompleteProvider(fakeBase(), {
      ...AGENT,
      sessions: () => {
        throw new Error("boom");
      },
    });
    expect(JSON.stringify(await throwing.getSuggestions(["@"], 0, 1, options()))).toEqual(expected);
    // control: WERE the entries live, the output WOULD differ (guards a vacuous comparison)
    const live = createMentionAutocompleteProvider(fakeBase(), {
      ...AGENT,
      sessions: () => [{ ref: "ab12cd34", name: "builder", cwdLabel: "~/repo", receive: "wake", busy: false }],
      sessionBareName: () => true,
    });
    expect(JSON.stringify(await live.getSuggestions(["@"], 0, 1, options()))).not.toEqual(expected);
  });
});

describe("§9.7 off states — web prompt sync determination (native path)", () => {
  it("states ①②③ all hand every @ shape to sendUserMessage verbatim", async () => {
    const mkHandler = (sessions: ReturnType<typeof portWith> | undefined) => {
      const { pi, sentUserMessages } = fakePi();
      const { ctx } = fakeCtx({ mode: "tui" });
      const deps: CommandHandlerDeps = {
        pi,
        getCtx: () => ctx,
        getSessionId: () => "s1",
        ledger: createCommandLedger(),
        queueMirror: createQueueMirror(),
        compactionState: { manualCompacting: false, dispose() {} },
        originEntry: { appendOrigin: vi.fn(), notify: vi.fn(), dispose: vi.fn() },
        builtinBridge: {
          execute: () => ({ ok: false, code: "E_UNSUPPORTED", retryable: false, effect: "none" }),
          isQuiet: () => false,
        },
        controlEnabled: () => true,
        now: () => 1000,
        send: () => undefined,
        onChanged: () => undefined,
        setTimer: fakeTimerQueue().setTimer,
        mention: () => tuiDeps(sessions) as never,
      };
      return { handler: createCommandHandler(deps), sentUserMessages };
    };

    let seq = 0;
    const frameOf = (text: string) => ({
      t: "cmd" as const,
      rid: `r-off${(seq += 1)}`,
      id: `off${seq}`,
      deadlineMs: 8000,
      origin: { listener: "loopback" as const, ip: "127.0.0.1", reqId: "abcdef0123456789" },
      cmd: { op: "prompt" as const, text, deliver: "steer" as const },
    });

    const states: Array<[string, ReturnType<typeof portWith> | undefined]> = [
      ["xs off", undefined],
      ["not joined", portWith(() => false, [])],
    ];
    let joined = true;
    const leavePort = portWith(() => joined, []);
    states.push(["after leave", leavePort]);

    for (const [stateName, sessions] of states) {
      if (stateName === "after leave") joined = false;
      // The command ledger is process-global (Symbol.for) and the fake pi never settles the
      // observation timers — clear it per state so the 16-running-entries capacity cap (E_RATE)
      // cannot mask the pass-through behavior under test.
      delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagent:web-hub:cmd-ledger")];
      const { handler, sentUserMessages } = mkHandler(sessions);
      for (const text of TEXTS) {
        handler.handle(frameOf(text));
        expect(
          sentUserMessages.some((m) => m.text === text),
          `${stateName}: ${text}`,
        ).toBe(true); // native path — the sync determination did not intercept
        expect(sentUserMessages.at(-1)?.options).toEqual({ deliverAs: "steer", expandPromptTemplates: false });
      }
      handler.dispose();
    }
  });
});
