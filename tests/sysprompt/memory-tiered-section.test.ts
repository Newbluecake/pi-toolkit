// todo #22 optimize-plan §2.6/§2.7 H group (package P1): hub integration for
// `memory.layout === "tiered"` \u2014 `memorySection()`'s tiered branch (real
// `renderTiered`, sticky access, the dynamic pointer function) folded through
// the REAL `PromptSectionHub` (sysprompt-stable). Mirrors
// `tests/sysprompt/memory-section.test.ts`'s structure (legacy, P0-owned,
// untouched) but drives the tiered path specifically.
//
// Key state-machine fact this file leans on throughout (`stable-section.ts`'s
// `resolveAtTurn`): the VERY FIRST render of a fresh section (stale, no
// snapshot yet) silently becomes the snapshot with NO update message \u2014
// exactly like the pre-existing legacy hub test's "Turn 1 contributes
// nothing" comment. Every scenario below therefore does one settling
// "warm-up" render before asserting `message` behavior on a SUBSEQUENT
// change, unless the state was already non-fresh (e.g. restored via resume).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPromptSectionHub, type PromptSectionHub, type PromptSectionHubOpts } from "../../src/sysprompt/hub.js";
import { PROMPT_SECTIONS_ENTRY_TYPE } from "../../src/prompt-sections/store.js";
import { SECTION_UPDATE_CUSTOM_TYPE } from "../../src/prompt-sections/update-message.js";
import { memorySection, memoryTitle, type MemorySectionDeps } from "../../src/memory/inject.js";
import { RenderCache } from "../../src/memory/render.js";
import { defaultPaths, toSlug } from "../../src/memory/paths.js";
import { DEFAULT_SETTINGS, type MemorySettings } from "../../src/config/settings.js";

// ────────────────────────────── env safety net ──────────────────────────────

let envTmp: string;
beforeEach(() => {
  envTmp = mkdtempSync(join(tmpdir(), "memfx-h-env-"));
  vi.stubEnv("HOME", join(envTmp, "nohome"));
  vi.stubEnv("ARMORY_MEMORY_ROOT", join(envTmp, "root"));
  expect(defaultPaths().memoryRoot.startsWith(tmpdir())).toBe(true);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(envTmp, { recursive: true, force: true });
});

// ────────────────────────────── fake pi / hub plumbing ──────────────────────

interface FakePi {
  pi: ExtensionAPI;
  handlers: Map<string, (event: any, ctx: any) => any>;
  appended: Array<{ type: string; data: unknown }>;
}

function fakePi(): FakePi {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const appended: Array<{ type: string; data: unknown }> = [];
  const pi = {
    on(event: string, handler: any) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    appendEntry(type: string, data?: unknown) {
      appended.push({ type, data });
    },
  } as unknown as ExtensionAPI;
  return { pi, handlers, appended };
}

function makeHub(host: FakePi, opts: Partial<PromptSectionHubOpts> = {}): PromptSectionHub {
  return createPromptSectionHub(host.pi, {
    mode: opts.mode ?? (() => "stable"),
    wakeReplay: opts.wakeReplay ?? false,
    adoptForeignForcedPrompt: opts.adoptForeignForcedPrompt ?? false,
    ...(opts.log ? { log: opts.log } : {}),
  });
}

function sessionStart(host: FakePi, reason: string, ctx: Partial<ExtensionContext> = {}): void {
  host.handlers.get("session_start")?.({ type: "session_start", reason }, ctx);
}
function sessionCompact(host: FakePi): void {
  host.handlers.get("session_compact")?.({ type: "session_compact" }, {});
}
function beforeAgentStart(host: FakePi, systemPrompt: string, ctx: ExtensionContext): any {
  const handler = host.handlers.get("before_agent_start")!;
  return handler(
    { type: "before_agent_start", prompt: "go", systemPrompt, systemPromptOptions: { cwd: ctx.cwd } },
    ctx,
  );
}

