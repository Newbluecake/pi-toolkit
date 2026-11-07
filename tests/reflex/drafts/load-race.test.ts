/**
 * jev-reflex · #25 B4: loader races and the single I/O budget (BA §4.6 rules 3–5, R-I13). Real fs for the
 * TOCTOU swaps (the swap happens inside an injected-fs hook, i.e. exactly between the loader's steps);
 * a scripted fake fs for hangs, so the 500 ms budget and abort are driven by a FakeClock, not wall time.
 */
import { appendFileSync, mkdirSync, renameSync, rmSync, symlinkSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../../src/core/clock.js";
import { BUILTIN_SCRIPTS } from "../../../src/reflex/core/catalog.js";
import { DRAFT_LOAD_BUDGET_MS, DRAFT_MAX_FILE_BYTES } from "../../../src/reflex/core/draft-schema.js";
import { defaultDraftFs, loadDrafts, type DraftFs } from "../../../src/reflex/drafts/load.js";
import { fakeDraftFs, hang, queueDraft, tmpAgent, type TmpAgent } from "./helpers.js";

const BUILTIN_IDS: ReadonlySet<string> = new Set(BUILTIN_SCRIPTS.map((s) => s.id));
let agent: TmpAgent;
beforeEach(() => {
  agent = tmpAgent();
});
afterEach(() => agent.cleanup());

const flush = async (n = 20): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
};

describe("TOCTOU on the real filesystem (swap lands between the loader's steps)", () => {
  it("file swapped for a symlink right before open ⇒ not-regular (O_NOFOLLOW, ELOOP)", async () => {
    agent.write("target.json", queueDraft("draft.target"));
    const victim = agent.write("victim.json", queueDraft("draft.victim"));
    const fs: DraftFs = {
      ...defaultDraftFs,
      open: async (path, flags) => {
        if (path.endsWith("victim.json")) {
          rmSync(victim);
          symlinkSync(join(agent.draftsDir, "target.json"), victim);
        }
        return defaultDraftFs.open(path, flags);
      },
    };
    const r = await loadDrafts(agent.draftsDir, BUILTIN_IDS, new FakeClock(0), new AbortController().signal, fs);
    expect(r.rejected.find((x) => x.file === "victim.json")?.code).toBe("not-regular");
    expect(r.loaded.map((d) => d.script.id)).toEqual(["draft.target"]); // the symlink target was NOT read through it
  });

  it("file grows after stat ⇒ the read hits cap+1 ⇒ size (stat said it was small)", async () => {
    const path = agent.write("grow.json", queueDraft("draft.grow"));
    const fs: DraftFs = {
      ...defaultDraftFs,
      open: async (p, flags) => {
        const h = await defaultDraftFs.open(p, flags);
        return {
          ...h,
          stat: async () => {
            const st = await h.stat();
            appendFileSync(path, " ".repeat(DRAFT_MAX_FILE_BYTES + 4096)); // after the size check's input is taken
            return st;
          },
        };
      },
    };
    const r = await loadDrafts(agent.draftsDir, BUILTIN_IDS, new FakeClock(0), new AbortController().signal, fs);
    expect(r.rejected).toEqual([{ file: "grow.json", code: "size" }]);
    expect(r.loaded).toEqual([]);
  });

  it("drafts directory replaced wholesale during the scan ⇒ dir-changed, everything discarded", async () => {
    agent.write("a.json", queueDraft("draft.a"));
    const fs: DraftFs = {
      ...defaultDraftFs,
      open: async (path, flags) => {
        const h = await defaultDraftFs.open(path, flags);
        // swap while the first file is open: old dir moves away, a fresh (different inode) one takes its place
        renameSync(agent.draftsDir, `${agent.draftsDir}.old`);
        mkdirSync(agent.draftsDir);
        chmodSync(agent.draftsDir, 0o700);
        return h;
      },
    };
    const r = await loadDrafts(agent.draftsDir, BUILTIN_IDS, new FakeClock(0), new AbortController().signal, fs);
    expect(r.failure?.code).toBe("dir-changed");
    expect(r.loaded).toEqual([]);
    expect(r.rejected).toEqual([]);
    rmSync(`${agent.draftsDir}.old`, { recursive: true, force: true });
  });
});

