import { effectScope, ref } from "vue";
import { describe, expect, it } from "vitest";
import { initialState, reduce } from "../../../src/web-hub/ui/src/logic/state.js";
import { buildTxEntries } from "../../../src/web-hub/ui/src/components/transcript/entries.js";
import {
  DESKTOP_DEFAULT_WINDOW,
  repositionAfterPage,
  TRANSCRIPT_CAP,
  useTranscriptWindow,
} from "../../../src/web-hub/ui/src/composables/useTranscriptWindow.js";
import type { AgentState } from "../../../src/web-hub/ui/src/types.js";

/**
 * Joint test (docs/dev/web-hub-session-switch/plan.md §3.1 — v2 review Blocker-4 / 一般-13):
 * `buildTxEntries` + `useTranscriptWindow` share ONE coordinate system — every length and index
 * counts ENTRIES (each visible item one entry, a paired toolResult none, streaming one trailing
 * entry, orphan live tools one each, attached live tools none). The agent is built through the
 * REAL reducer (history frame + inflight + page event), and the paging reposition goes through
 * the real `repositionAfterPage` used by Transcript.vue's paging watcher.
 */

type Msg = { event: string; data: unknown; id?: number };
const run = (msgs: Msg[], s = initialState()): ReturnType<typeof initialState> =>
  msgs.reduce((acc, m) => reduce(acc, m), s);

function card(agentKey: string): Record<string, unknown> {
  return {
    agentKey,
    kind: "tui",
    pid: 1,
    cwd: "/tmp/p",
    state: "live",
    pluginVersion: "1.0.0",
    outdated: false,
    prompts: [],
  };
}

function userEntry(id: string, ts: number, text: string): Record<string, unknown> {
  return {
    id,
    parentId: null,
    type: "message",
    timestamp: new Date(ts).toISOString(),
    message: { role: "user", content: text, timestamp: ts },
  };
}

const FILLER = 500;

function mixedHistoryEntries(): Record<string, unknown>[] {
  return [
    ...Array.from({ length: FILLER }, (_, i) => userEntry(`f${i}`, 1_000_000 + i, `filler ${i}`)),
    {
      id: "a1",
      parentId: null,
      type: "message",
      timestamp: new Date(2_000_000).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { cmd: "ls" } }],
        timestamp: 2_000_000,
        model: "claude-sonnet-5",
      },
    },
    {
      id: "r1",
      parentId: null,
      type: "message",
      timestamp: new Date(3_000_000).toISOString(),
      message: { role: "toolResult", toolCallId: "t1", content: "paired result", timestamp: 3_000_000 },
    },
    {
      id: "r9",
      parentId: null,
      type: "message",
      timestamp: new Date(4_000_000).toISOString(),
      message: { role: "toolResult", toolCallId: "t9", content: "orphan result", timestamp: 4_000_000 },
    },
  ];
}

/** The mixed agent: fillers + assistant(toolCall t1) + paired toolResult + orphan toolResult,
 * plus inflight {streaming message, attached live tool t1, orphan live tool t2}. */
function mixedAgent(): AgentState {
  const s = run([
    { event: "hello", data: { clientId: "c1" } },
    { event: "agents", data: [card("agent-a")] },
    { event: "subscribing", data: { agentKey: "agent-a", clientId: "c1" } },
    {
      event: "history",
      data: {
        agentKey: "agent-a",
        entries: mixedHistoryEntries(),
        tailMessages: [],
        fromSeq: FILLER + 3,
        hasMore: true,
        oldestEntryId: "f0",
        inflight: {
          message: { role: "assistant", content: [{ type: "text", text: "working" }], timestamp: 5_000_000 },
          tools: [
            { toolCallId: "t1", toolName: "bash", args: { cmd: "ls" } }, // attached (called by a1)
            { toolCallId: "t2", toolName: "read", args: {} }, // orphan live tool
          ],
        },
      },
    },
  ]);
  return s.agents.get("agent-a") as unknown as AgentState;
}