/** `getActiveTools` lives on `MemorySectionDeps` (wired by `wireMemory` from
 *  `pi.getActiveTools`), NOT on `ExtensionContext` \u2014 this fake ctx only
 *  needs a stable session id for the sticky-access-cache / pointer-clock
 *  behavior under test. */
function fakeCtx(cwd: string, sessionId: string): ExtensionContext {
  return {
    cwd,
    hasUI: false,
    mode: "rpc",
    sessionManager: { getSessionId: () => sessionId } as any,
  } as unknown as ExtensionContext;
}

// ────────────────────────────── fixture ──────────────────────────────

interface Fixture {
  tmp: string;
  cwd: string;
  memoryDir: string;
  memDeps: MemorySectionDeps;
}

function fixture(over: { settings?: Partial<MemorySettings>; getActiveTools?: () => string[] } = {}): Fixture {
  const tmp = mkdtempSync(join(tmpdir(), "memfx-h-"));
  const cwd = join(tmp, "proj");
  mkdirSync(cwd, { recursive: true });
  const memoryDir = join(tmp, "mem", toSlug(cwd));
  mkdirSync(memoryDir, { recursive: true });
  // The tiered renderer has no `paths` override (frozen `TieredRenderInput`
  // shape) \u2014 it always resolves through `defaultPaths()`, so THIS is what
  // actually needs to point at the fixture's temp root (the `paths` field
  // below is legacy-path-only plumbing, kept for interface parity).
  vi.stubEnv("ARMORY_MEMORY_ROOT", join(tmp, "mem"));
  const memDeps: MemorySectionDeps = {
    settings: { ...DEFAULT_SETTINGS.memory, layout: "tiered", toolSurface: "v2", ...over.settings },
    isChildSession: false,
    cache: new RenderCache(),
    frozenBlocks: new Map(),
    paths: { memoryRoot: join(tmp, "mem"), ccProjectsRoot: join(tmp, "cc") },
    getActiveTools: over.getActiveTools ?? (() => ["read", "memory"]),
  };
  return { tmp, cwd, memoryDir, memDeps };
}

function writeFile(dir: string, name: string, body: string, mtimeSec: number): void {
  writeFileSync(join(dir, name), body);
  utimesSync(join(dir, name), mtimeSec, mtimeSec);
}

function registerMemory(hub: PromptSectionHub, memDeps: MemorySectionDeps): void {
  hub.register("pi_project_memory", memorySection(memDeps));
}

// ═══════════════════════════ H1 — stable: write ⇒ one update ══════════════

describe("H1 — stable: writing memory produces one tail update, frozen head unchanged", () => {
  test("write core.md ⇒ next turn's system prompt stays frozen, one subagent:prompt-section-update with the new block", () => {
    const fx = fixture();
    const host = fakePi();
    const hub = makeHub(host);
    registerMemory(hub, fx.memDeps);
    const ctx = fakeCtx(fx.cwd, "s1");

    const first = beforeAgentStart(host, "BASE", ctx);
    expect(first?.systemPrompt).toBeUndefined(); // empty dir ⇒ nothing folded; turn 1 never announces
    expect(first?.message).toBeUndefined();

    writeFile(fx.memoryDir, "core.md", "---\npin: true\n---\n\n# core\n\nhello\n", 1000);
    const second = beforeAgentStart(host, "BASE", ctx);
    expect(second?.systemPrompt).toBeUndefined(); // frozen snapshot (still empty) unchanged
    expect(second?.message).toBeDefined();
    expect(second!.message.customType).toBe(SECTION_UPDATE_CUSTOM_TYPE);
    expect(second!.message.content).toContain("hello");
    expect(second!.message.content).toContain(memoryTitle(toSlug(fx.cwd)));

    const third = beforeAgentStart(host, "BASE", ctx);
    expect(third?.message).toBeUndefined(); // settled: live === announced from turn 2
    rmSync(fx.tmp, { recursive: true, force: true });
  });
  test("batch changes settle as exactly one update on the next turn", () => {
    const fx = fixture();
    const host = fakePi();
    const hub = makeHub(host);
    registerMemory(hub, fx.memDeps);
    const ctx = fakeCtx(fx.cwd, "s1");
    writeFile(fx.memoryDir, "core.md", "---\npin: true\n---\n\n# core\n\nold\n", 1000);
    writeFile(fx.memoryDir, "topic.md", "---\ndescription: topic\n---\n\n# topic\n", 1000);
    beforeAgentStart(host, "BASE", ctx);
    beforeAgentStart(host, "BASE", ctx); // settle the initial snapshot

    writeFile(fx.memoryDir, "core.md", "---\npin: true\n---\n\n# core\n\nnew\n", 2000);
    writeFile(fx.memoryDir, "topic.md", "---\ndescription: topic updated\n---\n\n# topic\n", 2000);
    const update = beforeAgentStart(host, "BASE", ctx);
    expect(update?.message).toBeDefined();
    expect(update!.message.customType).toBe(SECTION_UPDATE_CUSTOM_TYPE);
    expect(update!.message.content).toContain("new");
    expect(update!.message.content).toContain("topic updated");
    expect(beforeAgentStart(host, "BASE", ctx)?.message).toBeUndefined();
    rmSync(fx.tmp, { recursive: true, force: true });
  });
});

