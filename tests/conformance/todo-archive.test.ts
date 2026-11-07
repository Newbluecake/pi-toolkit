/**
 * todo-archive plan §3 conformance (real `AgentSession` + `SessionManager`, harness moved out of
 * pi-boundary.test.ts): the `session_compact` archive sweep against the REAL pi runtime —
 *
 *  - scripted turns drive TaskCreate ×2 + TaskUpdate(#1 completed) through the REAL extension
 *    pipeline (wireTodo registered via extensionFactories);
 *  - `session.compact()` (with a test `session_before_compact` hook riding the same
 *    fromExtension path as switch_context — no summary LLM) must leave the branch ending
 *    [..., compaction, todo custom entry] with #1 archived (`archivedAt`+`completedAt`) and #2
 *    open, and the todo entry must contribute ZERO messages to buildSessionProjection();
 *  - the archived snapshot survives a real session-file reopen (parseSessionEntries +
 *    SessionManager.inMemory) via replayState;
 *  - a second compact() after another scripted turn succeeds and appends NO new todo entry
 *    (nothing newly completed);
 *  - navigateTree before/after the archive entry flips the replayed state un-archived/archived;
 *  - parametrized over keep_recent: `firstKeptEntryId` = preparation.firstKeptEntryId vs a
 *    non-existent sentinel (hook.ts's keep_recent=false shape).
 *
 * §8 ruling: the harness's `compaction.keepRecentTokens` override (tiny) guarantees both
 * compact() calls find a summarizable range despite the small scripted history.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { parseSessionEntries, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  assistantTextMsg,
  assistantToolCallMsg,
  disposeHarnessDirs,
  fakeModel,
  withSession,
} from "./agent-session-harness.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { wireTodo, type TodoWireResult } from "../../src/todo/index.js";
import { ARCHIVE_ENTRY, replayState, STATE_ENTRY, type TodoState } from "../../src/todo/state.js";

afterEach(() => {
  disposeHarnessDirs();
});

/** Sentinel matching no entry id — hook.ts's keep_recent=false implementation shape. */
const DROP_ALL_SENTINEL = "__todo-archive-conformance-drop-all__";

const TASK_TOOLS = ["bash", "TaskCreate", "TaskList", "TaskGet", "TaskUpdate", "TaskDelete"];

interface Capture {
  wiring?: TodoWireResult;
  /** projection.messages snapshotted by the FIRST session_compact handler (before wireTodo's). */
  messagesBeforeArchive?: unknown[];
  messagesBeforeArchiveJson?: string;
}

/** Registered FIRST so its session_compact handler runs before wireTodo's (registration order). */
function projectionCaptureExtension(capture: Capture) {
  return (pi: ExtensionAPI) => {
    pi.on("session_compact", (_event, ctx) => {
      const projection = ctx.sessionManager?.buildSessionProjection?.();
      capture.messagesBeforeArchive = projection?.messages;
      capture.messagesBeforeArchiveJson = JSON.stringify(projection?.messages ?? []);
    });
  };
}

function todoExtension(capture: Capture) {
  return (pi: ExtensionAPI) => {
    capture.wiring = wireTodo(pi, { archive: { onCompact: true, afterTurns: 0 } });
  };
}

/** Test-only session_before_compact handler: same fromExtension path as switch_context's hook. */
function compactHookExtension(keepRecent: boolean) {
  return (pi: ExtensionAPI) => {
    pi.on("session_before_compact", (event) => {
      const preparation = (event as { preparation?: { firstKeptEntryId?: string; tokensBefore?: number } }).preparation;
      return {
        compaction: {
          summary: "todo-archive conformance summary",
          firstKeptEntryId: keepRecent ? preparation?.firstKeptEntryId : DROP_ALL_SENTINEL,
          tokensBefore: preparation?.tokensBefore ?? 0,
        },
      };
    });
  };
}