describe("buildTxEntries × useTranscriptWindow — one entries coordinate system (E1-2)", () => {
  it("entriesLen counts entries, not items+streaming+tools (F12 mapping)", () => {
    const build = buildTxEntries(mixedAgent());
    // 500 fillers + assistant a1 + orphan r9 (paired r1 folds away) + streaming + live:t2
    expect(build.entries).toHaveLength(FILLER + 4);
    expect(build.entries.map((e) => e.type).slice(-4)).toEqual(["assistant", "toolOrphan", "assistant", "toolOrphan"]);
  });

  it("the default window covers exactly the last DESKTOP_DEFAULT_WINDOW entries", () => {
    const scope = effectScope();
    scope.run(() => {
      const build = buildTxEntries(mixedAgent());
      const handle = useTranscriptWindow(ref(build.entries.length), ref(false));
      const w = handle.window.value;
      expect(w.start).toBe(build.entries.length - DESKTOP_DEFAULT_WINDOW);
      expect(w.end).toBe(build.entries.length);
      expect(w.hiddenBefore).toBe(build.entries.length - DESKTOP_DEFAULT_WINDOW);
      expect(w.hiddenAfter).toBe(0);
    });
    scope.stop();
  });

  it("windowedEntries (entries.slice(start, end)) has exactly end - start rows", () => {
    const scope = effectScope();
    scope.run(() => {
      const build = buildTxEntries(mixedAgent());
      const handle = useTranscriptWindow(ref(build.entries.length), ref(false));
      handle.showEarlier(); // reveal 200 more — window is now capped by TRANSCRIPT_CAP
      const w = handle.window.value;
      const windowed = build.entries.slice(w.start, w.end);
      expect(windowed.length).toBe(w.end - w.start);
      expect(windowed.length).toBe(TRANSCRIPT_CAP);
      expect(w.hiddenAfter).toBe(build.entries.length - w.end);
    });
    scope.stop();
  });

  it("an attached live tool appearing/disappearing changes neither entries nor anchors", () => {
    const withAttached = buildTxEntries(mixedAgent());
    // drop the attached tool (t1) from the live tool list — only the orphan t2 remains
    const withoutAttached = buildTxEntries({
      ...mixedAgent(),
      tools: [{ toolCallId: "t2", toolName: "read", args: {}, done: false }] as never,
    } as never);
    expect(withoutAttached.entries.length).toBe(withAttached.entries.length);
    expect(withoutAttached.anchors).toEqual(withAttached.anchors);
  });
});

describe("paging reposition — by first-mounted entry key (E1-2)", () => {
  it("a page whose toolCall pairs the old orphan toolResult folds it, yet the first mounted entry stays put", () => {
    // Pre-paging state: window start 304 → showEarlier → 104 ( Transcript.vue's paging watcher
    // captures `entries[view.start]?.key` the moment `paging` turns true).
    const before = mixedAgent();
    const buildBefore = buildTxEntries(before);
    const lenBefore = buildBefore.entries.length; // 504
    const start = 104;
    const firstKey = buildBefore.entries[start]?.key;
    expect(firstKey).toBeDefined();

    // The page: 60 older entries, one of which is the assistant that CALLED t9 — pairing the
    // old orphan toolResult r9, which therefore loses its own entry in the rebuilt build.
    const pageEntries = [
      ...Array.from({ length: 59 }, (_, i) => userEntry(`p${i}`, 500_000 + i, `page ${i}`)),
      {
        id: "a0",
        parentId: null,
        type: "message",
        timestamp: new Date(600_000).toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "t9", name: "bash", arguments: {} }],
          timestamp: 600_000,
          model: "claude-sonnet-5",
        },
      },
    ];
    const after = run(
      [
        { event: "paging", data: { agentKey: "agent-a" } },
        { event: "page", data: { agentKey: "agent-a", entries: pageEntries, hasMore: false, oldestEntryId: "p0" } },
      ],
      run([
        { event: "hello", data: { clientId: "c1" } },
        { event: "agents", data: [card("agent-a")] },
        { event: "subscribing", data: { agentKey: "agent-a", clientId: "c1" } },
        {
          event: "history",
          data: {
            agentKey: "agent-a",
            entries: mixedHistoryEntries(),
            tailMessages: [],
            fromSeq: FILLER + 3,
            hasMore: true,
            oldestEntryId: "f0",
            inflight: {
              message: { role: "assistant", content: [{ type: "text", text: "working" }], timestamp: 5_000_000 },
              tools: [
                { toolCallId: "t1", toolName: "bash", args: {} },
                { toolCallId: "t2", toolName: "read", args: {} },
              ],
            },
          },
        },
      ]),
    );
    const agentAfter = after.agents.get("agent-a") as unknown as AgentState;
    const buildAfter = buildTxEntries(agentAfter);
    expect(buildAfter.entries).toHaveLength(lenBefore + 60 - 1); // +60 page entries, −1 folded r9

    const newStart = repositionAfterPage(start, firstKey, buildAfter.entries, lenBefore);
    expect(buildAfter.entries[newStart]?.key).toBe(firstKey); // same first mounted entry
    expect(newStart).toBe(start + 60); // the fold was BELOW the window: pure prepend shift here
  });

  it("fallback: when the first mounted entry itself was folded away, shift by the entries delta", () => {
    const entries = [{ key: "x" }, { key: "y" }, { key: "z" }];
    expect(repositionAfterPage(2, "z", [{ key: "w" }, { key: "x" }, { key: "y" }], 3)).toBe(2 + (3 - 3)); // "z" gone, no growth
    expect(repositionAfterPage(0, "gone", [{ key: "w" }, { key: "x" }], 1)).toBe(1); // delta shift
    expect(repositionAfterPage(1, undefined, [{ key: "w" }, { key: "x" }, { key: "y" }], 1)).toBe(3);
  });
});