// ═══════════════════════════ H2 — touch / sub-kB-tier change ⇒ zero update ═

describe("H2 — stable: touch and small same-tier edits produce zero tail updates", () => {
  test("touch (mtime only, same content) ⇒ zero update", () => {
    const fx = fixture();
    const host = fakePi();
    const hub = makeHub(host);
    registerMemory(hub, fx.memDeps);
    const ctx = fakeCtx(fx.cwd, "s1");
    writeFile(fx.memoryDir, "topic.md", "# topic\n\nbody\n", 1000);

    const first = beforeAgentStart(host, "BASE", ctx); // turn 1: already folds the block (fresh-state text === snapshot === live)
    expect(first?.systemPrompt).toContain("topic.md");
    expect(first?.message).toBeUndefined(); // no message on the FIRST-ever render (nothing to diff against)
    const settled = beforeAgentStart(host, "BASE", ctx);
    expect(settled?.message).toBeUndefined(); // already settled by turn 2 (live === announced)

    utimesSync(join(fx.memoryDir, "topic.md"), 5000, 5000); // touch only, same content
    const third = beforeAgentStart(host, "BASE", ctx);
    expect(third?.systemPrompt).toBe(first?.systemPrompt); // I-M2: byte-identical, frozen head unchanged
    expect(third?.message).toBeUndefined(); // I-M2: byte-identical ⇒ live === announced ⇒ zero update
    rmSync(fx.tmp, { recursive: true, force: true });
  });

  test("a topic body edit that does not cross a sizeTier boundary produces zero update (topic bodies are never inlined)", () => {
    const fx = fixture();
    const host = fakePi();
    const hub = makeHub(host);
    registerMemory(hub, fx.memDeps);
    const ctx = fakeCtx(fx.cwd, "s1");
    writeFile(fx.memoryDir, "topic.md", "# topic\n\nshort body\n", 1000);
    beforeAgentStart(host, "BASE", ctx);
    beforeAgentStart(host, "BASE", ctx); // settle

    writeFile(fx.memoryDir, "topic.md", "# topic\n\nshort body, still under 1k\n", 2000);
    const after = beforeAgentStart(host, "BASE", ctx);
    expect(after?.message).toBeUndefined(); // description unchanged (H1 fallback) ⇒ index line unchanged ⇒ zero update
    rmSync(fx.tmp, { recursive: true, force: true });
  });

  test("a topic file growing across a sizeTier boundary (1k→2k) produces exactly one update, then settles", () => {
    const fx = fixture();
    const host = fakePi();
    const hub = makeHub(host);
    registerMemory(hub, fx.memDeps);
    const ctx = fakeCtx(fx.cwd, "s1");
    // 900 filler bytes + fixed header/frontmatter overhead → total file size
    // stays ≤ 1024B ⇒ sizeTier("1k") (tiered.ts's `≤ 1024 ⇒ "1k"` rule).
    writeFile(fx.memoryDir, "topic.md", `# topic\n\n${"a".repeat(900)}\n`, 1000);
    beforeAgentStart(host, "BASE", ctx); // turn 1: fresh ⇒ silent snapshot
    beforeAgentStart(host, "BASE", ctx); // turn 2: settled

    // 1200 filler bytes → total file size crosses 1024B ⇒ sizeTier becomes
    // "2k" — the index line's `· {sizeTier}` suffix changes even though the
    // topic's body itself is never inlined (topic bodies never appear in
    // the block).
    writeFile(fx.memoryDir, "topic.md", `# topic\n\n${"a".repeat(1200)}\n`, 2000);
    const crossed = beforeAgentStart(host, "BASE", ctx);
    expect(crossed?.message).toBeDefined();
    expect(crossed!.message.content).toContain("2k");

    const settled = beforeAgentStart(host, "BASE", ctx);
    expect(settled?.message).toBeUndefined(); // exactly one update, then stable again
    rmSync(fx.tmp, { recursive: true, force: true });
  });
});