const scriptedTurnOne = [
  {
    toolCall: true,
    build: (m: ReturnType<typeof fakeModel>) =>
      assistantToolCallMsg(m, "t1", "TaskCreate", { subject: "First", description: "d1" }),
  },
  {
    toolCall: true,
    build: (m: ReturnType<typeof fakeModel>) =>
      assistantToolCallMsg(m, "t2", "TaskCreate", { subject: "Second", description: "d2" }),
  },
  {
    toolCall: true,
    build: (m: ReturnType<typeof fakeModel>) =>
      assistantToolCallMsg(m, "t3", "TaskUpdate", { taskId: "1", status: "completed" }),
  },
  { toolCall: false, build: (m: ReturnType<typeof fakeModel>) => assistantTextMsg(m, "done one") },
];
const scriptedTextTurn = [
  { toolCall: false, build: (m: ReturnType<typeof fakeModel>) => assistantTextMsg(m, "next turn") },
];

// todo-archive-split #92: the sweep persists TWO custom entries (archive package then narrowed
// live snapshot), so the counters split by kind.
function countLiveEntries(branch: Array<Record<string, unknown>>): number {
  return branch.filter((entry) => entry.type === "custom" && entry.customType === STATE_ENTRY).length;
}
function countArchiveEntries(branch: Array<Record<string, unknown>>): number {
  return branch.filter((entry) => entry.type === "custom" && entry.customType === ARCHIVE_ENTRY).length;
}