describe("single budget + abort (FakeClock-driven, scripted fs)", () => {
  it("a hung open ⇒ timeout at exactly the 500 ms budget; the late handle is closed; timer cleared; later files never opened", async () => {
    const clock = new FakeClock(0);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { fs, calls } = fakeDraftFs({
      files: { "a.json": JSON.stringify(queueDraft("draft.a")), "b.json": JSON.stringify(queueDraft("draft.b")) },
      openHook: (name) => (name === "a.json" ? gate : undefined),
    });
    const pending = loadDrafts("/x/reflex/drafts", BUILTIN_IDS, clock, new AbortController().signal, fs);
    await flush();
    let settled = false;
    void pending.then(() => (settled = true));
    clock.advance(DRAFT_LOAD_BUDGET_MS - 1);
    await flush();
    expect(settled).toBe(false);
    clock.advance(1);
    const r = await pending;
    expect(r).toEqual({ loaded: [], rejected: [], failure: { code: "timeout" } });
    expect(clock.pendingTimers).toBe(0);
    expect(calls.open).toEqual(["a.json"]); // b.json was never opened
    release(); // the hung open finally resolves ⇒ its handle must be closed, not leaked
    await flush();
    expect(calls.openedHandles).toBe(1);
    expect(calls.closed).toBe(1);
  });

  it("a hung read ⇒ timeout; the open handle is closed; the next file is never opened", async () => {
    const clock = new FakeClock(0);
    const { fs, calls } = fakeDraftFs({
      files: { "a.json": JSON.stringify(queueDraft("draft.a")), "b.json": JSON.stringify(queueDraft("draft.b")) },
      readHook: () => hang(),
    });
    const pending = loadDrafts("/x/reflex/drafts", BUILTIN_IDS, clock, new AbortController().signal, fs);
    await flush();
    clock.advance(DRAFT_LOAD_BUDGET_MS);
    const r = await pending;
    expect(r.failure?.code).toBe("timeout");
    await flush();
    expect(calls.open).toEqual(["a.json"]);
    expect(calls.closed).toBe(calls.openedHandles);
    expect(calls.dirClosed).toBe(1);
    expect(clock.pendingTimers).toBe(0);
  });

  it("budget spans the whole load: first file fine, second open hangs ⇒ timeout drops EVERYTHING (partial results are never returned)", async () => {
    const clock = new FakeClock(0);
    const { fs, calls } = fakeDraftFs({
      files: {
        "a.json": JSON.stringify(queueDraft("draft.a")),
        "b.json": JSON.stringify(queueDraft("draft.b")),
        "c.json": JSON.stringify(queueDraft("draft.c")),
      },
      openHook: (name) => (name === "b.json" ? hang() : undefined),
    });
    const pending = loadDrafts("/x/reflex/drafts", BUILTIN_IDS, clock, new AbortController().signal, fs);
    await flush();
    clock.advance(DRAFT_LOAD_BUDGET_MS);
    const r = await pending;
    expect(r).toEqual({ loaded: [], rejected: [], failure: { code: "timeout" } });
    expect(calls.open).toEqual(["a.json", "b.json"]); // c.json never opened
    expect(calls.closed).toBe(1); // a's handle (b's never materialised)
  });

  it("abort mid-read ⇒ aborted, handle closed, later files untouched, timer cleared", async () => {
    const clock = new FakeClock(0);
    const ac = new AbortController();
    const { fs, calls } = fakeDraftFs({
      files: { "a.json": JSON.stringify(queueDraft("draft.a")), "b.json": JSON.stringify(queueDraft("draft.b")) },
      readHook: () => hang(),
    });
    const pending = loadDrafts("/x/reflex/drafts", BUILTIN_IDS, clock, ac.signal, fs);
    await flush();
    ac.abort();
    const r = await pending;
    expect(r.failure?.code).toBe("aborted");
    await flush();
    expect(calls.open).toEqual(["a.json"]);
    expect(calls.closed).toBe(calls.openedHandles);
    expect(clock.pendingTimers).toBe(0);
  });

  it("abort while opendir hangs ⇒ aborted (the late directory handle is closed once it appears)", async () => {
    const clock = new FakeClock(0);
    const ac = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const base = fakeDraftFs({ files: { "a.json": "{}" } });
    const fs: DraftFs = {
      ...base.fs,
      opendir: async (p) => {
        await gate;
        return base.fs.opendir(p);
      },
    };
    const pending = loadDrafts("/x/reflex/drafts", BUILTIN_IDS, clock, ac.signal, fs);
    await flush();
    ac.abort();
    expect((await pending).failure?.code).toBe("aborted");
    release();
    await flush();
    expect(base.calls.dirClosed).toBe(1);
    expect(base.calls.open).toEqual([]);
  });

  it("a normal load never trips the timer and leaves nothing pending", async () => {
    const clock = new FakeClock(0);
    const { fs, calls } = fakeDraftFs({ files: { "a.json": JSON.stringify(queueDraft("draft.a")) } });
    const r = await loadDrafts("/x/reflex/drafts", BUILTIN_IDS, clock, new AbortController().signal, fs);
    expect(r.loaded).toHaveLength(1);
    expect(clock.pendingTimers).toBe(0);
    expect(calls.closed).toBe(calls.openedHandles);
  });
});