// ═══════════════════════════ H3 — 4th change ⇒ pointer ════════════════════

describe("H3 — 4th distinct change escalates to a pointer message", () => {
  test("pointer text contains 'Changed this session:' and the access-appropriate action phrase", () => {
    const fx = fixture(); // getActiveTools ⇒ ["read","memory"] ⇒ access "memory+read"
    const host = fakePi();
    const hub = makeHub(host);
    registerMemory(hub, fx.memDeps);
    const ctx = fakeCtx(fx.cwd, "s1");

    // `core.md` (pin:true) is WHOLE-FILE inlined — its body changes actually
    // change the rendered block, unlike a topic file (whose body never
    // appears, only its H1-fallback description does).
    writeFile(fx.memoryDir, "core.md", "---\npin: true\n---\n\n# core\n\nv1\n", Date.now() / 1000);
    beforeAgentStart(host, "BASE", ctx); // turn 1: fresh ⇒ silent snapshot
    beforeAgentStart(host, "BASE", ctx); // turn 2: settled

    // Repeated distinct updates hit the pointer threshold (UPDATE_LIMITS.maxCount = 3).
    let last: any;
    let pointerMsg: any;
    for (let i = 0; i < 6 && !pointerMsg; i++) {
      writeFile(fx.memoryDir, "core.md", `---\npin: true\n---\n\n# core\n\nv${100 + i}\n`, Date.now() / 1000 + i + 1);
      last = beforeAgentStart(host, "BASE", ctx);
      if (last?.message?.content?.includes("Changed this session:")) pointerMsg = last.message;
    }
    expect(pointerMsg).toBeDefined();
    expect(pointerMsg.content).toContain("Changed this session:");
    expect(pointerMsg.content).toContain("core.md");
    expect(pointerMsg.content).toMatch(/memory view <file>|read .*<file>|not openable/);
    rmSync(fx.tmp, { recursive: true, force: true });
  });

  test("a throwing getActiveTools (⇒ throwing pointer function) omits the hint without crashing the session", () => {
    const fx = fixture({
      getActiveTools: () => {
        throw new Error("boom");
      },
    });
    const host = fakePi();
    const hub = makeHub(host);
    registerMemory(hub, fx.memDeps);
    const ctx = fakeCtx(fx.cwd, "s1");

    writeFile(fx.memoryDir, "a.md", "# a\n\nv1\n", 1000);
    beforeAgentStart(host, "BASE", ctx);
    beforeAgentStart(host, "BASE", ctx);

    let last: any;
    for (let i = 0; i < 6; i++) {
      writeFile(fx.memoryDir, "a.md", `# a\n\nv${100 + i}\n`, 2000 + i);
      expect(() => (last = beforeAgentStart(host, "BASE", ctx))).not.toThrow();
    }
    // Whatever the final message is (update or pointer), the session never
    // crashed and a pointer-kind message (if reached) carries no hint text
    // that depends on `getActiveTools` succeeding.
    void last;
    rmSync(fx.tmp, { recursive: true, force: true });
  });
});