async function runArchiveScenario(keepRecent: boolean): Promise<void> {
  const capture: Capture = {};
  await withSession(
    {
      // Turn one: TaskCreate ×2 + TaskUpdate(#1 completed) + text; later turns are text-only.
      // scripted[4+] (repeated last turn) serve turns two and three.
      scripted: [...scriptedTurnOne, ...scriptedTextTurn],
      extensionFactories: [
        projectionCaptureExtension(capture),
        todoExtension(capture),
        compactHookExtension(keepRecent),
      ],
      persist: true,
      tools: TASK_TOOLS,
      compaction: { keepRecentTokens: 1 },
    },
    async ({ session }) => {
      const snapshot = (): TodoState => capture.wiring!.getTodoSnapshot();

      // ── 1. scripted turn: two tasks created, #1 completed, nothing archived ──
      await session.prompt("one");
      const afterTurn = snapshot();
      expect(afterTurn.tasks).toHaveLength(2);
      const completedTask = afterTurn.tasks.find((task) => task.id === 1)!;
      expect(completedTask.status).toBe("completed");
      expect(completedTask.archivedAt).toBeUndefined();
      expect(completedTask.completedAt).toBeDefined();
      const branchBefore = session.sessionManager.getBranch() as Array<Record<string, unknown>>;
      const preCompactLeafId = branchBefore[branchBefore.length - 1]?.id as string;
      const todoEntriesBefore = countLiveEntries(branchBefore);
      expect(todoEntriesBefore).toBeGreaterThanOrEqual(3); // 2 creates + 1 update persisted
      expect(countArchiveEntries(branchBefore)).toBe(0); // pre-split: no archive packages yet

      // ── 2. compact(): branch ends [compaction, archive package, live]; #1 archived, #2 open ──
      // todo-archive-split §4.3 #2: the sweep persists pre {put:#1} → narrowed live.
      await session.compact();
      const branch = session.sessionManager.getBranch() as Array<Record<string, unknown>>;
      const compactionIdx = branch.map((entry) => entry.type).lastIndexOf("compaction");
      expect(compactionIdx).toBeGreaterThan(-1);
      const archivePackage = branch[branch.length - 2];
      expect(archivePackage?.type).toBe("custom");
      expect(archivePackage?.customType).toBe(ARCHIVE_ENTRY);
      expect(archivePackage?.data).toMatchObject({
        v: 1,
        put: [{ id: 1, status: "completed", archivedAt: expect.any(Number) }],
      });
      const liveEntry = branch[branch.length - 1];
      expect(liveEntry?.type).toBe("custom");
      expect(liveEntry?.customType).toBe(STATE_ENTRY);
      expect((liveEntry?.data as { tasks: Array<{ id: number }> }).tasks.map((task) => task.id)).toEqual([2]);
      expect(branch.length - 2).toBe(compactionIdx + 1); // both directly after the compaction entry

      const replayed = replayState(branch)!;
      const archivedTask = replayed.tasks.find((task) => task.id === 1)!;
      expect(archivedTask.archivedAt).toBeDefined();
      expect(archivedTask.completedAt).toBeDefined();
      const openTask = replayed.tasks.find((task) => task.id === 2)!;
      expect(openTask.status).toBe("pending");
      expect(openTask.archivedAt).toBeUndefined();
      expect(countLiveEntries(branch)).toBe(todoEntriesBefore + 1); // exactly one sweep live snapshot
      expect(countArchiveEntries(branch)).toBe(1); // and exactly one archive package

      // ── 3. both new entry kinds contribute ZERO context messages ──
      const projection = session.sessionManager.buildSessionProjection() as {
        entries: Array<{ sourceEntry: Record<string, unknown>; messages: unknown[] }>;
        messages: unknown[];
      };
      for (const sourceEntry of [archivePackage, liveEntry]) {
        const projectedTodo = projection.entries.find((entry) => entry.sourceEntry === sourceEntry);
        expect(projectedTodo).toBeDefined();
        expect(projectedTodo!.messages).toHaveLength(0);
      }
      expect(JSON.stringify(projection.messages)).toBe(capture.messagesBeforeArchiveJson);

      // ── 4. survives a real session-file reopen (parseSessionEntries + inMemory rebuild) ──
      const sessionFile = session.sessionManager.getSessionFile();
      expect(sessionFile).toBeDefined();
      const fileEntries = parseSessionEntries(readFileSync(sessionFile!, "utf8"));
      const rebuilt = SessionManager.inMemory(session.sessionManager.getCwd(), undefined, fileEntries);
      const reopened = replayState(rebuilt.getBranch())!;
      const reopenedArchived = reopened.tasks.find((task) => task.id === 1)!;
      expect(reopenedArchived.archivedAt).toBe(archivedTask.archivedAt);
      expect(reopenedArchived.completedAt).toBe(archivedTask.completedAt);

      // ── 5. another scripted turn + second compact(): succeeds, NO new todo entry of either kind ──
      await session.prompt("two");
      await session.compact();
      const branchAfterSecond = session.sessionManager.getBranch() as Array<Record<string, unknown>>;
      expect(branchAfterSecond.some((entry) => entry.type === "compaction")).toBe(true);
      expect(countLiveEntries(branchAfterSecond)).toBe(todoEntriesBefore + 1); // unchanged
      expect(countArchiveEntries(branchAfterSecond)).toBe(1); // unchanged
      expect(snapshot().tasks.find((task) => task.id === 1)?.archivedAt).toBeDefined();

      // ── 6. navigateTree across the archive boundary flips the replayed state ──
      await session.navigateTree(preCompactLeafId);
      const beforeArchive = snapshot();
      expect(beforeArchive.tasks.find((task) => task.id === 1)?.archivedAt).toBeUndefined();
      expect(beforeArchive.tasks.find((task) => task.id === 1)?.status).toBe("completed");
      expect(beforeArchive.tasks.find((task) => task.id === 2)?.status).toBe("pending");

      // Between the archive package and the narrowed live snapshot: the last live candidate is
      // still the pre-sweep one (#1 completed, NOT archived) and it WINS the id conflict with the
      // folded package — #1 shows up as an unarchived completed task (benign, §4.3 #2).
      const archivePackageId = archivePackage?.id as string;
      await session.navigateTree(archivePackageId);
      const betweenEntries = snapshot();
      const betweenTask = betweenEntries.tasks.find((task) => task.id === 1)!;
      expect(betweenTask.status).toBe("completed");
      expect(betweenTask.archivedAt).toBeUndefined(); // live wins over the archived copy

      // Back on the swept leaf: archived again.
      const liveEntryId = liveEntry?.id as string;
      await session.navigateTree(liveEntryId);
      const afterArchive = snapshot();
      expect(afterArchive.tasks.find((task) => task.id === 1)?.archivedAt).toBeDefined();
    },
  );
}

describe("todo-archive conformance: session_compact sweep on the real AgentSession", () => {
  it("archives completed tasks on compact() (keep_recent: preparation.firstKeptEntryId)", async () => {
    await runArchiveScenario(true);
  });

  it("archives completed tasks on compact() (keep_recent:false — sentinel firstKeptEntryId)", async () => {
    await runArchiveScenario(false);
  });
});