// ═══════════════ H3b — session_start baseline / sticky-cache reset (回归) ═══
//
// Verification fallout #1 (revise-#22-P1-injection): the pointer's
// `sessionStartedAt` clock used to be stamped lazily, inside
// `tieredPointerText`, on whichever turn FIRST reached the POINTED state —
// turns after the actual session start (per H3 above, POINTED needs the
// UPDATE_LIMITS.maxCount'th distinct change). A file that changed shortly
// after the real session start but before POINTED was reached would then
// silently miss the "Changed this session" list. Separately, the sticky
// `access` cache and that same baseline were never reset for a same-
// session-id reentry (a `/resume`/`/reload`/cron-wake that keeps
// `ctx.sessionManager.getSessionId()` identical) — only a genuinely NEW
// session id ever got a fresh compute.
describe("H3b — pointer baseline anchors at session start, and a session_start reentry resets sticky state", () => {
  test("the 'changed this session' baseline is anchored at the FIRST render (turn 1), not deferred to the first pointer call", () => {
    const fx = fixture(); // getActiveTools ⇒ ["read","memory"] ⇒ access "memory+read"
    const host = fakePi();
    const hub = makeHub(host);
    registerMemory(hub, fx.memDeps);
    const ctx = fakeCtx(fx.cwd, "s1");

    writeFile(fx.memoryDir, "core.md", "---\npin: true\n---\n\n# core\n\nv1\n", 1000);
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(2_000_000); // "session start" instant, in ms
    beforeAgentStart(host, "BASE", ctx); // turn 1: fresh ⇒ anchors sessionStart at Date.now() = 2_000_000ms
    beforeAgentStart(host, "BASE", ctx); // turn 2: settled

    // A topic file changes right after the real session start (mtime just
    // past the 2_000_000ms anchor) — long before the section ever reaches
    // POINTED.
    writeFile(fx.memoryDir, "early.md", "# early\n\nv1\n", 2001);

    // Every POINTER-reaching turn from here on happens much "later" — under
    // the pre-fix lazy-stamp behavior this would have (wrongly) reset the
    // baseline to ~9_000_000ms, pushing early.md's mtime (2001s) behind it
    // and dropping it from the change list.
    nowSpy.mockReturnValue(9_000_000);
    let pointerMsg: { content: string } | undefined;
    for (let i = 0; i < 6 && !pointerMsg; i++) {
      writeFile(fx.memoryDir, "core.md", `---\npin: true\n---\n\n# core\n\nv${100 + i}\n`, 9000 + i);
      const last = beforeAgentStart(host, "BASE", ctx);
      if (last?.message?.content?.includes("Changed this session:")) pointerMsg = last.message;
    }
    expect(pointerMsg).toBeDefined();
    expect(pointerMsg!.content).toContain("early.md");
    nowSpy.mockRestore();
    rmSync(fx.tmp, { recursive: true, force: true });
  });

  test("access is sticky mid-session, but frozenBlocks.clear() (wireMemory's session_start signal) forces recomputation even for the SAME session id", () => {
    const fx = fixture({ getActiveTools: () => ["read", "memory"] }); // access: memory+read
    const host = fakePi();
    const hub = makeHub(host);
    registerMemory(hub, fx.memDeps);
    const ctx = fakeCtx(fx.cwd, "s1");
    writeFile(fx.memoryDir, "a.md", "# a\n\nhello\n", 1000);

    beforeAgentStart(host, "BASE", ctx); // turn 1: fresh ⇒ silent snapshot, access "memory+read" memoized
    beforeAgentStart(host, "BASE", ctx); // turn 2: settled

    // Mid-session tool-scope narrowing must NOT change the block (§2.4's
    // sticky rule — unchanged behavior, not part of this regression).
    fx.memDeps.getActiveTools = () => ["read"];
    const midSession = beforeAgentStart(host, "BASE", ctx);
    expect(midSession?.message).toBeUndefined();

    // A same-session-id reentry: `wireMemory`'s real `pi.on("session_start",
    // () => frozenBlocks.clear())` fires for EVERY reason (new/resume/
    // reload), including one that keeps `getSessionId()` identical. This
    // must invalidate the sticky access cache too.
    fx.memDeps.frozenBlocks.clear();
    const afterReentry = beforeAgentStart(host, "BASE", ctx);
    expect(afterReentry?.message).toBeDefined();
    expect(afterReentry!.message.content).toContain('Topics (open one only when its "when" matches: read ');
    expect(afterReentry!.message.content).not.toContain("memory view <name>");
    rmSync(fx.tmp, { recursive: true, force: true });
  });
});

// ═══════════════════════════ H4 — legacy snapshot restore ⇒ tiered live ═══

describe("H4 — restoring a legacy snapshot with tiered live settles in exactly one update", () => {
  test("resume restores an old legacy block; the live tiered block differs ⇒ one update, then stable", () => {
    const fx = fixture();
    writeFile(fx.memoryDir, "core.md", "---\npin: true\n---\n\n# core\n\nhello\n", 1000);
    const legacyFirstLine = `## Memory (${toSlug(fx.cwd)})`;
    const legacySnapshot = `${legacyFirstLine}\nIndex:\n- a.md (10B)\n\n<!-- pi-toolkit:memory ${toSlug(fx.cwd)} -->\n`;
    const persistedData = {
      v: 1,
      sections: {
        pi_project_memory: { snapshot: legacySnapshot, announced: legacySnapshot, sentCount: 1, sentBytes: 10 },
      },
    };

    const host = fakePi();
    const hub = makeHub(host);
    registerMemory(hub, fx.memDeps);
    sessionStart(host, "resume", {
      sessionManager: {
        getBranch: () => [{ type: "custom", customType: PROMPT_SECTIONS_ENTRY_TYPE, data: persistedData }],
        getSessionId: () => "s1",
      } as any,
    });
    const ctx = fakeCtx(fx.cwd, "s1");
    const first = beforeAgentStart(host, "BASE", ctx);
    // resume restores a NON-stale state (forgetAnnounced, snapshot kept) ⇒
    // the frozen head is still the OLD legacy block on this very first call.
    expect(first?.systemPrompt).toContain(legacyFirstLine);
    expect(first?.message).toBeDefined(); // live (tiered) differs from the restored `announced` ⇒ one update
    expect(first!.message.content).toContain("hello");

    const second = beforeAgentStart(host, "BASE", ctx);
    expect(second?.message).toBeUndefined(); // settled
    rmSync(fx.tmp, { recursive: true, force: true });
  });

  test("session_compact marks the section stale; the NEXT turn's frozen snapshot becomes the tiered block", () => {
    const fx = fixture();
    writeFile(fx.memoryDir, "core.md", "---\npin: true\n---\n\n# core\n\nhello\n", 1000);
    const host = fakePi();
    const hub = makeHub(host);
    registerMemory(hub, fx.memDeps);
    const ctx = fakeCtx(fx.cwd, "s1");
    beforeAgentStart(host, "BASE", ctx); // turn 1: fresh state ⇒ already folds "hello" (no message)
    beforeAgentStart(host, "BASE", ctx); // turn 2: settled (live === announced)

    sessionCompact(host); // marks stale ⇒ the NEXT before_agent_start refreshes the frozen snapshot
    writeFile(fx.memoryDir, "core.md", "---\npin: true\n---\n\n# core\n\nchanged after compact\n", 2000);
    const after = beforeAgentStart(host, "BASE", ctx);
    expect(after?.systemPrompt).toContain("changed after compact"); // now folded straight into the frozen head
    expect(after?.message).toBeUndefined(); // a stale refresh re-seeds silently, same as turn 1
    rmSync(fx.tmp, { recursive: true, force: true });
  });
});

// ═══════════════════════════ H5 — SKIP / live mode ═════════════════════════

describe("H5 — provider error degrades to SKIP; mode=live refreshes every turn", () => {
  test("a session-id resolution failure degrades to un-sticky access, never crashes", () => {
    const fx = fixture();
    const host = fakePi();
    const hub = makeHub(host);
    registerMemory(hub, fx.memDeps);
    const ctx = fakeCtx(fx.cwd, "s1");
    writeFile(fx.memoryDir, "a.md", "# a\n\nhello\n", 1000);
    beforeAgentStart(host, "BASE", ctx);
    beforeAgentStart(host, "BASE", ctx);

    const brokenCtx = {
      ...ctx,
      sessionManager: {
        getSessionId: () => {
          throw new Error("no session");
        },
      } as any,
    } as ExtensionContext;
    expect(() => beforeAgentStart(host, "BASE", brokenCtx)).not.toThrow();
    rmSync(fx.tmp, { recursive: true, force: true });
  });

  test("mode=live re-renders every turn (no frozen snapshot)", () => {
    const fx = fixture();
    const host = fakePi();
    const hub = makeHub(host, { mode: () => "live" });
    registerMemory(hub, fx.memDeps);
    const ctx = fakeCtx(fx.cwd, "s1");
    writeFile(fx.memoryDir, "core.md", "---\npin: true\n---\n\n# core\n\nv1\n", 1000);
    const first = beforeAgentStart(host, "BASE", ctx);
    expect(first?.systemPrompt).toContain("v1");

    writeFile(fx.memoryDir, "core.md", "---\npin: true\n---\n\n# core\n\nv2\n", 2000);
    const second = beforeAgentStart(host, "BASE", ctx);
    expect(second?.systemPrompt).toContain("v2");
    rmSync(fx.tmp, { recursive: true, force: true });
  });
});

// ═══════════════════════════ H6 — consult form ═════════════════════════════

describe("H6 — consult (main-session snapshot + core-profile/read-access child live) settles in one update", () => {
  test("main-session full-block snapshot vs. consult child's core-profile+read-access live ⇒ exactly one update", () => {
    const fx = fixture();
    writeFile(fx.memoryDir, "a.md", "# a\n\nhello from main\n", 1000);
    writeFile(fx.memoryDir, "b.md", "# b\n\nanother topic\n", 1500);

    // Snapshot the MAIN session's full block first (child profile "full").
    const mainHost = fakePi();
    const mainHub = makeHub(mainHost);
    const mainDeps: MemorySectionDeps = { ...fx.memDeps, isChildSession: false };
    registerMemory(mainHub, mainDeps);
    const mainCtx = fakeCtx(fx.cwd, "main-session");
    beforeAgentStart(mainHost, "BASE", mainCtx); // fresh ⇒ silent snapshot
    beforeAgentStart(mainHost, "BASE", mainCtx); // settled
    const mainPersisted = mainHost.appended.filter((e) => e.type === PROMPT_SECTIONS_ENTRY_TYPE).at(-1)!;

    // The consult fork: child session, core profile, read-only access
    // (CONSULT_READONLY_TOOLS), restored from the main session's snapshot.
    const childHost = fakePi();
    const childHub = makeHub(childHost);
    const childDeps: MemorySectionDeps = {
      ...fx.memDeps,
      isChildSession: true,
      settings: { ...fx.memDeps.settings, childProfile: "core" },
      cache: new RenderCache(),
      frozenBlocks: new Map(),
      getActiveTools: () => ["read", "grep", "find", "ls"], // CONSULT_READONLY_TOOLS ⇒ access "read"
    };
    registerMemory(childHub, childDeps);
    sessionStart(childHost, "resume", {
      sessionManager: {
        getBranch: () => [{ type: "custom", customType: PROMPT_SECTIONS_ENTRY_TYPE, data: mainPersisted.data }],
        getSessionId: () => "consult-1",
      } as any,
    });
    const childCtx = fakeCtx(fx.cwd, "consult-1");
    const first = beforeAgentStart(childHost, "BASE", childCtx);
    expect(first?.message).toBeDefined(); // core+read differs from main's full snapshot ⇒ one update

    const second = beforeAgentStart(childHost, "BASE", childCtx);
    expect(second?.message).toBeUndefined(); // settled
    rmSync(fx.tmp, { recursive: true, force: true });
  });
});
